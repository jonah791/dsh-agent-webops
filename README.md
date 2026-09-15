<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: 浏览器自主操作插件：host 管一个 CDP 会话——既能自己拉起 headless Chrome，也能**附着到已运行的外部 CDP 端点**（Tauri/WebView2、Electron），给 agent 打开/附着/读取/点击/输入/执行 JS/等待条件/读控制台/截图/断开 的完整自助工具面——GUI 验证与网页操作不打扰主人的真实浏览器
  inject: 'tools'
  tools: webops_open,webops_attach,webops_read,webops_click,webops_type,webops_eval,webops_wait,webops_console,webops_shot,webops_close
  runtime: host-only
  envDeps: 本机 Chrome/Edge 可执行文件（browserBin，仅 spawn 模式）；attach 模式需目标进程自行开调试端口 + 目标页面需出网
  boundary: spawn 用临时 user-data-dir 的隔离实例，不接触主人真实浏览器会话/凭据；attach 只连显式开了调试端口的进程，且 close 只断开、**绝不杀目标进程**；webops_eval 可执行任意页面内 JS（等同该页面上下文中的完全控制），仅对受信目标使用
  compat: cordis ^4.0.1 / dsh-tools ^0.1.0-rc.6
-->
# dsh-agent-webops — 浏览器自主操作插件

<p align="center">
  <a href="https://github.com/jonah791/dsh-agent-webops"><img src="https://img.shields.io/badge/version-0.2.0-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript">
  <img src="https://img.shields.io/badge/tests-31%20passed-brightgreen" alt="tests">
</p>

**一句话**：给 agent 一个**自己的** CDP 会话——打开页面、读文本、点按钮、填输入框、跑 JS、等条件、读控制台、截图，全流程自主，不借用主人的浏览器。

**两种模式**：
- **spawn**（`webops_open`）：自己拉起 headless 浏览器，临时 profile 隔离，`close` 清干净；
- **attach**（`webops_attach`）：附着到**已在运行**的外部 CDP 端点（Tauri/WebView2 窗口、Electron 应用、任何带 `--remote-debugging-port=N` 的进程）——**DOM 级驱动桌面应用界面**，且 `close` 只断开、绝不碰目标进程。

**为什么值得用**：验收不再「交还给用户」。改完前端/面板/桌面应用，agent 直接 `webops_shot` 看图判定，或 `webops_eval` 取几何/状态断言；attach 模式下**连截图都不需要窗口在前台**，也不必做 DPI/坐标换算。

## 能力

| 工具 | 用途 |
|------|------|
| `webops_open` | 拉起自主浏览器（headless）并导航到 URL——自主 GUI/网页操作的第一步。关闭旧实例需先 `webops_close` |
| `webops_attach` | **附着到已运行的外部 CDP 端点**（Tauri/WebView2、Electron、任何开调试端口的进程）；不启动进程，`close` 只断开、不杀目标 |
| `webops_read` | 读取当前页面文本（可选 CSS 选择器限定；缺省取 body 全文） |
| `webops_click` | 点击元素（按可见文本精确/包含匹配 `button`/`a`/`span` 等；返回 `CLICKED`/`NOT_FOUND`） |
| `webops_type` | 向输入框写文本（CSS 选择器定位；React 兼容——原生 setter + `input`/`change` 事件） |
| `webops_eval` | 执行任意 JS（`awaitPromise` 支持 async；返回值需 JSON 可序列化） |
| `webops_wait` | **服务端轮询等待页面里的 JS 条件成立**（按真值判断；页面异常与「条件为假」区分开）——替代盲等 sleep |
| `webops_console` | **读取页面控制台/异常/日志**（连接期间缓冲的最近条目）——白屏与 JS 报错的第一取证入口（程序化 F12） |
| `webops_shot` | 截图（PNG 存到 `shotDir`，返回路径——配合 `read_image` 查看；attach 模式下无需窗口在前台） |
| `webops_close` | spawn：关实例（进程 + 临时 profile 清理）；attach：**只断开连接**（目标进程不受影响） |

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
    attachPort: 9333       # attach 缺省端口；不要与 portMin(9222) 相同
