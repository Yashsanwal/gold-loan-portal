// Production-style start: serves the built web app and the API from one process on PORT.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const child = spawn(npm, ["run", "start", "-w", "@goldloan/server"], {
  stdio: "inherit",
  env: { ...process.env, NODE_ENV: "production" },
  cwd: root,
    shell: process.platform === "win32",
});
child.on("exit", (code) => process.exit(code ?? 0));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
