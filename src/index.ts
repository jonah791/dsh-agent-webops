/**
 * dsh-agent-webops：浏览器自主操作插件。
 *
 * host 管理一个 headless Chrome 实例（CDP），工具面给爱丽丝：
 * open/navigate/read/click/type/eval/shot/close——GUI 验证与网页操作全自主。
 * 不接触主人的真实浏览器；实例独立（临时 user-data-dir），close 后清理。
 *
 * v0.2.0 新增 **attach 模式**：附着到已在运行的外部 CDP 端点（Tauri/WebView2、Electron、
 * 任何以 `--remote-debugging-port=N` 启动的进程）——DOM 级驱动桌面应用界面，
 * 且 attach 的 `close()` 只断开连接、**绝不杀目标进程**（见 `closePlan`）。
 * @module dsh-agent-webops
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  cdpJsonUrl, cdpTargetOf, chromeArgs, clickJs as CLICK_JS, profileDirFor, readExpr,
  resolveShotDir, screenshotFileName, typeJs as TYPE_JS,
  CDP_MAX_ATTEMPTS, CDP_POLL_INTERVAL_MS, CDP_SEND_TIMEOUT_MS,
  ATTACH_MAX_ATTEMPTS, ATTACH_POLL_INTERVAL_MS, CONSOLE_BUFFER_CAP,
  appendConsole, attachFailureMessage, closePlan, consoleEntryOf, socketLive, targetIdentity,
  waitDecision, waitExpr, type ConsoleEntry,
} from './pure.ts'

export const name = 'agent-webops'
export const inject = ['tools'] as const

export interface Config {
  browserBin: string
  portMin: number
  shotDir: string
  attachPort: number
}
export const Config = z.object({
  browserBin: z.string().default('C:/Program Files/Google/Chrome/Application/chrome.exe'),
  // 9222 = Chrome 默认调试端口（实测：非默认端口可能被安全软件拦截不监听）
  portMin: z.number().default(9222),
  shotDir: z.string().default(''),
  // 外部 CDP 端点的缺省端口：**不复用 9222**（那是本插件自己 Chrome 的端口，两个 owner 会互相堵死）。
  // 9333 = 爱丽丝工作台（Tauri/WebView2 debug 构建）的约定端口。
  attachPort: z.number().default(9333),
})

/** 「未打开」的统一提示：两条入口（open / attach）都要说清。 */
const OPEN_HINT = '实例未打开（先 webops_open，或 webops_attach 附着外部 CDP 端点）'

/** 等待条件的默认预算与间隔。 */
const WAIT_DEFAULT_TIMEOUT_MS = 5000
const WAIT_MAX_TIMEOUT_MS = 60000
const WAIT_DEFAULT_INTERVAL_MS = 250
const WAIT_MIN_INTERVAL_MS = 50

interface CdpMessage { id?: number; method?: string; result?: Record<string, unknown>; params?: Record<string, unknown> }

/** CDP 客户端：管理一个 headless Edge 页面。 */
class CdpPage {
  private proc: ChildProcess | null = null
  private port = 0
  private profileDir = ''
  private ws: WebSocket | null = null
  private seq = 0
  private readonly pending = new Map<number, (msg: CdpMessage) => void>()
  private closed = false
  /** 是否附着到外部端点（决定 `close()` 是「断开」还是「杀进程 + 清 profile」）。 */
  private attached = false
  private consoleBuf: ConsoleEntry[] = []

  constructor(private readonly bin: string, private readonly portMin: number, private readonly shotDir: string) {}

  /** 连接活着才算「开着」：socket 已被对端关掉（目标进程退出）即判否——否则后续 open/attach 全被挡住。 */
  get isOpen(): boolean { return socketLive(this.ws?.readyState ?? null, this.closed) }

  /** 连接模式（五问之一「我现在连的是谁」的可读答案）。 */
  get mode(): 'closed' | 'spawned' | 'attached' {
    if (!this.isOpen) return 'closed'
    return this.attached ? 'attached' : 'spawned'
  }

  get consoleEntries(): ConsoleEntry[] { return this.consoleBuf }

  clearConsole(): void { this.consoleBuf = [] }

