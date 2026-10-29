# OpenCode Plugins

个人维护的 **OpenCode 2.x 插件集合**：连接模型供应商、加载预设 agent、兼容旧版目标管理、逐条删除末尾 AI 消息、显示当前供应商额度、选择网络搜索供应商、优化思考区块的计时和收起操作，以及为 DeepSeek 注入协作行为提示词。

原有插件针对 **OpenCode 2.0.27** 验证，额度侧栏和搜索选择器针对 **OpenCode 2.1.0** 适配，UI 优化允许 **OpenCode 2.x** 启用，渲染适配基于 **2.1.2** 验证；DeepSeek 行为增强基于 **2.2.0** 验证。各插件独立安装，按需选择；详细配置、迁移差异和验证方法见对应目录。

**OpenCode 2.2.1 起已原生内置 `/goal`。** 新版安装器不再提供 Goal 插件的安装 / 更新，但保留新旧地址识别与卸载入口；OpenCode 旧版本仍可安装。已有用户请按下文迁移到原生 Goal。

## 插件一览

| 插件 | 功能 | 使用入口 | 配置位置 |
| --- | --- | --- | --- |
| [opencode-providers](./plugins/opencode-providers/README.md) | Qoder CN 与 Krill Codex 接入、模型发现、账号切换 | `/connect`、`/models` | `opencode.json` |
| [opencode-goal（旧版兼容）](./plugins/opencode-goal/README.md) | 仅用于 OpenCode < 2.2.1；新版使用原生目标管理 | `/goal` | 仅旧版需要 `opencode.json` + `cli.json` |
| [opencode-message-delete](./plugins/opencode-message-delete/README.md) | 每次删除末尾一条 AI 消息，保留项目文件 | `/delete-last-message` | `cli.json` |
| [opencode-agents](./plugins/opencode-agents/README.md) | 从插件自带 Markdown 注册 agent | agent 选择器 | `opencode.json` |
| [opencode-quota](./plugins/opencode-quota/README.md) | 当前供应商额度，内置 Go、DeepSeek、智谱 / Z.AI Coding Plan、Kimi For Coding，支持自定义 JS | 右侧栏、`/quota-refresh` | `opencode.json` + `cli.json` |
| [opencode-websearch](./plugins/opencode-websearch/README.md) | 搜索供应商单选、会话内选择及 DeepSeek Search（DSS） | `/search` | `opencode.json` + `cli.json` |
| [opencode-ui](./plugins/opencode-ui/README.md) | 思考中实时计时、展开内容末尾一键收起 | 思考标题与末尾、`/ui-enhance-status` | `cli.json` |
| [opencode-deepseek-behavior](./plugins/opencode-deepseek-behavior/README.md) | DeepSeek 进度沟通、讨论边界与提交授权提示词，默认开启并持久化 | 右侧点击开关、`/deepseek-behavior` | `opencode.json` + `cli.json` |

## 快速安装

通过公开的 GitHub 仓库安装，无需 GitHub 凭据，也无需克隆源码或本地编译。模型供应商的 PAT/API Key 仍需自行配置。

### 交互式安装（推荐）

需要 Node.js 24+、Git，以及已加入 PATH 的 OpenCode 2.x。在终端执行：

```powershell
npx github:nichem/opencode-plugins
```

安装器直接从 GitHub 获取，**不发布到 npm**；首次运行时 npm 可能提示确认下载运行。

- **安装 / 更新**：空格多选、回车执行。未安装、有更新或配置不完整的插件可选；最新版仍显示，但不可选。OpenCode 2.2.1+ 中 Goal 显示“已原生内置”，不可安装或更新，已配置的旧插件可从卸载页移除。默认不选任何项，直接回车返回。
- **卸载**：多选已配置的插件，再确认卸载；确认默认选择否。仅移除配置，保留账号、凭据、缓存和插件数据。
- **返回 / 退出**：子菜单按 `Esc` 返回，主菜单选择退出，或按 `Ctrl+C`。

安装器管理本仓库 GitHub 地址对应的全局 `plugins` 条目，保留其他配置和插件选项；Goal、额度侧栏、搜索选择器和 DeepSeek 行为增强自动同时处理服务端与终端界面入口。不会读取 agent 文档，也不会修改项目目录的配置或替换其他来源的同名插件。

插件统一放在 `plugins/` 下，根目录保留安装器和仓库文档。安装器同时识别历史根目录地址与新地址：旧地址会显示“需要迁移”，选择安装 / 更新即可替换为新路径，无需先卸载。新旧地址混杂时会去重并保留选项；重复选项值冲突时停止写入并提示手动合并，避免丢失设置。卸载会同时移除该插件的新旧地址配置。

