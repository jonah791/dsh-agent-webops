# 语义文档：dsh-agent-webops（自主浏览器操作面）

> 版本 v0.2 · 2026-09-15 · 作者：爱丽丝 · 状态：**draft**
> 开发方式：语义文档优先（先写清「是什么/什么关系/怎么裁决」，再让实现逼近，最后用实践回修）
> 实现落点：`self-plugins/dsh-agent-webops/src/index.ts`（IO 接线，415 行）+ `src/pure.ts`（纯逻辑，210 行）；产物 `lib/index.js`（429 行）+ `lib/pure.js`（189 行）

| 项 | 值 |
|----|----|
| 能力名 | dsh-agent-webops（插件内 `name = 'agent-webops'`） |
| 主副本路径 | `self-plugins/dsh-agent-webops/docs/semantic.md` |
| 实现落点 | `self-plugins/dsh-agent-webops/src/index.ts` + `src/pure.ts` |
| 版本 | `package.json` = 0.2.0 |
| 组合行 | `E:\alice\.dsh\profiles\web\cordis.patch.yml` 行 93–98，`id: agent-agent-webops`，config = `browserBin: C:/Program Files/Google/Chrome/Application/chrome.exe` / `portMin: 9222`（**`attachPort` 未写进 patch ⇒ 用默认值 9333**） |
| 状态 | **draft**（实现已上线并挂载；本文 2026-09-14 补课，2026-09-15 随 attach 扩展回修） |

---

## 1 · 定位与反定位

**定位**：由 host 托管**一个** CDP 会话，给爱丽丝 **10 个工具**：开页/附着/读文/按文本点击/输入/执行 JS/等待/读控制台/截图/关闭——用来**自己验证 GUI 与网页行为**，不把验证交还给主人。

两种模式（v0.2.0 起）：
- **spawn 模式**（`webops_open`）：插件自己拉起一个 headless Chrome，临时 profile 隔离，`close` 时杀进程 + 删 profile；
- **attach 模式**（`webops_attach`）：附着到**已在运行**的外部 CDP 端点（Tauri/WebView2 窗口、Electron 应用、任何带 `--remote-debugging-port=N` 的进程）——**DOM 级驱动桌面应用界面**；不启动、不知晓目标进程 ⇒ `close` **只断开连接**。

**反定位（本文不管什么）**：
- 不管**主人的真实浏览器**：spawn 实例独立（临时 `--user-data-dir`），close 后连 profile 一起删；attach 只连**显式开了调试端口**的进程
- 不管**截图的理解**——读图属 `dsh-agent-vision` / 官方 `read_image`
- 不管**网页抓取正文**（反爬绕过、正文提取属 `dsh-search-pro` / `fetch_*` 族）
- **不是**无人值守爬虫：单实例、串行、无队列、无重试，`close` 即终结
- **不是**浏览器池/多标签管理器（一个插件周期内只有一个 page）
- **不是**桌面自动化的通用替代：驱动**非 CDP** 的原生窗口仍属 `computer-use`（像素级注入）——两者互补，不是替代

## 2 · 术语表

| 术语 | 含义 |
|------|------|
| CDP | Chrome DevTools Protocol；本插件经 `/json` 取 `webSocketDebuggerUrl` 后走 WebSocket |
| 单实例闸门 | `isOpen` = `ws !== null && !closed`；已开时 `open`/`attach` 直接返回错误 |
| 临时 profile | `%TEMP%/webops-profile-<Date.now()>`，close 后 2s 异步 `rmSync`（**仅 spawn 模式**） |
| `shotDir` | 截图落盘目录；`config.shotDir` 为空时 = `<DSH_HOME>/webops-shots` |
| CLICK_JS / TYPE_JS | 注入页面的纯 JS 表达式（不含 TS 语法），返回 `CLICKED`/`TYPED`/`NOT_FOUND` |
| **attach** | 附着到外部 CDP 端点；目标是**别人启动的**进程 ⇒ 生命周期只到「连接」为止 |
| **`attachPort`** | attach 的缺省端口（9333）；**不复用 9222**——那是本插件自己 Chrome 的端口，两个 owner 会互相堵死 |
| **控制台缓冲** | 连接期间由 `Runtime.consoleAPICalled` / `Runtime.exceptionThrown` / `Log.entryAdded` 事件累积的环形数组（容量 200，单条 ≤1000 字符） |
| **wait** | 服务端轮询页面谓词（默认 5s / 250ms 间隔，上限 60s），把「等条件成立」从调用方睡眠变成一次调用 |
| 生效判据 | 「当前 web 进程真的在跑这份构建」的进程级判据（见 §6） |

## 3 · 概念模型

