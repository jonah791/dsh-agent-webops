<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: 浏览器自主操作插件：host 管一个 headless Chrome/Edge（CDP）实例，给 agent 打开/读取/点击/输入/执行 JS/截图/关闭的完整自助工具面——GUI 验证与网页操作不打扰主人的真实浏览器
  inject: 'tools'
  tools: webops_open,webops_read,webops_click,webops_type,webops_eval,webops_shot,webops_close
  runtime: host-only
  envDeps: 本机 Chrome/Edge 可执行文件（browserBin）+ 目标页面需出网
  boundary: 用临时 user-data-dir 的隔离实例，不接触主人真实浏览器会话/凭据；webops_eval 可执行任意页面内 JS（等同在该页面上下文中的完全控制），仅对受信目标使用
  compat: cordis ^4.0.1 / dsh-tools ^0.1.0-rc.6
-->
# dsh-agent-webops — 浏览器自主操作插件

<p align="center">
  <a href="https://github.com/jonah791/dsh-agent-webops"><img src="https://img.shields.io/badge/version-0.1.0-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript">
  <img src="https://img.shields.io/badge/tests-21%20passed-brightgreen" alt="tests">
</p>

**一句话**：给 agent 一个**自己的** headless 浏览器——打开页面、读文本、点按钮、填输入框、跑 JS、截图，全流程自主，不借用主人的浏览器。

**为什么值得用**：验收不再「交还给用户」。改完前端/面板，agent 直接 `webops_open` → `webops_shot` → 看图判定，或 `webops_eval` 取几何/状态断言；用的是**独立临时 profile**，与主人真实浏览器零耦合，无凭据泄露风险。

## 能力

| 工具 | 用途 |
|------|------|
| `webops_open` | 打开自主浏览器（headless Edge）并导航到 URL——自主 GUI/网页操作的第一步。关闭旧实例需先 `webops_close` |
| `webops_read` | 读取自主浏览器当前页面文本（可选 CSS 选择器限定；缺省取 body 全文） |
| `webops_click` | 在自主浏览器点击元素（按可见文本精确/包含匹配 `button`/`a`/`span` 等；返回 `CLICKED`/`NOT_FOUND`） |
| `webops_type` | 在自主浏览器输入框输入文本（CSS 选择器定位；React 兼容——原生 setter + `input`/`change` 事件） |
| `webops_eval` | 在自主浏览器执行任意 JS（`awaitPromise` 支持 async；返回值需 JSON 可序列化） |
| `webops_shot` | 自主浏览器截图（PNG 存到 `shotDir`，返回路径——配合 `read_image` 查看） |
| `webops_close` | 关闭自主浏览器实例（进程 + 临时 profile 清理） |

## 快速开始

**1) 装依赖**：

```jsonc
"dsh-agent-webops": "link:<工作区>/self-plugins/dsh-agent-webops"
```

**2) 挂组合**：

```yaml
- id: agent-webops
  name: dsh-agent-webops
  config:
    browserBin: C:/Program Files/Google/Chrome/Application/chrome.exe
    shotDir: ''            # 缺省 = <DSH_HOME>/webops-shots
```

**3) 30 秒验证**：

```text
webops_open { url: "http://127.0.0.1:3080" }   → 期望 { ok: true }
webops_eval { expression: "location.href" }    → 期望返回该 URL 字符串
webops_close {}                                 → 期望 ok，进程与临时 profile 被清理
```

## 配置

| 项 | 默认 | 说明 |
|----|------|------|
| `browserBin` | `C:/Program Files/Google/Chrome/Application/chrome.exe` | 浏览器可执行文件（Chrome 默认安装位；用 Edge 则指向 `msedge.exe`） |
| `portMin` | `9222` | CDP 调试端口。**固定用 9222**：实测非默认端口可能被安全软件拦截导致不监听 |
| `shotDir` | `''` | 截图目录；空则用 `<DSH_HOME>/webops-shots`（`DSH_HOME` 也缺失时回落 `.`） |

## 落盘与自证（出问题时先看这里）

**本插件无轨迹 JSONL**（无 `*-trace.jsonl`）——它的可观测面就是**浏览器自身的产物**：

| 产物 | 位置 | 含义 |
|------|------|------|
| 截图 PNG | `shotDir`（缺省 `<DSH_HOME>/webops-shots`） | `webops_shot` 落盘，文件名带时间戳（`screenshotFileName(nowMs)`） |
| 临时 profile | 系统 TEMP 下的新建目录（`profileDirFor(TEMP, Date.now())`） | 每次 `open` 新建，`close` 时清理 |
| 浏览器进程 | `spawn(browserBin, chromeArgs(...), { stdio: 'ignore' })` | 进程即实例；`webops_open` 时若实例已开则**报错**（不静默复用） |

**一条命令答五问**（用产物替代轨迹）：

