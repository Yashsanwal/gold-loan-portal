// Runs the API and the web app together with prefixed output. Ctrl+C stops both.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
// A global PORT (set by many shells and tools) must not move the API onto the web port.
const apiPort = process.env.API_PORT ?? "4000";
const tasks = [
  { name: "api", color: "\x1b[33m", args: ["run", "dev", "-w", "@goldloan/server"], env: { PORT: apiPort } },
  {
    name: "web",
    color: "\x1b[36m",
    args: ["run", "dev", "-w", "@goldloan/web"],
    env: { VITE_API_PROXY_TARGET: `http://localhost:${apiPort}` },
  },
];

const children = tasks.map(({ name, color, args, env }) => {
  const child = spawn(npm, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  const prefix = `${color}[${name}]\x1b[0m `;
  for (const stream of [child.stdout, child.stderr]) {
    let buffer = "";
    stream.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) process.stdout.write(prefix + line + "\n");
    });
  }
  child.on("exit", (code) => {
    if (!stopping) {
      console.error(`${prefix}exited with code ${code}; stopping the other process.`);
      stop(code ?? 1);
    }
  });
  return child;
});

let stopping = false;
function stop(code = 0) {
  stopping = true;
  for (const child of children) if (!child.killed) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 300);
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