```
爱丽丝 ── webops_open(url) ──► CdpPage.open()
   │                              ├─ 单实例闸门（已开 → 报错要求先 close）
   │                              ├─ spawn {browserBin} --headless --disable-gpu --no-first-run
   │                              │    --window-size=1440,900 --remote-debugging-port={portMin}
   │                              │    --user-data-dir=<TEMP/profile-<ts>> <url>
   │                              ├─ 轮询 http://127.0.0.1:{port}/json（80 × 500ms ≈ 40s 上限）
   │                              ├─ 连 WebSocket → Runtime.enable / Log.enable / Page.enable
   │                              └─ 就绪
   ├─ webops_attach(port?) ─────► CdpPage.attach()      ← v0.2.0
   │                              ├─ 单实例闸门（同上）
   │                              ├─ 轮询 http://127.0.0.1:{port}/json（10 × 300ms ≈ 3s，无冷启动预算）
   │                              ├─ 失败文案二分：无端点 / 有监听但无 page target
   │                              ├─ 连 WebSocket → 同上三域（控制台缓冲从此累积）
   │                              └─ 就绪（proc = null, profileDir = ''）
   ├─ webops_read(selector?)  → Runtime.evaluate(document.body.innerText | querySelector?.innerText)
   ├─ webops_click(text)      → Runtime.evaluate(CLICK_JS)   → CLICKED | NOT_FOUND
   ├─ webops_type(sel, text)  → Runtime.evaluate(TYPE_JS)    → TYPED   | NOT_FOUND
   ├─ webops_eval(js)         → Runtime.evaluate(awaitPromise, returnByValue)
   ├─ webops_wait(expr, …)    → Runtime.evaluate(waitExpr) 轮询 → ok | timeout | error   ← v0.2.0
   ├─ webops_console(limit?)  → 读环形缓冲（level + text）                                ← v0.2.0
   ├─ webops_shot()           → Page.captureScreenshot → 写 <shotDir>/shot-<ts>.png
   └─ webops_close()          → closePlan(attached)：
                                   spawn  → ws.close + proc.kill + taskkill /F /T /PID + 2s 后删 profile
                                   attach → **只 ws.close**（不杀目标、不删任何目录）
                                 （另：ctx.effect 卸载时自动 close —— 进程退出不留孤儿）
```

不变量（invariants）：
1. **I1 单实例**：任意时刻最多一个 CDP 连接；`isOpen` 为真时 `webops_open`/`webops_attach` **必须**返回 `ok:false`（一次测量：连续调两次，第二次必失败）。
2. **I2 未开即拒**：`read/click/type/eval/wait/console/shot` 在未连接时一律返回 `{ok:false, error:'实例未打开（先 webops_open，或 webops_attach 附着外部 CDP 端点）'}`（不隐式启动浏览器）。
3. **I3 spawn 端口固定**：spawn 调试端口恒为 `config.portMin`（默认/组合均为 9222），**不做随机偏移**——src 注释：随机端口实测不被安全软件放行监听。
4. **I4 spawn 隔离**：不读写主人真实浏览器 profile；`--user-data-dir` 指向 TEMP 新建目录。
5. **I5 CDP 调用有超时**：`send()` 每次 30s 上限，超时 reject 并清 pending，不悬挂。
6. **I6 attach 绝不杀目标（安全不变量）**：attach 模式下 `close()` 只断 WebSocket——`closePlan(true) = {killProc:false, rmProfile:false}`。**理由**：目标进程不是本插件启动的，杀它等于越权（真实事故形态：把主人的应用杀掉）。**含尸体测试**（`tests/pure.test.mjs`：attach 分支必须为 false/false）。
7. **I7 控制台缓冲有界**：容量 200 条、单条 ≤1000 字符、超容量丢最旧、非控制台事件一律返回 `null` 不入缓冲（否则一条事件流就能把缓冲灌满）。
8. **I8 wait 的三态分离**：「条件为假（continue）」≠「表达式异常（error）」≠「预算耗尽（timeout）」——页面内异常被包成 `WAIT_ERR:` 前缀字符串返回，**不得**与假值混同（否则「页面炸了」会被读成「还没就绪」）。
9. **I9 端口所有权**：`portMin`（9222，spawn 用）与 `attachPort`（9333，attach 用）**不得相同**——同一端口两个 owner 会互相堵死（对照 AGENTS.md §5.19）。
10. **I10 连接活性以 socket 为准**：`isOpen` 为真**必须**意味着「本进程正握着一条 OPEN 的 WebSocket」——即 `socketLive(ws.readyState, closed)`：未主动关闭 ∧ readyState=OPEN。**对端断开必须复位**（`onclose` 清引用 + 落闸门），否则闸门永远真、`open`/`attach` 被自己挡住。**理由**：目标进程不是本插件拉起的，它的生死只能从 socket 上读；把「曾经连过」当成「现在开着」= 用隐式状态做判定（对照 evolve 规则 2）。**含尸体测试** + 现场判据 A22。

