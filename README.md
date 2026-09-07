<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: 浏览器自主操作插件：爱丽丝经 headless Edge (CDP) 自主打开页面/点击/输入/读取/截图——GUI 验证与网页操作全自主，不依赖主人手动操作。
  inject: 'tools'
  tools: webops_*
  runtime: host-only
  envDeps: Chrome/Edge 浏览器（可配置 browserBin）
  boundary: 无特殊授权边界
  compat: cordis ^4.0.1 / dsh-tools ^0.1.0-rc.6
-->
# dsh-agent-webops — 浏览器自主操作插件


<p align="center">
  <a href="https://github.com/jonah791/dsh-agent-webops"><img src="https://img.shields.io/badge/version-0.1.0-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript">
</p>
DSH（DeepSeek Harness）插件：host 管理一个 headless Edge 实例（CDP），给 agent 完整的自主网页操作工具面——打开页面、读取内容、点击、输入、截图、执行 JS——GUI 验证与网页操作全自主，不打扰主人的真实浏览器。

## 功能特性

- **独立浏览器实例**：headless Edge + 临时 user-data-dir，close 后彻底清理
- **完整操作面**：open / read / click / type / eval / shot / close
- **React 兼容输入**：原生 setter + input/change 事件，兼容现代前端框架

## 安装

```bash
cd <你的 self-plugins 目录>
git clone https://github.com/jonah791/dsh-agent-webops.git
cd dsh-agent-webops
pnpm install
pnpm build
```

## 使用

| 工具 | 说明 |
|------|------|
| `webops_open` | 启动浏览器并导航到 URL |
| `webops_read` | 读取页面文本（可选 CSS 选择器） |
| `webops_click` | 按可见文本点击元素 |
| `webops_type` | 向输入框输入文本 |
| `webops_eval` | 执行任意 JS（返回值需可序列化） |
| `webops_shot` | 页面截图（PNG，供 agent 查看） |
| `webops_close` | 关闭实例并清理临时 profile |

## 技术要点

- 实例隔离：不接触主人真实浏览器，无凭据泄露风险
- 截图落地到 shotDir，配合图片读取实现「看到页面」

## 相关

- [我的数字生命爱丽丝 — 插件生态中心（架构总览）](https://github.com/jonah791/alice-digital-life)

## License

MIT
