/**
 * dsh-agent-webops · 纯逻辑套件（离线；无浏览器、无网络、无进程）。
 *
 * 覆盖：拉起参数（顺序即语义）、临时目录/截图目录解析、CDP 目标挑选（坏响应不抛）、
 * 注入表达式可解析性。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import {
  CDP_MAX_ATTEMPTS, CDP_POLL_INTERVAL_MS, CDP_SEND_TIMEOUT_MS,
  ATTACH_MAX_ATTEMPTS, ATTACH_POLL_INTERVAL_MS, CONSOLE_BUFFER_CAP, CONSOLE_TEXT_MAX,
  appendConsole, attachFailureMessage, cdpJsonUrl, cdpTargetOf, chromeArgs, closePlan, consoleEntryOf,
  isParseableExpression, profileDirFor, readExpr, resolveShotDir, screenshotFileName, socketLive, targetIdentity,
  waitDecision, waitExpr,
} from '../lib/pure.js'

test('chromeArgs: flag 齐全、顺序固定、URL 必须在最后（Chrome 把首个非 flag 参数当入口页）', () => {
  const args = chromeArgs({ port: 9222, profileDir: '/tmp/p', url: 'https://example.com' })
  assert.deepEqual(args, [
    '--headless', '--disable-gpu', '--no-first-run', '--window-size=1440,900',
    '--remote-debugging-port=9222', '--user-data-dir=/tmp/p', 'https://example.com',
  ])
  assert.equal(args[args.length - 1], 'https://example.com')
})

test('chromeArgs: 必须用旧 `--headless`，不得回退为 `--headless=new`（Chrome 132+ 已移除）', () => {
  const args = chromeArgs({ port: 9222, profileDir: '/tmp/p', url: 'about:blank' })
  assert.ok(args.includes('--headless'))
  assert.equal(args.some((a) => a.startsWith('--headless=')), false, '`--headless=new` 会让调试端口不监听 → CDP 永远不就绪')
})

test('chromeArgs: 退化输入——空 URL 不产生多余参数（仍以 URL 位置收尾）', () => {
  const args = chromeArgs({ port: 9222, profileDir: '/tmp/p', url: '' })
  assert.equal(args.length, 7)
  assert.equal(args[6], '')
})

test('resolveShotDir: 显式配置优先；否则 <DSH_HOME>/webops-shots；DSH_HOME 空回落 .', () => {
  assert.equal(resolveShotDir('/shots', '/home/dsh'), '/shots')
  assert.equal(resolveShotDir('', '/home/dsh'), join('/home/dsh', 'webops-shots'))
  assert.equal(resolveShotDir('', ''), join('.', 'webops-shots'))
})

test('profileDirFor: <TEMP>/webops-profile-<注入时间>；TEMP 缺失回落 .（不读隐藏状态）', () => {
  assert.equal(profileDirFor('/tmp', 1700000000000), join('/tmp', 'webops-profile-1700000000000'))
  assert.equal(profileDirFor(undefined, 1), join('.', 'webops-profile-1'))
  assert.notEqual(profileDirFor('/tmp', 1), profileDirFor('/tmp', 2), '两次拉起必须是两个独立 profile')
})

test('cdpJsonUrl / screenshotFileName: 端口与时间显式注入（可离线断言）', () => {
  assert.equal(cdpJsonUrl(9222), 'http://127.0.0.1:9222/json')
  assert.equal(screenshotFileName(123), 'shot-123.png')
})

test('cdpTargetOf: 取第一个 type=page 的条目（忽略 browser/其它类型）', () => {
  const page = { type: 'page', url: 'https://x', webSocketDebuggerUrl: 'ws://a' }
  assert.deepEqual(cdpTargetOf([{ type: 'browser' }, page, { type: 'page', url: 'second' }]), page)
})

test('cdpTargetOf: 失败/退化路径——非数组 / 空数组 / 无 page / 坏条目 一律 null 且不抛', () => {
  assert.equal(cdpTargetOf(null), null)
  assert.equal(cdpTargetOf(undefined), null)
  assert.equal(cdpTargetOf({ error: 'not ready' }), null, 'CDP 未就绪时 /json 可能返回对象')
  assert.equal(cdpTargetOf('[]'), null)
  assert.equal(cdpTargetOf([]), null)
  assert.equal(cdpTargetOf([{ type: 'browser' }, null, 'x']), null)
  assert.doesNotThrow(() => cdpTargetOf([null, { type: 'page' }]))
  assert.deepEqual(cdpTargetOf([null, { type: 'page' }]), { type: 'page' })
})

test('常量：轮询预算 ≈ 40s（80×500ms）、单命令超时 30s（与 README/注释一致）', () => {
  assert.equal(CDP_MAX_ATTEMPTS * CDP_POLL_INTERVAL_MS, 40000)
  assert.equal(CDP_SEND_TIMEOUT_MS, 30000)
})

test('readExpr: 无选择器取 body 全文；有选择器限定且无匹配给可读占位', () => {
  assert.equal(readExpr(undefined), 'document.body.innerText')
  assert.equal(readExpr(''), 'document.body.innerText')
  assert.equal(readExpr('#a'), `document.querySelector("#a")?.innerText ?? '(选择器无匹配)'`)
  assert.equal(isParseableExpression(readExpr('#a')), true)
})

test('readExpr: 注入安全——选择器里的引号/反斜杠被 JSON 转义（不破坏表达式）', () => {
  const expr = readExpr('input[placeholder="a\\"b"]')
  assert.equal(isParseableExpression(expr), true, `表达式必须可解析: ${expr}`)
})

/* ───────────────────── v0.2.0：attach 模式 + 控制台缓冲 + 等待判定 ───────────────────── */

