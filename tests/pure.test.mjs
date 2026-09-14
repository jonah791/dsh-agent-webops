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
  cdpJsonUrl, cdpTargetOf, chromeArgs, isParseableExpression, profileDirFor, readExpr,
  resolveShotDir, screenshotFileName,
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
