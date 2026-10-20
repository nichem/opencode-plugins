# OpenCode Quota

OpenCode **2.1.x** 的右侧额度面板。始终只显示当前模型所属供应商；切换模型时在原位置更新，同一供应商内切换模型也会重新查询。模型选择来自 TUI 的 `ui.model.current()`，展示通过官方 `sidebar.content` 插槽追加。

默认内置 **OpenCode Go、DeepSeek、智谱 / Z.AI Coding Plan、Kimi For Coding**，其他供应商通过用户的 JavaScript 脚本提供额度。查询只读取连接和额度，不修改供应商、模型请求或 OpenCode 的其他设置。

## 安装

通过本仓库的交互式安装器选择“当前供应商额度侧栏”：

```powershell
npx github:nichem/opencode-plugins
```

也可以将以下地址分别合并到 `opencode.json` / `opencode.jsonc` 和 `cli.json` 的 `plugins` 数组，保留原配置：

```json
{
  "plugins": [
    "git+https://github.com/nichem/opencode-plugins.git#main::path:opencode-quota"
  ]
}
```

服务端负责凭据和额度查询，终端入口负责显示和监听模型选择，两个入口都需要。执行 `opencode reload` 后重新打开 TUI；额度卡片随 OpenCode 的会话侧栏显示，侧栏关闭或终端宽度不足时不强行更改布局。远程连接时，服务端也必须安装本插件，自定义脚本放在服务端。

终端入口使用仓库内预编译的 `tui.js`，安装时无需本地编译。OpenTUI 会跳过 `node_modules` 中的 TSX 转换，直接分发 `tui.tsx` 会导致 `Cannot find package 'react'` 加载错误；遇到此错误请通过安装器更新额度插件，再重新打开 TUI。

## 内置 OpenCode Go

通过 `/connect` 连接 OpenCode Go，选择它的模型。插件通过 OpenCode 连接管理获取当前激活账号的 Key，调用固定地址：

```text
GET https://opencode.ai/zen/go/v1/usage
Authorization: Bearer <当前 Go 连接的 Key>
```

展示 5 小时、每周、每月三个窗口的剩余百分比和重置时间。数据使用服务端返回的使用率，不按模型价格估算金额，不查询网页 Cookie，不读取旧版 `auth.json`、`token.txt` 或环境变量凭据。兼容原版 `rollingUsage/usagePercent/resetInSec` 和新版 `usage.rolling/percent/resetsAt` 数据。