## 4 · 契约

### 4.1 配置（`Config`）

| 字段 | 类型 | 默认 | 语义 |
|------|------|------|------|
| `browserBin` | string | `C:/Program Files/Google/Chrome/Application/chrome.exe` | 浏览器可执行文件绝对路径（仅 spawn 模式用） |
| `portMin` | number | `9222` | **固定**远程调试端口（非范围） |
| `shotDir` | string | `''` | 空 → 运行时解析为 `join(DSH_HOME \|\| '.', 'webops-shots')` |
| `attachPort` | number | `9333` | attach 的**缺省**端口（调用时可用 `port` 覆盖）；与 `portMin` 必须不同（I9） |

### 4.2 工具契约（10 个）

| 工具 | 入参 | 出参 | 语义 |
|------|------|------|------|
| `webops_open` | `url`(必填) | `{ok, error?}` | spawn + 导航；已开则拒 |
| `webops_attach` | `port?` | `{ok, port, url?, title?, error?}` | 附着外部 CDP 端点；回执含目标身份与「close 只断开」提示；失败文案二分 |
| `webops_read` | `selector?` | `{ok, text?, error?}` | 无 selector = `document.body.innerText`；渲染截断 6000 字符 |
| `webops_click` | `text`(必填) | `{ok, result?, error?}` | 可见文本匹配：精确 → 包含 → 叶子节点 textContent 精确 |
| `webops_type` | `selector`(必填)、`text`(必填) | `{ok, result?, error?}` | 原生 value setter + `input`/`change` 事件（React 兼容） |
| `webops_eval` | `expression`(必填) | `{ok, value?, error?}` | `awaitPromise: true, returnByValue: true`；value 为 `JSON.stringify` 后的字符串 |
| `webops_wait` | `expression`(必填)、`timeoutMs?`、`intervalMs?` | `{ok, waitedMs, error?}` | 服务端轮询谓词；默认 5000ms / 250ms；上限 60000ms；三态分离（I8） |
| `webops_console` | `limit?`、`clear?` | `{ok, count, entries, error?}` | 读控制台环形缓冲（level + text 逐行）；`clear` 读取后清空 |
| `webops_shot` | — | `{ok, path?, error?}` | PNG 落盘，返回绝对路径（attach 模式下**不需要窗口在前台**） |
| `webops_close` | — | `{ok, mode}` | spawn：杀进程 + 清 profile；attach：**只断开**（I6）；未开时也返回 `{ok:true}`（幂等） |

### 4.3 调用点清单 `[MUST]`

| 调用方 | 调用点（文件:符号） | 时机 |
|-------|------------------|------|
| web 组合 | `.dsh/profiles/web/cordis.patch.yml:94`（`id: agent-agent-webops`，config `browserBin`/`portMin`） | web 启动装载（**唯一挂载点**） |
| 插件自身 | `src/index.ts:apply()` → `ctx.tools.register` × **10**（open/attach/read/click/type/eval/wait/console/shot/close） | 装载时注册 |
| 插件自身 | `src/index.ts` 末尾 `ctx.effect(() => () => page.close())` | 插件卸载/进程退出 → **自动关浏览器**（attach 模式下为断开） |
| 依赖服务 | `src/index.ts:inject = ['tools']` | cordis 激活门 |
| **工作台（新消费方）** | `projects/self/alice-workbench/scripts/dev-cdp.ps1`（以 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333` 启动窗口）→ 爱丽丝 `webops_attach {port:9333}` | 工作台 GUI 的 DOM 级驱动与验收（2026-09-15 Round 3-a） |
| 技能（消费方） | `alice-self-assets/skills/dsh-panel-plugin/SKILL.md:35`（`webops_open` + `webops_eval` 查 DOM：`hasRefresh`/`cardCount`/`statsText`） | 面板/GUI 验收（§5.9 验证不交还用户） |
| 技能（消费方） | `skills/ui-visual-verification`（几何断言 / 真实副作用断言） | 界面验收方法论 |
| 宿主原语清单 | `AGENTS.md` §二·2.3「自主的工具链」列出 `webops_*` | 自主 GUI 验证 |
| 落盘产物 | `<shotDir>/shot-<Date.now()>.png`；`%TEMP%/webops-profile-<ts>` 临时目录（**仅 spawn**） | 截图时 / open 时 |
| 外部端口 | spawn：`http://127.0.0.1:9222/json` + `ws://…/devtools/page/<id>`；attach：同上但端口由调用方给定（工作台 = 9333） | 就绪探测 + 全部 CDP 调用 |
| 日志 | `ctx.logger('agent-webops')`：`'open <url>'`、`'attach <port> <url>'`、`'dsh-agent-webops 就绪（v0.2.0：spawn + attach 双模式）'` | 连接成功 / 装载（**不落盘**） |

