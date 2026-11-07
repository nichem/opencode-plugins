# opencode-providers

个人维护的 OpenCode **2.x** 多供应商插件，目前支持 **Qoder 中国区**、**Qoder 国际版**和 **Krill Codex**。

针对 `@opencode/plugin 2.0.27` 接口适配。使用 Node.js 24+；JavaScript 源码直接加载，无需编译。

## 安装

在 OpenCode **2.x** 使用的 `opencode.json` 或 `opencode.jsonc` 中添加：

```jsonc
{
  "plugins": [
    {
      "package": "git+https://github.com/nichem/opencode-plugins.git#main::path:plugins/opencode-providers",
      "options": {
        "providers": {
          "qoder": {
            "enabled": true,
            "discoverModels": true,
            "setDefault": false
          },
          "krill": { "enabled": true, "discoverModels": true },
          "qoder-global": { "enabled": true, "discoverModels": true, "setDefault": false }
        }
      }
    }
  ]
}
```

也可以直接在 `plugins` 中填写上述 Git 地址字符串，默认启用三个供应商及模型发现。私有仓库需要本机 Git 访问权限。中国区和国际版的 `setDefault: true` 分别将默认模型设为 `qoder/auto` 和 `qoder-global/auto`；默认不会覆盖你的模型选择。各供应商均可通过 `enabled: false` 单独关闭。

这是服务端插件，不注册到 `cli.json`。更新仓库后执行 `opencode plugin update 'git+https://github.com/nichem/opencode-plugins.git#main::path:plugins/opencode-providers'` 更新安装包。

不要同时启用旧 Qoder 插件或旧的 `provider.krill` 配置和本插件的同名供应商。已有 Krill API Key 应先通过 `/connect` 存入 OpenCode，再移除旧配置。本插件自身不会改写全局配置，也不兼容 1.x 的插件接口。

## Qoder CN 认证

只支持中国区 `pt-` 开头的 Personal Access Token。在 OpenCode 2.x 中运行 `/connect`，选择 **Qoder CN**，输入 PAT。插件只读取 OpenCode 当前连接保存的凭据。

PAT 自动换取临时凭据，并按过期时间缓存。每次请求重新读取当前连接，切换账号后不会继续使用模型实例里缓存的旧 PAT。

内置 `auto` 和 `qmodel_38max`。启动时尝试读取账号可用模型，认证和模型列表请求共用 6 秒期限；失败时保留内置模型。首次连接或切换账号后，重启插件以刷新模型列表；`discoverModels: false` 可关闭发现。

Qwen3.8-Max 提供 `low`、`medium`、`xhigh`、`none` 思考强度，在线模型以服务端列表为准。目录里标记的零成本表示插件没有定价数据，不代表供应商免费。

## Qoder Global 认证和模型