  /** 连 WebSocket + 开所需域（spawn / attach 共用）；控制台事件在此开始入缓冲。 */
  private connect(wsUrl: string): Promise<{ ok: boolean; error?: string }> {
    this.consoleBuf = []
    return new Promise<{ ok: boolean; error?: string }>((resolve) => {
      let sock: WebSocket
      try {
        sock = new WebSocket(wsUrl)
      } catch (err) {
        resolve({ ok: false, error: String(err) })
        return
      }
      this.ws = sock
      sock.onopen = () => resolve({ ok: true })
      sock.onerror = () => resolve({ ok: false, error: 'CDP WebSocket 连接失败' })
      // 对端断开（目标进程退出/被关窗）时必须复位引用与闸门：否则 isOpen 永远为真、后续
      // open()/attach() 全被「实例已打开」挡掉（2026-09-15 现场复现的欠账根因）。
      // 按 socket 身份守卫：旧 socket 的迟到事件不得踩掉新连接（close() 后 this.ws 已为 null ⇒ 早退）。
      sock.onclose = () => {
        if (this.ws !== sock) return
        this.ws = null
        this.closed = true
      }
      sock.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data)) as CdpMessage
          if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
            this.pending.get(msg.id)!(msg)
            this.pending.delete(msg.id)
            return
          }
          const entry = consoleEntryOf(msg, Date.now())
          if (entry) this.consoleBuf = appendConsole(this.consoleBuf, entry, CONSOLE_BUFFER_CAP)
        } catch { /* 忽略畸形消息 */ }
      }
    })
  }

  /** 打开三个域：Runtime（evaluate + 控制台事件）、Log（浏览器级日志/网络错误）、Page（截图）。 */
  private async enableDomains(): Promise<void> {
    await this.send('Runtime.enable').catch(() => {})
    await this.send('Log.enable').catch(() => {})
    await this.send('Page.enable').catch(() => {})
  }

  async open(url: string): Promise<{ ok: boolean; error?: string }> {
    if (this.isOpen) return { ok: false, error: `实例已打开（${this.mode} @ :${this.port}）——先 webops_close` }
    // 固定调试端口（9222）：实测安全软件只放行默认调试端口，随机偏移端口不监听
    this.port = this.portMin
    this.attached = false
    this.profileDir = profileDirFor(process.env.TEMP, Date.now())
    // 复位上一轮 close() 留下的闸门：否则 isOpen 永远为假、后续工具全部误报「未打开」
    this.closed = false
    try {
      this.proc = spawn(this.bin, chromeArgs({ port: this.port, profileDir: this.profileDir, url }), { stdio: 'ignore' })
    } catch (err) {
      return { ok: false, error: '浏览器启动失败: ' + String(err) }
    }
    // 等 CDP 就绪（冷启动最长 ~40s）
    let target: { webSocketDebuggerUrl?: string } | null = null
    for (let i = 0; i < CDP_MAX_ATTEMPTS && !this.closed; i++) {
      await new Promise((r) => setTimeout(r, CDP_POLL_INTERVAL_MS))
      try {
        const list = await (await fetch(cdpJsonUrl(this.port))).json()
        target = cdpTargetOf(list)
        if (target?.webSocketDebuggerUrl) break
      } catch { /* retry */ }
    }
    if (!target?.webSocketDebuggerUrl) {
      this.close()
      return { ok: false, error: 'CDP 未就绪（浏览器可能无法启动）' }
    }
    const conn = await this.connect(target.webSocketDebuggerUrl)
    if (!conn.ok) { this.close(); return conn }
    await this.enableDomains()
    return { ok: true }
  }

  /**
   * 附着到**已运行**的外部 CDP 端点（Tauri/WebView2、Electron、任何开了调试端口的进程）。
   * 与 `open()` 的三点差异：① 不 spawn、不知晓目标进程 ⇒ `close()` 只断开（`closePlan`）
   * ② 轮询预算 3s 而非 40s（端口现在要么开着、要么就没开）③ 失败文案区分「无端点」与「有监听但非 CDP」。
   */
  async attach(port: number): Promise<{ ok: boolean; error?: string; url?: string; title?: string }> {
    if (this.isOpen) return { ok: false, error: `实例已打开（${this.mode} @ :${this.port}）——先 webops_close` }
    this.attached = false
    this.closed = false
    let target: { webSocketDebuggerUrl?: string; url?: string; title?: string } | null = null
    let sawListener = false
    for (let i = 0; i < ATTACH_MAX_ATTEMPTS && !this.closed; i++) {
      try {
        const list = await (await fetch(cdpJsonUrl(port))).json()
        sawListener = true
        target = cdpTargetOf(list)
        if (target?.webSocketDebuggerUrl) break
      } catch { /* 端点尚未就绪 / 不是 CDP 监听 */ }
      await new Promise((r) => setTimeout(r, ATTACH_POLL_INTERVAL_MS))
    }
    if (!target?.webSocketDebuggerUrl) {
      return { ok: false, error: attachFailureMessage(port, sawListener ? 'no-page' : 'unreachable') }
    }
    this.port = port
    this.proc = null
    this.profileDir = ''
    const conn = await this.connect(target.webSocketDebuggerUrl)
    if (!conn.ok) { this.close(); return conn }
    this.attached = true
    await this.enableDomains()
    const id = targetIdentity(target)
    return { ok: true, url: id.url, title: id.title }
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<CdpMessage> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) { reject(new Error('浏览器未连接')); return }
      const id = ++this.seq
      this.pending.set(id, resolve)
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 超时: ' + method)) } }, CDP_SEND_TIMEOUT_MS)
    })
  }

  async evaluate(expression: string): Promise<{ value?: unknown; error?: string }> {
    try {
      const msg = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (msg.result?.exceptionDetails) {
        const ex = msg.result.exceptionDetails as { exception?: { description?: string }; text?: string }
        return { error: ex.exception?.description ?? ex.text ?? 'evaluate 异常' }
      }
      const rv = msg.result?.result as { value?: unknown } | undefined
      return { value: rv?.value }
    } catch (err) {
      return { error: String(err) }
    }
  }

  /** 服务端轮询等待条件成立（免调用方盲等）；判定逻辑在 `pure.ts:waitDecision`（离线可测）。 */
  async waitFor(expression: string, timeoutMs: number, intervalMs: number): Promise<{ ok: boolean; waitedMs: number; error?: string }> {
    const started = Date.now()
    const expr = waitExpr(expression)
    for (;;) {
      const r = await this.evaluate(expr)
      const waitedMs = Date.now() - started
      const d = waitDecision(r, waitedMs, timeoutMs)
      if (d.state === 'ok') return { ok: true, waitedMs }
      if (d.state === 'error' || d.state === 'timeout') return { ok: false, waitedMs, error: d.detail }
      await new Promise((r2) => setTimeout(r2, intervalMs))
    }
  }

  async screenshot(): Promise<{ ok: boolean; path?: string; error?: string }> {
    try {
      const msg = await this.send('Page.captureScreenshot', { format: 'png' })
      const data = msg.result?.data as string | undefined
      if (!data) return { ok: false, error: '截图失败' }
      mkdirSync(this.shotDir, { recursive: true })
      const file = join(this.shotDir, screenshotFileName(Date.now()))
      writeFileSync(file, Buffer.from(data, 'base64'))
      return { ok: true, path: file }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  }

  close(): void {
    this.closed = true
    try { this.ws?.close() } catch { /* 忽略 */ }
    this.ws = null
    const plan = closePlan(this.attached)
    if (plan.killProc) {
      try { this.proc?.kill() } catch { /* 忽略 */ }
      if (this.proc && this.proc.pid) {
        try { spawn('taskkill', ['/F', '/T', '/PID', String(this.proc.pid)], { stdio: 'ignore' }) } catch { /* 忽略 */ }
      }
    }
    if (plan.rmProfile && this.profileDir) {
      setTimeout(() => { try { rmSync(this.profileDir, { recursive: true, force: true }) } catch { /* 忽略 */ } }, 2000)
    }
    this.proc = null
    this.profileDir = ''
    this.attached = false
  }
}

