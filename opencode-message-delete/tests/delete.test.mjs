import assert from "node:assert/strict"
import test from "node:test"
import { deleteLastMessage } from "../src/delete.ts"
import plugin from "../tui.ts"

function fixture() {
  const state = {
    messages: [{ id: "u", type: "user" }, { id: "a1", type: "assistant" },
      { id: "a2", type: "assistant", content: [{ type: "text", text: "final" }] }, { id: "end", type: "idle" }],
    revert: undefined, active: {}, pending: [], stages: [], commits: 0, lists: 0,
  }
  const client = {
    message: { async list() { state.lists++; await state.onList?.(); return { data: state.messages.toReversed(), cursor: {} } } },
    session: {
      async active() { return state.active },
      async get() { return { revert: state.revert } },
      inbox: { async list() { return state.pending } },
      revert: {
        async stage(input) { state.stages.push(input); state.revert = { messageID: input.messageID, files: [] }; await state.onStage?.(); return state.revert },
        async commit() {
          if (state.failCommit) throw new Error("offline")
          state.commits++
          state.messages = state.messages.slice(0, state.messages.findIndex(m => m.id === state.revert.messageID))
          state.revert = undefined
        },
        async clear() { assert.fail("Must not clear a revert and wake execution implicitly") },
      },
    },
  }
  return { state, client }
}

test("deletes one assistant and its idle marker at a time, stops at the user", async () => {
  const { state, client } = fixture()
  assert.equal(await deleteLastMessage(client, "s"), "a2")
  assert.deepEqual(state.messages.map(m => m.id), ["u", "a1"])
  assert.deepEqual(state.stages[0], { sessionID: "s", messageID: "a2", files: false })
  assert.equal(await deleteLastMessage(client, "s"), "a1")
  await assert.rejects(deleteLastMessage(client, "s"), /末尾不是 AI/)
  assert.deepEqual(state.messages.map(m => m.id), ["u"])
  assert.equal(state.commits, 2)
})

test("does not skip newer user, synthetic, compaction or model change messages", async () => {
  for (const type of ["user", "synthetic", "compaction", "model-switched"]) {
    const { state, client } = fixture()
    state.messages.push({ id: "new", type })
    await assert.rejects(deleteLastMessage(client, "s"), /末尾不是 AI/)
    assert.equal(state.stages.length, 0)
  }
})

test("empty, running, queued or reverted sessions are left unchanged", async () => {
  for (const change of [s => s.messages = [], s => s.active = { s: { type: "running" } },
    s => s.pending = [{}], s => s.revert = { messageID: "a1", files: ["file"] }]) {
    const { state, client } = fixture()
    change(state)
    await assert.rejects(deleteLastMessage(client, "s"))
    assert.equal(state.stages.length, 0)
  }
})

test("a changed tail before stage prevents deletion", async () => {
  const { state, client } = fixture()
  state.onList = () => { if (state.lists === 2) state.messages.push({ id: "a3", type: "assistant" }) }
  await assert.rejects(deleteLastMessage(client, "s"), /末尾消息已变化/)
  assert.equal(state.stages.length, 0)
})

test("changed boundary, pending input, or new message after stage prevents commit", async () => {
  for (const change of [s => s.revert.messageID = "a1", s => s.pending = [{}],
    s => s.messages.push({ id: "a3", type: "assistant" }), s => s.revert.files = [{ file: "x" }]]) {
    const { state, client } = fixture()
    state.onStage = () => change(state)
    await assert.rejects(deleteLastMessage(client, "s"), /redo/)
    assert.equal(state.commits, 0)
  }
})

test("failed commit reports possible staged state and never automatically resumes", async () => {
  const { state, client } = fixture()
  state.failCommit = true
  await assert.rejects(deleteLastMessage(client, "s"), /offline.*redo/)
  assert.equal(state.messages.length, 4)
  assert.equal(state.revert.messageID, "a2")
})

test("paginates idle markers and uses server ordering, not message ID sorting", async () => {
  const { client } = fixture()
  let calls = 0
  client.message.list = async input => {
    calls++
    assert.equal(input.order, "desc")
    return input.cursor ? { data: [{ id: "a2", type: "assistant" }], cursor: {} }
      : { data: [{ id: "end", type: "idle" }], cursor: { next: "older" } }
  }
  assert.equal(await deleteLastMessage(client, "s"), "a2")
  assert.equal(calls, 6)
})

test("TUI registers slash command, ignores duplicate dispatch and refreshes the session", async () => {
  const { client, state } = fixture()
  let command, release, syncs = 0
  const notices = []
  state.onStage = () => new Promise(resolve => { release = resolve })
  const ctx = { client,
    keymap: { layer: factory => { command = factory().commands[0] } },
    ui: { router: { current: () => ({ type: "session", sessionID: "s" }) }, toast: { show: notice => notices.push(notice) } },
    data: { session: { status: () => "idle", invalidate() {}, async sync() { syncs++ },
      message: { invalidate() {}, async sync() { syncs++ } } } },
  }
  plugin.setup(ctx)
  assert.equal(command.slash.name, "delete-last-message")
  assert.equal(command.enabled(), true)
  const first = command.run()
  await new Promise(resolve => setImmediate(resolve))
  await command.run()
  assert.equal(state.stages.length, 1)
  release()
  await first
  assert.equal(state.commits, 1)
  assert.equal(syncs, 2)
  assert.equal(notices[0].variant, "success")
  ctx.data.session.status = () => "running"
  assert.equal(command.enabled(), false)
})
