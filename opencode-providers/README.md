# opencode-providers

个人维护的 OpenCode **2.x** 多供应商插件，目前支持 **Qoder 中国区**、**Krill Codex** 和 **Cursor**。

针对 `@opencode/plugin 2.0.27` 接口适配。使用 Node.js 24+；JavaScript 源码直接加载，无需编译。

## 安装

在 OpenCode **2.x** 使用的 `opencode.json` 或 `opencode.jsonc` 中添加：

```jsonc
{
  "plugins": [
    {
      "package": "git+https://github.com/nichem/opencode-plugins.git#main::path:opencode-providers",
      "options": {
        "providers": {
          "qoder": {
            "enabled": true,
            "discoverModels": true,
            "setDefault": false
          },
          "krill": { "enabled": true, "discoverModels": true },
          "cursor": { "enabled": true, "discoverModels": true }
        }
      }
    }
  ]
}
```

也可以直接在 `plugins` 中填写上述 Git 地址字符串，默认启用三个供应商及模型发现。公开仓库无需 GitHub 凭据。Qoder 的 `setDefault: true` 将默认模型设为 `qoder/auto`；默认不会覆盖你的模型选择。各供应商均可通过 `enabled: false` 单独关闭。

这是服务端插件，不注册到 `cli.json`。更新仓库后执行 `opencode plugin update 'git+https://github.com/nichem/opencode-plugins.git#main::path:opencode-providers'` 更新安装包。

不要同时启用旧 Qoder 插件或旧的 `provider.krill` 配置和本插件的同名供应商。已有 Krill API Key 应先通过 `/connect` 存入 OpenCode，再移除旧配置。本插件自身不会改写全局配置，也不兼容 1.x 的插件接口。

## Qoder CN 认证

只支持中国区 `pt-` 开头的 Personal Access Token。在 OpenCode 2.x 中运行 `/connect`，选择 **Qoder CN**，输入 PAT。插件只读取 OpenCode 当前连接保存的凭据。

PAT 自动换取临时凭据，并按过期时间缓存。每次请求重新读取当前连接，切换账号后不会继续使用模型实例里缓存的旧 PAT。

内置 `auto` 和 `qmodel_38max`。启动时尝试读取账号可用模型，认证和模型列表请求共用 6 秒期限；失败时保留内置模型。首次连接或切换账号后，重启插件以刷新模型列表；`discoverModels: false` 可关闭发现。

Qwen3.8-Max 提供 `low`、`medium`、`xhigh`、`none` 思考强度，在线模型以服务端列表为准。目录里标记的零成本表示插件没有定价数据，不代表供应商免费。

## Krill 认证和模型

在 `/connect` 中选择 **Krill** 并输入 API Key。密钥只读取 OpenCode 当前连接，不从环境变量、配置或文件兜底读取；切换账号后，已缓存的 SDK 也会在下一次请求读取新凭据。

默认接口为 `https://api.krill-code.net/codex/v1`，使用 OpenAI **Responses** 协议。内置 `gpt-5.6-sol` 和 `gpt-6.1-sol`，沿用迁移前的 272000 上下文、128000 输出上限，支持 `low`、`medium`、`high`、`xhigh` 思考档位，默认 `medium`、简短输出和 `store: false`。这些限制来自原配置，不代表服务端公布的规格；未提供定价数据。

启动时通过 `/models` 发现 GPT 文本模型，6 秒超时或失败时保留内置模型。网关列表还包含其他系列，因此不会自动将 Claude、图片、音频等模型加入此 Codex 通道。首次连接或换账号后执行 `opencode reload` 刷新模型列表。

列表接口仅返回 ID，新增模型默认使用保守的 200000 上下文、32768 输出上限。可以在插件 `options.providers.krill` 中覆盖名称、长度、输入类型和思考档位，或显式添加兼容 Responses 的模型：

```json
{
  "enabled": true,
  "discoverModels": true,
  "baseURL": "https://api.krill-code.net/codex/v1",
  "models": {
    "gpt-6.1-sol": {
      "contextWindow": 272000,
      "maxTokens": 128000,
      "input": ["text"],
      "efforts": ["low", "medium", "high", "xhigh"]
    }
  }
}
```

`providerID` 默认 `krill`，可自定义。模型参数覆盖不会改变服务端的实际能力或配额。

## Cursor 认证和支持范围

