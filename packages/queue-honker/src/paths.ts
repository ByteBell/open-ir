import path from "node:path";
import { homedir } from "node:os";
import { Config } from "@bb/types";
import { getPlumblineHome, getConfigValue } from "@bb/config";

export function resolveQueueDbPath(): string {
  const configured = getConfigValue(Config.QueueDbPath);
  if (configured.length > 0) {
    return expandTilde(configured);
  }
  return path.join(getPlumblineHome(), "queue.db");
}

function expandTilde(p: string): string {
  if (p === "~") {
    return homedir();
  }
  if (p.startsWith("~/")) {
    return path.join(homedir(), p.slice(2));
  }
  return p;
}