```

**3a) 30 秒验证（spawn 模式）**：

```text
webops_open { url: "http://127.0.0.1:3080" }   → 期望 { ok: true }
webops_eval { expression: "location.href" }    → 期望返回该 URL 字符串
webops_close {}                                 → 期望 ok，进程与临时 profile 被清理
```

**3b) 30 秒验证（attach 模式，以 Tauri/WebView2 应用为例）**：

```text
# 目标进程必须**自己**带调试端口启动（Windows/WebView2 经环境变量）：
#   set "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333" && <app>.exe
webops_attach { port: 9333 }                   → 期望 { ok:true, title:"…", url:"…" }
webops_console { limit: 20 }                   → 期望看到页面真实控制台输出（白屏时先看这里）
webops_wait { expression: "document.querySelectorAll('.star').length >= 1" }
webops_shot {}                                 → 截图落盘；read_image 看图
webops_close {}                                → 只断开：目标进程仍然活着（这是设计，不是缺陷）
```

## 配置

| 项 | 默认 | 说明 |
|----|------|------|
| `browserBin` | `C:/Program Files/Google/Chrome/Application/chrome.exe` | 浏览器可执行文件（仅 spawn 模式用；用 Edge 则指向 `msedge.exe`） |
| `portMin` | `9222` | spawn 的 CDP 调试端口。**固定用 9222**：实测非默认端口可能被安全软件拦截导致不监听 |
| `shotDir` | `''` | 截图目录；空则用 `<DSH_HOME>/webops-shots`（`DSH_HOME` 也缺失时回落 `.`） |
| `attachPort` | `9333` | attach 的缺省端口（调用时可用 `port` 覆盖）。**必须与 `portMin` 不同**：同一端口两个 owner 会互相堵死 |

## 落盘与自证（出问题时先看这里）

**本插件无轨迹 JSONL**（无 `*-trace.jsonl`）——它的可观测面就是**浏览器自身的产物**：

| 产物 | 位置 | 含义 |
|------|------|------|
| 截图 PNG | `shotDir`（缺省 `<DSH_HOME>/webops-shots`） | `webops_shot` 落盘，文件名带时间戳（`screenshotFileName(nowMs)`） |
| 临时 profile | 系统 TEMP 下的新建目录（`profileDirFor(TEMP, Date.now())`） | 每次 `open` 新建，`close` 时清理（**attach 模式无此产物**） |
| 浏览器进程 | `spawn(browserBin, chromeArgs(...), { stdio: 'ignore' })` | 进程即实例；`webops_open` 时若实例已开则**报错**（不静默复用） |
| 控制台缓冲 | 内存（连接期间） | `webops_console` 读取；容量 200 条、单条 ≤1000 字符 |

**一条命令答五问**（用产物替代轨迹）：

```bash
ls -lt "$DSH_HOME/webops-shots" | head -3
# ① 跑的是哪个构建   → 无 build 戳；用 lib/index.js mtime + plugin_boot_status 判定（见下节）
# ② 谁发起           → 截图文件名的时间戳 ↔ 会话事件流里的工具调用时间对齐
# ③ 断在哪一段       → 工具返回值：open/attach/click 的 { ok:false, error } 直接给出失败原因（无阶段枚举；
#                      attach 失败文案已二分：「无端点」vs「有监听但无 page target」）
# ④ 结果质量         → read_image 打开最新 PNG 亲眼看；或 webops_read/eval/console 的返回内容
# ⑤ 耗时与预算       → wait 返回 waitedMs；open/attach 为轮询就绪后返回
```

行为级自证（推荐，比看文件更直接）：`webops_eval { expression: "document.title" }` → 标题正确 = 连接真的在跑且页面真的加载了。

## 生效判据与回退

**生效判据**（三选一，按可靠性排序）：
1. 行为级：`webops_open`/`webops_attach` 返回 `{ok:true}` 且 `webops_eval` 能取到页面状态 ⇒ 连接与 CDP 链路都通；
2. 进程级：spawn 模式下任务管理器/`Get-Process` 里能看到 headless 浏览器进程，命令行包含本次的临时 profile 目录；attach 模式下 `Get-NetTCPConnection -LocalPort <port> -State Listen` 命中目标进程；
3. 生态级：工具面出现 **10 个** `webops_*`，且 `plugin_boot_status`（`dsh-plugin-bootreport`）返回 `liveNow` 含本插件 ⇒ 当前进程跑的是当前构建。

> 注意：**重新构建 ≠ 生效**——产物 mtime 新只证明「构建过」，进程启动时间晚于产物 mtime 才算「在跑它」。
> 另注：**CDP 端口被占用 / 浏览器路径写错 / 目标进程没开调试端口**时连接会失败——这正是需要先跑 30 秒验证的原因。

**回退**（三档）：
- 源码级：`git -C self-plugins/dsh-agent-webops revert <commit>` → 重新构建 → 预检 → 重启（v0.2.0 的回退 = 失去 `webops_attach`，`webops_open` 行为不变）；
- 组合级：预设里给 `agent-webops` 行加 `disabled: true`（或移除该行）→ 哨兵重启；
- 运行期：spawn 模式 `webops_close` 关实例（异常残留时按进程名清理 headless 浏览器进程 + 删 TEMP 下临时 profile）；attach 模式 `webops_close` 只断开，**无需清理**。

## 测试

```bash
npm test        # = node --test "tests/*.test.mjs"
```

**31 例离线测试**（不需要浏览器、不需要网络）：
- `tests/pure.test.mjs` — 纯逻辑（21 例）：`resolveShotDir`、`profileDirFor`、`chromeArgs`（含 `--headless`/调试端口/临时 profile/顺序）、`cdpJsonUrl`、`cdpTargetOf`（坏响应不抛）、`screenshotFileName`、`isParseableExpression`；v0.2.0 新增 **`closePlan` 尸体测试**（attach 分支必须不杀进程）、`attachFailureMessage`（两态文案必须不同）、`consoleEntryOf`（三条事件归一 + 非控制台事件 null + 截断）、`appendConsole`（环形丢最旧、不原地改）、`waitExpr`/`waitDecision`（四态：ok/continue/timeout/error）
- `tests/dom.test.mjs` — 注入安全（10 例）：`readExpr`/`clickJs`/`typeJs` 生成的表达式对选择器/文本中的引号、反斜杠做 JSON 转义，不破坏表达式（含注入样本）

**真实外部依赖**：spawn 模式需本机 Chrome/Edge 可执行文件；attach 模式需目标进程自行开调试端口；两者都需目标页面可达。测试不需要。

## 设计要点

- **固定调试端口 9222（spawn）/ 独立缺省端口 9333（attach）**：实测随机偏移端口在部分安全软件下**不监听**——宁可固定；而两个用途**不得共用同一端口**（同一端口两个 owner 会互相堵死）。
- **attach 的安全不变量**：目标进程不是我启动的 ⇒ `close()` 只断 WebSocket（`closePlan(attached=true) = {killProc:false, rmProfile:false}`，有尸体测试）；这样「用 agent 驱动别人的应用」不会变成「agent 把别人的应用关了」。
- **单实例、显式生命周期**：已连接时再 `open`/`attach` 直接报错（不静默复用）；spawn 的 `close` 清理进程 + 临时 profile，不存在「幽灵实例」。
- **`stdio: 'ignore'`**：浏览器 stdout/stderr 与宿主管道解耦——宿主崩溃/管道背压不会波及浏览器，反之亦然。
- **React 兼容输入**：`webops_type` 用原生 setter + 派发 `input`/`change`，否则受控组件收不到值（直接改 `value` 会被 React 覆盖）。
- **表达式注入边界**：选择器/文本一律经 JSON 转义后拼进表达式（`tests/dom.test.mjs` 覆盖），避免引号破坏选择器语义。
- **等待与服务端轮询**：`webops_wait` 把「条件成立」的判断放在服务端（默认 5s / 250ms），页面内异常转成 `WAIT_ERR:` → `ok:false`，**不与「条件为假」混同**。
- **`webops_eval` 是页面内完全控制**：只在受信目标上使用；它给的是「页面上下文里的任意 JS」，不是沙箱逃逸能力。

## 相关文档

| 文档 | 内容 |
|------|------|
| [`docs/semantic.md`](docs/semantic.md) | **权威契约**：定位与反定位、术语、概念模型与不变量（含 I6「attach 绝不杀目标」）、契约（含调用点清单）、边界与信任、可证伪验收清单 A1–A20、实践修订记录、未决问题 |
| [alice-digital-life](https://github.com/jonah791/alice-digital-life) | 本插件所属生态的中心索引（全部自研插件） |
| 插件 `computer-use` | 像素级 GUI 驱动（原生窗口；与本文的 DOM 级驱动互补） |
| 技能 `ui-visual-verification` | 界面视觉与交互验收方法论（截图 + 四类断言，本插件的典型用法） |
| 技能 `anti-scraping-bypass` | 反爬通道选择与 headless 执行（页面抓不动时的诊断路径） |

## License

MIT © jonah791

---

本插件属于我的数字生命爱丽丝（[alice-digital-life](https://github.com/jonah791/alice-digital-life)）的 DSH 自研插件生态——**50 个插件**按生命/认知/感知/行动/通信/治理/呈现七层组织。