在 `/connect` 选择 **Cursor**，使用浏览器登录或输入 Cursor API Key。凭据由 OpenCode 保存和刷新；不读取 `CURSOR_API_KEY`、旧 `auth.json`、插件配置中的 Key 或 token 文件。浏览器登录最多等待三分钟；API Key 按需换取临时访问令牌。

首次连接、切换账号或更新模型列表后执行 `opencode reload`。默认显示 `cursor/default`（Auto）；模型发现成功后使用账号返回的目录，并映射思考档位、长上下文等变体。失败时仅保留 Auto，不沿用其他账号的模型缓存。上游模型限制和价格为参考元数据，以 Cursor 账号的实际能力和计费为准。

Cursor 配置只接受 `enabled`、`discoverModels` 两个布尔选项，供应商 ID 固定为 `cursor`。请求时重新读取当前账号，按连接隔离会话缓存；生成过程中切换账号时，应中断并重新发起请求。

协议保留与宿主计划模式对应的传输状态，但不注入额外模式或计划提交提醒。从 `plan` 切到只读、自定义或 `build` agent 时，行为约束均由 OpenCode 当前 agent 的指令决定，不自动宣告允许编辑。

新一轮请求和工具续接都会更新同名工具的描述与参数 schema，参数校验使用宿主当前定义。目录缓存保留已有排序并追加新工具；历史目录条目不授予执行权限，可执行工具仍以当前宿主传入的列表为准。

`toolChoice: none` 禁止工具调用，指定工具时只允许该工具，`required` 和指定工具模式下没有实际工具调用的结束会报错。普通 exec、原生 `AskQuestion` 和显示事件转换共用本轮允许列表，并在向宿主输出工具调用前再次校验。取消当前生成会关闭连接并打断等待；续接会在回传工具结果前完成校验，准备阶段或工具图片下载期间取消、校验失败时，也会清理连接并停止回传。已经输出 `tool-calls` 的调用解除取消监听，之后的收尾取消不会破坏正常续接或下一轮调用。

首次及重试请求在等待认证、连接和上下文准备时也支持取消；准备失败会清理已经打开的流，迟到的连接会立即关闭，取消后不再发送初始 Run 请求。新请求等待上一轮时可以取消；若已接管旧流进行收尾，会关闭该流，但不会中断仍由另一调用持有的生成。删除消息或回退使 AI 历史全部清空时，若旧会话曾输出文本、思考或工具调用，会重建 Cursor 会话并清除旧检查点，避免模型继续看到已删除内容；正常历史及尚未输出内容的新会话保留原有缓存。

工具续接会核对实际持有连接的账号及 OpenCode 会话；不匹配时拒绝返回工具结果，正常账号和会话的续接保持可用。文件读取统一交给宿主工具，保留宿主返回的范围及截断信息，不从磁盘补读全文或绕过权限处理不存在的文件。模型结束一轮后，不因回复只是进度描述而自动追加合成用户消息或续跑请求。

宿主提供 `write`、`edit` 时按原参数传递。关联编辑的整文件写入若需要转换成其他工具，或 `edit` 需要转换成 `apply_patch`，协议会拒绝需要读盘的转换，提示模型根据宿主已授权的读取结果直接构造工具调用。无需读取原文件的新建文件写入仍可转换成 `apply_patch`。协议提示词明确禁用 Cursor 原生 `CreatePlan`、`SwitchMode`、`GenerateImage`；规划遵循宿主指令及实际提供的 `plan_enter` / `plan_exit` 等工具。

