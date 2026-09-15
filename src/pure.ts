/** dsh-agent-webops · 纯逻辑层（无 IO、无进程、时间注入）。
 *
 * 从 `index.ts` 抽出三类判定：
 * ① 拉起参数（Chrome/Edge 命令行、临时 profile 目录、截图目录）——写错一个 flag 就是「浏览器起不来但看不出为什么」；
 * ② 注入页面的 DOM 辅助表达式（点击/输入/读文本）——**注入安全**（文本必须经 JSON.stringify 转义，不能靠裸拼接）；
 * ③ CDP `/json` 目标挑选——坏响应不得抛出。
 * `index.ts` 只留 spawn / WebSocket / fetch / fs。
 */
import { join } from 'node:path'

/** CDP 就绪轮询：80 次 × 500ms = 冷启动最多 ~40s。 */
export const CDP_MAX_ATTEMPTS = 80
export const CDP_POLL_INTERVAL_MS = 500
/** 单条 CDP 命令超时。 */
export const CDP_SEND_TIMEOUT_MS = 30000

/** 截图目录：显式配置 > `<DSH_HOME>/webops-shots`（DSH_HOME 缺失回落 `.`）。 */
export function resolveShotDir(configShotDir: string, dshHome: string): string {
  return configShotDir || join(dshHome || '.', 'webops-shots')
}

/** 临时 profile 目录：`<TEMP>/webops-profile-<nowMs>`（TEMP 缺失回落 `.`；调用方注入时间）。 */
export function profileDirFor(tempDir: string | undefined, nowMs: number): string {
  return join(tempDir ?? '.', 'webops-profile-' + nowMs)
}

/**
 * 浏览器拉起参数（**顺序即语义**：URL 必须最后，Chrome 把第一个非 flag 参数当入口页）。
 * `--headless` 用旧写法：Chrome 132+ 已移除 `--headless=new`（实测 151 不识别 → 调试端口不监听 → CDP 永远不就绪）。
 */
export function chromeArgs(args: { port: number; profileDir: string; url: string }): string[] {
  return [
    '--headless',
    '--disable-gpu',
    '--no-first-run',
    '--window-size=1440,900',
    '--remote-debugging-port=' + args.port,
    '--user-data-dir=' + args.profileDir,
    args.url,
  ]
}

/** CDP 目标列表 URL。 */
export function cdpJsonUrl(port: number): string {
  return 'http://127.0.0.1:' + port + '/json'
}

/**
 * 从 `/json` 响应挑出页面目标：取第一个 `type === 'page'` 的条目。
 * **坏响应（不是数组 / 条目非对象）返回 null，不抛**——调用方在轮询循环里据此重试。
 */
export function cdpTargetOf(list: unknown): { type?: string; url?: string; webSocketDebuggerUrl?: string } | null {
  if (!Array.isArray(list)) return null
  for (const t of list) {
    if (t && typeof t === 'object' && (t as { type?: unknown }).type === 'page') {
      return t as { type?: string; url?: string; webSocketDebuggerUrl?: string }
    }
  }
  return null
}

/** 截图文件名（时间注入，避免同秒覆盖靠 Date.now 隐式状态）。 */
export function screenshotFileName(nowMs: number): string {
  return 'shot-' + nowMs + '.png'
}

/** 读文本表达式：有选择器时限定，无匹配给出可读占位；无选择器取 body 全文。 */
export function readExpr(selector: string | undefined): string {
  if (!selector) return 'document.body.innerText'
  return `document.querySelector(${JSON.stringify(selector)})?.innerText ?? '(选择器无匹配)'`
}

/**
 * 点击表达式（注入页面执行）。
 * 三级匹配梯：**精确 innerText** → 包含 innerText → 叶子节点 textContent 精确；都不中返回 `NOT_FOUND`。
 * 文本一律 `JSON.stringify` 转义——页面里出现引号/反斜杠/换行也不会破坏表达式（注入安全）。
 */
export function clickJs(text: string): string {
  return `(() => {
  const targets = [...document.querySelectorAll('button,a,[role=button],[role=menuitem],input,label,span')]
  const hit = targets.find((el) => el.innerText && el.innerText.trim() === ${JSON.stringify(text)})
    ?? targets.find((el) => el.innerText && el.innerText.includes(${JSON.stringify(text)}))
    ?? [...document.querySelectorAll('*')].find((el) => el.childElementCount === 0 && el.textContent && el.textContent.trim() === ${JSON.stringify(text)})
  if (!hit) return 'NOT_FOUND'
  hit.click()
  return 'CLICKED'
})()`
}

/**
 * 输入表达式（注入页面执行）：React 受控组件兼容——用原生 value setter 写值，
 * 再派发 `input` + `change`（只改 `.value` 不派事件的话 React 读不到）。
 * 无选择器匹配返回 `NOT_FOUND`；`window.HTMLInputElement` 不可用时回落直接赋值。
 */
export function typeJs(selector: string, text: string): string {
  return `(() => {
  const el = document.querySelector(${JSON.stringify(selector)})
  if (!el) return 'NOT_FOUND'
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value') && Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  if (setter) setter.call(el, ${JSON.stringify(text)})
  else el.value = ${JSON.stringify(text)}
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return 'TYPED'
})()`
}

