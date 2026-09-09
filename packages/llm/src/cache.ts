import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getPlumblineHome, getConfigValue } from "@bb/config";
import { Config } from "@bb/types";
import type { AskLlmUsage } from "./client.ts";

const CACHE_DIR_NAME = "repos/llmdecisions";

export interface CacheKeyInput {
  provider: string;
  prompt: string;
  systemPrompt: string | null;
  modelChain: string[];
  temperature: number | null;
}

export interface CachedDecision {
  key: string;
  content: string;
  usage: AskLlmUsage;
  modelChain: string[];
  hitCount: number;
  createdAt: string;
  lastHitAt: string;
}

export function isCacheEnabled(): boolean {
  try {
    return getConfigValue(Config.LlmCacheEnabled);
  } catch {
    return false;
  }
}

export function computeCacheKey(input: CacheKeyInput): string {
  const canonical = JSON.stringify({
    provider: input.provider,
    prompt: input.prompt,
    systemPrompt: input.systemPrompt,
    modelChain: input.modelChain,
    temperature: input.temperature,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function cacheDir(): string {
  return path.join(getPlumblineHome(), CACHE_DIR_NAME);
}

function entryPath(key: string): string {
  return path.join(cacheDir(), `${key}.json`);
}

export async function getCachedDecision(key: string): Promise<CachedDecision | null> {
  try {
    const raw = await fs.readFile(entryPath(key), "utf8");
    const parsed = JSON.parse(raw) as CachedDecision;
    if (typeof parsed.content !== "string" || parsed.usage === undefined) {
      return null;
    }
    // Tolerate older cache entries written before AskLlmUsage gained costUsd.
    if (typeof parsed.usage.costUsd !== "number") {
      parsed.usage.costUsd = 0;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function recordDecision(
  key: string,
  payload: { content: string; usage: AskLlmUsage; modelChain: string[] },
): Promise<void> {
  try {
    await fs.mkdir(cacheDir(), { recursive: true, mode: 0o700 });
    const now = new Date().toISOString();
    const entry: CachedDecision = {
      key,
      content: payload.content,
      usage: payload.usage,
      modelChain: payload.modelChain,
      hitCount: 0,
      createdAt: now,
      lastHitAt: now,
    };
    const tmp = `${entryPath(key)}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(entry), { mode: 0o600 });
    await fs.rename(tmp, entryPath(key));
  } catch (cause: unknown) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    console.warn(`[LLM CACHE WRITE FAILED] key=${key.slice(0, 8)} ${msg}`);
  }
}

export async function recordHit(key: string): Promise<void> {
  try {
    const existing = await getCachedDecision(key);
    if (existing === null) {
      return;
    }
    existing.hitCount += 1;
    existing.lastHitAt = new Date().toISOString();
    const tmp = `${entryPath(key)}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(existing), { mode: 0o600 });
    await fs.rename(tmp, entryPath(key));
  } catch {
    // best-effort; hit accounting must never fail the call
  }
}
