# 真机探针夹具（`webops_read mode=fields`）

这两个 HTML 不是自动测试——**它们需要真浏览器**，所以是手动跑的探针。纯函数层的判定逻辑由
`tests/sensitive-fields.test.mjs` 守着（含硬断言 `/value/i.test(fieldsExpr()) === false`），
这里补的是**「在真 DOM 里跑一遍」**那一层。

## 为什么需要这一层

「表达式里没有 value」是**源码读出来的**结论；「真浏览器里跑也没带出值」是**跑出来的**结论。
前者能被 grep 到，后者不能——而 2026-11-03 的实测恰好证明两者会分开：当时的对照
（`mode=text`）在表单页上也零泄漏，原因不在我们的代码，而在 `document.body.innerText`
本身就是渲染文本。**这个原因是读源码读不出来的，必须跑一次。**

## 怎么跑

```bash
# 1. 起自主浏览器，打开夹具
webops_open  url=file:///<repo>/tests/fixtures/fields-probe.html
# 2. 读字段元信息
webops_read  mode=fields
webops_read  mode=text        # 对照组
# 3. 换第二个夹具（同一实例不能重复 open，用 eval 导航）
webops_eval  expression="location.href='file:///<repo>/tests/fixtures/render-probe.html'"
webops_read  mode=text
webops_read  mode=fields
# 4. 收尾（避免孤儿进程）
webops_close
```

## 判据

**`fields-probe.html` 上，任何 `PROBE_VAL_*` 都不得出现在任一模式的输出里。**

报表应为「字段 8 个，敏感 5 个」，且每条敏感都带原因：

| 控件 | 期望 | 命中原因 |
|---|---|---|
| `input[password] name=password` | 敏感 | `type=password` **且** `name 含「passw」` |
| `input[hidden] name=csrf` | 敏感 | `type=hidden` |
| `input[text] name=cc autocomplete=cc-number` | 敏感 | `autocomplete=cc-` |
| `input[text] name=api_key` | 敏感 | `name 含「api_key」` |
| `input[file] name=upload` | 敏感 | `type=file` |
| `input[text] name=username` | **不敏感** | 含 `user` 但不在词根里（刻意的） |
| `input[email] name=email` | **不敏感** | 同上，`email` 不是凭据 |
| `textarea name=note` | **不敏感** | — |

**反向判据（更重要）：只测前 5 行会让「全判敏感」也满分。** 所以后 3 行必须报不敏感。

## 2026-11-03 05:05 实测读数（对照基线）

| 夹具 | `mode=text` | `mode=fields` |
|---|---|---|
| `fields-probe.html` | 哨兵值**零泄漏**（`innerText` 不含 form control 的 value） | 8 字段 / 5 敏感，哨兵值零泄漏 ✓ |
| `render-probe.html` | **4 个哨兵全泄漏**（值被渲染成正文） | **0 字段**，完全看不见 |

⇒ 这个模式的定位是「**不读值的表单侦察通道**」，不是「缩小泄漏面」。
值被渲染成正文文本时，两种模式都拦不住——那是这个功能的已知盲区，不是 bug。

## 附带观察

`fields-probe.html` 会让注入检测器报 `credential-probe(score=3)`——因为页面里有
`password` / `api_key` 这类**元信息**。它在元信息层就报警，与 `mode=fields` 互补：
一个负责「这页可疑」，一个负责「这页具体哪几个字段敏感」。
