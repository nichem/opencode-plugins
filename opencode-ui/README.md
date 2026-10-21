# opencode-ui

OpenCode 终端 UI 优化，面向 **OpenCode 2.x**。

- 思考进行中，在原来的 `Thinking` 标题后显示实时耗时，例如 `Thinking · 12s`；每秒变化，关闭动画后仍在标题同行显示。收起、展开或重新进入会话不会从零计时。
- 展开思考后，正文容器内部末尾独占一行显示 **↑ 收起思考**，随正文卸载清理，避免完成或中断后在 `Build · 模型 · 耗时 · interrupted` 等原生回复状态行附近残留。点击后调用该区块原来的折叠操作，从长内容底部收起时让标题回到视口内，可以再次点击标题展开。
- 思考完成后移除实时计时，沿用 OpenCode 原有的 `Thought` 标题、步数和最终耗时。

## 安装

通过仓库交互式安装器选择“UI 优化：思考实时计时 / 末尾收起”：

```powershell
npx github:nichem/opencode-plugins
```

也可以将以下条目合并到全局 `~/.config/opencode/cli.json` 的 `plugins` 数组中，保留其他字段、插件及选项：

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": [
    "git+https://github.com/nichem/opencode-plugins.git#main::path:opencode-ui"
  ]
}
```

这是纯终端插件，只需 `cli.json`，无需服务端入口。安装后重新打开 OpenCode 终端界面。

## 行为与选项

两项功能默认开启，可在现有插件条目中设置：

```json
{
  "package": "git+https://github.com/nichem/opencode-plugins.git#main::path:opencode-ui",
  "options": {
    "thinkingTimer": true,
    "collapseThinking": true
  }
}
```

计时使用原思考片段的创建时间：成组标题累计该组相邻思考步骤的耗时，单独展示的标题只计算当前片段，排除中间工具调用时间；缺少片段时间时使用该条 AI 消息的创建时间。隐藏的上下文更新不会重置同组计时，可见消息和轮次结束仍会分隔思考组。停止生成、发生错误、等待重试、输出正文或执行工具时不继续显示实时计时。插件不查询服务端接口，不修改消息、凭据、模型请求或 thinking 显示模式。

默认折叠模式支持底部收起；原生“始终显示思考”模式只增强实时计时，不显示无法生效的收起按钮。若要逐块展开和收起，先使用 OpenCode 的原生命令切回折叠模式。

选中文字、拖动或右键不会触发底部按钮。禁用或重载插件时删除插件创建的 UI 节点和定时器，保留原生区块与折叠状态。

执行 `/ui-enhance-status` 查看当前版本是否受支持，以及当前识别到的思考区块数量。发生运行异常时，插件停止增强并清理自身节点，状态中显示 OpenCode 版本、出错阶段和错误类型，不再统一误报为“结构不兼容”；诊断不包含异常正文或堆栈。

## 兼容边界

[官方 CLI 插件 API](https://opencode.ai/v2/docs/build/plugins/cli/#slots) 目前没有思考区块的专用插槽。本插件通过 OpenTUI 的公开渲染节点 API，适配 2.1.2 的内部布局：

- [group-view.tsx](https://github.com/anomalyco/opencode/blob/v2.1.2/packages/tui/src/routes/session/group-view.tsx)：成组思考标题及展开内容。
- [message-parts.tsx](https://github.com/anomalyco/opencode/blob/v2.1.2/packages/tui/src/routes/session/message-parts.tsx)：单独思考片段。

所有 2.x 版本均尝试启用增强，包括带 `v` 前缀、预发布标记或构建信息的版本，不逐个限制小版本；其他大版本显示不支持提示。渲染测试与宿主加载检查目前基于 2.1.2，其他 2.x 版本按运行结果适配。运行时过滤 Solid 的不可见占位节点和已销毁节点，仅匹配当前会话时间线中符合布局的标题；无法识别的区块跳过，扫描发生异常时停止增强并清理节点。不覆盖宿主原型、事件处理器、标题文字或折叠状态。关闭动画时，计时期间将对应标题容器临时改为横向排列，移除计时后恢复。

通过公开的 `session.composer.top` 插槽放置不占布局空间的定位节点，结合 2.1.2 的时间线容器结构确认当前会话的滚动区。长分组首次单独挂载、较早消息边界行被移除时，计时和收起按钮仍可工作。定位跟随插槽的实时会话 ID，忽略已隐藏或卸载的视图；停用插件时移除定位节点。插槽定位不可用时，保留原有的消息 ID 匹配方式。

## 开发验证

依赖安装与类型检查使用 Node.js 24+；真实 OpenTUI 渲染测试需要 Bun（上游声明要求 1.3.14+）。插件使用原生 JavaScript 分发，无需本地编译。

```powershell
npm ci
npm run check
npm test
npm run test:ui
npm run check:host
```

测试使用人工构造的思考内容和 OpenTUI 原生渲染器，并通过真正的 Solid 条件组件生成占位节点。覆盖实时刷新、完成切换、完成及中断状态行与收起按钮共存、分组替换、正文卸载时立即清理按钮、异常诊断与隐私保护、长内容底部点击、滚动位置、再次展开、片段行 ID、匿名分组首次挂载及边界行移除、会话切换与视图复用、其他面板隔离、隐藏上下文前后的耗时累计、分组与单独片段的计时差异、关闭及切换动画、选中文字、窄窗口、关闭选项和禁用清理。宿主检查在临时目录验证 OpenCode 2.1.2 加载器可以解析、加载纯 TUI 包；不读取用户 agent 文档，不更改真实配置。

MIT License，见 [LICENSE](./LICENSE)。
