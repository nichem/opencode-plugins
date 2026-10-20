# opencode-goal（个人维护的 2.x 版本）

基于 `mirsella/opencode-goal 0.4.3` 迁移，适配 OpenCode **2.0.27**。不是同名 npm 包的官方新版。源码为 TypeScript，OpenCode 直接加载；本地检查使用 Node.js 24+。

## 安装

先删除原来的 `opencode-goal` npm 配置条目，避免两个插件同时注册 `/goal`。

```powershell
opencode plugin add 'git+https://github.com/nichem/opencode-plugins.git#main::path:opencode-goal'
```

上面的命令安装服务端插件。在 `~/.config/opencode/cli.json` 的 `plugins` 中也添加同一地址，启用状态提示的 TUI 入口：

```json
{
  "plugins": ["git+https://github.com/nichem/opencode-plugins.git#main::path:opencode-goal"]
}
```

已有 `plugins` 数组时追加，保留其他配置。服务端 `opencode.json` 的 `plugins` 也可以直接填写该地址。私有仓库需要 Git 访问权限。

本地开发可以在这两个配置中使用插件目录绝对路径，并在本目录执行 `npm ci`。配置修改后重启 OpenCode 服务及终端界面。

## 功能

| 命令 | 行为 |
| --- | --- |
| `/goal` | 查看状态、目标和累计耗时；没有目标时显示用法 |
| `/goal <objective>` | 创建或替换目标；保留已有累计耗时 |
| `/goal append <text>` | 追加目标并继续；保留累计耗时 |
| `/goal pause` | 暂停后续自动续跑，不主动中断正在执行的模型请求 |
| `/goal resume` | 恢复目标并继续；也可恢复状态仍为 active 但调度已中止的目标，不重复提交正在等待或执行的续跑 |
| `/goal clear` | 清除目标和待调度续跑 |

模型通过 `update_goal({"status":"complete","revision":"<续跑提示中的目标版本>"})` 标记完成，`revision` 必须原样取自对应续跑提示的 `<goal_revision>`。该工具仅在目标活跃时注册，并从无活跃目标的会话上下文中移除。保留原插件的完成审查提示词；不增加额外裁判模型、轮数限制或 token 预算。

完成操作同时校验工具快照和模型实际收到的目标版本。运行中替换、追加、清除后重建目标，或暂停后恢复时，旧请求的完成调用会被拒绝；即使后续请求刷新了工具，沿用旧上下文重试也不能完成新目标或取消其续跑。拒绝后模型应结束本轮，等待新续跑传入目标和版本，不猜测版本；正在保存目标变更时同样拒绝旧完成调用。计时更新、查看状态及其他会话的目标变更不影响当前请求的完成资格。

每次执行成功后自动续跑；连续两次续跑没有调用工具时使用原版停滞恢复提示词。使用会话当前的模型、变体和 agent，`plan` agent/plan 变体不自动续跑。用户中断及执行失败会暂停目标，避免错误循环。

运行中设置或追加目标时，插件会等待会话空闲后再提交续跑，不预先向服务端队列追加模型请求。暂停、清除和更新目标会取消旧的等待；已经开始的请求仍会正常结束。累计耗时保留不足一秒的部分，仅在显示时取整。

取消在命令或用户输入到达插件时立即生效，不等待状态写入完成；读取会话、保存状态和刷新工具后都会重新检查取消状态，避免旧续跑在这些异步操作期间被提交。

## 状态与 1.x 差异

- 2.x 原生插件存储按位置、工作区和会话隔离状态。重启保留目标，停机时间不计入耗时；启动不会自行发起模型请求，会在下一次成功执行后继续，也可以用 `/goal resume` 手动重启。暂停或清除因存储错误失败时不会自动恢复续跑；修复错误后可显式执行 `/goal resume`。
- 首次访问对应会话时，会只读导入原版状态文件：`$XDG_STATE_HOME/opencode-goal/scope_<hash>/sessions.json`（默认根目录 `~/.local/state`）。原 `OPENCODE_GOAL_STATE_FILE` 仅用于指定导入来源。V2 不覆盖旧文件，也不会恢复已在 V2 清除的目标。
- 2.x 使用原生合成消息提交续跑提示，会在会话中留下有描述的续跑记录，不再使用 1.x 的隐藏触发消息和历史消息修改钩子。
- 状态提示使用 RPC + TUI 通知，不向模型提交状态消息。只装服务端仍可执行目标，但查看提示需要 TUI 入口；无界面客户端可调用 `opencode-goal` RPC 的 `status` 方法，输入 `{ "sessionID": "..." }`。
- 错误暂停比旧版更严格；存储失败不会被当作成功的状态变更。

## 验证

```powershell
npm ci
npm run check
npm test
node scripts/smoke.mjs "C:/path/to/opencode.exe"
```

单元测试覆盖命令、耗时、会话隔离、重复事件、暂停/恢复、停滞恢复、重启与旧状态导入，以及目标变更和完成调用的并发处理。集成验证启动隔离的真实 OpenCode 2.x 服务，使用本地模拟模型验证 `/goal` → 自动续跑 → `update_goal` → 完成后停止，并验证旧上下文在工具刷新后连续重试仍被拒绝、新续跑收到目标版本后可以正常完成，不使用真实账号或请求远程模型。

来源及许可见 [NOTICE.md](./NOTICE.md) 和 [LICENSE](./LICENSE)。