test('attachFailureMessage: 两种失败形态文案**必须不同**（「目标没开调试端口」≠「端口被别人占」）', () => {
  const unreachable = attachFailureMessage(9333, 'unreachable')
  const noPage = attachFailureMessage(9333, 'no-page')
  assert.notEqual(unreachable, noPage)
  assert.match(unreachable, /9333/)
  assert.match(unreachable, /remote-debugging-port=9333/, '要给出可照做的启动参数')
  assert.match(noPage, /9333/)
})

test('closePlan（尸体测试）：attach 模式**绝不杀进程、绝不删 profile**——目标不是我启动的', () => {
  assert.deepEqual(closePlan(true), { killProc: false, rmProfile: false })
  assert.deepEqual(closePlan(false), { killProc: true, rmProfile: true })
})

test('socketLive（尸体测试）：对端断开后**不得再算「开着」**——目标进程退出 ⇒ 后续 open/attach 必须放行', () => {
  // 事故样本：目标窗口关闭，socket 变成 CLOSED(3)，但 closed 标志仍是 false
  assert.equal(socketLive(3, false), false, 'socket 已断 ⇒ 不是活着（旧实现在此处判真 ⇒ 永远「实例已打开」）')
  assert.equal(socketLive(2, false), false, 'CLOSING(2) 亦非活着')
  assert.equal(socketLive(null, false), false, '无 socket 引用 ⇒ 不活着')
  assert.equal(socketLive(undefined, false), false, '未定义 readyState ⇒ 不活着（坏输入不得抛）')
  // 良性样本
  assert.equal(socketLive(1, false), true, 'OPEN(1) 且未主动关闭 ⇒ 活着')
  // 边界：主动 close() 后即便 readyState 还没翻到 CLOSED 也必须判否
  assert.equal(socketLive(1, true), false, 'close() 已置闸门 ⇒ 立即判否（不等 readyState 事件）')
})

test('targetIdentity: 缺字段给可读占位，不抛（坏目标也能进回执）', () => {
  assert.deepEqual(targetIdentity({ url: 'http://x', title: '工作台' }), { url: 'http://x', title: '工作台' })
  assert.deepEqual(targetIdentity(null), { url: '(无 url)', title: '(无标题)' })
  assert.deepEqual(targetIdentity({ title: '' }), { url: '(无 url)', title: '(无标题)' })
})

