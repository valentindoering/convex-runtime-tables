import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const stateDir = join(root, ".codex-runtime");
const stateFile = join(stateDir, "dev.json");
const logFile = join(stateDir, "dev.log");
const mode = process.argv[2] ?? "status";

async function state() {
  try {
    return JSON.parse(await readFile(stateFile, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function stop() {
  const saved = await state();
  if (saved && alive(saved.pid)) {
    process.kill(-saved.pid, "SIGTERM");
    for (let i = 0; i < 50 && alive(saved.pid); i++) await pause(100);
    if (alive(saved.pid)) process.kill(-saved.pid, "SIGKILL");
  }
  await rm(stateFile, { force: true });
  console.log("This worktree's app stopped.");
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function healthy(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}
async function start() {
  const saved = await state();
  if (saved && alive(saved.pid) && (await healthy(saved.url))) {
    console.log(`App ready: ${saved.url}`);
    return;
  }
  if (saved && alive(saved.pid))
    throw new Error(
      "This worktree's app is starting or unhealthy; inspect .codex-runtime/dev.log, then stop it before retrying.",
    );
  await mkdir(stateDir, { recursive: true });
  const port = await freePort();
  const url = `http://127.0.0.1:${port}/`;
  const command = process.execPath;
  const args = ["scripts/dev-all.mjs"];
  const log = openSync(logFile, "w", 0o600);
  const child = spawn(command, args, {
    cwd: root,
    detached: true,
    stdio: ["ignore", log, log],
  });
  closeSync(log);
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
  await writeFile(stateFile, JSON.stringify({ pid: child.pid, url }), {
    mode: 0o600,
  });
  try {
    for (let i = 0; i < 240; i++) {
      if (!alive(child.pid))
        throw new Error("App exited; inspect .codex-runtime/dev.log.");
      const output = await readFile(logFile, "utf8");
      const match = /Showcase ready: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(
        output,
      );
      if (match && (await healthy(match[1]))) {
        await writeFile(
          stateFile,
          JSON.stringify({ pid: child.pid, url: match[1] }),
          { mode: 0o600 },
        );
        console.log(`App ready: ${match[1]}`);
        return;
      }
      await pause(500);
    }
    throw new Error(
      "App did not become ready; inspect .codex-runtime/dev.log.",
    );
  } catch (error) {
    await stop();
    throw error;
  }
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
if (mode === "start") await start();
else if (mode === "stop") await stop();
else if (mode === "status") {
  const saved = await state();
  if (saved && alive(saved.pid)) console.log(`App: ${saved.url}`);
  else console.log("This worktree's app is stopped.");
} else
  throw new Error("Usage: node scripts/worktree-dev.mjs start|status|stop");
