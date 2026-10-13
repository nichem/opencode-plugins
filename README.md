# OpenCode Plugins

个人维护的 **OpenCode 2.x 插件集合**：连接模型供应商、加载预设 agent、管理持续执行的目标，以及逐条删除末尾 AI 消息。

目前针对 **OpenCode 2.0.27** 验证。各插件独立安装，按需选择；详细配置、迁移差异和验证方法见对应目录。

## 插件一览

| 插件 | 功能 | 使用入口 | 配置位置 |
| --- | --- | --- | --- |
| [opencode-providers](./opencode-providers/README.md) | Qoder CN、Krill Codex 与 Cursor 接入、模型发现、账号切换 | `/connect`、`/models` | `opencode.json` |
| [opencode-goal](./opencode-goal/README.md) | 设置目标、自动续跑、暂停恢复、完成状态提示 | `/goal` | `opencode.json` + `cli.json` |
| [opencode-message-delete](./opencode-message-delete/README.md) | 每次删除末尾一条 AI 消息，保留项目文件 | `/delete-last-message` | `cli.json` |
| [opencode-agents](./opencode-agents/README.md) | 从插件自带 Markdown 注册 agent | agent 选择器 | `opencode.json` |

## 快速安装

通过公开的 GitHub 仓库安装，无需 GitHub 凭据，也无需克隆源码或本地编译。模型供应商的 PAT/API Key 仍需自行配置。

### 交互式安装（推荐）

需要 Node.js 24+、Git，以及已加入 PATH 的 OpenCode 2.x。在终端执行：

```powershell
npx github:nichem/opencode-plugins
```

安装器直接从 GitHub 获取，**不发布到 npm**；首次运行时 npm 可能提示确认下载运行。

- **安装 / 更新**：空格多选、回车执行。未安装、有更新或配置不完整的插件可选；最新版仍显示，但不可选。默认不选任何项，直接回车返回。
- **卸载**：多选已配置的插件，再确认卸载；确认默认选择否。仅移除配置，保留账号、凭据、缓存和插件数据。
- **返回 / 退出**：子菜单按 `Esc` 返回，主菜单选择退出，或按 `Ctrl+C`。

安装器管理本仓库 GitHub 地址对应的全局 `plugins` 条目，保留其他配置和插件选项；Goal 自动同时处理服务端与终端界面入口。不会读取 agent 文档，也不会修改项目目录的配置或替换其他来源的同名插件。

版本以仓库 `main` 的提交为单位判断，文档更新也可能显示新版本。安装时固定到本次检查的提交；后续更新请重新运行上面的命令。配置版本与 OpenCode 缓存用于状态判断，显示最新版不代表已验证插件运行正常。网络检查失败时不会标记为最新版。

改动前备份到 `~/.local/state/opencode-plugins/backups/`（设置 `XDG_STATE_HOME` 时跟随该目录），完成后尝试 `opencode reload`。请重新打开 OpenCode 终端界面，由 OpenCode 下载并加载插件。

### 手动配置

配置目录默认是 `~/.config/opencode/`，Windows 对应 `%USERPROFILE%\.config\opencode\`。如果设置了 `XDG_CONFIG_HOME`，则使用该目录下的 `opencode/`。

**将以下条目合并到已有的 `plugins` 数组中，保留其他配置。** 安装部分插件时，只保留对应条目即可。

### 服务端：`opencode.json`

负责供应商接入、预设 agent 和目标执行；使用 `opencode.jsonc` 也可以，无需同时维护两份。

```json
{
  "plugins": [
    "git+https://github.com/nichem/opencode-plugins.git#main::path:opencode-providers",
    "git+https://github.com/nichem/opencode-plugins.git#main::path:opencode-goal",
    "git+https://github.com/nichem/opencode-plugins.git#main::path:opencode-agents"
  ]
}
```

### 终端界面：`cli.json`

负责 Goal 的状态通知和删除消息命令。

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": [
    "git+https://github.com/nichem/opencode-plugins.git#main::path:opencode-goal",
    "git+https://github.com/nichem/opencode-plugins.git#main::path:opencode-message-delete"
  ]
}
```

Goal 在两个文件中使用同一地址，分别加载服务端和界面入口。仅配置服务端可以执行目标，但缺少界面状态通知。

配置完成后执行 `opencode reload`，并重新打开终端界面。

> 请保留完整 Git 地址。仅填写 `"opencode-goal"` 等名称会指向 npm 包，不会安装本仓库里的版本。

## 使用

### 连接供应商

在 `/connect` 中选择供应商并输入凭据，再通过 `/models` 选择模型。

| 供应商 | 凭据 | 当前支持 |
| --- | --- | --- |
| Qoder CN | 中国区 `pt-` 开头的 PAT | 内置 Auto、Qwen3.8-Max，并尝试发现账号可用模型 |
| Krill | API Key | `/codex/v1` 的 OpenAI Responses 通道，内置两个 GPT 模型并发现更多 GPT 文本模型 |
| Cursor | 浏览器登录或 Cursor API Key | 仅显示 Cursor Models 额度池内的已知模型及账号可用变体，隐藏 Auto 和 Other Models |

