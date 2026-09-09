import os from "node:os";
import path from "node:path";

let testHomeOverride: string | null = null;
let homeResolver: (() => string | null) | null = null;
const cacheInvalidators: Array<() => void> = [];

export function getPlumblineHome(): string {
  if (testHomeOverride !== null) {
    return testHomeOverride;
  }
  if (homeResolver !== null) {
    const resolved = homeResolver();
    if (resolved !== null) {
      return resolved;
    }
  }
  return path.join(os.homedir(), ".plumbline");
}

/**
 * Register an override resolver for `getPlumblineHome()`. The resolver runs on
 * every call (no caching) so it may return different values across invocations.
 * Returning `null` falls through to the `~/.plumbline` default. Pass `null` to
 * clear the resolver.
 */
export function setPlumblineHomeResolver(fn: (() => string | null) | null): void {
  homeResolver = fn;
  __notifyConfigChanged();
}

export function getConfigPath(): string {
  return path.join(getPlumblineHome(), "config.json");
}

/**
 * Resolve a configured filesystem path to an absolute one. Expands a leading
 * `~` to the OS home, resolves a relative value against the plumbline home, and
 * returns absolute paths unchanged. An empty value stays empty so callers can
 * still detect "not set" — embedded-mode validation relies on this.
 */
export function resolveUnderHome(value: string): string {
  const v = value.trim();
  if (v.length === 0) {
    return "";
  }
  if (v === "~") {
    return os.homedir();
  }
  if (v.startsWith("~/") || v.startsWith("~\\")) {
    return path.join(os.homedir(), v.slice(2));
  }
  if (path.isAbsolute(v)) {
    return v;
  }
  return path.join(getPlumblineHome(), v);
}

export function __registerCacheInvalidator(fn: () => void): void {
  cacheInvalidators.push(fn);
}

export function __notifyConfigChanged(): void {
  for (const fn of cacheInvalidators) {
    fn();
  }
}

export function __setPlumblineHomeForTests(home: string | null): void {
  testHomeOverride = home;
  __notifyConfigChanged();
}

/**
 * Dev-mode toggle. Enabled by `PLUMBLINE_DEV=1` on the shell session.
 *
 * Narrow purpose: redirect log output to the working directory so contributors
 * can tail logs without cd-ing to ~/.plumbline. Does NOT bypass the Rule of Env
 * Vars — no infra URI, credential, or persisted setting is sourced here.
 */
export function isDevMode(): boolean {
  return process.env["PLUMBLINE_DEV"] === "1";
}

/**
 * TEST-ONLY toggle (`PLUMBLINE_FORCE_HALT_ONCE=1`). When on, the ingest pipeline
 * forces a one-shot transient LLM failure per knowledge so the HALTED → retry →
 * PROCESSED loop can be exercised end-to-end. Read here (the sanctioned env
 * boundary) rather than in package code, mirroring `isDevMode`. Does NOT bypass
 * the Rule of Env Vars — no infra URI, credential, or persisted setting is
 * sourced. Remove alongside `ingest-github`'s `fault-injection.ts`.
 */
export function isForceHaltOnceEnabled(): boolean {
  return process.env["PLUMBLINE_FORCE_HALT_ONCE"] === "1";
}
