# OpenCode 搜索供应商选择器

面向 **OpenCode 2.1.0** 的独立插件，提供 `/search` 单选弹窗，以及 DeepSeek 官方 Search API 供应商 **DSS**（ID：`dss`）。

## 使用

执行 `/search`，使用方向键选择 `random` 或搜索供应商。列表从 OpenCode 动态读取，也包含其他插件注册的搜索供应商。每项占一行，说明与名称同行显示，整行高亮使用当前主题的焦点配色，勾号标识已生效的项；右上角提示 `Esc` 关闭，底部显示方向键、保存默认和可用时的会话快捷键。

| 操作 | 行为 |
| --- | --- |
| `Enter` | 保存当前项目目录的默认选择，并清除当前会话的单独设置 |
| `s` | 所选具体供应商仅对当前会话生效 |
| `Esc` | 关闭弹窗，保留原设置 |

**首页、高亮 `random`、高亮未连接的 DSS 或搜索被禁用时，隐藏 `s`，也不注册该快捷键。** 首页操作不会创建空会话。`random` 仅能通过 Enter 保存为默认；搜索时继续使用 OpenCode 原生自动选择和限流切换策略。

没有搜索选择时默认 `random`。搜索状态来自 OpenCode 原生配置 API，包含全局、上级目录及当前目录的有效设置；也会读取其他插件最终设定的默认供应商或禁用状态，兼容插件先后加载的顺序。继承的禁用设置同样隐藏 `s`。已有显式供应商或禁用设置会保留，直到通过 Enter 保存新的默认。弹窗打开时高亮当前会话的单独选择，否则高亮项目默认；勾号标识已生效的项。

默认选择按项目目录保存，会话选择按 `sessionID` 保存，重开同一会话后仍有效。其他会话继续使用各自选择或项目默认；子会话不自动继承这个单独设置。

在会话中打开弹窗时，先重新读取该会话的实际目录；首页使用当前目录。服务端在保存前再次核对会话位置，若会话已移动则拒绝写入，重新打开 `/search` 后重试。

Enter 精确更新该目录配置中的 `websearch.provider`，保留注释、其他字段及插件选项。遵循原生优先级：`.opencode/opencode.json[c]` 高于直接放在目录中的 `opencode.json[c]`，同一位置的 JSONC 高于 JSON。继承上级 `.opencode` 搜索设置时，在当前目录创建 `.opencode/opencode.jsonc` 覆盖，不修改上级或全局配置；没有这类设置且本目录没有配置时创建 `opencode.jsonc`。写入前备份原文并检查并发修改，备份位于 `~/.local/state/opencode-websearch/backups/`，设置 `XDG_STATE_HOME` 时跟随该目录。

保存默认后刷新 OpenCode 服务，并重新读取有效搜索配置确认生效。若仍被更高优先级的系统设置等覆盖，会明确提示“已保存，但未生效”。搜索原来被禁用时，只有这次显式保存才会尝试启用。

`s` 的会话选择保存在插件存储中，不修改项目配置。卸载保留凭据及插件数据；如果项目默认设为 `dss`，卸载前先通过 Enter 改为 `random` 或其他仍可用的供应商。

## DSS

先在 `/connect` 中选择独立的 **DSS (DeepSeek Search)**，保存 DeepSeek 官方 API Key。DSS 只读取这个入口当前激活账号的 Key，切换 DSS 账号后下次请求读取新的凭据。DeepSeek 模型连接与 DSS 分别管理，修改或移除一方的连接不影响另一方。

从旧版升级后，需要在 DSS 入口单独连接一次；插件不会自动复制原有 DeepSeek 连接的凭据。API Key 仍由 OpenCode 连接管理保存，插件不使用配置中的密钥、环境变量凭据或独立 token 文件。

未连接时，DSS 仍显示在弹窗里，并标记“未连接”；它不加入原生搜索候选，避免自动选择到缺少凭据的 DSS。连接变化时会刷新，重新打开弹窗也会检查连接状态。

搜索请求发送到官方固定地址 `POST https://api.deepseek.com/v1/tools/search`，返回最多 10 条结果，优先使用长摘要，附带标题、链接和有效的发布时间。默认不额外获取网页正文。搜索词最多 128 个 Unicode 字符；默认选择和会话单独选择两条路径都会向模型返回明确的长度限制，由模型缩短后重试。每次请求最长等待 20 秒，支持取消。

工具保持为 `websearch`，结果保留原生结构化输出和供应商字段，供终端沿用 `Web Search via … "搜索词"` 的展示。会话单独设置仍检查原生 `websearch` 权限；没有单独设置的会话沿用原生工具，仅将带有 DSS 本地校验标记的输入错误转换为明确的重试提示。其他供应商保留各自的搜索词长度规则。

DSS 的 HTTP 429 转换为 OpenCode 能识别的 HTTP 限流错误，保留 `Retry-After`，由原生 `random` 处理切换。其他 HTTP 错误会报告失败，不转述可能含敏感信息的服务端错误正文。

接口、限制及计费见 [DeepSeek 官方搜索指南](https://api-docs.deepseek.com/zh-cn/guides/search/)和 [Search API Reference](https://api-docs.deepseek.com/zh-cn/api/search/)。

## 安装

通过本仓库安装器选择“搜索供应商选择 / DeepSeek Search”：

```powershell
npx github:nichem/opencode-plugins
```

也可将以下条目分别合并到 `opencode.json`（或 `opencode.jsonc`）以及 `cli.json` 的 `plugins` 数组，保留已有条目和选项：

```json
"git+https://github.com/nichem/opencode-plugins.git#main::path:opencode-websearch"
```

两个入口需要同时配置。服务端注册 DSS、管理选择并处理会话覆盖，终端入口提供 `/search` 弹窗。执行 `opencode reload` 并重新打开终端界面。分发文件为 JavaScript，安装时无需本地构建。

## 开发验证

```powershell
npm ci
npm run check
npm test
npm run check:host
```

原生渲染测试使用 Bun 运行 OpenTUI：

```powershell
npm run test:ui
```

用实际 OpenCode 2.1.0 验证插件加载、会话隔离、跨目录定位、`.opencode` 及继承配置优先级、全局禁用、原生结构化输出、权限拒绝、连接、持久化、限流切换，以及模型收到 DSS 长度提示后缩短查询并重试：

```powershell
npm run check:smoke -- 'C:\path\to\opencode.exe'
npm run check:smoke -- 'C:\path\to\opencode.exe' --reverse-order
```

两次隔离验证分别将搜索插件放在供应商插件之后和之前，检查最终默认值和禁用状态，同时检查 DSS 独立连接入口、账号切换与删除、以及和 DeepSeek 模型连接的隔离。测试目录位于本插件的 `node_modules` 下，避免 Windows 用户临时目录继承用户主目录中的项目配置。脚本仅使用临时配置、临时数据库、模拟模型和模拟搜索响应，不读取用户 agent 文档，也不调用真实 DeepSeek 接口或使用真实凭据。UI 测试会实际渲染列表并模拟方向键，检查首页与 `random` 上隐藏 `s`。