版本按各插件整个目录的 Git tree hash 判断：比较已安装提交中实际安装路径与 `main` 最新提交中 `plugins/<插件目录>` 的内容。内容相同且使用新地址才显示最新版；仅搬目录时显示需要迁移，不误报内容更新。其他插件、根目录文档或安装器的修改不会触发该插件的更新提示；插件目录内的文档和测试变化仍算更新，改动撤销后内容相同也不会提示更新。安装时仍固定到本次检查的完整提交 SHA；后续更新请重新运行上面的命令。

安装器从配置或 OpenCode 缓存确定已安装提交，缓存按完整安装地址分别匹配；同一插件的新旧目录、不同分支、标签或地址写法不会互借版本。Goal、额度侧栏、搜索选择器和 DeepSeek 行为增强均分别比较两个入口，全部一致才显示最新版。优先通过 GitHub API 查询提交元数据，以及根目录和 `plugins/` 两层非递归 tree；不进入单个插件目录。API 限流或请求失败时显示原因，并自动改用 Git 查询，不需要 GitHub 凭据。

已被当前 OpenCode 版本原生替代的插件不再查询旧安装提交或提示更新；其他插件仍按上述目录内容比较。退役只改变安装器的选择，不会自动修改用户配置或删除旧目标数据。

Git 回退在临时裸仓库中使用 `tree:0` 过滤，先取提交元数据，再单独取所需根目录和 `plugins/` 容器 tree，不获取单个插件 tree、不检出文件、不请求文件正文，完成后清理临时目录。缓存短提交号通过远端分支历史解析；仅由标签保留的提交，结合原安装地址查询轻量或附注标签的实际提交，并核对缓存短 SHA，避免把标签移动后的版本误认为已安装版本。批量获取提交或目录失败时逐项重试，失效版本只影响对应路径，其他查询结果继续保留。同一次检查复用相同提交的查询结果。

两种查询均失败或目录版本仍无法解析时显示检查失败，该项不可选，请返回重试；未能确定已安装版本时仍可重新安装。显示最新版仅代表目录内容一致，不代表已验证插件运行正常。当前按插件自包含目录比较；以后如引入目录外共享依赖，需同步扩展比较范围。

改动前备份到 `~/.local/state/opencode-plugins/backups/`（设置 `XDG_STATE_HOME` 时跟随该目录），完成后尝试 `opencode reload`。请重新打开 OpenCode 终端界面，由 OpenCode 下载并加载插件。

### 手动配置

配置目录默认是 `~/.config/opencode/`，Windows 对应 `%USERPROFILE%\.config\opencode\`。如果设置了 `XDG_CONFIG_HOME`，则使用该目录下的 `opencode/`；设置 `OPENCODE_CONFIG_DIR` 时优先使用其指定目录，服务端配置和终端界面的 `cli.json` 均跟随该目录，安装、更新和卸载使用同一规则。

**将以下条目合并到已有的 `plugins` 数组中，保留其他配置。** 安装部分插件时，只保留对应条目即可。

### 服务端：`opencode.json`

负责供应商接入、预设 agent、额度查询、搜索选择和 DeepSeek 行为提示词；使用 `opencode.jsonc` 也可以，无需同时维护两份。以下示例面向 OpenCode 2.2.1+，不包含已被原生替代的 Goal 插件。

```json
{
  "plugins": [
    "git+https://github.com/nichem/opencode-plugins.git#main::path:plugins/opencode-providers",
    "git+https://github.com/nichem/opencode-plugins.git#main::path:plugins/opencode-agents",
    "git+https://github.com/nichem/opencode-plugins.git#main::path:plugins/opencode-quota",
    "git+https://github.com/nichem/opencode-plugins.git#main::path:plugins/opencode-websearch",
    "git+https://github.com/nichem/opencode-plugins.git#main::path:plugins/opencode-deepseek-behavior"
  ]
}
```

### 终端界面：`cli.json`

负责删除消息命令、额度侧栏、搜索选择弹窗、思考 UI 优化和 DeepSeek 行为增强开关。新版原生 Goal 的状态界面无需另装插件。

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": [
    "git+https://github.com/nichem/opencode-plugins.git#main::path:plugins/opencode-message-delete",
    "git+https://github.com/nichem/opencode-plugins.git#main::path:plugins/opencode-quota",
    "git+https://github.com/nichem/opencode-plugins.git#main::path:plugins/opencode-websearch",
    "git+https://github.com/nichem/opencode-plugins.git#main::path:plugins/opencode-ui",
    "git+https://github.com/nichem/opencode-plugins.git#main::path:plugins/opencode-deepseek-behavior"
  ]
}
```

