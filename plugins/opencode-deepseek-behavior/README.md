# DeepSeek 行为增强

为 OpenCode 2.x 的 DeepSeek 模型追加协作行为提示词，改善埋头执行、沿用旧任务提交授权、讨论阶段直接动手的问题。基于 OpenCode **2.2.0** 接口开发和验证。

- **默认开启**：首次无已保存设置时启用；之后以用户的开关选择为准。
- **按模型 ID 匹配**：忽略大小写，只要当前请求模型 ID 包含 `deepseek` 就命中，不限制供应商；供应商名包含该词而模型 ID 不含时不命中。
- **右侧点击切换**：命中模型时在侧栏显示“DeepSeek 行为增强 [开 / 关]”，点击标题行切换。也可执行 `/deepseek-behavior`，适用于侧栏隐藏或窄终端。
- **跨会话保存**：使用 OpenCode 服务端的插件持久化存储。新建会话、重启、重新加载插件均保留，并在同一服务端的不同项目之间共享；连接其他服务器时使用该服务器的设置。
- **下一次请求生效**：每次主对话模型请求（含工具续跑）按实际模型 ID 和已保存状态判断。已经发送的请求不受开关影响。多个界面通过事件刷新，并每 15 秒核对一次状态。

## 行为规则

提示词要求模型在开始工具操作前简短说明意图，在完成一轮排查、获得关键发现、调整方案、遇到阻塞或切换工作阶段时适度汇报；连续完成一组工具操作后，先交代发现与下一步，再继续工作。相邻节点可以合并汇报，避免逐项刷屏。汇报按工作节点触发，不依赖模型判断经过了多少秒。讨论方案、询问理解时先回答，明确要求执行后持续推进。修改、提交、推送分别遵循当前任务授权，历史任务的提交决定不会自动延续到新任务或追加提交。

提示词源码见 [src/behavior.ts](./src/behavior.ts)。只在 `session.hook("context")` 中追加系统文本，保留原有提示词、消息、工具、采样参数和权限；不注入标题生成、压缩摘要等辅助请求，不把提示词写入聊天历史或用户配置。

这是行为引导，遵循程度取决于模型，**没有增加 Git 命令拦截**。

## 安装

在仓库交互式安装器中选择“DeepSeek 行为增强与持久化开关”：

```powershell
npx github:nichem/opencode-plugins
```

或将相同地址分别追加到 `opencode.json` / `opencode.jsonc` 和 `cli.json` 的 `plugins` 中，保留原有字段、其他插件与选项：

```json
{
  "plugins": [
    "git+https://github.com/nichem/opencode-plugins.git#main::path:plugins/opencode-deepseek-behavior"
  ]
}
```

服务端入口负责提示词与存储，TUI 入口负责开关；两个入口需要同时配置。执行 `opencode reload` 并重新打开 TUI。随包提供预编译 `tui.js`，安装时无需编译。

读取或保存失败时会明确显示，点击可重新读取；不会把未确认的保存显示为成功。卸载仅移除插件配置，持久化的开关状态保留。

## 开发验证

```powershell
npm ci
npm run build:tui
npm run check
npm test
npm run test:ui
npm run check:host
npm run check:smoke -- "C:\path\to\opencode.exe"
```

`test:ui` 需要 Bun；`check:smoke` 使用本机 OpenCode 可执行文件，启动隔离的服务端和离线模型，验证真实请求的注入以及跨项目、会话、安装源目录迁移和重启的持久化。测试仅使用人工构造的请求、临时包和模拟设置，不读取用户 agent 文档，不修改真实 OpenCode 配置。

接口参考：[服务端模型请求钩子与存储](https://opencode.ai/v2/docs/build/plugins/server/)、[TUI 插槽](https://opencode.ai/v2/docs/build/plugins/cli/)。
