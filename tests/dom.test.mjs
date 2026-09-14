/**
 * dsh-agent-webops · 注入表达式套件（**真执行**：在 Node 里用假 DOM 跑页面内 JS）。
 *
 * `clickJs` / `typeJs` 是注入浏览器的字符串——它们的正确性只在真页面里才暴露，
 * 所以本套件不"读字符串"，而是搭一个最小假 DOM 把它们**当代码跑**：
 * 断言三级点击匹配梯、React 受控组件写值路径、失败路径（NOT_FOUND）、以及
 * **注入安全**（文本含引号/反斜杠/换行/`');` 时不得破坏表达式）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clickJs, typeJs } from '../lib/pure.js'

/** 假元素：够用的 innerText/textContent/childElementCount/click/dispatchEvent/value。 */
function makeEl(opts = {}) {
  return {
    innerText: opts.innerText,
    textContent: opts.textContent ?? opts.innerText ?? '',
    childElementCount: opts.childElementCount ?? 0,
    clicked: 0,
    events: [],
    value: opts.value,
    click() { this.clicked += 1 },
    dispatchEvent(ev) { this.events.push(ev); return true },
  }
}

/** 装一套假 DOM（跑完务必还原，避免污染其它用例）。 */
function withFakeDom({ buckets = {}, bySelector = {}, inputProto }, fn) {
  const prevDoc = globalThis.document
  const prevWin = globalThis.window
  const prevEvent = globalThis.Event
  globalThis.document = {
    querySelectorAll: (sel) => buckets[sel] ?? [],
    querySelector: (sel) => bySelector[sel] ?? null,
    body: { innerText: 'BODY' },
  }
  globalThis.window = { HTMLInputElement: inputProto ?? class {} }
  globalThis.Event = class { constructor(type, opts) { this.type = type; this.bubbles = opts?.bubbles } }
  try {
    return fn()
  } finally {
    globalThis.document = prevDoc
    globalThis.window = prevWin
    globalThis.Event = prevEvent
  }
}

const run = (expr) => (0, eval)(expr) // 间接 eval：在全局作用域执行（与页面内一致）

const CHAIN = 'button,a,[role=button],[role=menuitem],input,label,span'

test('clickJs: 正常路径——精确 innerText 命中并真的调用 click()', () => {
  withFakeDom({
    buckets: { [CHAIN]: [makeEl({ innerText: '插件' }), makeEl({ innerText: '插件管理' })], '*': [] },
  }, () => {
    const els = globalThis.document.querySelectorAll(CHAIN)
    assert.equal(run(clickJs('插件')), 'CLICKED')
    assert.equal(els[0].clicked, 1, '必须点精确命中的那个')
    assert.equal(els[1].clicked, 0)
  })
})

test('clickJs: 匹配梯降级——无精确时用「包含」，再退到叶子节点 textContent 精确', () => {
  withFakeDom({
    buckets: {
      [CHAIN]: [makeEl({ innerText: '打开插件页面' })],
      '*': [makeEl({ textContent: '插件', childElementCount: 0 })],
    },
  }, () => {
    const chain = globalThis.document.querySelectorAll(CHAIN)
    const all = globalThis.document.querySelectorAll('*')
    assert.equal(run(clickJs('插件')), 'CLICKED')
    assert.equal(chain[0].clicked, 1, '包含匹配优先于叶子匹配')
    assert.equal(all[0].clicked, 0)
  })

  withFakeDom({ buckets: { [CHAIN]: [], '*': [makeEl({ textContent: ' 插件 ', childElementCount: 0 })] } }, () => {
    assert.equal(run(clickJs('插件')), 'CLICKED', '叶子节点的 textContent 去空白后精确匹配')
  })
})

test('clickJs: 失败路径——无任何匹配返回 NOT_FOUND（不抛、不误点）', () => {
  withFakeDom({ buckets: { [CHAIN]: [makeEl({ innerText: '别的东西' })], '*': [makeEl({ textContent: 'x', childElementCount: 2 })] } }, () => {
    assert.equal(run(clickJs('插件')), 'NOT_FOUND')
  })
})

