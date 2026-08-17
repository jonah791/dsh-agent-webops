/**
 * dsh-agent-webops：浏览器自主操作插件。
 *
 * host 管理一个 headless Edge 实例（CDP），工具面给爱丽丝：
 * open/navigate/read/click/type/eval/shot/close——GUI 验证与网页操作全自主。
 * 不接触主人的真实浏览器；实例独立（临时 user-data-dir），close 后清理。
 * @module dsh-agent-webops
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'agent-webops'
export const inject = ['tools'] as const

export interface Config {
  browserBin: string
  portMin: number
  shotDir: string
}
export const Config = z.object({
  browserBin: z.string().default('C:/Program Files/Google/Chrome/Application/chrome.exe'),
  // 9222 = Chrome 默认调试端口（实测：非默认端口可能被安全软件拦截不监听）
  portMin: z.number().default(9222),
  shotDir: z.string().default(''),
})

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

  constructor(private readonly bin: string, private readonly portMin: number, private readonly shotDir: string) {}

  get isOpen(): boolean { return this.ws !== null && !this.closed }

  async open(url: string): Promise<{ ok: boolean; error?: string }> {
    if (this.isOpen) return { ok: false, error: '实例已打开（先 webops_close）' }
    // 固定调试端口（9222）：实测安全软件只放行默认调试端口，随机偏移端口不监听
    this.port = this.portMin
    this.profileDir = join(process.env.TEMP ?? '.', 'webops-profile-' + Date.now())
    try {
      this.proc = spawn(this.bin, [
        '--headless', // Chrome 132+ 移除 --headless=new（实测 151 不识别导致调试端口不监听）
        '--disable-gpu',
        '--no-first-run',
        '--window-size=1440,900',
        '--remote-debugging-port=' + this.port,
        '--user-data-dir=' + this.profileDir,
        url,
      ], { stdio: 'ignore' })
    } catch (err) {
      return { ok: false, error: '浏览器启动失败: ' + String(err) }
    }
    // 等 CDP 就绪（冷启动最长 ~40s）
    let target: { webSocketDebuggerUrl?: string } | null = null
    for (let i = 0; i < 80 && !this.closed; i++) {
      await new Promise((r) => setTimeout(r, 500))
      try {
        const list = await (await fetch('http://127.0.0.1:' + this.port + '/json')).json() as Array<{ type?: string; url?: string; webSocketDebuggerUrl?: string }>
        target = list.find((t) => t.type === 'page') ?? null
        if (target?.webSocketDebuggerUrl) break
      } catch { /* retry */ }
    }
    if (!target?.webSocketDebuggerUrl) {
      this.close()
      return { ok: false, error: 'CDP 未就绪（浏览器可能无法启动）' }
    }
    await new Promise<void>((resolve, reject) => {
      try {
        this.ws = new WebSocket(target!.webSocketDebuggerUrl!)
        this.ws.onopen = () => resolve()
        this.ws.onerror = () => reject(new Error('CDP WebSocket 连接失败'))
        this.ws.onmessage = (ev) => {
          try {
            const msg = JSON.parse(String(ev.data)) as CdpMessage
            if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
              this.pending.get(msg.id)!(msg)
              this.pending.delete(msg.id)
            }
          } catch { /* 忽略畸形消息 */ }
        }
      } catch (err) { reject(err) }
    }).catch((err) => {
      this.close()
      return { ok: false, error: String(err) }
    })
    if (!this.ws) return { ok: false, error: 'CDP 连接失败' }
    await this.send('Runtime.enable').catch(() => {})
    await this.send('Page.enable').catch(() => {})
    return { ok: true }
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<CdpMessage> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) { reject(new Error('浏览器未连接')); return }
      const id = ++this.seq
      this.pending.set(id, resolve)
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 超时: ' + method)) } }, 30000)
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

  async screenshot(): Promise<{ ok: boolean; path?: string; error?: string }> {
    try {
      const msg = await this.send('Page.captureScreenshot', { format: 'png' })
      const data = msg.result?.data as string | undefined
      if (!data) return { ok: false, error: '截图失败' }
      mkdirSync(this.shotDir, { recursive: true })
      const file = join(this.shotDir, 'shot-' + Date.now() + '.png')
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
    try { this.proc?.kill() } catch { /* 忽略 */ }
    if (this.proc && this.proc.pid) {
      try { spawn('taskkill', ['/F', '/T', '/PID', String(this.proc.pid)], { stdio: 'ignore' }) } catch { /* 忽略 */ }
    }
    this.proc = null
    if (this.profileDir) {
      setTimeout(() => { try { rmSync(this.profileDir, { recursive: true, force: true }) } catch { /* 忽略 */ } }, 2000)
    }
  }
}

