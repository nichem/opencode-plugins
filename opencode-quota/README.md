# OpenCode Quota

OpenCode **2.1.x** 的右侧额度面板。始终只显示当前模型所属供应商；切换模型时在原位置更新，同一供应商内切换模型也会重新查询。模型选择来自 TUI 的 `ui.model.current()`，展示通过官方 `sidebar.content` 插槽追加。

默认内置 **OpenCode Go**，其他供应商通过用户的 JavaScript 脚本提供额度。查询只读取连接和额度，不修改供应商、模型请求或 OpenCode 的其他设置。

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

## 内置 OpenCode Go

通过 `/connect` 连接 OpenCode Go，选择它的模型。插件通过 OpenCode 连接管理获取当前激活账号的 Key，调用固定地址：

```text
GET https://opencode.ai/zen/go/v1/usage
Authorization: Bearer <当前 Go 连接的 Key>
```

展示 5 小时、每周、每月三个窗口的剩余百分比和重置时间。数据使用服务端返回的使用率，不按模型价格估算金额，不查询网页 Cookie，不读取旧版 `auth.json`、`token.txt` 或环境变量凭据。兼容原版 `rollingUsage/usagePercent/resetInSec` 和新版 `usage.rolling/percent/resetsAt` 数据。

接口参考：[OpenCode 官方路由](https://github.com/anomalyco/opencode/blob/v2.1.0/packages/console/app/src/lib/inference-proxy.ts)、[原始额度 API 实现](https://github.com/anomalyco/opencode/pull/16513/files)。

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

支持 `.mjs`，以及按所在目录模块规则解释的 `.js`；推荐 `.mjs`。`~/` 跟随服务端用户目录，相对路径以服务端当前项目目录为基准，也可使用绝对路径。无需把脚本添加为 OpenCode 插件。每次查询重新加载脚本，修改后刷新即可生效。为 `opencode-go` 配置脚本可覆盖内置适配器。

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
npm run check
npm test
npm run check:host
node scripts/smoke.mjs 'C:/path/to/opencode.exe'
```

单元测试使用 Node.js 24+，覆盖 API 数据、脚本错误与超时、凭据脱敏、取消、快速切换模型、保留旧数据和账号失效。host 检查解析两个入口、加载服务端入口并编译 TUI JSX。原生 smoke 使用临时配置、数据库和人工构造的供应商/Key，检查实际 OpenCode 2.1.0 的 RPC、连接读取及 Worker 行为，不调用付费模型，不读取用户 agent 文档或真实配置。OpenTUI 的独立运行环境另需满足其 Node/Bun 引擎要求；正常使用由 OpenCode 内置运行时负责。
