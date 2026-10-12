# opencode-providers

个人维护的 OpenCode **2.x** 多供应商插件。目前实现 **Qoder 中国区**，未来供应商放在独立模块中。

针对 `@opencode/plugin 2.0.27` 接口适配。使用 Node.js 24+；JavaScript 源码直接加载，无需编译。

## 安装

在本目录执行：

```powershell
npm ci
```

在 OpenCode **2.x** 使用的 `opencode.json` 或 `opencode.jsonc` 中添加：

```jsonc
{
  "plugins": [
    {
      "package": "C:/Code/My/Projects/opencode-plugins/opencode-providers",
      "options": {
        "providers": {
          "qoder": {
            "enabled": true,
            "discoverModels": true,
            "setDefault": false
          }
        }
      }
    }
  ]
}
```

也可以直接在 `plugins` 中填目录字符串，默认启用 Qoder CN 和模型发现。`setDefault: true` 将默认模型设为 `qoder/auto`；默认不会覆盖你的模型选择。`providerID` 可选，默认 `qoder`。

这是服务端插件，不注册到 `cli.json`。配置和源码更新后重启 OpenCode，确保该目录的修改已加载。

不要在同一 2.x 配置里同时启用旧 Qoder 插件和本插件的 `qoder` 提供者。本插件不会修改现有全局配置，也不兼容 1.x 的插件接口。

## Qoder CN 认证

只支持中国区 `pt-` 开头的 Personal Access Token。在 OpenCode 2.x 中运行 `/connect`，选择 **Qoder CN**，输入 PAT。插件只读取 OpenCode 当前连接保存的凭据。

PAT 自动换取临时凭据，并按过期时间缓存。每次请求重新读取当前连接，切换账号后不会继续使用模型实例里缓存的旧 PAT。

内置 `auto` 和 `qmodel_38max`。启动时尝试读取账号可用模型，认证和模型列表请求共用 6 秒期限；失败时保留内置模型。首次连接或切换账号后，重启插件以刷新模型列表；`discoverModels: false` 可关闭发现。

Qwen3.8-Max 提供 `low`、`medium`、`xhigh`、`none` 思考强度，在线模型以服务端列表为准。目录里标记的零成本表示插件没有定价数据，不代表供应商免费。

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
```

新增供应商时增加 `src/providers/<name>/`，导出 setup 函数并注册到入口的 `providers` 映射。各供应商使用独立的 provider/integration ID 和认证实现。

保留了原 Qoder 实现的思考解析、图片输入、工具调用、取消、认证超时和残缺流检测。2.x 通过 `provider.transform` 注册模型，使用 `aisdk:` 本地模块与 `aisdk.hook("language")` 接入 AI SDK v3 桥接；不使用旧 `catalog` 或 `aisdk.language` 接口。

根目录 `index.js` 是本地目录加载入口。OpenCode 2.0.27 的本地目录解析会查找根目录 `index`/`server`，因此该文件不能仅用 `package.json` 的 `main` 替代。

## 验证

```powershell
npm run check
npm test
```

测试使用模拟网络和虚构 PAT，覆盖 2.x 模型 schema、供应商隔离、账号切换、模型发现、工具约束、流式结束、取消和超时。测试不会使用真实 PAT 请求 Qoder；真实账号端到端验证仍需在 2.x 中进行。

已在 Windows 上用临时安装的 `@opencode/cli 2.0.27` 验证：插件加载成功、两个内置模型可见，真实服务端的一次生成请求到达 Qoder 认证代码并报告缺少 PAT。该验证使用隔离的配置、数据库和凭据目录，没有调用真实 Qoder 接口。可重复执行：

```powershell
node scripts/smoke.mjs "C:/path/to/opencode2.exe"
```

验证数据保留在输出所示的系统临时目录，方便检查日志；不会写入现有 OpenCode 配置。

`QODERCN_DEBUG_BODY` 是原实现保留的调试开关，会把请求和提供者选项写入系统临时目录；日志可能包含凭据和对话内容，不要提交。
