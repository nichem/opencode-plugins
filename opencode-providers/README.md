# opencode-providers

个人维护的 OpenCode **2.x** 多供应商插件，目前支持 **Qoder 中国区**和 **Krill Codex**。

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
          "krill": { "enabled": true, "discoverModels": true }
        }
      }
    }
  ]
}
```

也可以直接在 `plugins` 中填写上述 Git 地址字符串，默认启用两个供应商及模型发现。私有仓库需要本机 Git 访问权限。Qoder 的 `setDefault: true` 将默认模型设为 `qoder/auto`；默认不会覆盖你的模型选择。两个供应商均可通过 `enabled: false` 单独关闭。

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
```

新增供应商时增加 `src/providers/<name>/`，导出 setup 函数并注册到入口的 `providers` 映射。各供应商使用独立的 provider/integration ID 和认证实现。

保留了原 Qoder 实现的思考解析、图片输入、工具调用、取消、认证超时和残缺流检测。2.x 通过 `provider.transform` 注册模型，使用 `aisdk:` 本地模块与 `aisdk.hook("language")` 接入 AI SDK v3 桥接；不使用旧 `catalog` 或 `aisdk.language` 接口。

根目录 `index.js` 是本地目录加载入口。OpenCode 2.0.27 的本地目录解析会查找根目录 `index`/`server`，因此该文件不能仅用 `package.json` 的 `main` 替代。

## 验证

```powershell
npm run check
npm test
node scripts/smoke-krill.mjs "C:/path/to/opencode2.exe"
```

测试使用模拟网络和虚构 PAT，覆盖 2.x 模型 schema、供应商隔离、账号切换、模型发现、工具约束、流式结束、取消和超时。测试不会使用真实 PAT 请求 Qoder；真实账号端到端验证仍需在 2.x 中进行。

Krill 冒烟测试使用独立数据库和本地模拟 Responses 服务，验证真实 2.x 插件加载、连接密钥、生成及切换账号，不读取本机 API Key。

已在 Windows 上用临时安装的 `@opencode/cli 2.0.27` 验证：插件加载成功、两个内置模型可见，真实服务端的一次生成请求到达 Qoder 认证代码并报告缺少 PAT。该验证使用隔离的配置、数据库和凭据目录，没有调用真实 Qoder 接口。可重复执行：

```powershell
node scripts/smoke.mjs "C:/path/to/opencode2.exe"
```

验证数据保留在输出所示的系统临时目录，方便检查日志；不会写入现有 OpenCode 配置。

`QODERCN_DEBUG_BODY` 是原实现保留的调试开关，会把请求和提供者选项写入系统临时目录；日志可能包含凭据和对话内容，不要提交。