## 5 · 边界与信任

- **能力边界 ≠ 沙箱**：`webops_eval` 在页面里执行**任意 JS**，`webops_type` 可向任意选择器写值——**没有域名白名单、没有动作审计**。它能做的事 = 被连接页面 + 进程权限的交集。它不是安全边界，**只用于自建/公开页面验证**。
- **attach 的边界更需明说**：附着对象是**已在运行的第三方进程**（Tauri/Electron 应用）。因此 ① 只连**显式开调试端口**的进程（没开端口 = 连不上，不是本插件去开）② `close` 只断开（I6）③ 驱动的是**界面**，不是进程本身——**不能**借 attach 去改目标进程的文件/配置/生命周期。
- 不越界清单：不接管主人真实浏览器（I4）、不做多标签/多实例、不处理登录凭据（无 cookie 注入工具面）、不重试、不后台常驻任务、不替目标进程做决策。
- 失败面：
  - 浏览器启动失败 → `{ok:false, error:'浏览器启动失败: …'}`（拒绝 + 报错）
  - CDP 未就绪（40s 内无 page target，含**9222 被别的进程占用**这一常见情形）→ 先 `close()` 再 `{ok:false, error:'CDP 未就绪（浏览器可能无法启动）'}`（拒绝 + 报错 + **自清理**）
  - **attach 失败二分（v0.2.0）**：`'端口 N 上没有 CDP 端点（目标进程未以 --remote-debugging-port=N 启动？）'` vs `'端口 N 有监听但取不到 page target（可能被非 CDP 进程占用）'`——**两类原因不得混同**（对照 §5.9 规则 1）
  - WS 连接失败 → `close()` 后返回错误串（拒绝 + 报错 + 自清理；attach 模式下 `close()` 无副作用）
  - CDP 单次调用超时 → reject `'CDP 超时: <method>'`（拒绝 + 报错）
  - 页面内表达式抛异常 → `Runtime.evaluate` 的 `exceptionDetails` → 返回 `{ok:false, error: description}`；**经 `webops_wait` 时**则转成 `WAIT_ERR:` → `error`（I8）
  - 畸形 CDP 消息 → **静默忽略**（等价「该消息不是我的响应」，由 pending 超时兜底，可接受但需登记）
  - `taskkill` / `rmSync` 失败 → **静默忽略**（清理由 I4 保证尽力而为，不阻塞主流程）
- 副作用边界：截图会**持续落盘**（无自动清理、无配额）→ 长期使用需人工或 `clyan_*` 清理（见 §10 U3）。

## 6 · 与既有机制的关系

- **AGENTS.md**：§5.9「验证不交还用户」的**执行器**——用 CDP 自证，而非请主人看屏；§2.3 把它列为自主工具链原语。
- **AGENTS.md §5.2**：不涉及 watch/守护进程，本插件无守护语义（**它不是保活对象**，浏览器实例按需起停）。
- **AGENTS.md §5.19（单点所有权）**：`portMin`(9222) 与 `attachPort`(9333) 端口分离就是这条纪律的落地——同一端口两个 owner 会互相堵死。
- **AGENTS.md §5.11（组合变更）**：改源码 = 组合变更，须重建 + 完整预检 + 哨兵重启。
- **与 `computer-use` 的关系**：像素级注入（原生窗口）↔ DOM 级驱动（CDP 可达窗口），互补而非替代；后者在 CDP 可达时精确得多（无需 DPI/坐标换算，且截图不需要窗口在前台）。
- **生效判据（改代码后怎么证明真的生效）**：
  1. 进程级：`self-plugins/dsh-agent-webops/lib/index.js` mtime 必须**早于** web 进程启动时间。本轮实测：lib = `2026-09-15 14:45:56`，web 启动 = `2026-09-15 14:47:16` → **已生效**。
  2. 工具面级：`webops_attach` 工具**存在且可调**（新构建专有）→ 已实测（14:49 调用成功）。
  3. 端口级：attach 成功后 `Get-NetTCPConnection -LocalPort <port> -State Listen` 命中目标进程（9333 → WebView2 子进程）；spawn 成功后 9222 命中 node/chrome。
  4. 端到端级：`webops_shot` 返回的 PNG 路径**真实存在且 mtime 为调用时刻**，且 `read_image` 能读出内容。
- **回退（出问题怎么退）**：
  1. 运行期：spawn 模式先 `webops_close`（清进程 + profile，避免僵尸 chrome 占住 9222）；attach 模式 `webops_close` 只断开，**不需要清理任何东西**。
  2. 组合级：`plugin_stop dsh-agent-webops`（patch `disabled` + 预检 + 哨兵重启）或删 patch 行 → 立即失去工具面，无残留。
  3. 代码级：`git -C E:/alice/self-plugins/dsh-agent-webops log --oneline` → `git revert <sha>`（v0.2.0 = `attach/wait/console`，回退后 `webops_attach` 消失、`webops_open` 行为不变）→ 重建 → 预检 → 哨兵重启。
  4. 配置级：`browserBin` 指错（例如机器没有 Chrome）→ 改回可用浏览器路径或 Edge 路径，走 `plugin_configure`。