/** 点击/输入用的 DOM 辅助表达式（页面内执行）——定义在 `src/pure.ts`（可离线单测），此处仅重导出。
 * 注意：那些是注入浏览器的纯 JS（不能含 TS 语法如 as 类型断言）。 */
export { clickJs, typeJs, readExpr } from './pure.ts'

export function apply(ctx: Context, config: Config): void {
  const page = new CdpPage(config.browserBin, config.portMin, resolveShotDir(config.shotDir, process.env.DSH_HOME || ''))
  const logger = ctx.logger('agent-webops')
  const opened = (): boolean => page.isOpen

  ctx.tools.register(defineTool({
    name: 'webops_open',
    description: '打开自主浏览器（headless Edge）并导航到 URL——爱丽丝自主 GUI/网页操作的第一步。关闭旧实例需先 webops_close。',
    parameters: { url: { type: 'string', required: true, description: '目标 URL' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, error: { type: 'string' } } }, render: (_a: any, v: any) => [{ type: 'text', text: v.ok ? '浏览器已打开' : ('失败: ' + (v.error ?? '')) }] },
    async execute(args: { url: string }) {
      const r = await page.open(args.url)
      if (r.ok) logger.info('open ' + args.url)
      return r
    },
  }))

  ctx.tools.register(defineTool({
    name: 'webops_attach',
    description: '附着到**已运行**的外部 CDP 端点（Tauri/WebView2、Electron、任何带 --remote-debugging-port 的进程）——DOM 级驱动桌面应用界面；不启动进程，close 只断开、不杀目标。附着后 read/click/type/eval/shot/wait/console 全部可用。',
    parameters: { port: { type: 'number', description: '目标进程的 CDP 端口（缺省用 config.attachPort；爱丽丝工作台 WebView2 = 9333）' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, port: { type: 'number' }, url: { type: 'string' }, title: { type: 'string' }, error: { type: 'string' } } },
      render: (_a: any, v: any) => [{ type: 'text', text: v.ok ? `已附着 CDP:${v.port} 「${v.title}」 ${v.url}（close 只断开，不杀目标进程）` : ('失败: ' + (v.error ?? '')) }],
    },
    async execute(args: { port?: number }): Promise<{ ok: boolean; port: number; url?: string; title?: string; error?: string }> {
      const port = args.port ?? config.attachPort
      const r = await page.attach(port)
      if (!r.ok) return { ok: false, port, error: r.error ?? '附着失败' }
      logger.info('attach ' + port + ' ' + (r.url ?? ''))
      return { ok: true, port, url: r.url ?? '', title: r.title ?? '' }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'webops_read',
    description: '读取自主浏览器当前页面文本（可选 CSS 选择器限定；缺省取 body 全文）。',
    parameters: { selector: { type: 'string', description: 'CSS 选择器（可选）' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, text: { type: 'string' }, error: { type: 'string' } } }, render: (_a: any, v: any) => [{ type: 'text', text: v.ok ? String(v.text ?? '').slice(0, 6000) : ('失败: ' + (v.error ?? '')) }] },
    async execute(args: { selector?: string }) {
      if (!opened()) return { ok: false, error: OPEN_HINT }
      const expr = readExpr(args.selector)
      const r = await page.evaluate(expr)
      if (r.error) return { ok: false, error: r.error }
      return { ok: true, text: String(r.value ?? '') }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'webops_click',
    description: '在自主浏览器点击元素（按可见文本精确/包含匹配 button/a/span 等；返回 CLICKED/NOT_FOUND）。',
    parameters: { text: { type: 'string', required: true, description: '元素文本（如「插件」）' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, result: { type: 'string' }, error: { type: 'string' } } }, render: (_a: any, v: any) => [{ type: 'text', text: v.ok ? String(v.result) : ('失败: ' + (v.error ?? '')) }] },
    async execute(args: { text: string }) {
      if (!opened()) return { ok: false, error: OPEN_HINT }
      const r = await page.evaluate(CLICK_JS(args.text))
      if (r.error) return { ok: false, error: r.error }
      return { ok: true, result: String(r.value ?? '') }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'webops_type',
    description: '在自主浏览器输入框输入文本（CSS 选择器定位；React 兼容——原生 setter + input/change 事件）。',
    parameters: { selector: { type: 'string', required: true, description: 'CSS 选择器（如 input[placeholder*=插件名]）' }, text: { type: 'string', required: true, description: '要输入的文本' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, result: { type: 'string' }, error: { type: 'string' } } }, render: (_a: any, v: any) => [{ type: 'text', text: v.ok ? String(v.result) : ('失败: ' + (v.error ?? '')) }] },
    async execute(args: { selector: string; text: string }) {
      if (!opened()) return { ok: false, error: OPEN_HINT }
      const r = await page.evaluate(TYPE_JS(args.selector, args.text))
      if (r.error) return { ok: false, error: r.error }
      return { ok: true, result: String(r.value ?? '') }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'webops_eval',
    description: '在自主浏览器执行任意 JS（awaitPromise 支持 async；返回值需 JSON 可序列化）。',
    parameters: { expression: { type: 'string', required: true, description: 'JS 表达式' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, value: { type: 'string' }, error: { type: 'string' } } }, render: (_a: any, v: any) => [{ type: 'text', text: v.ok ? String(v.value) : ('失败: ' + (v.error ?? '')) }] },
    async execute(args: { expression: string }) {
      if (!opened()) return { ok: false, error: OPEN_HINT }
      const r = await page.evaluate(args.expression)
      if (r.error) return { ok: false, error: r.error }
      return { ok: true, value: JSON.stringify(r.value) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'webops_wait',
    description: '服务端轮询等待页面里的 JS 条件成立（按真值判断；页面异常与「条件为假」区分开）——替代盲等 sleep。',
    parameters: {
      expression: { type: 'string', required: true, description: 'JS 表达式（真值即满足，如 document.querySelectorAll(".star").length >= 2）' },
      timeoutMs: { type: 'number', description: `超时毫秒（缺省 ${WAIT_DEFAULT_TIMEOUT_MS}，上限 ${WAIT_MAX_TIMEOUT_MS}）` },
      intervalMs: { type: 'number', description: `轮询间隔毫秒（缺省 ${WAIT_DEFAULT_INTERVAL_MS}）` },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, waitedMs: { type: 'number' }, error: { type: 'string' } } },
      render: (_a: any, v: any) => [{ type: 'text', text: v.ok ? ('条件成立（等待 ' + v.waitedMs + 'ms）') : ('失败: ' + (v.error ?? '')) }],
    },
    async execute(args: { expression: string; timeoutMs?: number; intervalMs?: number }): Promise<{ ok: boolean; waitedMs: number; error?: string }> {
      if (!opened()) return { ok: false, waitedMs: 0, error: OPEN_HINT }
      const timeoutMs = Math.max(100, Math.min(args.timeoutMs ?? WAIT_DEFAULT_TIMEOUT_MS, WAIT_MAX_TIMEOUT_MS))
      const intervalMs = Math.max(WAIT_MIN_INTERVAL_MS, args.intervalMs ?? WAIT_DEFAULT_INTERVAL_MS)
      const r = await page.waitFor(args.expression, timeoutMs, intervalMs)
      if (!r.ok) return { ok: false, waitedMs: r.waitedMs, error: r.error ?? '等待超时' }
      return { ok: true, waitedMs: r.waitedMs }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'webops_console',
    description: '读取页面控制台输出/未捕获异常/浏览器日志（连接期间缓冲的最近条目）——白屏与 JS 报错的第一取证入口（程序化 F12）。',
    parameters: { limit: { type: 'number', description: `返回条数（缺省 50，上限 ${CONSOLE_BUFFER_CAP}）` }, clear: { type: 'boolean', description: '读取后是否清空缓冲' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, count: { type: 'number' }, entries: { type: 'string' }, error: { type: 'string' } } },
      render: (_a: any, v: any) => [{ type: 'text', text: v.ok ? ('缓冲 ' + v.count + ' 条\n' + String(v.entries ?? '')) : ('失败: ' + (v.error ?? '')) }],
    },
    async execute(args: { limit?: number; clear?: boolean }): Promise<{ ok: boolean; count: number; entries: string; error?: string }> {
      if (!opened()) return { ok: false, count: 0, entries: '', error: OPEN_HINT }
      const limit = Math.max(1, Math.min(args.limit ?? 50, CONSOLE_BUFFER_CAP))
      const all = page.consoleEntries
      const shown = all.slice(Math.max(0, all.length - limit))
      const text = shown.map((e) => '[' + e.level + '] ' + e.text).join('\n')
      if (args.clear) page.clearConsole()
      return { ok: true, count: all.length, entries: text || '(空——连接后该页面无控制台输出)' }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'webops_shot',
    description: '自主浏览器截图（PNG 存到 shotDir，返回路径——配合 read_image 查看）。attach 模式下也无需窗口在前台。',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, path: { type: 'string' }, error: { type: 'string' } } }, render: (_a: any, v: any) => [{ type: 'text', text: v.ok ? ('截图: ' + v.path) : ('失败: ' + (v.error ?? '')) }] },
    async execute() {
      if (!opened()) return { ok: false, error: OPEN_HINT }
      return page.screenshot()
    },
  }))

  ctx.tools.register(defineTool({
    name: 'webops_close',
    description: '关闭/断开当前 CDP 会话（spawn 模式：杀进程 + 清临时 profile；attach 模式：只断开连接，目标进程不受影响）。',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, mode: { type: 'string' }, error: { type: 'string' } } }, render: (_a: any, v: any) => [{ type: 'text', text: v.ok ? ('已关闭（原模式: ' + v.mode + '）') : ('失败: ' + (v.error ?? '')) }] },
    async execute(): Promise<{ ok: boolean; mode: string }> {
      const mode = page.mode
      page.close()
      return { ok: true, mode }
    },
  }))

  ctx.effect(() => () => page.close())
  logger.info('dsh-agent-webops 就绪（v0.2.0：spawn + attach 双模式）')
}
