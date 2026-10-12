import type { Plugin } from "@opencode/plugin/tui"
import { deleteLastMessage } from "./src/delete.ts"

export default {
  id: "opencode-message-delete.tui",
  setup(ctx) {
    const deleting = new Set<string>()
    ctx.keymap.layer(() => ({ commands: [{
      id: "message.delete-last",
      title: "删除末尾一条 AI 消息",
      description: "逐条删除 AI 消息，保留你的问题和已修改的文件",
      group: "Session",
      palette: true,
      slash: { name: "delete-last-message" },
      enabled: () => {
        const route = ctx.ui.router.current()
        return route.type === "session" && ctx.data.session.status(route.sessionID) === "idle"
      },
      async run() {
        const route = ctx.ui.router.current()
        if (route.type !== "session") return
        const sessionID = route.sessionID
        if (deleting.has(sessionID)) return
        deleting.add(sessionID)
        let deleted = false
        try {
          await deleteLastMessage(ctx.client, sessionID)
          deleted = true
          ctx.data.session.invalidate(sessionID)
          ctx.data.session.message.invalidate(sessionID)
          await Promise.all([ctx.data.session.sync(sessionID), ctx.data.session.message.sync(sessionID)])
          ctx.ui.toast.show({ sessionID, variant: "success", message: "已删除末尾一条 AI 消息，文件保持不变。" })
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          ctx.ui.toast.show({ sessionID, variant: "warning", duration: 8000,
            message: deleted ? `消息已删除，但界面刷新失败：${reason}` : reason })
        } finally {
          deleting.delete(sessionID)
        }
      },
    }] }))
  },
} satisfies Plugin.Definition
