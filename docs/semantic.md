# 语义文档：dsh-agent-webops（自主浏览器操作面）

> 版本 v0.1 · 2026-09-14 · 作者：爱丽丝 · 状态：**draft**
> 开发方式：语义文档优先（先写清「是什么/什么关系/怎么裁决」，再让实现逼近，最后用实践回修）
> 实现落点：`self-plugins/dsh-agent-webops/src/index.ts`（唯一源文件，276 行；构建产物 `lib/index.js`）

| 项 | 值 |
|----|----|
| 能力名 | dsh-agent-webops（插件内 `name = 'agent-webops'`） |
| 主副本路径 | `self-plugins/dsh-agent-webops/docs/semantic.md` |
| 实现落点 | `self-plugins/dsh-agent-webops/src/index.ts` |
| 版本 | `package.json` = 0.1.0 |
| 组合行 | `E:\alice\.dsh\profiles\web\cordis.patch.yml` 行 93–98，`id: agent-agent-webops`，config = `browserBin: C:/Program Files/Google/Chrome/Application/chrome.exe` / `portMin: 9222` |
| 状态 | **draft**（实现已上线并挂载；本文为 2026-09-14 补课产物） |

---

## 1 · 定位与反定位

**定位**：由 host 托管**一个** headless 浏览器实例（CDP over WebSocket），给爱丽丝 7 个工具：开页/读文/按文本点击/输入/执行 JS/截图/关闭——用来**自己验证 GUI 与网页行为**，不把验证交还给主人。

**反定位（本文不管什么）**：
- 不管**主人的真实浏览器**：实例独立（临时 `--user-data-dir`），close 后连 profile 一起删
- 不管**截图的理解**——读图属 `dsh-agent-vision` / 官方 `read_image`
- 不管**网页抓取正文**（反爬绕过、正文提取属 `dsh-search-pro` / `fetch_*` 族）
- **不是**无人值守爬虫：单实例、串行、无队列、无重试，`close` 即终结
- **不是**浏览器池/多标签管理器（一个插件周期内只有一个 page）

## 2 · 术语表

| 术语 | 含义 |
|------|------|
| CDP | Chrome DevTools Protocol；本插件经 `/json` 取 `webSocketDebuggerUrl` 后走 WebSocket |
| 单实例闸门 | `isOpen` = `ws !== null && !closed`；已开时 `open` 直接返回错误 |
| 临时 profile | `%TEMP%/webops-profile-<Date.now()>`，close 后 2s 异步 `rmSync` |
| `shotDir` | 截图落盘目录；`config.shotDir` 为空时 = `<DSH_HOME>/webops-shots` |
| CLICK_JS / TYPE_JS | 注入页面的纯 JS 表达式（不含 TS 语法），返回 `CLICKED`/`TYPED`/`NOT_FOUND` |
| 生效判据 | 「当前 web 进程真的在跑这份构建」的进程级判据（见 §6） |

## 3 · 概念模型

```
爱丽丝 ── webops_open(url) ──► CdpPage.open()
   │                              ├─ 单实例闸门（已开 → 报错要求先 close）
   │                              ├─ spawn {browserBin} --headless --disable-gpu --no-first-run
   │                              │    --window-size=1440,900 --remote-debugging-port={portMin}
   │                              │    --user-data-dir=<TEMP/profile-<ts>> <url>
   │                              ├─ 轮询 http://127.0.0.1:{port}/json（80 × 500ms ≈ 40s 上限）
   │                              ├─ 连 WebSocket → Runtime.enable / Page.enable
   │                              └─ 就绪
   ├─ webops_read(selector?)  → Runtime.evaluate(document.body.innerText | querySelector?.innerText)
   ├─ webops_click(text)      → Runtime.evaluate(CLICK_JS)   → CLICKED | NOT_FOUND
   ├─ webops_type(sel, text)  → Runtime.evaluate(TYPE_JS)    → TYPED   | NOT_FOUND
   ├─ webops_eval(js)         → Runtime.evaluate(awaitPromise, returnByValue)
   ├─ webops_shot()           → Page.captureScreenshot → 写 <shotDir>/shot-<ts>.png
   └─ webops_close()          → ws.close + proc.kill + taskkill /F /T /PID + 2s 后删 profile
                                 （另：ctx.effect 卸载时自动 close —— 进程退出不留孤儿）
```

