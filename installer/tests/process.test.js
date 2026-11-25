import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runProcess } from "../process.js";

async function waitFor(check, timeout = 5000) {
    const end = Date.now() + timeout;
    do {
        const result = await check();
        if (result) return result;
        await delay(25);
    } while (Date.now() < end);
    assert.fail("fixture did not settle in time");
}
function alive(pid) {
    try { process.kill(pid, 0); return true; }
    catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

async function tree(t) {
    const root = await mkdtemp(join(tmpdir(), "opencode-process-test-"));
    let owned = [];
    t.after(async () => {
        for (const pid of owned) if (alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch {} }
        assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
        await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
    });
    await writeFile(join(root, "child.mjs"), `import { writeFileSync } from 'node:fs';
writeFileSync('pids.json', JSON.stringify([process.ppid, process.pid]));
setInterval(() => {}, 1000);
`);
    await writeFile(join(root, "parent.mjs"), `import { spawn } from 'node:child_process';
spawn(process.execPath, ['child.mjs'], { stdio: 'inherit', windowsHide: true });
setInterval(() => {}, 1000);
`);
    return {
        root,
        start: options => process.platform === "win32"
            ? runProcess(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "node parent.mjs"], { cwd: root, ...options })
            : runProcess(process.execPath, ["parent.mjs"], { cwd: root, ...options }),
        ready: async () => {
            owned = await waitFor(async () => {
                try { return JSON.parse(await readFile(join(root, "pids.json"), "utf8")); }
                catch (error) { if (error.code === "ENOENT") return; throw error; }
            });
            return owned;
        },
    };
}

test("process runner captures both streams and preserves literal arguments", async () => {
    const output = await runProcess(process.execPath, ["-e", "process.stdout.write(process.argv[1]); process.stderr.write('诊断');", "value with spaces 中文"]);
    assert.deepEqual(output, { stdout: "value with spaces 中文", stderr: "诊断" });
    await assert.rejects(runProcess(process.execPath, ["-e", "process.stderr.write('fixture'); process.exit(7)"]), error =>
        error.code === 7 && error.stderr === "fixture");
});

test("spawn failures and pre-aborted commands settle without starting a process", async () => {
    await assert.rejects(runProcess("missing-opencode-test-executable", []), { code: "ENOENT" });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(runProcess("missing-opencode-test-executable", [], { signal: controller.signal }), { code: "ABORT_ERR" });
});

test("timeout terminates the wrapper and descendants and releases their working directory", async t => {
    const fixture = await tree(t), started = Date.now();
    const result = assert.rejects(fixture.start({ timeout: 2500 }), error => error.code === "ETIMEDOUT" && !error.terminationFailed);
    const pids = await fixture.ready();
    assert.ok(pids.every(alive));
    await result;
    await waitFor(() => pids.every(pid => !alive(pid)));
    assert.ok(Date.now() - started < 10000);
    assert.ok(resolve(fixture.root).startsWith(resolve(tmpdir()) + sep));
    await rm(fixture.root, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
    await assert.rejects(access(fixture.root), { code: "ENOENT" });
});

test("abort waits for process tree termination before rejecting", async t => {
    const fixture = await tree(t), controller = new AbortController();
    const result = assert.rejects(fixture.start({ timeout: 10000, signal: controller.signal }), error => error.code === "ABORT_ERR" && !error.terminationFailed);
    const pids = await fixture.ready();
    controller.abort();
    await result;
    await waitFor(() => pids.every(pid => !alive(pid)));
});

test("output limits stop the child instead of leaving it alive", async () => {
    await assert.rejects(runProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(4096)); setInterval(() => {}, 1000)"], { maxBuffer: 64 }),
        error => error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" && error.stdout.length === 64 && !error.terminationFailed);
});