协议层基于 MIT 项目 [`oakimov/cursor-opencode-provider`](https://github.com/oakimov/cursor-opencode-provider) 的 `0.8.1`，**不加载上游插件入口**。协议 SDK 带有本集合的隔离补丁，作为可直接加载的 `vendor/protocol.js` 随 GitHub 包分发；认证及模型转换模块使用精确版本依赖。依赖从 npm 下载不等于向 npm 发布本集合。内部模块接口在升级时必须重新验证，维护者运行 `npm run build:cursor` 可从锁定版本重建协议文件，用户安装时无需编译。

保留的能力包括协议层的流式文本、思考、图片输入及向宿主传递工具调用。接入层遵循以下边界：

- 不修改全局 MCP 的 Code Mode 设置和工具展示方式，按 OpenCode 提供的工具目录传递请求。
- 不注册 shell 超时包装、全局工具钩子、额外网页搜索或 todo 工具。
- 不自动切换 OpenCode agent，不合成执行目标或计划续跑；系统提示和权限由 OpenCode 管理。
- 不注册上游的计划暂存、图片保存等专有工具。因此不承诺上游 CreatePlan 自动执行、GenerateImage 保存等扩展功能；需要计划模式时使用 OpenCode 自己的 agent 切换。
- 协议内部也拒绝原生 CreatePlan、SwitchMode、GenerateImage 审批请求，避免绕过宿主直接写计划文件；原生 GitDiff 执行被禁用，模型应调用 OpenCode 的 shell 工具。

MCP Code Mode 经 `execute` 的实际调用效果、Cursor 特有交互及完整多轮工具兼容性仍需真实账号验证。已完成模拟网络单元测试，以及隔离 OpenCode 2.0.27 的实际加载、登录方式注册和缺少凭据请求验证；未使用真实 Cursor 账号进行生成。

## 源码结构

```text
src/index.js                     插件入口和供应商选择
src/providers/qoder/index.js     2.x 注册、认证连接和模型桥接
src/providers/qoder/models.js    模型发现
src/providers/qoder/auth.js      PAT 认证和凭据缓存
src/providers/qoder/language-model.js  请求和流式响应
src/providers/qoder/transform.js 消息、图片和工具调用转换
src/providers/qoder/cosy.js      请求签名
src/providers/qoder/encoding.js  请求编码
src/providers/krill/index.js     /connect 注册、Responses SDK 和实时凭据
src/providers/krill/models.js    内置模型、模型发现和参数覆盖
src/providers/cursor/index.js   仅限 Cursor 的模型与会话适配
src/providers/cursor/auth.js    OpenCode 连接、OAuth 登录及令牌更新
src/providers/cursor/models.js  上游模型到原生 2.x 模型的转换
src/providers/cursor/upstream.js 固定版本协议模块入口（不启用上游插件）
```

新增供应商时增加 `src/providers/<name>/`，导出 setup 函数并注册到入口的 `providers` 映射。各供应商使用独立的 provider/integration ID 和认证实现。

保留了原 Qoder 实现的思考解析、图片输入、工具调用、取消、认证超时和残缺流检测。2.x 通过 `provider.transform` 注册模型，使用 `aisdk:` 本地模块与 `aisdk.hook("language")` 接入 AI SDK v3 桥接；不使用旧 `catalog` 或 `aisdk.language` 接口。

根目录 `index.js` 是本地目录加载入口。OpenCode 2.0.27 的本地目录解析会查找根目录 `index`/`server`，因此该文件不能仅用 `package.json` 的 `main` 替代。

## 验证

```powershell
npm run check
npm test
node scripts/smoke-krill.mjs "C:/path/to/opencode2.exe"
node scripts/smoke-cursor.mjs "C:/path/to/opencode2.exe"
```

测试使用模拟网络和虚构 PAT，覆盖 2.x 模型 schema、供应商隔离、账号切换、模型发现、工具约束、流式结束、取消和超时。测试不会使用真实 PAT 请求 Qoder；真实账号端到端验证仍需在 2.x 中进行。

Cursor 离线协议回归使用虚构会话及 protobuf 帧，覆盖指定工具、强制工具调用、移除后的原生提问与 todo 事件、续接准备及工具图片下载期间取消、续接校验失败、静默上游取消、部分并行工具步骤取消，以及工具交接后的延迟取消。启动阶段测试通过 Node VM 加载实际分发的协议文件，仅替换外部 I/O，验证首次及重试的取消、准备失败清理，以及内存和恢复后的历史删空、正常历史缓存保留；不使用真实账号或本机 agent 文档。

Krill 冒烟测试使用独立数据库和本地模拟 Responses 服务，验证真实 2.x 插件加载、连接密钥、生成及切换账号，不读取本机 API Key。

已在 Windows 上用临时安装的 `@opencode/cli 2.0.27` 验证：插件加载成功、两个内置模型可见，真实服务端的一次生成请求到达 Qoder 认证代码并报告缺少 PAT。该验证使用隔离的配置、数据库和凭据目录，没有调用真实 Qoder 接口。可重复执行：

```powershell
node scripts/smoke.mjs "C:/path/to/opencode2.exe"
```

验证数据保留在输出所示的系统临时目录，方便检查日志；不会写入现有 OpenCode 配置。

`QODERCN_DEBUG_BODY` 是原实现保留的调试开关，会把请求和提供者选项写入系统临时目录；日志可能包含凭据和对话内容，不要提交。