不变量（invariants）：
1. **I1 单实例**：任意时刻最多一个 CDP 连接；`isOpen` 为真时 `webops_open` **必须**返回 `ok:false`（一次测量：连续调两次 open，第二次必失败）。
2. **I2 未开即拒**：`read/click/type/eval/shot` 在未 open 时一律返回 `{ok:false, error:'浏览器未打开（先 webops_open）'}`（不隐式启动浏览器）。
3. **I3 端口固定**：调试端口恒为 `config.portMin`（默认/组合均为 9222），**不做随机偏移**——src 注释：随机端口实测不被安全软件放行监听。
4. **I4 隔离**：不读写主人真实浏览器 profile；`--user-data-dir` 指向 TEMP 新建目录。
5. **I5 CDP 调用有超时**：`send()` 每次 30s 上限，超时 reject 并清 pending，不悬挂（`src/index.ts:110`）。

## 4 · 契约

### 4.1 配置（`Config`）

| 字段 | 类型 | 默认 | 语义 |
|------|------|------|------|
| `browserBin` | string | `C:/Program Files/Google/Chrome/Application/chrome.exe` | 浏览器可执行文件绝对路径 |
| `portMin` | number | `9222` | **固定**远程调试端口（非范围） |
| `shotDir` | string | `''` | 空 → 运行时解析为 `join(DSH_HOME \|\| '.', 'webops-shots')` |

### 4.2 工具契约（7 个）

| 工具 | 入参 | 出参 | 语义 |
|------|------|------|------|
| `webops_open` | `url`(必填) | `{ok, error?}` | 启动 + 导航；已开则拒 |
| `webops_read` | `selector?` | `{ok, text?, error?}` | 无 selector = `document.body.innerText`；渲染截断 6000 字符 |
| `webops_click` | `text`(必填) | `{ok, result?, error?}` | 可见文本匹配：精确 → 包含 → 叶子节点 textContent 精确 |
| `webops_type` | `selector`(必填)、`text`(必填) | `{ok, result?, error?}` | 原生 value setter + `input`/`change` 事件（React 兼容） |
| `webops_eval` | `expression`(必填) | `{ok, value?, error?}` | `awaitPromise: true, returnByValue: true`；value 为 `JSON.stringify` 后的字符串 |
| `webops_shot` | — | `{ok, path?, error?}` | PNG 落盘，返回绝对路径 |
| `webops_close` | — | `{ok, error?}` | 关闭 + 清理；未开时也返回 `{ok:true}`（幂等） |

### 4.3 调用点清单 `[MUST]`

| 调用方 | 调用点（文件:符号） | 时机 |
|-------|------------------|------|
| web 组合 | `.dsh/profiles/web/cordis.patch.yml:94`（`id: agent-agent-webops`，config `browserBin`/`portMin`） | web 启动装载（**唯一挂载点**） |
| 插件自身 | `src/index.ts:apply()` → `ctx.tools.register` × 7（`webops_open`/`read`/`click`/`type`/`eval`/`shot`/`close`） | 装载时注册 |
| 插件自身 | `src/index.ts:274` `ctx.effect(() => () => page.close())` | 插件卸载/进程退出 → **自动关浏览器** |
| 依赖服务 | `src/index.ts:inject = ['tools']` | cordis 激活门 |
| 技能（消费方） | `alice-self-assets/skills/dsh-panel-plugin/SKILL.md:35`（`webops_open` + `webops_eval` 查 DOM：`hasRefresh`/`cardCount`/`statsText`） | 面板/GUI 验收（§5.9 验证不交还用户） |
| 宿主原语清单 | `AGENTS.md` §二·2.3「自主的工具链」列出 `webops_*` | 自主 GUI 验证 |
| 落盘产物 | `<shotDir>/shot-<Date.now()>.png`（`src/index.ts:134`）；`%TEMP%/webops-profile-<ts>` 临时目录 | 截图时 / open 时 |
| 外部端口 | `http://127.0.0.1:9222/json`（HTTP）与 `ws://127.0.0.1:9222/devtools/page/<id>` | open 就绪探测 + 全部 CDP 调用 |
| 日志 | `ctx.logger('agent-webops')`：`'open <url>'`、`'dsh-agent-webops 就绪'` | open 成功 / 装载（**不落盘**） |