## 7 · 可证伪验收清单

| # | 可证伪命题 | 证据（单测名/命令/日志行/HTTP） | 状态 |
|---|-----------|------------------------------|------|
| A1 | 工具面恰为 **10** 个 | 源码 `grep -c "name: 'webops_" src/index.ts` = 10；会话工具列表 `webops_` 前缀命中 10 | 已实测（2026-09-15，源码计数 10） |
| A2 | 单实例闸门有效（**活性感知**，I1+I10） | 连续两次 `webops_open`：第二次返回含 `实例已打开` + **模式与端口**（如 `实例已打开（spawned @ :9222）——先 webops_close`；文案 v0.2.1 起变更） | 已实测（2026-09-15 16:53，v0.2.2 实测回显 `实例已打开（spawned @ :9222）——先 webops_close`；v0.2.1 该文案曾把 `${}` 打成字面量，v0.2.2 修） |
| A3 | 未开即拒（I2） | 重启后未连接直接调 `webops_shot`/`webops_wait` → `'实例未打开（先 webops_open，或 webops_attach 附着外部 CDP 端点）'` | **待验收** |
| A4 | 截图真实落盘 | `webops_shot` 返回路径 `Test-Path` 为真且 mtime = 调用时刻 | 已实测（2026-09-15 14:49，`shot-1789454939398.png` 2041×1292 / 299 KB） |
| A5 | spawn 模式 close 后无残留 | close 后 `Get-Process chrome` 无该 PID；`%TEMP%\webops-profile-*` 2s 后消失；9222 不再 Listen | **待验收** |
| A6 | 当前进程加载最新构建 | lib mtime `2026-09-15 14:45:56` < web 启动 `2026-09-15 14:47:16` | 已实测（2026-09-15） |
| A7 | 挂载行唯一 | `grep -n "dsh-agent-webops" .dsh/profiles/web/cordis.patch.yml` → 1 命中（行 95） | 已实测（2026-09-14） |
| A8 | 浏览器实现与配置一致 | patch `browserBin` 指向 **Chrome**，而工具描述/README 称「headless Edge」→ 命题：**描述与实现不一致**（见 §8） | 已实测（不一致，登记为缺口） |
| A9 | 拉起参数正确且**顺序固定**（URL 在最后） | `npm test` → `chromeArgs` 3 条用例（含「不得回退 `--headless=new`」） | 已实测（2026-09-14，离线） |
| A10 | 注入网页的两段 JS 真能跑（点击匹配梯 / React 写值） | `npm test` → `tests/dom.test.mjs` 在假 DOM 里**真执行** `clickJs`/`typeJs` | 已实测（2026-09-14，10 例） |
| A11 | 注入安全：文本/选择器含引号、反斜杠、换行、`');` 不破坏表达式 | `npm test` → `clickJs/typeJs: 注入安全…` 断言照常 `CLICKED`/`TYPED` 且写入值逐字相同 | 已实测（2026-09-14） |
| A12 | CDP `/json` 坏响应不得抛（未就绪时可能是对象/HTML） | `npm test` → `cdpTargetOf` 5 条退化用例一律 `null` | 已实测（2026-09-14） |
| A13 | 失败/退化路径被机器锁住（S6 判据） | `npm test` → **32/32 pass**（pure 22 + dom 10） | 已实测（2026-09-15，v0.2.1） |
| A14 | attach 能附着外部端点并拿到目标身份 | `webops_attach {port:9333}` → `已附着 CDP:9333 「爱丽丝工作台」 http://localhost:1420/（close 只断开，不杀目标进程）` | 已实测（2026-09-15 14:49） |
| A15 | **attach 的 close 只断开、绝不杀目标进程**（I6 现场验收） | close 后：`alice-workbench` 仍存活（pid 4384，启动 14:48:37 未变）、9333 与 1420 仍 LISTEN、`/json` 仍返回 page target「爱丽丝工作台」、可再次 attach 成功 | 已实测（2026-09-15 14:52） |
| A16 | **closePlan 尸体测试**（attach 分支不得杀进程/删 profile） | `npm test` → `closePlan(true) = {killProc:false, rmProfile:false}` | 已实测（2026-09-15） |
| A17 | 控制台缓冲捕获真实条目 | `webops_console` → 4 条（`[debug] [vite] connecting…` / `connected` / React DevTools info / `[error] Failed to load resource: 404`） | 已实测（2026-09-15 14:49） |
| A18 | **DOM 级驱动产生真实状态变更**（起节点 → 停节点 → 收尸闭环） | 起：星数 5→6、HUD「节点 2 在线」、账本 `.workbench-spawned.json` 写入 `LAPTOP-BF4IAPLM-wb-0`/pid、心跳文件出现；停（**一次调用内双击确认**）：星数 6→5、HUD「节点 1 在线」、账本回到 `[]`、`nodes/LAPTOP-BF4IAPLM-wb-0.json` 已删、登记 pid 已终止 | 已实测（2026-09-15 14:49–14:51） |
| A19 | wait 三态分离（I8）+ 环形缓冲有界（I7） | `npm test` → `waitDecision` 四态用例（含 `WAIT_ERR:` 与 exception 透传、4999ms 不得提前判超时）；`appendConsole` 超容量丢最旧；`consoleEntryOf` 非控制台事件 `null` | 已实测（2026-09-15） |
| A20 | attach 失败文案二分（可诊断性） | `npm test` → `attachFailureMessage` 两态文案必须不同且含可照做的启动参数 | 已实测（2026-09-15） |
| A21 | **socket 死了不得再算「开着」**（I10 尸体测试） | `npm test` → `socketLive`：CLOSED(3) / CLOSING(2) / `null` / `undefined` 一律 `false`；OPEN(1)+未关闭 `true`；`close()` 落闸门后即便 readyState 仍是 1 也 `false` | 已实测（2026-09-15，pure 22/22） |
| A22 | 目标进程退出后 `open`/`attach` **必须放行**（v0.2.1 事故的现场判据） | 现场：目标窗口关闭后直接调 `webops_open` → **不得**再报「实例已打开」，应正常拉起；对照旧实现（2026-09-15 复现：必报错，须人工 `webops_close` 才恢复） | 已实测（2026-09-15 16:01：`taskkill /F /T` 杀掉监听 9222 的浏览器 → 复查 9222 无监听 → 再调 `webops_open` **成功拉起**） |

