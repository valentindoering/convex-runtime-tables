import { spawn } from "node:child_process";

const repository = new URL("../", import.meta.url).pathname;
const children = [
  start("backend", ["run", "dev:backend"]),
  start("frontend", ["run", "dev:frontend"]),
];
let stopping = false;
let backendReady = false;
let frontendReady = false;

for (const child of children) {
  child.process.stdout.on("data", (chunk) => handleOutput(child, chunk));
  child.process.stderr.on("data", (chunk) => handleOutput(child, chunk));
  child.process.once("exit", (code, signal) => {
    if (stopping) return;
    process.stderr.write(
      `[${child.name}] exited unexpectedly (${signal ?? code ?? "unknown"})\n`,
    );
    void stopAll(code ?? 1);
  });
}

process.once("SIGINT", () => void stopAll(0));
process.once("SIGTERM", () => void stopAll(0));
await new Promise(() => {});

function start(name, args) {
  return {
    name,
    process: spawn("npm", args, {
      cwd: repository,
      env: {
        ...process.env,
        CONVEX_AGENT_MODE: "anonymous",
        CONVEX_DISABLE_SENTRY: "1",
        NO_COLOR: "1",
      },
      stdio: ["inherit", "pipe", "pipe"],
    }),
  };
}

function handleOutput(child, chunk) {
  const output = chunk.toString();
  process.stdout.write(`[${child.name}] ${output}`);
  if (child.name === "backend" && output.includes("Convex functions ready")) {
    backendReady = true;
  }
  if (child.name === "frontend" && output.includes("Local:")) {
    frontendReady = true;
  }
  if (backendReady && frontendReady) {
    backendReady = false;
    frontendReady = false;
    process.stdout.write("Development stack ready: http://127.0.0.1:5173/\n");
  }
}

async function stopAll(exitCode) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.process.exitCode === null) child.process.kill("SIGTERM");
  }
  await Promise.all(
    children.map(
      (child) =>
        new Promise((resolve) => {
          if (child.process.exitCode !== null) return resolve();
          child.process.once("exit", resolve);
          setTimeout(() => {
            if (child.process.exitCode === null) child.process.kill("SIGKILL");
          }, 5_000).unref();
        }),
    ),
  );
  process.exit(exitCode);
}
