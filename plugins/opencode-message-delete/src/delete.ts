import type { Plugin } from "@opencode/plugin/tui"

type Client = Plugin.Context["client"]
export type DeleteClient = {
  session: Pick<Client["session"], "get" | "active" | "inbox" | "revert">
  message: Client["message"]
}

// Read the actual end of the timeline, never a filtered assistant list: that
// could cross a newer user message. Idle is an execution marker, not a reply.
async function tail(client: DeleteClient, sessionID: string) {
  let cursor: string | undefined
  const markers: string[] = []
  const seen = new Set<string>()
  for (;;) {
    const page = await client.message.list({ sessionID, order: "desc", limit: 50, cursor })
    for (const message of page.data) {
      markers.push(message.id)
      if (message.type === "idle") continue
      if (message.type !== "assistant") {
        throw new Error("末尾不是 AI 消息，已停止；不会跨过或删除你的消息。")
      }
      return { messageID: message.id, signature: JSON.stringify([markers, message]) }
    }
    const next = page.cursor.next
    if (!next) throw new Error("当前会话没有可删除的末尾 AI 消息。")
    if (seen.has(next)) throw new Error("消息分页状态发生变化，请重试。")
    seen.add(next)
    cursor = next
  }
}

async function idle(client: DeleteClient, sessionID: string) {
  const [active, pending] = await Promise.all([
    client.session.active(), client.session.inbox.list({ sessionID }),
  ])
  if (active[sessionID] || pending.length) {
    throw new Error("会话正在运行或有待处理消息，请等待结束；自动续跑的 goal 请先暂停。")
  }
}

export async function deleteLastMessage(client: DeleteClient, sessionID: string) {
  await idle(client, sessionID)
  if ((await client.session.get({ sessionID })).revert) {
    throw new Error("已有待处理的回退，请先处理 /undo 或 /redo，再删除消息。")
  }
  const target = await tail(client, sessionID)
  // Recheck after fetching the timeline, including changes from other clients.
  await idle(client, sessionID)
  if ((await client.session.get({ sessionID })).revert) {
    throw new Error("回退状态已变化，本次未删除。")
  }
  if ((await tail(client, sessionID)).signature !== target.signature) {
    throw new Error("末尾消息已变化，本次未删除，请重试。")
  }

  let staged = false
  try {
    await client.session.revert.stage({ sessionID, messageID: target.messageID, files: false })
    staged = true
    await idle(client, sessionID)
    const session = await client.session.get({ sessionID })
    if (session.revert?.messageID !== target.messageID || session.revert.files?.length) {
      throw new Error("回退边界已被其他操作修改，未提交删除。")
    }
    if ((await tail(client, sessionID)).signature !== target.signature) {
      throw new Error("消息已变化，未提交删除。")
    }
    await client.session.revert.commit({ sessionID })
    return target.messageID
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    // clear() wakes the execution queue. Do not call it automatically after a
    // failed commit: this could unexpectedly start a model or disturb /undo.
    throw new Error(`${reason}${staged ? " 若仍显示回退状态，可用 /redo 恢复；本次未确认删除成功。" : ""}`)
  }
}
