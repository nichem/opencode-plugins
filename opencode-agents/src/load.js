import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, basename } from "node:path";
import { parseDocument } from "yaml";
import { Schema } from "effect";
import { Agent, Model } from "@opencode/plugin";

const allowed = new Set(["name", "description", "mode", "model", "hidden", "color", "steps", "permissions", "request"]);

export function parseAgent(source, filename) {
    const text = source.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
    let metadata = {}, body = text;
    if (text.startsWith("---\n")) {
        const end = /^---\s*$/gm;
        end.lastIndex = 4;
        const match = end.exec(text);
        if (!match) throw new Error(`${filename}: frontmatter missing closing ---`);
        try {
            const doc = parseDocument(text.slice(4, match.index), { uniqueKeys: true });
            if (doc.errors.length) throw new Error();
            metadata = doc.toJS({ maxAliasCount: 20 }) ?? {};
        } catch { throw new Error(`${filename}: invalid YAML frontmatter`); }
        body = text.slice(match.index + match[0].length).trim();
    }
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error(`${filename}: frontmatter must be a mapping`);
    for (const key of Object.keys(metadata)) {
        if (!allowed.has(key)) throw new Error(`${filename}: unsupported frontmatter field (use the documented 2.x format)`);
    }
    if (!body.trim()) throw new Error(`${filename}: agent prompt is empty`);
    const name = metadata.name ?? basename(filename).replace(/\.md$/i, "");
    if (typeof name !== "string" || !/^[\p{L}\p{N}_-]+$/u.test(name)) throw new Error(`${filename}: invalid agent name`);
    // Namespace avoids replacing built-ins or similarly named local agents.
    const id = `bundled-${name}`;
    const agent = { ...Agent.Info.default(Agent.ID.make(id)), name: id, system: body.trim() };
    for (const field of ["description", "mode", "hidden", "color", "steps"]) {
        if (metadata[field] !== undefined) agent[field] = metadata[field];
    }
    try {
        if (metadata.model !== undefined) agent.model = typeof metadata.model === "string" ? Model.Ref.parse(metadata.model) : metadata.model;
        if (metadata.permissions !== undefined) {
            if (!Array.isArray(metadata.permissions)) throw new Error();
            agent.permissions = [...agent.permissions, ...metadata.permissions];
        }
        if (metadata.request !== undefined) {
            if (!metadata.request || typeof metadata.request !== "object" || Array.isArray(metadata.request)) throw new Error();
            agent.request = { ...agent.request, ...metadata.request };
        }
        return Schema.decodeUnknownSync(Agent.Info)(agent);
    } catch { throw new Error(`${filename}: invalid agent metadata; check model, mode, permissions or request`); }
}

export async function loadAgents(directory) {
    const root = directory instanceof URL ? fileURLToPath(directory) : directory;
    let entries;
    try { entries = await readdir(root, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
    const agents = [], seen = new Set();
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        // No recursion and no symlink traversal outside the bundled directory.
        if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue;
        const agent = parseAgent(await readFile(join(root, entry.name), "utf8"), entry.name);
        const key = agent.id.toLowerCase();
        if (seen.has(key)) throw new Error(`${entry.name}: duplicate bundled agent name`);
        seen.add(key);
        agents.push(agent);
    }
    return agents;
}

export function registerAgents(editor, agents) {
    for (const agent of agents) {
        // Only check existence; never inspect another agent's prompt.
        if (editor.get(agent.id)) continue;
        editor.update(agent.id, target => Object.assign(target, structuredClone(agent)));
    }
}