test('consoleEntryOf: consoleAPICalled 归一（值/对象/缺 value 三类参数）', () => {
  const e = consoleEntryOf({ method: 'Runtime.consoleAPICalled', params: { type: 'error', args: [{ value: 'boom' }, { description: 'Error: x' }, { type: 'undefined' }] } }, 7)
  assert.equal(e.level, 'error')
  assert.equal(e.text, 'boom Error: x undefined')
  assert.equal(e.atMs, 7)
})

test('consoleEntryOf: exceptionThrown（description 与 text 两条回退）+ Log.entryAdded + 其它事件 null', () => {
  assert.match(consoleEntryOf({ method: 'Runtime.exceptionThrown', params: { exceptionDetails: { exception: { description: 'TypeError: t is not a function' } } } }, 1).text, /TypeError/)
  assert.match(consoleEntryOf({ method: 'Runtime.exceptionThrown', params: { exceptionDetails: { text: 'Uncaught' } } }, 1).text, /Uncaught/)
  const log = consoleEntryOf({ method: 'Log.entryAdded', params: { entry: { level: 'warning', text: 'deprecated' } } }, 2)
  assert.deepEqual([log.level, log.text], ['warning', 'deprecated'])
  assert.equal(consoleEntryOf({ method: 'Page.loadEventFired' }, 1), null, '非控制台事件必须返回 null（否则缓冲被事件流灌满）')
  assert.equal(consoleEntryOf(null, 1), null)
  assert.equal(consoleEntryOf({ method: 'Runtime.consoleAPICalled' }, 1).text, '', '缺 params 不抛')
})

test('consoleEntryOf: 单条文本截断到 CONSOLE_TEXT_MAX（一条巨型日志不得吃掉上下文）', () => {
  const e = consoleEntryOf({ method: 'Runtime.consoleAPICalled', params: { type: 'log', args: [{ value: 'x'.repeat(5000) }] } }, 1)
  assert.equal(e.text.length, CONSOLE_TEXT_MAX)
})

test('appendConsole: 环形保留最近 cap 条、不原地改原数组', () => {
  const mk = (n) => ({ atMs: n, level: 'log', text: 't' + n })
  let buf = []
  const first = [mk(0)]
  buf = appendConsole(first, mk(1), 2)
  assert.equal(first.length, 1, '原数组不得被就地改（返回值语义）')
  buf = appendConsole(buf, mk(2), 2)
  assert.deepEqual(buf.map((e) => e.text), ['t1', 't2'], '超容量丢最旧')
  assert.equal(appendConsole([], mk(9)).length, 1)
})

test('waitExpr: 包装后仍可解析，且把页面异常变成 WAIT_ERR 前缀（异常 ≠ 条件为假）', () => {
  const expr = waitExpr('document.querySelectorAll(".star").length >= 2')
  assert.equal(isParseableExpression(expr), true, expr)
  assert.match(expr, /WAIT_ERR/)
  assert.equal(isParseableExpression(waitExpr('await fetch("/x")')), true)
})

test('waitDecision: ok / error / timeout / continue 四态判定（含 WAIT_ERR 与异常透传）', () => {
  assert.equal(waitDecision({ value: true }, 10, 5000).state, 'ok')
  assert.equal(waitDecision({ value: false }, 10, 5000).state, 'continue')
  assert.equal(waitDecision({ value: 'WAIT_ERR:boom' }, 10, 5000).state, 'error')
  assert.equal(waitDecision({ value: 'WAIT_ERR:boom' }, 10, 5000).detail, 'boom')
  assert.equal(waitDecision({ error: 'CDP 超时: Runtime.evaluate' }, 10, 5000).state, 'error')
  const to = waitDecision({ value: false }, 5000, 5000)
  assert.equal(to.state, 'timeout')
  assert.match(to.detail, /5000ms/)
  assert.equal(waitDecision({ value: 0 }, 4999, 5000).state, 'continue', '预算未到不得提前判超时')
})

test('常量：attach 轮询预算 ≈ 3s（10×300ms，与 open 的 40s 冷启动预算区分）', () => {
  assert.equal(ATTACH_MAX_ATTEMPTS * ATTACH_POLL_INTERVAL_MS, 3000)
  assert.equal(CONSOLE_BUFFER_CAP, 200)
  assert.equal(CONSOLE_TEXT_MAX, 1000)
})
