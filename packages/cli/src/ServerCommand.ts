import { Command } from "commander";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { error } from "./output.ts";

export function buildServerCommand(): Command {
  const cmd = new Command("server");
  cmd.description("Manage the plumbline-server daemon.");
  const start = new Command("start");
  start.description("Start the plumbline-server in the foreground (Ctrl+C to stop).");
  start.action(runStart);
  cmd.addCommand(start);
  return cmd;
}

function runStart(): void {
  const entry = resolveServerEntry();
  const child = spawn("bun", ["--bun", entry], { stdio: "inherit" });

  process.on("SIGINT", () => {
    child.kill("SIGINT");
  });
  process.on("SIGTERM", () => {
    child.kill("SIGTERM");
  });

  child.on("exit", (code) => {
    process.exit(typeof code === "number" ? code : 0);
  });
  child.on("error", (cause: Error) => {
    error(`failed to start server: ${cause.message}`);
    process.exit(1);
  });
}

function resolveServerEntry(): string {
  const here = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(here), "..", "..", "server", "src", "index.ts");
}