## 5 · 边界与信任

- **能力边界 ≠ 沙箱**：`webops_eval` 在页面里执行**任意 JS**，`webops_type` 可向任意选择器写值——**没有域名白名单、没有动作审计**。它能做的事 = 被打开页面 + 进程权限的交集。它不是安全边界，**只用于自建/公开页面验证**。
- 不越界清单：不接管主人真实浏览器（I4）、不做多标签/多实例、不处理登录凭据（无 cookie 注入工具面）、不重试、不后台常驻任务。
- 失败面：
  - 浏览器启动失败 → `{ok:false, error:'浏览器启动失败: …'}`（拒绝 + 报错）
  - CDP 未就绪（40s 内无 page target，含**9222 被别的进程占用**这一常见情形）→ 先 `close()` 再 `{ok:false, error:'CDP 未就绪（浏览器可能无法启动）'}`（拒绝 + 报错 + **自清理**）
  - WS 连接失败 → `close()` 后返回错误串（拒绝 + 报错 + 自清理）
  - CDP 单次调用超时 → reject `'CDP 超时: <method>'`（拒绝 + 报错）
  - 页面内表达式抛异常 → `Runtime.evaluate` 的 `exceptionDetails` → 返回 `{ok:false, error: description}`（拒绝 + 报错）
  - 畸形 CDP 消息 → **静默忽略**（`catch { /* 忽略畸形消息 */ }`，`src/index.ts:91`）——等价「该消息不是我的响应」，由 pending 超时兜底，可接受但需登记。
  - `taskkill` / `rmSync` 失败 → **静默忽略**（清理由 I4 保证尽力而为，不阻塞主流程）。
- 副作用边界：截图会**持续落盘**（无自动清理、无配额）→ 长期使用需人工或 `clyan_*` 清理（见 §10 U3）。

## 6 · 与既有机制的关系

- **AGENTS.md**：§5.9「验证不交还用户」的**执行器**——用 headless 浏览器自证，而非请主人看屏；§2.3 把它列为自主工具链原语。
- **AGENTS.md §5.2**：不涉及 watch/守护进程，本插件无守护语义（**它不是保活对象**，浏览器实例按需起停）。
- **组合变更纪律（§5.11）**：改源码 = 组合变更，须重建 + 完整预检 + 哨兵重启。
- **生效判据（改代码后怎么证明真的生效）**：
  1. 进程级：`self-plugins/dsh-agent-webops/lib/index.js` mtime 必须**早于** 3080 监听进程启动时间。本轮实测：lib = `2026-09-06 17:37:24`，web（PID 7080）启动 = `2026-09-14 10:05:47` → **已生效**。
  2. 产物级：调 `webops_open` 打开 `http://127.0.0.1:3080` → `webops_shot` 返回的 PNG 路径**真实存在且 mtime 为调用时刻**，且 `read_image` 能读出内容（端到端自证）。
  3. 端口级：open 成功后 `Get-NetTCPConnection -LocalPort 9222 -State Listen` 命中 node/chrome 进程。
- **回退（出问题怎么退）**：
  1. 运行期先 `webops_close`（清进程 + profile），避免僵尸 chrome 占住 9222 把后续 open 全堵死。
  2. 组合级：`plugin_stop dsh-agent-webops`（patch `disabled` + 预检 + 哨兵重启）或删 patch 行 → 立即失去工具面，无残留。
  3. 代码级：`git -C E:/alice/self-plugins/dsh-agent-webops log --oneline` → `git revert <sha>` → `pnpm build` → 预检 → 哨兵重启。
  4. 配置级：`browserBin` 指错（例如机器没有 Chrome）→ 改回可用浏览器路径或 Edge 路径，走 `plugin_configure`。

## 7 · 可证伪验收清单

