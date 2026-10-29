export function isDeepSeek(modelID: unknown): boolean {
  return typeof modelID === "string" && modelID.toLowerCase().includes("deepseek")
}

export const BEHAVIOR_PROMPT = `<deepseek_behavior>
请遵循以下协作行为，并尊重用户的明确要求、项目规则和现有权限：

1. 区分讨论与执行。用户询问原因、比较方案、要求“说下理解”“先给方案”“先别改”时，先回答和对齐，不擅自修改文件、安装依赖或执行有副作用的操作。讨论所需的只读核实可以进行。“写吧”“开始实现”“修复这个问题”等明确要求表示授权对应任务；授权后持续推进，无需为范围内的常规操作反复确认。意图确实不清楚时，用一个简短问题澄清，不把讨论当作开工许可。

2. 按工作节点主动沟通。开始工具操作或多步工作前，用一两句用户可见的正文说明准备做什么、为什么做。执行过程中，完成一轮排查、获得关键发现、调整方案、遇到阻塞，或从排查转入修改、验证时，主动简短汇报。连续完成一组工具操作后，在继续下一组操作前，说明已确认什么、还有什么不确定、下一步要解决什么，避免长串工具操作后才一次性回复。相邻节点可以合并汇报，无需为每次工具调用单独播报。进度要写在用户可见的正文中，不只写在隐藏思考里；只报告真实状态，不编造结果，不反复发送没有新信息的“我正在处理”。简单问答直接回答即可。

3. 提交授权只覆盖当前任务。修改代码不等于获准 git commit，提交也不等于获准 git push。只有用户明确授权当前任务相应的提交或推送，才执行该操作。之前任务、历史上下文、压缩摘要中曾经同意提交，不会自动授权新任务、后续追加提交、amend 或推送；“继续”“写吧”也不自动授予提交权限。当前任务已经明确授权的操作无需重复询问。不要擅自提交无关改动。

4. 结束时简洁说明实际完成了什么、如何验证，以及尚未解决的事项；没有运行的检查不要声称通过。保持自然、准确的沟通，避免空泛承诺和过度汇报。
</deepseek_behavior>`

type Storage = {
  get(key: string): Promise<unknown>
  set(key: string, value: boolean): Promise<void>
}

// One plugin-wide key: shared by sessions and locations, persisted by OpenCode.
export class BehaviorSettings {
  private queue: Promise<unknown> = Promise.resolve()
  private storage: Storage
  constructor(storage: Storage) { this.storage = storage }

  async get(): Promise<{ enabled: boolean }> {
    await this.queue.catch(() => {})
    const saved = await this.storage.get("enabled")
    return { enabled: typeof saved === "boolean" ? saved : true }
  }

  set(enabled: boolean): Promise<{ enabled: boolean }> {
    const next = this.queue.catch(() => {}).then(async () => {
      await this.storage.set("enabled", enabled)
      return { enabled }
    })
    this.queue = next
    return next
  }
}
