# 来源与迁移

基于 `mirsella/opencode-goal` 的 npm 发布版本 **0.4.3**，上游提交：
`de78a048030e0fb94745233a3ebba19fd6d99522`。

- 上游：https://github.com/mirsella/opencode-goal
- 本次来源：本机已安装的 npm 包中的 TypeScript 源码。
- `src/core.ts` 保留上游命令解析、提示词、耗时计算和状态显示逻辑。
- 2.x 插件入口、事件调度、持久化适配、RPC 和 TUI 入口由本仓库维护。
- 保留上游 MIT `LICENSE`。这是个人维护的迁移版本，不是上游官方 2.x 发布。

没有复制用户的目标状态、账号凭据或原插件的依赖目录。