额度侧栏、搜索选择器和 DeepSeek 行为增强在两个文件中使用各自相同的地址，分别加载服务端和界面入口。OpenCode < 2.2.1 使用旧 Goal 插件时，也需要同时配置两个入口；安装方法见 [旧版 Goal 文档](./plugins/opencode-goal/README.md)。

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

Krill 的模型列表只提供 ID，长度与能力参数使用插件默认值，也可在插件选项中覆盖。其他模型系列不自动加入 Codex 通道。具体参数见 [供应商配置说明](./plugins/opencode-providers/README.md)。

### 使用预设 agent

也可以单独通过命令安装：

```powershell
opencode plugin add 'git+https://github.com/nichem/opencode-plugins.git#main::path:plugins/opencode-agents'
```

插件从随包分发的 `agents/` Markdown 文档注册 agent，无需复制到本机 agent 目录。注册名称统一带 `bundled-` 前缀，可在 agent 选择器中选择；具体可见性取决于文档中的 `mode` 和 `hidden` 设置。

只需配置服务端入口，不需要添加到 `cli.json`。文档格式和更新方法见 [Agent 插件说明](./plugins/opencode-agents/README.md)。

### 持续执行目标

OpenCode 2.2.1+ 使用原生 Goal，无需安装本仓库的 Goal 插件：

```text
/goal 完成这次重构并验证相关功能
/goal pause
/goal resume
/goal
/goal clear
```