## 8 · 与实现的关系

- 主实现：`self-plugins/dsh-agent-webops/src/index.ts`（IO 接线：spawn / WebSocket / fetch / fs / 工具注册，**415 行**）+ `src/pure.ts`（纯逻辑，**210 行**——`chromeArgs` / `profileDirFor` / `resolveShotDir` / `cdpJsonUrl` / `cdpTargetOf` / `screenshotFileName` / `clickJs` / `typeJs` / `readExpr` / `isParseableExpression` / **`attachFailureMessage` / `closePlan` / `targetIdentity` / `consoleEntryOf` / `appendConsole` / `waitExpr` / `waitDecision`** + 常量 `CDP_MAX_ATTEMPTS=80` / `CDP_POLL_INTERVAL_MS=500` / `CDP_SEND_TIMEOUT_MS=30000` / **`ATTACH_MAX_ATTEMPTS=10` / `ATTACH_POLL_INTERVAL_MS=300` / `CONSOLE_BUFFER_CAP=200` / `CONSOLE_TEXT_MAX=1000`**）；两者无同语义副本。产物 `lib/index.js`（429 行）+ `lib/pure.js`（189 行）。测试：`tests/pure.test.mjs`（**21**）+ `tests/dom.test.mjs`（10）= **31**。
- 未实现/未验证部分**显式标注**：
  - **文案与实现漂移（已实测）**：`webops_open` 的 description 与 README 正文仍称「headless **Edge**」，而 `Config.browserBin` 默认值与 web 组合实际配置都指向 **Chrome**（`chrome.exe`）。程序行为以配置为准（Chrome）；本轮只登记**不改文案**（保持最小改动面）。
  - **`shotDir` 默认为空串**：组合行未配置 `shotDir` → 实际落盘位置由 `DSH_HOME` 决定（`E:\alice\.dsh\webops-shots`）。若 `DSH_HOME` 未设则落在 `.` 下——路径不显式，属可维护性缺口。
  - **控制台条目不含 url/stack**：`consoleEntryOf` 只留 `level + text` ⇒ 本轮那条 `404` 的**具体资源 URL 未捕获**（要从 `Log.entryAdded.params.entry.url` 取）。已登记为 U8。
  - **无真实鼠标事件注入**：驱动靠页面内 `el.click()` / 合成指针序列——对 React `onClick` 足够，但**不是**浏览器级真实输入（`Input.dispatchMouseEvent` 未接线）。已登记为 U7。
  - **A2/A3/A5 仍未验收**：spawn 路径（单实例闸门重复 open、未开即拒、close 后无残留）本次未逐条复跑——它们与 attach 路径共用 `connect()`/`close()`，但**共用不等于已验**。
  - 无自证侧车轨迹：只有宿主 `ctx.logger`（不落盘），五问中的「断在哪一段」只能靠调用返回值判读。

## 9 · 实践修订记录

