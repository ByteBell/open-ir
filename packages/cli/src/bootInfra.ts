// SPDX-License-Identifier: AGPL-3.0-only WITH non-commercial-clause
import { composeServicesNeeded } from "./infraMode.ts";
import {
  DockerComposeError,
  DockerHealthTimeoutError,
  DockerNotFoundError,
  DockerPortConflictError,
  composeFilePath,
  down,
  up,
  type UpResult,
} from "./dockerInfra.ts";
import { createSpinner, error, info, success } from "./output.ts";
import {
  labelForService,
  readInfraPorts,
  serviceForPort,
  setInfraPort,
  type InfraPorts,
  type InfraService,
} from "./infraPorts.ts";
import { diagnosePortConflict, promptPortConflict } from "./portConflictPrompt.ts";
import { removeContainer } from "./dockerPortDiagnostics.ts";

const MAX_CONFLICT_ROUNDS = 4;

export async function bringInfraUp(neo4jPassword: string): Promise<UpResult | null> {
  const skipServices = new Set<"neo4j">();
  for (let round = 0; round < MAX_CONFLICT_ROUNDS; round += 1) {
    const ports = readInfraPorts();
    const watched = composeServicesToStart(skipServices);
    const spinner = createSpinner("Starting Docker infrastructure...");
    try {
      const result = await up({
        neo4jPassword,
        ports,
        servicesToStart: watched,
        onProgress: (line) => spinner.update(`Docker: ${line}`),
      });
      spinner.stop(true, `Docker infra is up (${composeFilePath()})`);
      for (const svc of skipServices) {
        info(`reusing existing service on port ${portFor(svc, ports)} for ${svc} (not managed by plumbline)`);
      }
      return result;
    } catch (cause: unknown) {
      spinner.stop(false, "Docker startup failed");
      if (cause instanceof DockerPortConflictError) {
        const handled = await handlePortConflict(cause, ports, skipServices);
        if (handled) {
          continue;
        }
        process.exitCode = 1;
        return null;
      }
      handleDockerError(cause);
      return null;
    }
  }
  error(`Gave up after ${MAX_CONFLICT_ROUNDS} attempts to resolve port conflicts.`);
  process.exitCode = 1;
  return null;
}

async function handlePortConflict(
  cause: DockerPortConflictError,
  ports: InfraPorts,
  skipServices: Set<"neo4j">,
): Promise<boolean> {
  const infraService = serviceForPort(cause.port, ports);
  if (infraService === null) {
    error(`Port ${cause.port} conflict, but it doesn't match a known plumbline service. Aborting.`);
    info(cause.stderr.trim());
    return false;
  }
  const composeService = composeServiceFor(infraService);
  const serviceLabel = labelForService(infraService);
  const ctx = await diagnosePortConflict(cause.port, serviceLabel);
  const resolution = await promptPortConflict(ctx);

  if (resolution.action === "cancel") {
    error("Boot cancelled.");
    return false;
  }

  // Tear down the half-created compose state so the retry starts clean.
  await safeComposeDown();

  if (resolution.action === "reuse") {
    skipServices.add(composeService);
    success(`will reuse existing ${serviceLabel} on port ${cause.port}.`);
    return true;
  }
  if (resolution.action === "kill") {
    if (ctx.container === null) {
      error("Nothing to remove — the conflicting process isn't a docker container. Stop it manually and retry.");
      return false;
    }
    try {
      await removeContainer(ctx.container.id);
      success(`removed conflicting container ${ctx.container.name}.`);
    } catch (e: unknown) {
      error(`docker rm -f ${ctx.container.name} failed: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
    return true;
  }
  if (resolution.action === "change") {
    const newPort = resolution.newPort;
    if (newPort === undefined) {
      error("internal: change selected without a new port.");
      return false;
    }
    setInfraPort(infraService, newPort);
    success(`updated plumbline ${serviceLabel} → port ${newPort}.`);
    skipServices.delete(composeService);
    return true;
  }
  return false;
}

async function safeComposeDown(): Promise<void> {
  try {
    await down();
  } catch {
    // best-effort cleanup — ignore failures
  }
}

function composeServicesToStart(skip: Set<"neo4j">): readonly "neo4j"[] {
  const needed = composeServicesNeeded();
  return (["neo4j"] as const).filter((s) => needed.has(s) && !skip.has(s));
}

function composeServiceFor(_service: InfraService): "neo4j" {
  return "neo4j";
}

function portFor(_service: "neo4j", ports: InfraPorts): number {
  return ports.neo4jBolt;
}

function handleDockerError(cause: unknown): void {
  if (cause instanceof DockerNotFoundError) {
    error(cause.message);
  } else if (cause instanceof DockerComposeError) {
    error(cause.message);
  } else if (cause instanceof DockerHealthTimeoutError) {
    error(cause.message);
  } else {
    error(cause instanceof Error ? cause.message : String(cause));
  }
  process.exitCode = 1;
}