凭据由 OpenCode 保存，插件读取当前激活账号。支持保存多个账号并手动切换；不做自动轮换或额度耗尽切号。首次连接或切换账号后，执行 `opencode reload` 刷新模型列表。

Krill 的模型列表只提供 ID，长度与能力参数使用插件默认值，也可在插件选项中覆盖。其他模型系列不自动加入 Codex 通道。具体参数见 [供应商配置说明](./opencode-providers/README.md)。

Cursor 只使用 OpenCode 保存的连接，不读取 `CURSOR_API_KEY`。首次连接后执行 `opencode reload` 刷新模型。接入不修改全局 MCP、shell、权限或 agent 切换行为；上游依赖额外工具及全局钩子的功能不随包启用，详见 [Cursor 支持范围](./opencode-providers/README.md#cursor-认证和支持范围)。

Cursor 模型列表按[官方额度池划分](https://cursor.com/docs/models-and-pricing)过滤，目前仅保留账号返回的 Composer 2.5、Grok 4.5 / 4.6 / 4.7 及对应变体。未连接、模型发现失败或关闭发现时列表为空，不再使用 Auto 兜底；未确认额度池的新模型也暂不显示。

Cursor 文件读取经过宿主工具，不绕过权限补读全文；切换账号后拒绝向旧连接续传工具结果。模型结束一轮后，协议层不会因为回复只是进度描述而自行追加请求。

需要额外读盘的编辑自动转换不启用；模型应根据宿主读取结果直接调用可用的编辑工具。计划和 agent 切换遵循 OpenCode 的指令及工具，Cursor 原生 `CreatePlan`、`SwitchMode` 不可用。

切换 agent 时，协议不追加执行授权、模式限制或计划提交指令；当前 agent 的行为约束由 OpenCode 提供。

会话内同名工具的描述和参数定义随宿主更新，工具续接时也使用当前定义校验参数。

Cursor 遵守 `toolChoice` 的禁用、指定工具和必须调用工具要求；原生提问与事件转换也检查本轮允许列表。取消生成会打断响应等待；工具续接准备期间取消也会关闭连接，停止回传工具结果。正常工具交接后的取消不会关闭下一轮续接连接。

首次请求和重试请求的准备阶段也支持取消；准备失败会清理连接，取消后不再发送初始请求。删除消息使 AI 历史全部清空时，Cursor 会丢弃旧会话缓存，按照 OpenCode 剩余历史重新建立上下文。

Windows 下，Cursor 后台收集 Git 状态和读取设备标识时会隐藏子进程窗口，避免聊天期间终端窗口闪现。

### 使用预设 agent

也可以单独通过命令安装：

```powershell
opencode plugin add 'git+https://github.com/nichem/opencode-plugins.git#main::path:opencode-agents'
```

插件从随包分发的 `agents/` Markdown 文档注册 agent，无需复制到本机 agent 目录。注册名称统一带 `bundled-` 前缀，可在 agent 选择器中选择；具体可见性取决于文档中的 `mode` 和 `hidden` 设置。

只需配置服务端入口，不需要添加到 `cli.json`。文档格式和更新方法见 [Agent 插件说明](./opencode-agents/README.md)。

### 持续执行目标

```text
/goal 完成这次重构并验证相关功能
/goal append 补充一项要求
/goal pause
/goal resume
/goal
/goal clear
```

目标活跃时自动续跑，由模型通过 `update_goal` 标记完成。用户中断或执行失败会暂停目标；暂停不会主动中断正在执行的请求。本版本基于 `mirsella/opencode-goal 0.4.3` 迁移，详细行为见 [Goal 文档](./opencode-goal/README.md)。

### 删除末尾 AI 消息

```text
/delete-last-message
```

每次删除一条内部 AI 消息，包括其中的正文、思考及工具记录。可重复执行，遇到用户消息或其他非 AI 消息就停止；已修改的文件保留。AI 一轮回复可能包含多条消息，因此一次操作不一定删除整轮。

生成中无法删除。使用 Goal 自动续跑时先 `/goal pause`。**删除成功后不能用 `/redo` 恢复**；这也不是原 message-editor 的按片段编辑功能。详见 [删除插件文档](./opencode-message-delete/README.md)。

## 更新与迁移

通过交互式安装器安装的插件，重新执行 `npx github:nichem/opencode-plugins`，选择“安装 / 更新”。安装器使用固定提交地址，不能靠 `opencode plugin update` 自动跟随 `main`。

手动配置为上述 `#main` 地址的插件可以执行：

```powershell
opencode plugin update
```

更新后重新打开终端界面。安装状态可通过 `opencode plugin list` 查看。

迁移旧配置时，移除原来的 Qoder 插件和原版 `opencode-goal` npm 条目，避免重复注册。旧 `provider.krill` 配置应在通过 `/connect` 保存密钥并验证连接后移除。插件本身不会自动改写旧配置或导入密钥。

## 开发与许可

各插件独立管理依赖，开发检查使用 Node.js 24+。进入对应插件目录执行：

```powershell
npm ci
npm run check
npm test
```

真实 OpenCode 的隔离验证脚本和使用方法见各插件 README。源码来源与许可见对应目录中的 `LICENSE`、`NOTICE.md`（如有）。
