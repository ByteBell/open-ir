import { auth, driver as createDriver, int, type Driver, type Integer, type Session } from "neo4j-driver";
import { getConfigValue } from "@bb/config";
import { Config } from "@bb/types";
import { Neo4jConfigError, Neo4jConnectError, Neo4jNotConnectedError } from "@bb/errors";

export interface PingResult {
  ok: boolean;
  latencyMs: number;
}

let driver: Driver | null = null;
let connecting: Promise<void> | null = null;

export async function connectNeo4j(): Promise<void> {
  if (driver !== null) {
    return;
  }
  if (connecting !== null) {
    return connecting;
  }
  connecting = doConnect().finally(() => {
    connecting = null;
  });
  return connecting;
}

async function doConnect(): Promise<void> {
  const uri = getConfigValue(Config.Neo4jUri);
  const user = getConfigValue(Config.Neo4jUser);
  const password = getConfigValue(Config.Neo4jPassword);
  if (uri.length === 0) {
    throw new Neo4jConfigError("plumbline set neo4j <uri>");
  }
  if (user.length === 0 || password.length === 0) {
    throw new Neo4jConfigError("plumbline set neo4j-user <user> && plumbline set neo4j-password <pwd>");
  }
  const next = createDriver(uri, auth.basic(user, password));
  try {
    await next.verifyConnectivity();
  } catch (cause: unknown) {
    await next.close().catch(() => undefined);
    throw new Neo4jConnectError(uri, cause);
  }
  driver = next;
}

export async function closeNeo4j(): Promise<void> {
  if (driver === null) {
    return;
  }
  const d = driver;
  driver = null;
  await d.close();
}

export async function pingNeo4j(): Promise<PingResult> {
  const d = _getDriver();
  const start = performance.now();
  try {
    await d.verifyConnectivity();
    return { ok: true, latencyMs: Math.round(performance.now() - start) };
  } catch {
    return { ok: false, latencyMs: Math.round(performance.now() - start) };
  }
}

export function _getDriver(): Driver {
  if (driver === null) {
    throw new Neo4jNotConnectedError();
  }
  return driver;
}

export async function _runCypher<T = unknown>(query: string, params: Record<string, unknown> = {}): Promise<T[]> {
  const session: Session = _getDriver().session();
  try {
    const result = await session.run(query, params);
    return result.records.map((r) => r.toObject() as T);
  } finally {
    await session.close();
  }
}

export interface CypherStep {
  readonly query: string;
  readonly params: Record<string, unknown>;
}

/**
 * Run multiple Cypher statements inside one write transaction. All-or-nothing:
 * either every statement commits or none do. Used by the batched upsert APIs
 * so a 50-file batch lands as one transaction instead of 12 × 50 sessions.
 *
 * Statements are PIPELINED: every `tx.run` is dispatched up-front (the driver
 * queues the RUN messages on the connection in call order; the server executes
 * them sequentially within the transaction) and awaited together. Semantics are
 * identical to awaiting each statement in turn — later statements still see
 * earlier writes — but the whole batch costs ~one network round-trip instead of
 * one per statement. Over a WAN that is the difference between seconds and
 * minutes for a thousand-statement batch.
 *
 * Uses the driver's `executeWrite` which retries automatically on transient
 * errors (deadlock, leader switch) up to a few attempts.
 */
export async function _runInTransaction(steps: readonly CypherStep[]): Promise<void> {
  if (steps.length === 0) {
    return;
  }
  const session: Session = _getDriver().session();
  try {
    await session.executeWrite(async (tx) => {
      await Promise.all(steps.map((step) => tx.run(step.query, step.params)));
    });
  } finally {
    await session.close();
  }
}

export function toNeo4jInt(value: number): Integer {
  return int(value);
}

export function __resetForTests(): void {
  driver = null;
  connecting = null;
}
