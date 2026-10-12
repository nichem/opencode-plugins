# OpenCode Plugins

个人维护的 **OpenCode 2.x 插件集合**：连接模型供应商、管理持续执行的目标，以及逐条删除末尾 AI 消息。

目前针对 **OpenCode 2.0.27** 验证。各插件独立安装，按需选择；详细配置、迁移差异和验证方法见对应目录。

## 插件一览

| 插件 | 功能 | 使用入口 | 配置位置 |
| --- | --- | --- | --- |
| [opencode-providers](./opencode-providers/README.md) | Qoder CN 与 Krill Codex 接入、模型发现、账号切换 | `/connect`、`/models` | `opencode.json` |
| [opencode-goal](./opencode-goal/README.md) | 设置目标、自动续跑、暂停恢复、完成状态提示 | `/goal` | `opencode.json` + `cli.json` |
| [opencode-message-delete](./opencode-message-delete/README.md) | 每次删除末尾一条 AI 消息，保留项目文件 | `/delete-last-message` | `cli.json` |

## 快速安装

通过 GitHub 仓库安装，无需发布 npm 包，也无需克隆源码或本地编译。私有仓库需要本机 Git 已具备访问权限。

配置目录默认是 `~/.config/opencode/`，Windows 对应 `%USERPROFILE%\.config\opencode\`。如果设置了 `XDG_CONFIG_HOME`，则使用该目录下的 `opencode/`。

**将以下条目合并到已有的 `plugins` 数组中，保留其他配置。** 安装部分插件时，只保留对应条目即可。

### 服务端：`opencode.json`

负责供应商接入和目标执行；使用 `opencode.jsonc` 也可以，无需同时维护两份。

```json
{
  "plugins": [
    "git+https://github.com/nichem/opencode-plugins.git#main::path:opencode-providers",
    "git+https://github.com/nichem/opencode-plugins.git#main::path:opencode-goal"
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

凭据由 OpenCode 保存，插件读取当前激活账号。支持保存多个账号并手动切换；不做自动轮换或额度耗尽切号。首次连接或切换账号后，执行 `opencode reload` 刷新模型列表。

Krill 的模型列表只提供 ID，长度与能力参数使用插件默认值，也可在插件选项中覆盖。其他模型系列不自动加入 Codex 通道。具体参数见 [供应商配置说明](./opencode-providers/README.md)。

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

更新已安装的插件：

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