/** 点击/输入用的 DOM 辅助表达式（页面内执行）。 */
// 注意：这些是注入浏览器的纯 JS（不能含 TS 语法如 as 类型断言）
const CLICK_JS = (text: string): string => `(() => {
  const targets = [...document.querySelectorAll('button,a,[role=button],[role=menuitem],input,label,span')]
  const hit = targets.find((el) => el.innerText && el.innerText.trim() === ${JSON.stringify(text)})
    ?? targets.find((el) => el.innerText && el.innerText.includes(${JSON.stringify(text)}))
    ?? [...document.querySelectorAll('*')].find((el) => el.childElementCount === 0 && el.textContent && el.textContent.trim() === ${JSON.stringify(text)})
  if (!hit) return 'NOT_FOUND'
  hit.click()
  return 'CLICKED'
})()`

const TYPE_JS = (selector: string, text: string): string => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)})
  if (!el) return 'NOT_FOUND'
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value') && Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  if (setter) setter.call(el, ${JSON.stringify(text)})
  else el.value = ${JSON.stringify(text)}
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return 'TYPED'
})()`

export function apply(ctx: Context, config: Config): void {
  const page = new CdpPage(config.browserBin, config.portMin, config.shotDir || join(process.env.DSH_HOME || '.', 'webops-shots'))
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
    name: 'webops_read',
    description: '读取自主浏览器当前页面文本（可选 CSS 选择器限定；缺省取 body 全文）。',
    parameters: { selector: { type: 'string', description: 'CSS 选择器（可选）' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, text: { type: 'string' }, error: { type: 'string' } } }, render: (_a: any, v: any) => [{ type: 'text', text: v.ok ? String(v.text ?? '').slice(0, 6000) : ('失败: ' + (v.error ?? '')) }] },
    async execute(args: { selector?: string }) {
      if (!opened()) return { ok: false, error: '浏览器未打开（先 webops_open）' }
      const expr = args.selector
        ? `document.querySelector(${JSON.stringify(args.selector)})?.innerText ?? '(选择器无匹配)'`
        : 'document.body.innerText'
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
      if (!opened()) return { ok: false, error: '浏览器未打开（先 webops_open）' }
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
      if (!opened()) return { ok: false, error: '浏览器未打开（先 webops_open）' }
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
      if (!opened()) return { ok: false, error: '浏览器未打开（先 webops_open）' }
      const r = await page.evaluate(args.expression)
      if (r.error) return { ok: false, error: r.error }
      return { ok: true, value: JSON.stringify(r.value) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'webops_shot',
    description: '自主浏览器截图（PNG 存到 shotDir，返回路径——配合 read_image 查看）。',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, path: { type: 'string' }, error: { type: 'string' } } }, render: (_a: any, v: any) => [{ type: 'text', text: v.ok ? ('截图: ' + v.path) : ('失败: ' + (v.error ?? '')) }] },
    async execute() {
      if (!opened()) return { ok: false, error: '浏览器未打开（先 webops_open）' }
      return page.screenshot()
    },
  }))

  ctx.tools.register(defineTool({
    name: 'webops_close',
    description: '关闭自主浏览器实例（进程 + 临时 profile 清理）。',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, error: { type: 'string' } } }, render: (_a: any, v: any) => [{ type: 'text', text: v.ok ? '已关闭' : ('失败: ' + (v.error ?? '')) }] },
    async execute() {
      page.close()
      return { ok: true }
    },
  }))

  ctx.effect(() => () => page.close())
  logger.info('dsh-agent-webops 就绪')
}
