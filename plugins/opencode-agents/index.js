import { Plugin } from "@opencode/plugin";
import { loadAgents, registerAgents } from "./src/load.js";

export default Plugin.define({
    id: "opencode-agents",
    async setup(ctx) {
        // Only the documents bundled with this plugin. Never scan user config.
        const agents = await loadAgents(new URL("./agents/", import.meta.url));
        await ctx.agent.transform(editor => registerAgents(editor, agents));
    },
});