原生 Goal 自动续跑，每轮结束后由当前会话模型额外审查目标是否完成，带有停滞检测和轮数上限，TUI 和桌面端均有状态界面。[官方发布说明](https://github.com/anomalyco/opencode/releases/tag/v2.2.1)

OpenCode 旧版本可继续使用本仓库基于 `mirsella/opencode-goal 0.4.3` 迁移的插件。`append`、累计耗时和 `update_goal` 是旧插件行为，详细说明见 [旧版 Goal 文档](./plugins/opencode-goal/README.md)。

### 删除末尾 AI 消息

```text
/delete-last-message
```

每次删除一条内部 AI 消息，包括其中的正文、思考及工具记录。可重复执行，遇到用户消息或其他非 AI 消息就停止；已修改的文件保留。AI 一轮回复可能包含多条消息，因此一次操作不一定删除整轮。

生成中无法删除。使用 Goal 自动续跑时先 `/goal pause`。**删除成功后不能用 `/redo` 恢复**；这也不是原 message-editor 的按片段编辑功能。详见 [删除插件文档](./plugins/opencode-message-delete/README.md)。

### 当前供应商额度

右侧只显示当前所选模型所属供应商的一张额度卡片，切换模型时在原位置更新。内置 OpenCode Go、DeepSeek 余额、智谱 / Z.AI Coding Plan 和 Kimi For Coding 订阅额度，凭据直接使用 `/connect` 保存的当前连接。Go 展示 5 小时、每周、每月三个窗口；Coding Plan 展示接口提供的周期、剩余比例和重置时间。智谱和 Kimi 支持国内 / 国际站，Kimi 的月度窗口仅在接口返回时展示。

其他供应商可在服务端插件选项中按 `providerID` 指定 `.js` / `.mjs` 脚本；为内置供应商配置脚本也可覆盖默认查询。准确的供应商 ID、接口和支持范围见[额度插件文档](./plugins/opencode-quota/README.md#其他内置供应商)。

内置查询会在读取凭据前校验供应商、模型及变体的实际接口地址；自定义地址或代理需配置额度脚本。Kimi 同一周期的新旧额度数据冲突时显示查询失败，保留上次数据，不将冲突结果显示为满额度。

默认每 60 秒刷新，也可执行 `/quota-refresh`。TUI 请求默认 15 秒超时，网络挂起后保留上次额度并允许重试。凭据由 OpenCode 连接管理提供，TUI 只接收额度数据。自定义脚本在服务端运行，完整配置、返回格式及 UI 预览见 [额度插件文档](./plugins/opencode-quota/README.md)。

额度侧栏随仓库分发预编译的 `tui.js`，安装时无需本地编译。旧版本出现 `Cannot find package 'react'` 时，通过安装器更新额度插件并重新打开 TUI。

`a106134` 版本若出现 `NpmInstallFailedError`，同样需要更新额度插件；已调整开发构建命令，避免 Git 安装触发预构建。

### 网络搜索供应商

执行 `/search` 打开紧凑的单行列表；无已有设置时默认 `random`，动态列出全部已注册的搜索供应商。整行高亮当前选项，勾号标识已生效的选择。按 Enter 保存当前项目默认，按 `s` 仅当前会话生效；首页或高亮 `random` 时隐藏 `s`。

会话中按实际会话目录定位配置，Enter 仅更新该目录的 `websearch.provider`，遵循 `.opencode` 的配置优先级，写入前备份并检查并发修改，保存后刷新并核验生效结果；`s` 只保存会话设置。继承的全局或上级禁用设置同样会隐藏 `s`。

新增 DSS（DeepSeek Search），通过 `/connect` 中独立的 **DSS (DeepSeek Search)** 入口保存搜索 API Key，调用官方新上线的 Search API。DSS 与 DeepSeek 模型连接分别管理；升级后需要在 DSS 入口单独连接。未连接时保留显示并标记为不可用。搜索保留原生供应商字段和权限检查。完整行为及验证说明见 [搜索选择器文档](./plugins/opencode-websearch/README.md)。

弹窗兼容其他供应商插件的先后加载顺序，显示最终默认值。DSS 查询超过 128 个 Unicode 字符时，向模型返回明确限制，供模型缩短后重试。

### 思考 UI 优化

思考进行中在原 `Thinking` 标题后每秒更新耗时，关闭动画后仍可显示；成组标题累计该组耗时，单独标题只计算当前片段，隐藏的上下文更新不会重置同组计时。展开后在正文内部末尾独占一行显示“↑ 收起思考”，随正文卸载清理，避免完成或中断后在回复状态行附近残留；长分组单独挂载或原生时间线行没有 ID 时仍可识别并从底部收起。完成后沿用原生最终耗时。纯终端插件，仅需配置 `cli.json`。

允许所有 OpenCode **2.x** 版本尝试启用，使用基于 **2.1.2** 验证的内部思考布局兼容层；不逐个限制小版本，其他大版本停止增强并提示。状态可用 `/ui-enhance-status` 查看；发生运行异常时停止增强，显示宿主版本、出错阶段和错误类型。选项和兼容边界见 [UI 优化文档](./plugins/opencode-ui/README.md)。

### DeepSeek 行为增强

当前模型 ID 包含 `deepseek`（忽略大小写）时，主对话请求追加行为提示词，要求按排查、发现、阻塞和阶段切换等工作节点适度汇报进展、区分方案讨论与执行，并遵守当前任务的提交和推送授权。不限供应商，其他模型不注入。

首次默认开启，右侧“DeepSeek 行为增强”标题行可点击切换，也可使用 `/deepseek-behavior`。选择保存在 OpenCode 服务端的插件存储中，跨会话、项目和重启保留，从下一次模型请求生效。切到其他模型时隐藏侧栏卡片，已保存的选择仍保留。

需要同时配置服务端和 TUI 入口；提示词属于行为引导，没有增加 Git 命令拦截。完整规则和验证方式见 [DeepSeek 行为增强文档](./plugins/opencode-deepseek-behavior/README.md)。

## 更新与迁移

### 从 Goal 插件迁移到原生 Goal

升级到 OpenCode 2.2.1+ 后，先暂停旧目标并记下未完成的目标内容。运行 `npx github:nichem/opencode-plugins`，在“卸载”中选择 `opencode-goal` 并确认，安装器会备份后移除服务端和 TUI 对应的新旧地址条目，保留账号、凭据、缓存和旧目标数据；仅配置其中一个入口时同样可以卸载。

执行 `opencode reload` 并重新打开 TUI，再通过原生 `/goal <目标>` 重新设置目标。旧插件目标不会自动转成原生目标。项目配置、其他来源或本地路径加载的旧插件不在安装器管理范围内，需自行移除对应条目。源码保留供旧版使用，不自动卸载用户的现有插件。

### 从根目录安装地址迁移

旧地址形如 `#<ref>::path:opencode-quota`，新地址为 `#<ref>::path:plugins/opencode-quota`。运行新版 `npx github:nichem/opencode-plugins`，在“安装 / 更新”中选择显示“需要迁移”的插件即可；安装器备份后更新服务端和 TUI 对应入口，保留其他插件、选项及顺序。卸载也识别两种地址，不删除账号、凭据、缓存或插件数据。包名和插件 ID 保持不变。新版 OpenCode 中已退役的 Goal 应按上节卸载，旧版中仍可迁移地址。

固定旧提交 SHA 的安装仍使用历史目录，不会因最新提交搬迁而立即失效。手动使用 `#main` 旧路径的配置，请先通过新版安装器迁移，或手动将路径改为 `plugins/<插件目录>`；直接执行 `opencode plugin update` 不会替你改配置中的目录路径，可能找不到已搬走的旧目录。项目配置不在安装器管理范围内，需要自行更新对应地址。

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