/** 表达式是否可被 JS 引擎解析（守卫用：注入的 JS 不能含 TS 语法/语法错）。 */
export function isParseableExpression(expr: string): boolean {
  try {
    // eslint-disable-next-line no-new-func
    new Function('return (' + expr + ')')
    return true
  } catch {
    return false
  }
}

/* ───────────────────────── attach 模式（v0.2.0：附着外部 CDP 端点） ───────────────────────── */

/**
 * attach 就绪轮询：10 次 × 300ms ≈ 3s。
 * 与 `open` 的 40s 冷启动预算不同——attach 连的是**已运行**的进程，端口要么已经开着、要么就没开。
 */
export const ATTACH_MAX_ATTEMPTS = 10
export const ATTACH_POLL_INTERVAL_MS = 300
/** 控制台环形缓冲容量（超出丢最旧）。 */
export const CONSOLE_BUFFER_CAP = 200
/** 单条控制台文本上限（防一条巨型日志吃掉上下文）。 */
export const CONSOLE_TEXT_MAX = 1000

export interface ConsoleEntry { atMs: number; level: string; text: string }

/**
 * attach 失败文案：**区分「端口没有 CDP 端点」与「有监听但不是可用 CDP 端点」**。
 * （对照 §5.9 规则 1：不精确的错误文案会让「目标没开调试端口」被读成「插件坏了」。）
 */
export function attachFailureMessage(port: number, kind: 'unreachable' | 'no-page'): string {
  return kind === 'unreachable'
    ? `端口 ${port} 上没有 CDP 端点（目标进程未以 --remote-debugging-port=${port} 启动？）`
    : `端口 ${port} 有监听但取不到 page target（可能被非 CDP 进程占用）`
}

/**
 * 关闭计划：attach 模式**只断开连接**——目标进程不是本插件启动的，
 * 杀它等于越权（真实事故形态：把主人的应用杀掉）。
 */
export function closePlan(attached: boolean): { killProc: boolean; rmProfile: boolean } {
  return attached ? { killProc: false, rmProfile: false } : { killProc: true, rmProfile: true }
}

/** attach 回执里的目标身份（缺字段给可读占位，不抛）。 */
export function targetIdentity(t: { url?: string; title?: string } | null | undefined): { url: string; title: string } {
  return { url: (t && t.url) || '(无 url)', title: (t && t.title) || '(无标题)' }
}

/**
 * CDP 事件 → 控制台条目（`Runtime.consoleAPICalled` / `Runtime.exceptionThrown` / `Log.entryAdded`）。
 * 其它事件（含命令响应）返回 `null`——调用方据此忽略。
 */
export function consoleEntryOf(
  msg: { method?: string; params?: Record<string, unknown> } | null | undefined,
  nowMs: number,
): ConsoleEntry | null {
  if (!msg || typeof msg !== 'object') return null
  const params = (msg.params ?? {}) as Record<string, any>
  if (msg.method === 'Runtime.consoleAPICalled') {
    const args = Array.isArray(params.args) ? params.args : []
    const text = args.map((a: any) => (a && a.value !== undefined ? String(a.value) : (a?.description ?? a?.type ?? '?'))).join(' ')
    return { atMs: nowMs, level: String(params.type ?? 'log'), text: text.slice(0, CONSOLE_TEXT_MAX) }
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const details = (params.exceptionDetails ?? {}) as Record<string, any>
    const desc = details?.exception?.description ?? details?.text ?? '(无描述)'
    return { atMs: nowMs, level: 'exception', text: String(desc).slice(0, CONSOLE_TEXT_MAX) }
  }
  if (msg.method === 'Log.entryAdded') {
    const entry = (params.entry ?? {}) as Record<string, any>
    return { atMs: nowMs, level: String(entry.level ?? 'log'), text: String(entry.text ?? '').slice(0, CONSOLE_TEXT_MAX) }
  }
  return null
}

/** 环形缓冲追加（返回新数组，不原地改；超容量丢最旧）。 */
export function appendConsole(buf: ConsoleEntry[], entry: ConsoleEntry, cap: number = CONSOLE_BUFFER_CAP): ConsoleEntry[] {
  const next = buf.concat([entry])
  return next.length > cap ? next.slice(next.length - cap) : next
}

/**
 * wait 表达式：把调用方表达式包成「真值布尔」的 async IIFE。
 * 页面内异常**不抛出**，而是变成 `WAIT_ERR:` 前缀的字符串（否则异常与「条件为假」无法区分）。
 */
export function waitExpr(expression: string): string {
  return `(async () => { try { return Boolean(await (${expression})) } catch (e) { return 'WAIT_ERR:' + String((e && e.message) || e) } })()`
}

/** wait 轮询判定（纯函数）：ok（条件成立）/ error（表达式异常）/ timeout（预算耗尽）/ continue。 */
export function waitDecision(
  r: { value?: unknown; error?: string },
  waitedMs: number,
  timeoutMs: number,
): { state: 'ok' | 'error' | 'continue' | 'timeout'; detail: string } {
  if (r.error) return { state: 'error', detail: r.error }
  const v = r.value
  if (typeof v === 'string' && v.startsWith('WAIT_ERR:')) return { state: 'error', detail: v.slice('WAIT_ERR:'.length) }
  if (v === true) return { state: 'ok', detail: 'true' }
  if (waitedMs >= timeoutMs) return { state: 'timeout', detail: `等待 ${waitedMs}ms 未满足（最后取值 ${JSON.stringify(v)}）` }
  return { state: 'continue', detail: String(v) }
}