- **2026-09-14 补课：本插件此前无语义文档（可维护性工程）**
  - 语义**被确认**：单实例 + 固定端口 9222 + 临时 profile 隔离 + 卸载自动 close；7 工具契约；§5.9「验证不交还用户」的执行器定位。
  - 语义**被补充**：截图落盘位置的真实解析规则（`DSH_HOME/webops-shots`）、失败面逐类归口（含 9222 被占用这一**最常见**失败原因）、消费方技能 `dsh-panel-plugin:35`。
  - 语义**被修正**：能力描述中的「headless Edge」与实际 Chrome 不符（登记为漂移，见 §8）。
  - 教训（同时回写技能 `semantic-doc-first`）：**文案漂移也要进「未实现/未验证部分」而不是悄悄改文案**——先记录，再另行裁决是否修实现或修文案。
- **2026-09-14 · 可维护性补课（S3 有测试 / S6 失败路径）：抽纯逻辑层 + 21 例回归（含把注入 JS 当代码跑）**
  - **抽层（行为不变的搬家）**：新增 `src/pure.ts` —— `chromeArgs` / `profileDirFor` / `resolveShotDir` / `cdpTargetOf` / `cdpJsonUrl` / `screenshotFileName` / `clickJs` / `typeJs` / `readExpr` / 常量 `CDP_MAX_ATTEMPTS=80`、`CDP_POLL_INTERVAL_MS=500`、`CDP_SEND_TIMEOUT_MS=30000`（原为散落字面量）。`index.ts` 只留 spawn / WebSocket / fetch / fs。
  - **语义被确认**：`--headless` 必须用**旧写法**（Chrome 132+ 移除 `--headless=new`，实测 151 不识别 → 调试端口不监听 → CDP 永远不就绪）；URL 必须在参数**最后**；点击三级匹配梯；`typeJs` 必须走原生 setter + input/change。以上全部升级为**机器断言**。
  - **语义被补充（新不变量 ①·注入安全）**：注入页面的 JS 必须对**一切**外来文本用 `JSON.stringify` 转义——文本含 `'`、`"`、`\`、换行乃至 `'); alert(1); //` 时表达式不得被破坏。
  - **语义被补充（新不变量 ②·坏响应不抛）**：`/json` 在浏览器未就绪时可能返回对象/HTML，`cdpTargetOf` 必须返回 `null` 让轮询继续，**不得抛**。
  - **行为变更：无**（参数数组、目录解析、目标挑选、表达式文本、超时数值全部一致）。**方法学收获**：注入型 JS 可以**离线真跑**——搭一个最小假 DOM（`document`/`window`/`Event` 三个全局）就能把只在真页面才暴露的分支变成秒级回归。
- **2026-09-15 · v0.2.1 修 I10：socket 死掉不再算「实例已打开」（欠账 #3 现场复现）**
  - **触发（先复现，再改）**：给数字身份做注册前勘测时，目标窗口早已关闭，`webops_open` 却报 `实例已打开（先 webops_close）`——**这正是 v0.2.0 遗留的欠账 #3 现场**，不是猜测。
  - **根因**：`connect()` **从未挂 `onclose`** ⇒ 目标进程退出时 WebSocket 静默断开，而 `ws` 引用与 `closed` 闸门都不复位 ⇒ `isOpen` 恒真。**症状（插件坏了）与根因（一处没挂 onclose）相距很远**——`isOpen` 是「曾经连过」而非「现在连着」，等于拿隐式状态做判定（对照 evolve 规则 2）。
  - **修法（三处，全部可离线测）**：① `pure.ts` 新增 `socketLive(readyState, closed)`（未主动关闭 ∧ readyState=OPEN）；② `index.ts` 的 `isOpen` 改用它；③ `connect()` 挂 `onclose` 并按 **socket 身份**复位（`this.ws !== sock` 即早退——旧 socket 的迟到事件不得踩新连接）。
  - **语义被补充（新不变量 I10）**：连接活性以 socket 为准 + 对端断开必须复位。
  - **语义被补充（可诊断性）**：拒绝文案补上**模式与端口**（`实例已打开（spawned @ :9222）——先 webops_close`）——排障时不必再猜「开着的到底是谁」。
  - **验收证据**：A21 已实测（pure 21→22、全量 31→32 通过）；A22 待线上验收（需重启生效）。A2 文案同步更新（**声明与实现对账**：旧命题写的是旧文案）。
  - **方法学收获**：**欠账要带现场判据才能被验收**——「知道有 bug」不等于「能判定它修好了」；A22 就是为本条欠账补的可证伪现场判据。另：给目标进程做「活着吗」的判定，**唯一可靠来源是连接本身**，别信自己上次记的状态。