test('clickJs: 退化输入——元素缺 innerText（如未渲染的节点）不得抛，继续找下一个', () => {
  withFakeDom({
    buckets: { [CHAIN]: [makeEl({ innerText: undefined }), makeEl({ innerText: '插件' })], '*': [] },
  }, () => {
    const els = globalThis.document.querySelectorAll(CHAIN)
    assert.equal(run(clickJs('插件')), 'CLICKED')
    assert.equal(els[1].clicked, 1)
  })
})

test('clickJs: 注入安全——文本含引号/反斜杠/换行/`\');` 不破坏表达式且照常匹配', () => {
  const nasty = `it's a "quote" \\ back\nnewline'); document.title='pwned'; //`
  withFakeDom({ buckets: { [CHAIN]: [makeEl({ innerText: nasty })], '*': [] } }, () => {
    assert.equal(run(clickJs(nasty)), 'CLICKED', '恶意文本必须被 JSON 转义，不得变成代码')
  })
})

test('typeJs: 正常路径（React 受控）——走原生 setter 写值 + 派发 input/change(bubbles)', () => {
  class FakeInput {}
  let setterCalls = 0
  Object.defineProperty(FakeInput.prototype, 'value', {
    configurable: true,
    get() { return this._v },
    set(v) { setterCalls += 1; this._v = v },
  })
  const el = new FakeInput()
  el.events = []
  el.dispatchEvent = function (ev) { this.events.push(ev); return true }
  withFakeDom({ bySelector: { '#q': el }, inputProto: FakeInput }, () => {
    assert.equal(run(typeJs('#q', '插件名')), 'TYPED')
  })
  assert.equal(setterCalls, 1, '有 setter 时必须用原生 setter（React 才读得到）')
  assert.equal(el.value, '插件名')
  assert.deepEqual(el.events.map((e) => e.type), ['input', 'change'])
  assert.equal(el.events.every((e) => e.bubbles === true), true)
})

test('typeJs: 退化路径——无原生 setter 时回落直接赋值（仍派发事件）', () => {
  const el = { value: '', events: [], dispatchEvent(ev) { this.events.push(ev); return true } }
  withFakeDom({ bySelector: { '#q': el } }, () => {
    assert.equal(run(typeJs('#q', 'x')), 'TYPED')
  })
  assert.equal(el.value, 'x')
  assert.deepEqual(el.events.map((e) => e.type), ['input', 'change'])
})

test('typeJs: 失败路径——选择器无匹配返回 NOT_FOUND（不抛）', () => {
  withFakeDom({ bySelector: {} }, () => {
    assert.equal(run(typeJs('#missing', 'x')), 'NOT_FOUND')
  })
})

test('typeJs: 注入安全——含单引号/双引号/换行的文本原样写入（不执行、不截断）', () => {
  class FakeInput {}
  Object.defineProperty(FakeInput.prototype, 'value', { configurable: true, get() { return this._v }, set(v) { this._v = v } })
  const el = new FakeInput()
  el.dispatchEvent = () => true
  const text = `a'b"c\\d\ne'); alert(1); //`
  withFakeDom({ bySelector: { '#q': el }, inputProto: FakeInput }, () => {
    assert.equal(run(typeJs('#q', text)), 'TYPED')
  })
  assert.equal(el.value, text, '写入值必须与原始文本逐字相同')
})

test('typeJs: 选择器含引号也安全（JSON 转义）', () => {
  const el = { value: '', dispatchEvent: () => true }
  withFakeDom({ bySelector: { 'input[placeholder="a\\"b"]': el } }, () => {
    assert.equal(run(typeJs('input[placeholder="a\\"b"]', 'v')), 'TYPED')
  })
  assert.equal(el.value, 'v')
})