在 `/connect` 中选择 **Qoder Global**，输入从 [Qoder 国际版账号页面](https://qoder.com/account/integrations) 创建的 `pt-` PAT。凭据只从 OpenCode 当前连接读取，不从插件选项、环境变量或凭据文件回退读取。

国际版的 provider/integration ID 为 `qoder-global`，原中国区仍为 `qoder`，可以同时连接。两边使用独立的连接、认证缓存及模型列表；国际版通过 `openapi.qoder.sh` 认证，通过 `api3.qoder.sh` 发现模型并发送请求，不使用中国区的凭据或地址。切换账号会在下一次请求读取新凭据。

内置 `qoder-global/auto`，启动时尝试发现账号可用模型及思考档位。读取模型接口的 `chat`（兼容 `models`）分组，并补充 `app` 分组独有的模型；同 ID 优先保留 `chat` 的参数和倍率，不合并 `quest`、`nap` 等任务分组。此补充仅作用于国际版，中国区保持原有行为。认证和模型列表请求共用 6 秒期限，未连接或发现失败时保留 Auto。首次连接或切换账号后，执行 `opencode reload` 刷新列表，再用 `/models` 选择模型。`discoverModels: false` 可关闭发现，`providerID` 可自定义。

Auto 沿用上游适配器的 180000 上下文、32768 输出默认值；发现的模型优先采用服务端返回的上下文和能力参数，未提供时使用 200000 上下文、32768 输出默认值。这些默认值不代表服务端公布的规格，零成本标记也不代表免费。

**Qoduck 是否出现取决于国际版接口对当前账号返回的模型列表。** 2026-11-07 实测接口将 `QoDuck`（ID `lmodel`）放在 `app` 分组，倍率为 `0×`、原倍率 `0.5×`；现有 CLI 请求通道的最小文本调用成功。旧版只读取 `chat` 时会漏掉该模型。插件按接口发现，不将 Qoduck 硬编码进保底列表。

[官方活动说明](https://docs.qoder.com/zh/events/qoduck-free)仍注明 Qoder CLI 等产品暂不支持该活动。上述接口倍率和单次调用结果不代表官方承诺第三方 CLI 享有免费额度，也不保证所有账号或后续时段可用；实际可用性和计费以服务端为准。

## Qoder 模型倍率

中国区和国际版都会在发现模型时，一并读取模型列表中的 `price_factor`（当前倍率）和 `original_price_factor`（原倍率），无需额外请求。`/models` 中的模型名称会显示为 `模型名 · 0.5×`；原倍率与当前倍率不同时显示为 `模型名 · 0×（原 0.5×）`。仅装饰显示名称，模型 ID 和请求参数不变。

倍率为本次模型列表返回的 Credits 消耗参考值，不是美元单价，不填入 OpenCode 的 token 价格字段。`0×` 如实展示，但不表示无限免费；实际消耗与活动额度以 Qoder 为准。接口未提供有效当前倍率、未连接或发现失败时不显示倍率，也不会把原倍率当成当前倍率。执行 `opencode reload` 可重新获取；不会在界面中按促销时段自行推算或定时刷新倍率。

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
src/providers/qoder-global/index.js  国际版独立入口，复用 Qoder 协议实现
src/providers/qoder-global/constants.js  国际版接口和保底模型
src/providers/qoder-global/language-model.js  国际版 AI SDK 工厂
src/providers/krill/index.js     /connect 注册、Responses SDK 和实时凭据
src/providers/krill/models.js    内置模型、模型发现和参数覆盖
```

新增供应商时增加 `src/providers/<name>/`，导出 setup 函数并注册到入口的 `providers` 映射。各供应商使用独立的 provider/integration ID；Qoder 两个地区共享协议实现，但地区参数由各自入口固定。

保留了原 Qoder 实现的思考解析、图片输入、工具调用、取消、认证超时和残缺流检测。2.x 通过 `provider.transform` 注册模型，使用 `aisdk:` 本地模块与 `aisdk.hook("language")` 接入 AI SDK v3 桥接；不使用旧 `catalog` 或 `aisdk.language` 接口。

根目录 `index.js` 是本地目录加载入口。OpenCode 2.0.27 的本地目录解析会查找根目录 `index`/`server`，因此该文件不能仅用 `package.json` 的 `main` 替代。

## 验证

```powershell
npm run check
npm test
node scripts/smoke-krill.mjs "C:/path/to/opencode2.exe"
```

测试使用模拟网络和虚构 PAT，覆盖 2.x 模型 schema、供应商隔离、账号切换、模型发现、工具约束、流式结束、取消和超时。国际版测试还覆盖同一 PAT 在两区的并发认证与缓存隔离、独立设备标识和凭据回退禁止。测试不会使用真实 PAT 请求 Qoder；真实账号端到端验证仍需在 2.x 中进行。

Krill 冒烟测试使用独立数据库和本地模拟 Responses 服务，验证真实 2.x 插件加载、连接密钥、生成及切换账号，不读取本机 API Key。

已在 Windows 的 `@opencode/cli 2.2.6` 上验证：中国区和国际版同时加载，中国区两个内置模型及国际版 Auto 均可见，两边的生成请求分别到达认证代码并提示连接对应供应商。该验证使用隔离的配置、数据库和凭据目录，没有调用真实 Qoder 接口，也未验证真实国际版账号或 Qoduck 的可用性。可重复执行：

```powershell
node scripts/smoke.mjs "C:/path/to/opencode2.exe"
```

验证数据保留在输出所示的系统临时目录，方便检查日志；不会写入现有 OpenCode 配置。

`QODERCN_DEBUG_BODY` 是原实现保留的调试开关，会把请求和提供者选项写入系统临时目录；日志可能包含凭据和对话内容，不要提交。
