/**
 * 敏感字段识别（2026-11-03 · t-ce65f010）。
 *
 * 判据来源：browser-use 的 `browser_use/dom/enhanced_snapshot.py::_is_sensitive_input`
 * （两条：`type ∈ {password,file,hidden}` / `autocomplete` 敏感前缀）
 * + 本地补充（`name`/`id` 含凭据词根）。
 *
 * 这个文件存在的理由：此前「要不要把某个字段的值喂进上下文」靠人工判断，
 * 而判断失误的代价是凭据进会话日志（**不可逆**）。
 *
 * 三条承重判据：
 * ① 该敏感的必须判敏感（漏判 = 凭据进上下文）
 * ② **不该敏感的必须不敏感**（误判会把正常字段也拦掉，工具就没人用了）
 * ③ ★ `fieldsExpr()` 的源码里**不能出现 `value`** ——值不进上下文是
 *    **结构保证**（表达式里根本没有那个字段），不是靠记住「别读它」。
 *    这条是字符串断言，故意做得很硬：它是本改动的全部意义所在。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { fieldsExpr, isSensitiveField } from '../lib/pure.js'

const f = (o) => ({ tag: 'input', ...o })

// ── 判据①：该敏感的必须敏感 ────────────────────────────────────────────
test('① type 三类（password / file / hidden）判敏感', () => {
  for (const t of ['password', 'file', 'hidden']) {
    const v = isSensitiveField(f({ type: t }))
    assert.equal(v.sensitive, true, `type=${t} 漏判`)
    assert.ok(v.reasons.some((r) => r.includes(`type=${t}`)), `拒因没说清：${JSON.stringify(v.reasons)}`)
  }
})

test('① autocomplete 敏感前缀（含 cc- 整族）判敏感', () => {
  for (const ac of ['current-password', 'new-password', 'one-time-code', 'cc-number', 'cc-csc', 'payment']) {
    const v = isSensitiveField(f({ type: 'text', autocomplete: ac }))
    assert.equal(v.sensitive, true, `autocomplete=${ac} 漏判`)
  }
})

test('① name / id 含凭据词根判敏感', () => {
  for (const key of ['password', 'passwd', 'api_key', 'apikey', 'auth_token', 'otp_code', 'captcha', 'private_key', 'client_secret']) {
    const byName = isSensitiveField(f({ type: 'text', name: key }))
    const byId = isSensitiveField(f({ type: 'text', id: key }))
    assert.equal(byName.sensitive, true, `name=${key} 漏判`)
    assert.equal(byId.sensitive, true, `id=${key} 漏判`)
  }
})

// ── 判据②（尸体）：不该敏感的不许敏感 ──────────────────────────────────
test('★ 尸体②：标识类字段不判敏感（误判会让工具变成噪音）', () => {
  const benign = [
    { type: 'text', name: 'email' },
    { type: 'text', name: 'username' },
    { type: 'text', name: 'search' },
    { type: 'text', name: 'q' },
    { type: 'email', name: 'mail', autocomplete: 'email' },
    { type: 'text', name: 'nickname' },
  ]
  for (const b of benign) {
    const v = isSensitiveField(f(b))
    assert.equal(v.sensitive, false, `${JSON.stringify(b)} 被误判成敏感：${JSON.stringify(v.reasons)}`)
  }
})

test('★ 尸体②：autocomplete=username 不是敏感前缀（username ≠ 凭据）', () => {
  assert.equal(isSensitiveField(f({ type: 'text', autocomplete: 'username' })).sensitive, false)
})

test('空字段不判敏感（既无 type 也无 name）', () => {
  assert.equal(isSensitiveField({ tag: 'input' }).sensitive, false)
})

// ── 判据③（承重）：值根本不进表达式 ───────────────────────────────────
test('★★ 判据③：fieldsExpr() 的源码里不出现 value —— 值不进上下文是结构保证', () => {
  const expr = fieldsExpr()
  assert.equal(/value/i.test(expr), false,
    `表达式里出现了 value：${expr.slice(0, 200)}`)
})

test('★★ 判据③：表达式只收集元信息（tag/type/name/id/autocomplete/label）', () => {
  const expr = fieldsExpr()
  for (const k of ['tag', 'type', 'name', 'id', 'autocomplete', 'label']) {
    assert.ok(expr.includes(k), `元信息缺 ${k}`)
  }
  assert.ok(expr.includes('querySelectorAll'), '没有枚举字段')
})

test('★★ 判据③：表达式被包成可求值的 IIFE（不是裸语句）', () => {
  const expr = fieldsExpr().trim()
  assert.ok(expr.startsWith('(() =>'), `不是 IIFE 开头：${expr.slice(0, 40)}`)
  assert.ok(expr.endsWith('})()'), `不是自调用结尾：${expr.slice(-20)}`)
})

// ── 判据可审：reasons 要说清命中了哪一条 ──────────────────────────────
test('reasons 可审：多条件同时命中时全部列出', () => {
  const v = isSensitiveField(f({ type: 'password', name: 'api_key', autocomplete: 'new-password' }))
  assert.equal(v.sensitive, true)
  assert.ok(v.reasons.length >= 3, `三条都命中却只报了 ${v.reasons.length} 条：${JSON.stringify(v.reasons)}`)
})

test('reasons 在非敏感时为空数组（不能有「默认理由」）', () => {
  assert.deepEqual(isSensitiveField(f({ type: 'text', name: 'email' })).reasons, [])
})
