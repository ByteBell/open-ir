import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { envFileBody, type InfraPorts } from "./infraPorts.ts";
import { parsePortFromComposeError } from "./dockerPortDiagnostics.ts";

const COMPOSE_HEALTH_POLL_MS = 2_000;
const COMPOSE_HEALTH_TIMEOUT_MS = 90_000;
const SERVICES = ["neo4j"] as const;

type ServiceName = (typeof SERVICES)[number];

export class DockerNotFoundError extends Error {
  override readonly name = "DockerNotFoundError";
  constructor() {
    super("`docker` was not found on PATH. Install Docker Desktop or the Docker engine and retry.");
  }
}

export class DockerComposeError extends Error {
  override readonly name = "DockerComposeError";
  readonly stderr: string;
  constructor(stage: string, exitCode: number, stderr: string) {
    super(`docker compose ${stage} failed (exit ${exitCode}): ${stderr.trim() || "no stderr"}`);
    this.stderr = stderr;
  }
}

export class DockerPortConflictError extends Error {
  override readonly name = "DockerPortConflictError";
  readonly port: number;
  readonly stderr: string;
  constructor(port: number, stderr: string) {
    super(`Host port ${port} is already in use.`);
    this.port = port;
    this.stderr = stderr;
  }
}

export class DockerHealthTimeoutError extends Error {
  override readonly name = "DockerHealthTimeoutError";
  constructor(unhealthy: ServiceName[]) {
    super(
      `services not healthy after ${COMPOSE_HEALTH_TIMEOUT_MS / 1000}s: ${unhealthy.join(", ")}. Inspect with \`docker compose -f infra/docker/docker-compose.yml logs\`.`,
    );
  }
}

interface ComposePsRow {
  Service?: string;
  Health?: string;
  State?: string;
}

interface UpOptions {
  neo4jPassword: string;
  ports: InfraPorts;
  servicesToStart?: readonly ServiceName[];
  onProgress?: (line: string) => void;
}

export interface UpResult {
  composeFile: string;
  services: Record<ServiceName, string>;
}

export function composeFilePath(): string {
  const here = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(here), "..", "..", "..", "infra", "docker", "docker-compose.yml");
}

function envFilePath(): string {
  return path.resolve(path.dirname(composeFilePath()), ".env");
}

export async function up(opts: UpOptions): Promise<UpResult> {
  await writeEnvFile(opts.ports, opts.neo4jPassword);
  const upArgs = ["compose", "-f", composeFilePath(), "up", "-d", ...(opts.servicesToStart ?? [])];
  await runDocker(upArgs, "up");

  const watched = opts.servicesToStart ?? SERVICES;
  const unhealthy = await waitUntilHealthy(watched, opts.onProgress);
  if (unhealthy.length > 0) {
    throw new DockerHealthTimeoutError(unhealthy);
  }
  return {
    composeFile: composeFilePath(),
    services: {
      neo4j: `127.0.0.1:${opts.ports.neo4jBolt} (HTTP ${opts.ports.neo4jHttp})`,
    },
  };
}

export async function down(): Promise<void> {
  await runDocker(["compose", "-f", composeFilePath(), "down", "--remove-orphans"], "down");
}

async function writeEnvFile(ports: InfraPorts, neo4jPassword: string): Promise<void> {
  await writeFile(envFilePath(), envFileBody(ports, neo4jPassword), { mode: 0o600 });
}

async function waitUntilHealthy(
  watched: readonly ServiceName[],
  onProgress?: (line: string) => void,
): Promise<ServiceName[]> {
  const start = Date.now();
  while (Date.now() - start < COMPOSE_HEALTH_TIMEOUT_MS) {
    const rows = await psSnapshot();
    const status = summarize(rows, watched);
    if (onProgress !== undefined) {
      onProgress(formatProgress(status, watched));
    }
    if (status.unhealthy.length === 0) {
      return [];
    }
    await sleep(COMPOSE_HEALTH_POLL_MS);
  }
  const final = await psSnapshot();
  return summarize(final, watched).unhealthy;
}

interface StatusSummary {
  healthy: ServiceName[];
  unhealthy: ServiceName[];
}

function summarize(rows: ComposePsRow[], watched: readonly ServiceName[]): StatusSummary {
  const healthy: ServiceName[] = [];
  const unhealthy: ServiceName[] = [];
  for (const service of watched) {
    const row = rows.find((r) => r.Service === service);
    if (row !== undefined && row.Health === "healthy") {
      healthy.push(service);
    } else {
      unhealthy.push(service);
    }
  }
  return { healthy, unhealthy };
}

function formatProgress(status: StatusSummary, watched: readonly ServiceName[]): string {
  const tag = (name: ServiceName): string => (status.healthy.includes(name) ? `${name} ✓` : `${name} …`);
  return watched.map(tag).join("  ");
}

async function psSnapshot(): Promise<ComposePsRow[]> {
  const { stdout } = await runDocker(["compose", "-f", composeFilePath(), "ps", "--format", "json"], "ps");
  return parsePsOutput(stdout);
}

export function parsePsOutput(stdout: string): ComposePsRow[] {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return [];
  }
  if (trimmed.startsWith("[")) {
    const parsed: unknown = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed.map(coerceRow) : [];
  }
  const rows: ComposePsRow[] = [];
  for (const line of trimmed.split("\n")) {
    const candidate = line.trim();
    if (candidate.length === 0) {
      continue;
    }
    const parsed: unknown = JSON.parse(candidate);
    rows.push(coerceRow(parsed));
  }
  return rows;
}

function coerceRow(value: unknown): ComposePsRow {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  const obj = value as Record<string, unknown>;
  const out: ComposePsRow = {};
  if (typeof obj["Service"] === "string") {
    out.Service = obj["Service"];
  }
  if (typeof obj["Health"] === "string") {
    out.Health = obj["Health"];
  }
  if (typeof obj["State"] === "string") {
    out.State = obj["State"];
  }
  return out;
}

interface DockerRunResult {
  stdout: string;
  stderr: string;
}

async function runDocker(args: string[], stage: string): Promise<DockerRunResult> {
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
    child.on("error", (cause: Error & { code?: string }) => {
      if (cause.code === "ENOENT") {
        reject(new DockerNotFoundError());
        return;
      }
      reject(cause);
    });
    child.on("exit", (code) => {
      const exit = typeof code === "number" ? code : 0;
      if (exit === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const port = parsePortFromComposeError(stderr);
      if (port !== null) {
        reject(new DockerPortConflictError(port, stderr));
        return;
      }
      reject(new DockerComposeError(stage, exit, stderr));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