- **2026-09-15 · v0.2.0 attach 扩展（由爱丽丝工作台 Round 3-a 驱动）**
  - **动机（实践先于文档）**：给工作台（Tauri/WebView2）做 Round 3-a「DOM 级控制」时，实测 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333` **零代码**即可让 WebView2 暴露 CDP（`/json/version` → `Edg/149.0.4022.80`）。既然通道已在，**复用本插件已有 CDP 客户端**比新造插件更合「组合优先」——本次因此**没有**新建插件。
  - **语义被补充（能力面）**：新增 **attach 模式**——外部端点（别人启动的进程）也纳入工具面；三条边界随之显式化：不 spawn、**close 只断开（I6）**、只驱动界面不改进程。
  - **语义被补充（端口所有权）**：新增 I9 与 `attachPort=9333`——**不复用 9222**（9222 是本插件自己 Chrome 的端口；两个 owner 抢一个端口会让彼此都失效）。
  - **语义被补充（可诊断性）**：attach 失败文案**二分**（无端点 / 有监听但无 page target），对应 §5.9 规则 1「错误文案不得让两类原因混同」。
  - **语义被补充（两个新工具面）**：`webops_wait`（服务端谓词轮询，I8 三态分离）与 `webops_console`（Runtime/Log 事件环形缓冲，I7 有界）——把「盲等 sleep」和「白屏只能开 F12 看」两件事收进工具面。
  - **语义被修正（顺带抓到的真缺陷）**：`close()` 只置 `closed = true` 而 `open()` **不复位**它 ⇒ `isOpen` 恒假 ⇒ **close 之后再 open 会永久「未打开」**（A2/A5 从未覆盖 reopen 路径）。修法：`open()`/`attach()` 入口复位 `closed=false`。
  - **验收证据**：A14–A20 全部实测（见 §7），关键一条是 **A15（attach 的 close 不杀目标）**——单元测试（A16）+ 现场验收（A15）双证。
  - **方法学收获（写回技能 `ui-visual-verification`）**：**几何重叠断言必须先排除父子包含关系**——首版检查把「父元素矩形覆盖子元素」当成重叠，一次报出 26 处假阳性；排除 `contains` 后为 0。同理，「看起来重叠」不等于重叠：判据错了，结论必然错。
  - **未闭环项**：A2/A3/A5 待验收（spawn 路径未逐条复跑）；U7/U8 见 §10。

## 10 · 未决问题

- **U1 Edge/Chrome 表述归一**：修文案（README/description 改 Chrome）还是修配置（改回 Edge 路径）？倾向修文案——Chrome 实机已验证可用。需主人/实现者裁决。
- **U2 端口硬编码 9222 的代价**：固定端口换来「能被安全软件放行」，代价是**同机第二个实例/遗留 chrome 会互相堵死**。**2026-09-15 部分闭环**：attach 路径已有二分文案（A20）；spawn 路径的就绪失败仍未区分「被占用」与「启动失败」——倾向：就绪失败时探测 9222 占用者并把占用者写进 error。
- **U3 截图目录无清理策略**：长期运行会累积（本机 `E:\alice\.dsh\webops-shots`）。倾向：由 `clyan_*` 清扫而非插件自建清理，但需在 README 写明。
- **U4 `chromeArgs` 的窗口尺寸硬编码 1440×900**：截图分辨率即视口尺寸——需要其它分辨率时只能改代码。是否把 `windowSize` 提为配置项待定调。
- **U5 `webops_open` 的目标页等待策略缺失**：`open` 在 CDP 就绪后立即返回，页面可能仍在加载。**2026-09-15 部分闭环**：新增 `webops_wait` 让调用方等谓词（如 `document.readyState === 'complete'`）——但 `open` 自身仍未内建等待，待定调是否加可选 `waitUntil`。
- **U6 注入表达式的 `NOT_FOUND` 与「真错误」未区分**：`webops_click` 返回 `{ok:true, result:'NOT_FOUND'}`（ok 为真）——调用方需读 result 才知道失败。是否改为 `ok:false` 待定调（属行为变更，会影响既有调用方判读）。
- **U7（新，2026-09-15）缺少浏览器级真实输入**：现有驱动是页面内 `el.click()` 与合成指针序列——对 React 足够，但**绕过**了浏览器的命中测试（hit-testing）与真实事件链；hover 依赖型 UI 无法驱动。倾向：新增 `webops_tap {x, y}`（`Input.dispatchMouseEvent` 组合），坐标由调用方用 `getBoundingClientRect()` 提供（DOM 坐标系，无需 DPI 换算）。待定调。
- **U8（新，2026-09-15）控制台条目缺 `url`/`stack`**：`consoleEntryOf` 只留 `level + text`，本次一条 `404` 因此**无法定位具体资源**。倾向：`Log.entryAdded` 追加 `entry.url`，`exceptionThrown` 追加首个 stack 帧。待定调（属输出格式变更）。
