import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const child = spawn(process.execPath, ["--import", "tsx", "scripts/files-assets-qa-server.mjs"], {
  cwd: path.join(root, "backend"), env: process.env, stdio: "inherit", windowsHide: true,
});
child.on("exit", (code) => { process.exitCode = code || 0; });
process.on("SIGINT", () => child.kill());
process.on("SIGTERM", () => child.kill());
