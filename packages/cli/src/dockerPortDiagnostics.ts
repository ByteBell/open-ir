// SPDX-License-Identifier: AGPL-3.0-only WITH non-commercial-clause
import { spawn } from "node:child_process";

const PORT_ALLOCATION_RE = /Bind for (?:[\d.]+:)?(\d+) failed: port is already allocated/iu;
const ADDRESS_IN_USE_RE =
  /(?:listen tcp(?:[46])?\s+[\d.]+:|listen tcp \[[^\]]+\]:)(\d+):\s*bind: address already in use/iu;

export interface ConflictingContainer {
  id: string;
  name: string;
  image: string;
  isPlumbline: boolean;
}

export interface ConflictingHostProcess {
  pid: number;
  command: string;
}

export function parsePortFromComposeError(stderr: string): number | null {
  const m1 = PORT_ALLOCATION_RE.exec(stderr);
  if (m1?.[1] !== undefined) {
    return parsePort(m1[1]);
  }
  const m2 = ADDRESS_IN_USE_RE.exec(stderr);
  if (m2?.[1] !== undefined) {
    return parsePort(m2[1]);
  }
  return null;
}

export async function findContainerOnPort(port: number): Promise<ConflictingContainer | null> {
  const args = ["ps", "--filter", `publish=${port}`, "--format", "{{.ID}}\t{{.Names}}\t{{.Image}}"];
  const { stdout } = await runDockerCapture(args);
  const line = stdout
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (line === undefined) {
    return null;
  }
  const [id, name, image] = line.split("\t");
  if (id === undefined || name === undefined || image === undefined) {
    return null;
  }
  return {
    id,
    name,
    image,
    isPlumbline: name.startsWith("plumbline-"),
  };
}

export async function removeContainer(id: string): Promise<void> {
  await runDockerCapture(["rm", "-f", id]);
}

export async function findHostProcessOnPort(port: number): Promise<ConflictingHostProcess | null> {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    return null;
  }
  const result = await runCapture("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-F", "pc"]);
  if (result === null) {
    return null;
  }
  const lines = result.stdout.split("\n");
  let pid: number | null = null;
  let command = "";
  for (const line of lines) {
    if (line.startsWith("p")) {
      const n = Number.parseInt(line.slice(1), 10);
      if (Number.isInteger(n) && n > 0) {
        pid = n;
      }
    } else if (line.startsWith("c")) {
      command = line.slice(1);
    }
    if (pid !== null && command.length > 0) {
      break;
    }
  }
  if (pid === null) {
    return null;
  }
  return { pid, command };
}

function parsePort(raw: string): number | null {
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    return null;
  }
  return n;
}

async function runDockerCapture(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (cause: Error) => reject(cause));
    child.on("exit", () => resolve({ stdout, stderr }));
  });
}

async function runCapture(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string } | null> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", () => resolve(null));
    child.on("exit", () => resolve({ stdout, stderr }));
  });
}
