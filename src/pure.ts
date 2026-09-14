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