接口参考：[OpenCode 官方路由](https://github.com/anomalyco/opencode/blob/v2.1.0/packages/console/app/src/lib/inference-proxy.ts)、[原始额度 API 实现](https://github.com/anomalyco/opencode/pull/16513/files)。

## 其他内置供应商

通过 `/connect` 保存对应供应商的连接，然后选择该供应商的模型即可，无需配置脚本。精确匹配 OpenCode 的 `providerID`：

| 供应商 | `providerID` | 展示内容 |
| --- | --- | --- |
| DeepSeek | `deepseek` | 分币种显示可用、赠送和充值余额 |
| 智谱 Coding Plan | `zhipuai-coding-plan` | 5 小时、每周等套餐窗口及每月 MCP 额度 |
| Z.AI Coding Plan | `zai-coding-plan` | 国际站的套餐窗口及每月 MCP 额度 |
| Kimi For Coding 国内站 | `kimi-for-coding`、`kimi-code-plan-cn` | 5 小时、每周和接口返回的月度订阅额度 |
| Kimi For Coding 国际站 | `kimi-code-plan-global` | 国际站的对应订阅额度 |

DeepSeek 调用 `GET https://api.deepseek.com/user/balance`，保留接口余额精度，不按充值额推算总额度或绘制比例进度条。[官方余额 API](https://api-docs.deepseek.com/api/get-user-balance/)说明了币种和三种余额字段。

智谱调用 `GET https://open.bigmodel.cn/api/monitor/usage/quota/limit`，Z.AI 使用 `https://api.z.ai` 下的相同路径。按照[官方查询实现](https://github.com/zai-org/zai-coding-plugins/blob/0446d0bb0bc537d97d3ab3664c4b8b9c4a0e1254/plugins/glm-plan-usage/skills/usage-query-skill/scripts/query-usage.mjs)使用当前连接的原始 Key 作为 `Authorization`。兼容 `TOKENS_LIMIT`、新版 `CREDIT_LIMIT` 和 `TIME_LIMIT`，按窗口元数据区分周期，优先使用接口百分比；MCP 有总量时显示已用 / 总量。普通 `zhipuai`、`zai` 按量供应商不自动当作 Coding Plan。

Kimi 调用 `GET https://api.kimi.com/coding/v1/usages`，国际站为 `https://api.kimi.ai/coding/v1/usages`。支持 API Key，以及 OpenCode 已保存的 OAuth access token；不读取 Kimi CLI 凭据、不自行刷新 OAuth、不使用网页 Cookie。按照[Kimi 官方当前实现](https://github.com/MoonshotAI/kimi-code/blob/67325c1b25e46b2fc66043bceab059221b719fa9/packages/oauth/src/managed-usage.ts)读取 `usages.limit_5h/limit_7d/limit_month_total/limit_month_code` 的使用比例，并兼容旧版 `usage/limits` 计数格式。两种格式同时提供同一周期的额度时会核对剩余比例，容忍 1 个百分点的舍入差异；重置时间相差超过 1 分钟时视为不同周期。有效数据冲突会显示“同一额度窗口的新旧数据不一致”，保留上次成功数据并提示刷新失败，不发布新的满额度结果。月度窗口只在接口提供时展示，缺失数据不补零；不把订阅百分比解释为请求次数或金额，不查询 Moonshot 开放平台 API 余额。

所有内置请求只发往所选供应商的固定官方地址，禁用重定向，不跨国内 / 国际站重试，也不读取环境变量凭据。读取连接凭据前会检查 OpenCode 当前供应商与模型的有效 `settings.baseURL`；模型的设置覆盖供应商的设置。使用代理、自定义域名、其他地区地址、无法确认默认地址的运行包，或模型任一变体使用非官方地址时，侧栏显示“未配置”并提示配置额度脚本，不读取凭据、不发送内置查询。每次查询重新校验，模型或地址变化不会沿用旧校验结果；用户配置的脚本仍可覆盖内置查询并使用对应连接。

异常响应正文不传入侧栏；字段缺失、格式错误、连接无效和无可用套餐时会显示查询错误。未列出的自定义供应商 ID 仍需配置脚本。

## 自定义供应商脚本

仅在**服务端配置**的本插件条目中配置 `providers`，以当前模型的准确 `providerID` 为键。已有供应商的 ID 可从模型列表确认。

```jsonc
{
  "plugins": [
    {
      "package": "git+https://github.com/nichem/opencode-plugins.git#main::path:opencode-quota",
      "options": {
        "timeoutMs": 10000,
        "providers": {
          "my-provider": {
            "script": "~/.config/opencode/quota/my-provider.mjs"
          }
        }
      }
    }
  ]
}
```

支持 `.mjs`，以及按所在目录模块规则解释的 `.js`；推荐 `.mjs`。`~/` 跟随服务端用户目录，相对路径以服务端当前项目目录为基准，也可使用绝对路径。无需把脚本添加为 OpenCode 插件。每次查询重新加载脚本，修改后刷新即可生效。为任一内置供应商的准确 ID 配置脚本可覆盖其内置适配器。

脚本默认导出一个函数，返回对象或返回该对象的 Promise：

```javascript
export default async function quota({ providerID, modelID, credential, signal }) {
  if (credential?.type !== "key") throw new Error("请先连接供应商")
  const response = await fetch("https://api.example.com/account/quota", {
    headers: { Authorization: `Bearer ${credential.key}` },
    signal,
    redirect: "error",
  })
  if (!response.ok) throw new Error("查询失败")
  const data = await response.json()
  return {
    title: "我的供应商",
    items: [
      { label: "余额", value: `$${data.balance}` },
      { label: "月额度", used: data.used, limit: data.limit, unit: "次", resetsAt: data.resetsAt },
    ],
  }
}
```

`credential` 是所选供应商关联 integration 的当前连接凭据，没有已保存的连接时为 `undefined`；Key 使用 `credential.key`，OAuth 使用 `credential.access` 等官方字段。函数也能在不需要认证时忽略它。插件不代替供应商执行登录、刷新账号或切换账号。

返回数据约定：

| 字段 | 说明 |
| --- | --- |
| `title` | 可选的卡片标题，最多 80 字符；省略时使用供应商名 |
| `items` | 1–12 项额度指标 |
| `items[].label` | 必填名称，最多 80 字符 |
| `items[].value` | 可选展示文本，最多 160 字符，例如余额；优先于默认数值文案 |
| `items[].used`、`limit` | 同时提供非负已用量与大于 0 的总量，显示剩余比例进度条 |
| `items[].unit` | 可选单位；`%` 时显示“剩余 N%” |
| `items[].resetsAt` | 可选 ISO 日期时间，建议带时区，例如 `2026-11-01T00:00:00Z` |

每项至少提供 `value` 或 `used/limit`。纯文本指标不显示进度条。剩余比例越少，颜色从绿色变为黄色、红色；超额时进度条最低为 0%。

## 刷新与状态

默认每 60 秒查询当前供应商，也可执行 `/quota-refresh` 或使用命令面板刷新。只改变数值，不轮播其他供应商。终端配置 `cli.json` 中可设置：

```jsonc
{
  "plugins": [
    {
      "package": "git+https://github.com/nichem/opencode-plugins.git#main::path:opencode-quota",
      "options": { "refreshMs": 60000, "requestTimeoutMs": 15000 }
    }
  ]
}
```

`refreshMs` 支持 10000–3600000，设为 0 关闭定时刷新；模型切换、账号变化和手动刷新仍有效。服务端 `timeoutMs` 支持 1000–60000，默认 10000。终端 `requestTimeoutMs` 独立限制整个 RPC 请求等待时间，支持 1000–120000，默认 15000；如果增大服务端查询超时，应将终端请求超时设得更长，为网络往返留出余量。

网络挂起时，即使底层请求没有响应取消信号，终端也会在请求超时后退出刷新状态、保留上次额度，并允许下一次定时或手动重试。相同卡片的并发刷新会合并；模型、项目、账号变化时立即清空旧数据并取消旧查询，迟到或已经超时的响应不会覆盖新卡片。同一账号刷新失败时保留上次成功数据并标明更新时间。未适配供应商显示“尚未配置额度脚本”，不会假装额度为零。

脚本在独立 Worker 中执行，超时、取消、插件卸载时终止 Worker，避免同步死循环阻塞 OpenCode 主进程。脚本的标准输出和异常原文不会进入插件返回值；TUI 只接收展示数据。**Worker 用于执行与超时管理，不是安全沙箱**：插件与用户 JS 都是本机受信任代码，应只使用可信来源。凭据不会由本插件另存到配置或磁盘。

## 预览与验证

[静态 UI 预览](./docs/preview.html) 使用示例额度，供查看布局，最终字体、颜色和边距跟随 TUI 主题。

```powershell
npm ci
npm run build
npm run check
npm test
npm run check:host
node scripts/smoke.mjs 'C:/path/to/opencode.exe'
```

修改 `tui.tsx` 后执行 `npm run build`，并将生成的 `tui.js` 一起提交；`npm run check` 会检查产物是否与源码一致。构建仅转换本插件的 JSX，Solid/OpenTUI 仍由宿主运行时提供。

单元测试使用 Node.js 24+，覆盖内置供应商的新旧 API 数据、Kimi 数据冲突、国内 / 国际站请求隔离、供应商 / 模型 / 变体地址校验、代理地址在读取凭据前被拦截、脚本覆盖内置查询、脚本错误与超时、凭据脱敏、取消、快速切换模型、保留旧数据和账号失效。新增供应商接口使用模拟响应验证，不将此视为真实账号联调。host 检查将分发文件复制到临时 `node_modules`，不带开发用 `tsconfig.json`，并实际加载服务端与预编译 TUI 入口。原生 smoke 使用临时配置、数据库和人工构造的供应商/Key，检查实际 OpenCode 2.1.0 的 RPC、代理模型拦截、连接读取及 Worker 行为，不调用付费模型，不读取用户 agent 文档或真实配置。OpenTUI 的独立运行环境另需满足其 Node/Bun 引擎要求；正常使用由 OpenCode 内置运行时负责。
