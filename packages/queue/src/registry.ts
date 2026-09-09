// Provider registry — the facade core. Mirrors the `@bb/db` / `@bb/graph-db`
// pattern: a side-effect import of a provider package (`@bb/queue-honker`)
// calls `registerQueueProvider(name, factory)` at module load. The server then
// picks one with `connectQueue(Config.QueueProvider)`.
//
// Switching providers is a cold cutover — only one is active at a time;
// `closeQueue()` must be called before re-connecting under a different name.

import { QueueNotConnectedError } from "@bb/errors";
import type { IQueueProvider, QueuePingResult } from "@bb/queue-core";

let activeProvider: IQueueProvider | null = null;
// In-flight connect promise: dedupes concurrent `connectQueue` callers so
// two parallel callers don't construct two providers and race.
let connecting: Promise<void> | null = null;
const providers = new Map<string, () => IQueueProvider>();

export function registerQueueProvider(name: string, factory: () => IQueueProvider): void {
  providers.set(name, factory);
}

export function getQueue(): IQueueProvider {
  if (activeProvider === null) {
    throw new QueueNotConnectedError();
  }
  return activeProvider;
}

export async function connectQueue(providerName: string): Promise<void> {
  if (activeProvider !== null) {
    return;
  }
  if (connecting !== null) {
    return connecting;
  }
  connecting = doConnect(providerName).finally(() => {
    connecting = null;
  });
  return connecting;
}

async function doConnect(providerName: string): Promise<void> {
  const factory = providers.get(providerName);
  if (factory === undefined) {
    throw new Error(`Queue provider '${providerName}' not registered.`);
  }
  const next = factory();
  await next.connect();
  // Only set `activeProvider` after `connect()` succeeds — if it throws the
  // facade stays in the "not connected" state and `connectQueue` can be
  // retried cleanly.
  activeProvider = next;
}

export async function closeQueue(): Promise<void> {
  if (activeProvider === null) {
    return;
  }
  // Clear the reference *before* awaiting `close()` so a concurrent
  // `connectQueue` call doesn't see a half-torn-down provider.
  const c = activeProvider;
  activeProvider = null;
  await c.close();
}

export async function pingQueue(): Promise<QueuePingResult> {
  return getQueue().ping();
}

export function __resetForTests(): void {
  activeProvider = null;
  connecting = null;
}