| # | 可证伪命题 | 证据（单测名/命令/日志行/HTTP） | 状态 |
|---|-----------|------------------------------|------|
| A1 | 工具面恰为 7 个 | 会话工具列表 `webops_` 前缀命中 7；源码 `ctx.tools.register` 计数 = 7 | 已实测（源码计数） |
| A2 | 单实例闸门有效 | 连续两次 `webops_open`：第二次返回 `'实例已打开（先 webops_close）'` | **待验收** |
| A3 | 未开即拒（I2） | 重启后未 open 直接调 `webops_shot` → `'浏览器未打开（先 webops_open）'` | **待验收** |
| A4 | 截图真实落盘 | `webops_shot` 返回路径 `Test-Path` 为真且 mtime = 调用时刻 | **待验收** |
| A5 | close 后无残留 | close 后 `Get-Process chrome` 无该 PID；`%TEMP%\webops-profile-*` 2s 后消失；9222 不再 Listen | **待验收** |
| A6 | 当前进程加载最新构建 | lib mtime `2026-09-06 17:37:24` < web PID 7080 启动 `2026-09-14 10:05:47` | 已实测（2026-09-14 读数） |
| A7 | 挂载行唯一 | `grep -n "dsh-agent-webops" .dsh/profiles/web/cordis.patch.yml` → 1 命中（行 95） | 已实测 |
| A8 | 浏览器实现与配置一致 | patch `browserBin` 指向 **Chrome**，而工具描述/README 称「headless Edge」→ 命题：**描述与实现不一致**（见 §8） | 已实测（不一致，登记为缺口） |

## 8 · 与实现的关系

- 主实现：`self-plugins/dsh-agent-webops/src/index.ts`（唯一文件，无同语义副本）。
- 未实现/未验证部分**显式标注**：
  - **文案与实现漂移（已实测）**：`webops_open` 的 description、`package.json` description、`README.md` 正文均称「headless **Edge**」，而 `Config.browserBin` 默认值与 web 组合实际配置都指向 **Chrome**（`chrome.exe`）。程序行为以配置为准（Chrome）；文案属漂移，本文件只登记**不改源码/README**（守补课纪律）。
  - **`shotDir` 默认为空串**：组合行未配置 `shotDir` → 实际落盘位置由 `DSH_HOME` 决定（`E:\alice\.dsh\webops-shots`）。若 `DSH_HOME` 未设则落在 `.` 下（相对进程 cwd）——路径不显式，属可维护性缺口。
  - 无单测文件（仓库内无 `tests/`），A2–A5 无自动化证据。
  - 无自证侧车轨迹：只有宿主 `ctx.logger`（不落盘），五问中的「断在哪一段」只能靠调用返回值判读。

## 9 · 实践修订记录

- **2026-09-14 补课：本插件此前无语义文档（可维护性工程）**
  - 语义**被确认**：单实例 + 固定端口 9222 + 临时 profile 隔离 + 卸载自动 close；7 工具契约；§5.9「验证不交还用户」的执行器定位。
  - 语义**被补充**：截图落盘位置的真实解析规则（`DSH_HOME/webops-shots`）、失败面逐类归口（含 9222 被占用这一**最常见**失败原因）、消费方技能 `dsh-panel-plugin:35`。
  - 语义**被修正**：能力描述中的「headless Edge」与实际 Chrome 不符（登记为漂移，见 §8）。
  - 教训（同时回写技能 `semantic-doc-first`）：**文案漂移也要进「未实现/未验证部分」而不是悄悄改文案**——先记录，再另行裁决是否修实现或修文案。

## 10 · 未决问题

- **U1 Edge/Chrome 表述归一**：修文案（README/description 改 Chrome）还是修配置（改回 Edge 路径）？倾向修文案——Chrome 实机已验证可用。需主人/实现者裁决。
- **U2 端口硬编码 9222 的代价**：固定端口换来「能被安全软件放行」，代价是**同机第二个实例/遗留 chrome 会互相堵死**（表现为 `CDP 未就绪`，报错未区分「被占用」与「启动失败」）。倾向：就绪失败时探测 9222 占用者并把占用者写进 error，提高可诊断性（§5.22 五问）。
- **U3 截图目录无清理策略**：长期运行会累积。倾向：由 `clyan_*` 清扫而非插件自建清理（保持职责单一），但需在 README 写明。