```bash
ls -lt "$DSH_HOME/webops-shots" | head -3
# ① 跑的是哪个构建   → 无 build 戳；用 lib/index.js mtime + plugin_boot_status 判定（见下节）
# ② 谁发起           → 截图文件名的时间戳 ↔ 会话事件流里的工具调用时间对齐
# ③ 断在哪一段       → 工具返回值：open/click 的 { ok:false, error } 直接给出失败原因（无阶段枚举）
# ④ 结果质量         → read_image 打开最新 PNG 亲眼看；或 webops_read/eval 的返回内容
# ⑤ 耗时与预算       → 无 durationMs；open 为同步 spawn 后立即返回，页面加载由后续 eval/read 体现
```

行为级自证（推荐，比看文件更直接）：`webops_open` → `webops_eval { expression: "document.title" }` → 标题正确 = 实例真的在跑且页面真的加载了。

## 生效判据与回退

**生效判据**（三选一，按可靠性排序）：
1. 行为级：`webops_open` 返回 `{ok:true}` 且 `webops_eval` 能取到页面状态 ⇒ 实例与 CDP 链路都通；
2. 进程级：任务管理器/`Get-Process` 里能看到 headless 浏览器进程，命令行包含本次的临时 profile 目录；
3. 生态级：工具面出现 7 个 `webops_*`，且 `plugin_boot_status`（`dsh-plugin-bootreport`）返回 `liveNow` 含本插件 ⇒ 当前进程跑的是当前构建。

> 注意：**重新构建 ≠ 生效**——产物 mtime 新只证明「构建过」，进程启动时间晚于产物 mtime 才算「在跑它」。
> 另注：**CDP 端口被占用 / 浏览器路径写错**时 `open` 会失败——这正是需要先跑 30 秒验证的原因。

**回退**（三档）：
- 源码级：`git -C self-plugins/dsh-agent-webops revert <commit>` → 重新构建 → 预检 → 重启；
- 组合级：预设里给 `agent-webops` 行加 `disabled: true`（或移除该行）→ 哨兵重启；
- 运行期：`webops_close` 关实例；异常残留时按进程名清理 headless 浏览器进程 + 删 TEMP 下临时 profile（截图可保留）。

## 测试

```bash
npm test        # = node --test "tests/*.test.mjs"
```

**21 例离线测试**（不需要浏览器、不需要网络）：
- `tests/pure.test.mjs` — 纯逻辑：`resolveShotDir`、`profileDirFor`、`chromeArgs`（含 `--headless`/调试端口/临时 profile）、`cdpJsonUrl`、`cdpTargetOf`、`screenshotFileName`、`isParseableExpression`
- `tests/dom.test.mjs` — 注入安全：`readExpr`/`clickJs`/`typeJs` 生成的表达式对选择器/文本中的引号、反斜杠做 JSON 转义，不破坏表达式（含注入样本）

**真实外部依赖**：跑通业务需本机 Chrome/Edge 可执行文件 + 出网（目标页面）；测试不需要。

## 设计要点

- **固定调试端口 9222**：实测随机偏移端口在部分安全软件下**不监听**——宁可固定（并用 `webops_close` 保证释放），不要偏移。
- **单实例、显式生命周期**：`open` 时若已打开直接报错（不静默复用）；`close` 清理进程 + 临时 profile，不存在「幽灵实例」。
- **`stdio: 'ignore'`**：浏览器 stdout/stderr 与宿主管道解耦——宿主崩溃/管道背压不会波及浏览器，反之亦然。
- **React 兼容输入**：`webops_type` 用原生 setter + 派发 `input`/`change`，否则受控组件收不到值（直接改 `value` 会被 React 覆盖）。
- **表达式注入边界**：选择器/文本一律经 JSON 转义后拼进表达式（`tests/dom.test.mjs` 覆盖），避免引号破坏选择器语义。
- **`webops_eval` 是页面内完全控制**：只在受信目标上使用；它给的是「页面上下文里的任意 JS」，不是沙箱逃逸能力。

## 相关文档

| 文档 | 内容 |
|------|------|
| [`docs/semantic.md`](docs/semantic.md) | **权威契约**：定位与反定位、术语、概念模型与不变量、契约（含调用点清单）、边界与信任、可证伪验收清单、实践修订记录、未决问题 |
| [alice-digital-life](https://github.com/jonah791/alice-digital-life) | 本插件所属生态的中心索引（全部自研插件） |
| 技能 `ui-visual-verification` | 界面视觉与交互验收方法论（截图 + 四类断言，本插件的典型用法） |
| 技能 `anti-scraping-bypass` | 反爬通道选择与 headless 执行（页面抓不动时的诊断路径） |

## License

MIT © jonah791

---

本插件属于我的数字生命爱丽丝（[alice-digital-life](https://github.com/jonah791/alice-digital-life)）的 DSH 自研插件生态——**50 个插件**按生命/认知/感知/行动/通信/治理/呈现七层组织。
