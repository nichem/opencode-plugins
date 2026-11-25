import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const failure = (code, message) => Object.assign(new Error(message), { code });

async function terminateTree(child) {
    if (!child.pid) return;
    if (process.platform === "win32") {
        // Kill the tree while its cmd.exe root still exists. Killing just cmd
        // leaves OpenCode running with the temporary working directory locked.
        await exec("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 10000 });
    } else {
        try { process.kill(-child.pid, "SIGKILL"); }
        catch (error) { if (error.code !== "ESRCH") throw error; }
    }
}

export function runProcess(file, args, { env, cwd, signal, timeout = 60000, maxBuffer = 2 * 1024 * 1024 } = {}) {
    if (signal?.aborted) return Promise.reject(failure("ABORT_ERR", "操作已取消"));
    return new Promise((resolve, reject) => {
        const child = spawn(file, args, { env, cwd, windowsHide: true,
            detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
        const buffers = { stdout: [], stderr: [] }, sizes = { stdout: 0, stderr: 0 };
        let settled = false, stopping = false, timer;
        const finish = error => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
            const output = Object.fromEntries(Object.entries(buffers).map(([name, chunks]) => [name, Buffer.concat(chunks).toString("utf8")]));
            if (error) reject(Object.assign(error, output)); else resolve(output);
        };
        const stop = async error => {
            if (settled || stopping) return;
            stopping = true;
            try { await terminateTree(child); }
            catch {
                error.terminationFailed = true;
                // Only this owned process is a fallback target; never kill by name.
                try { child.kill("SIGKILL"); } catch { /* Report the incomplete cleanup. */ }
            }
            // A descendant holding a pipe must not prevent a timeout from settling.
            child.stdout.destroy();
            child.stderr.destroy();
            child.unref();
            finish(error);
        };
        const abort = () => { void stop(failure("ABORT_ERR", "操作已取消")); };
        for (const name of ["stdout", "stderr"]) child[name].on("data", chunk => {
            if (stopping || settled) return;
            const remaining = maxBuffer - sizes[name];
            buffers[name].push(chunk.subarray(0, Math.max(0, remaining)));
            sizes[name] += chunk.length;
            if (sizes[name] > maxBuffer) void stop(failure("ERR_CHILD_PROCESS_STDIO_MAXBUFFER", "子进程输出超出限制"));
        });
        child.once("error", error => { if (!stopping) finish(error); });
        child.once("close", (code, exitSignal) => {
            if (!stopping) finish(code === 0 ? undefined : Object.assign(new Error("子进程执行失败"), { code, signal: exitSignal }));
        });
        if (timeout > 0) timer = setTimeout(() => { void stop(failure("ETIMEDOUT", "操作超时")); }, timeout).unref();
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
    });
}
