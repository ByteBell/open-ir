// SPDX-License-Identifier: AGPL-3.0-only WITH non-commercial-clause
import { Config } from "@bb/types";
import { getConfigValue, setConfigValue } from "@bb/config";

export type InfraService = "neo4j-bolt" | "neo4j-http";

export const NEO4J_HTTP_BOLT_OFFSET = 213;

const DEFAULTS: Record<InfraService, number> = {
  "neo4j-bolt": 7687,
  "neo4j-http": 7474,
};

export interface InfraPorts {
  neo4jBolt: number;
  neo4jHttp: number;
}

export function readInfraPorts(): InfraPorts {
  const boltPort = portFromUri(readString(Config.Neo4jUri), DEFAULTS["neo4j-bolt"]);
  return {
    neo4jBolt: boltPort,
    neo4jHttp: deriveHttpPort(boltPort),
  };
}

export function serviceForPort(port: number, ports: InfraPorts): InfraService | null {
  if (port === ports.neo4jBolt) {
    return "neo4j-bolt";
  }
  if (port === ports.neo4jHttp) {
    return "neo4j-http";
  }
  return null;
}

export function setInfraPort(service: InfraService, newPort: number): void {
  switch (service) {
    case "neo4j-bolt":
    case "neo4j-http":
      setConfigValue(Config.Neo4jUri, replacePort(readString(Config.Neo4jUri), boltPortForService(service, newPort)));
      return;
  }
}

export function envFileBody(ports: InfraPorts, neo4jPassword: string): string {
  return [
    `NEO4J_PASSWORD=${neo4jPassword}`,
    `NEO4J_BOLT_HOST_PORT=${ports.neo4jBolt}`,
    `NEO4J_HTTP_HOST_PORT=${ports.neo4jHttp}`,
    "",
  ].join("\n");
}

export function labelForService(service: InfraService): string {
  switch (service) {
    case "neo4j-bolt":
      return "neo4j (bolt)";
    case "neo4j-http":
      return "neo4j (http UI)";
  }
}

function deriveHttpPort(boltPort: number): number {
  const candidate = boltPort - NEO4J_HTTP_BOLT_OFFSET;
  if (candidate > 0 && candidate <= 65535) {
    return candidate;
  }
  return DEFAULTS["neo4j-http"];
}

function boltPortForService(service: "neo4j-bolt" | "neo4j-http", newPort: number): number {
  if (service === "neo4j-bolt") {
    return newPort;
  }
  return newPort + NEO4J_HTTP_BOLT_OFFSET;
}

function portFromUri(uri: string, fallback: number): number {
  if (uri.length === 0) {
    return fallback;
  }
  try {
    const parsed = new URL(uri);
    if (parsed.port.length > 0) {
      const n = Number.parseInt(parsed.port, 10);
      if (Number.isInteger(n) && n > 0 && n <= 65535) {
        return n;
      }
    }
  } catch {
    // fall through
  }
  return fallback;
}

function replacePort(uri: string, newPort: number): string {
  if (uri.length === 0) {
    throw new Error("internal: cannot replace port on empty URI");
  }
  const parsed = new URL(uri);
  parsed.port = String(newPort);
  return parsed.toString();
}

function readString(key: Config): string {
  const value = getConfigValue(key);
  return typeof value === "string" ? value : "";
}
