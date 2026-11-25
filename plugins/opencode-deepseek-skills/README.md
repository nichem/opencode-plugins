# DeepSeek 会话技能

面向 **OpenCode 2.4.1+**，提供 Search、Fetch、OCR、ASR、TTS 五份按需加载的技能，直接调用 DeepSeek 独立工具 API。支持当前对话使用其他供应商的模型。

## 安装及升级

```powershell
npx github:nichem/opencode-plugins
```

在“管理插件”中勾选 `opencode-deepseek-skills`，回车预览并确认安装（默认否）。检测到本仓库旧 `opencode-websearch` 时，列表显示 `websearch → deepseek-skills`，默认勾选并保持现状；按 `u` 标记迁移，再回车确认，先准备新插件，再备份并替换旧服务端和终端入口。已同时安装两者时也通过此项完成迁移。取消勾选该统一入口并确认，会卸载新旧插件配置，保留账号、凭据和插件数据。

安装器管理的服务端配置中，旧 `websearch.provider = dss` 会改为 `random`，其他供应商选择不变。安装器不会扫描项目配置；项目或上级目录单独设置了 `dss` 时，请改为 `random` 或其他仍可用的原生供应商。旧 `/search` 选择器不再由新插件提供。

手动安装时，将以下条目合并到 `opencode.json`（或 `opencode.jsonc`）和 `cli.json` 的 `plugins`，并移除旧 websearch 的两个入口：

```json
"git+https://github.com/nichem/opencode-plugins.git#main::path:plugins/opencode-deepseek-skills"
```

执行 `opencode reload`，重新打开终端界面。插件分发为 JavaScript，安装时无需构建。

## 连接及开关

凭据沿用 `/connect` 中的 **DSS (DeepSeek Skills)**，内部连接 ID 仍为 `dss`。已连接旧 DSS 的用户不必重新输入 Key。每次调用读取当前激活账号，切换或断开连接立即影响后续调用。DeepSeek 模型供应商连接独立管理，不会复制其 Key；不使用环境变量、配置中的密钥或独立 token 文件。

执行 `/deepseek-skills`：

- 首页：创建空会话，保存开启状态后进入会话，沿用所选模型；不会发送消息或触发模型请求。第一条消息即可发现技能。
- 会话内：切换该会话的开启状态。重复执行关闭。
- 默认关闭；状态按会话 ID 保存，恢复同一会话及服务端重载后保留。其他会话、新会话、子会话和分叉会话默认关闭。
- 关闭后隐藏技能目录和执行入口，拒绝后续调用；已进入历史的说明和结果保留，已经开始的请求不会因关闭开关自动取消，可使用宿主停止操作。

## 技能如何加载

OpenCode 2.4.1 的原生 `/skills` 目录按项目共享，没有会话级目录过滤接口。本插件因此**不将五项技能注册到共享 `/skills` 列表**，也不改动其他技能、原生 `websearch`、MCP、shell、agent 或全局权限。

开启时仅向当前会话的模型提供 `deepseek_skill` 目录，列出五项能力及简短描述。模型按需读取随包分发的 `skills/<名称>/SKILL.md`，读取成功后才可通过 `deepseek_run` 执行对应技能。执行端再次核对会话开关和加载状态，猜测名称不能绕过开关。关闭后重新开启，需要重新加载技能。

两个入口不加入 Code Mode 工具目录，以免通过共享目录泄露到关闭的会话。加载使用原生 `skill` 权限（资源为 `deepseek-search` 等），API 调用使用对应的 `deepseek-search`、`deepseek-fetch`、`deepseek-ocr`、`deepseek-asr`、`deepseek-tts` 权限；读取和保存文件还会检查 `read`、`edit` 权限。遵循用户已有规则，不自动授予权限。

| 技能 | 参数与结果 |
| --- | --- |
| Search | query 1～128 个 Unicode 字符，count 1～50；可请求正文，返回带链接的结构化结果，不支持图片搜索 |
| Fetch | 无用户名密码的 HTTP/HTTPS URL，返回 Markdown 正文 |
| OCR | 图片、PDF、Word、PowerPoint，最多 100 MiB / 1000 页；逐页结果保留标记与截断状态 |
| ASR | 16 位 PCM WAV 或 Ogg Opus，最多 8 MiB / 120 秒；返回转写文本，自动识别语言 |
| TTS | stella / tide，生成 WAV 或 PCM；最多 10,000 个计费字符，汉字按 2 个计费字符；必须指定新输出文件 |

文件路径相对于会话目录。输出目录须已存在，不覆盖已有文件。Search、Fetch、OCR、ASR 可用 `output_file` 保存完整 JSON；模型展示最多 24,000 字符，截断时明确提示。JSON 响应上限为 32 MiB，TTS 音频上限为 100 MiB；遇到限制应缩小输入。文件上传和音频合成遵守已有权限及用户请求范围。

TTS 采用完整文本的 HTTP 请求接收音频，不提供 WebSocket 实时输入、自动播放或音频转换。网络请求支持取消，有超时限制，不自动重试付费请求；错误不会输出 API Key 或服务端错误正文。OCR 即使 HTTP 200 也检查返回的 `error`。

官方接口、计费及格式限制：[Search / Fetch](https://api-docs.deepseek.com/zh-cn/guides/search/)、[OCR](https://api-docs.deepseek.com/zh-cn/guides/ocr/)、[ASR](https://api-docs.deepseek.com/zh-cn/guides/asr/)、[TTS](https://api-docs.deepseek.com/zh-cn/guides/tts/)。

## 验证

```powershell
npm ci
npm run check
npm test
npm run check:smoke -- 'C:\path\to\opencode.exe'
```

检查包括两个入口加载、五份技能文件、模拟 API、会话隔离、首页创建顺序、关闭后的执行拦截和凭据切换。隔离宿主验证在依赖目录中创建临时 Git 项目、配置和数据库，使用人工模型、模拟响应及假凭据，验证首轮加载和执行以及重载持久化；结束后清理。不使用真实 DeepSeek API，不读取用户 agent 文档，不修改真实 OpenCode 配置。
