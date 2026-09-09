import fs from "node:fs";
import path from "node:path";
import { getPlumblineHome } from "@bb/config";
import { Config } from "@bb/types";
import { getConfigValue } from "@bb/config";
import { logger } from "@bb/logger";

const FILE_MODE = 0o600;

export interface DecisionEntry {
  ignore: boolean;
  source: "hardcoded" | "llm";
  repository_name?: string;
  files?: string[];
}

export interface DecisionsCache {
  directories: Record<string, DecisionEntry>;
  extensions: Record<string, DecisionEntry>;
  filenames: Record<string, DecisionEntry>;
  filename_globs: Record<string, DecisionEntry>;
  /**
   * Per-file decisions keyed by sha256 of the file content. This is the
   * authoritative cache for the LLM admission gate: every accepted file is
   * inspected individually, so an unchanged file (same content hash) skips the
   * LLM call on re-index/pull while a junk file cannot ride a sibling's verdict.
   */
  files: Record<string, DecisionEntry>;
}

export function defaultCachePath(): string {
  const configured = getConfigValue(Config.SkipDecisionCachePath);
  if (configured.length > 0) {
    return configured;
  }
  return path.join(getPlumblineHome(), "llmDecisions.json");
}

export function emptyCache(): DecisionsCache {
  return { directories: {}, extensions: {}, filenames: {}, filename_globs: {}, files: {} };
}

export function loadCache(filePath: string): DecisionsCache {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return narrow(parsed);
  } catch {
    return emptyCache();
  }
}

export function saveCache(filePath: string, cache: DecisionsCache): void {
  const tmp = `${filePath}.tmp`;
  const json = `${JSON.stringify(cache, null, 2)}\n`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(tmp, "w", FILE_MODE);
  try {
    fs.writeSync(fd, json);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
}

export function setExtensionDecision(
  cache: DecisionsCache,
  ext: string,
  ignore: boolean,
  source: DecisionEntry["source"],
  repositoryName: string | undefined,
  relativePath: string,
): void {
  const existing = cache.extensions[ext];
  const files = existing?.files ?? [];
  if (ignore && !files.includes(relativePath)) {
    files.push(relativePath);
  }
  const entry: DecisionEntry = { ignore, source };
  if (repositoryName !== undefined) {
    entry.repository_name = repositoryName;
  }
  if (ignore) {
    entry.files = files;
  }
  cache.extensions[ext] = entry;
}

export function setFilenameDecision(
  cache: DecisionsCache,
  filename: string,
  ignore: boolean,
  source: DecisionEntry["source"],
  repositoryName: string | undefined,
  relativePath: string,
): void {
  const existing = cache.filenames[filename];
  const files = existing?.files ?? [];
  if (ignore && !files.includes(relativePath)) {
    files.push(relativePath);
  }
  const entry: DecisionEntry = { ignore, source };
  if (repositoryName !== undefined) {
    entry.repository_name = repositoryName;
  }
  if (ignore) {
    entry.files = files;
  }
  cache.filenames[filename] = entry;
}

export function getFileDecision(cache: DecisionsCache, contentHash: string): DecisionEntry | undefined {
  return cache.files[contentHash];
}

export function setFileDecision(
  cache: DecisionsCache,
  contentHash: string,
  ignore: boolean,
  source: DecisionEntry["source"],
  repositoryName: string | undefined,
  relativePath: string,
): void {
  const existing = cache.files[contentHash];
  const files = existing?.files ?? [];
  if (!files.includes(relativePath)) {
    files.push(relativePath);
  }
  const entry: DecisionEntry = { ignore, source, files };
  if (repositoryName !== undefined) {
    entry.repository_name = repositoryName;
  }
  cache.files[contentHash] = entry;
}

function narrow(value: unknown): DecisionsCache {
  if (typeof value !== "object" || value === null) {
    return emptyCache();
  }
  const rec = value as Record<string, unknown>;
  return {
    directories: narrowSection(rec["directories"]),
    extensions: narrowSection(rec["extensions"]),
    filenames: narrowSection(rec["filenames"]),
    filename_globs: narrowSection(rec["filename_globs"]),
    files: narrowSection(rec["files"]),
  };
}

function narrowSection(value: unknown): Record<string, DecisionEntry> {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  const out: Record<string, DecisionEntry> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) {
      continue;
    }
    const obj = raw as Record<string, unknown>;
    const ignore = obj["ignore"];
    const source = obj["source"];
    if (typeof ignore !== "boolean") {
      continue;
    }
    const entry: DecisionEntry = {
      ignore,
      source: source === "llm" ? "llm" : "hardcoded",
    };
    if (typeof obj["repository_name"] === "string") {
      entry.repository_name = obj["repository_name"];
    }
    if (Array.isArray(obj["files"])) {
      entry.files = obj["files"].filter((f): f is string => typeof f === "string");
    }
    out[key] = entry;
  }
  return out;
}

export function logCacheSummary(cache: DecisionsCache): void {
  const dirs = Object.keys(cache.directories).length;
  const exts = Object.keys(cache.extensions).length;
  const filenames = Object.keys(cache.filenames).length;
  const globs = Object.keys(cache.filename_globs).length;
  const files = Object.keys(cache.files).length;
  logger.info(
    `skip-decisions cache loaded: directories=${dirs} extensions=${exts} filenames=${filenames} globs=${globs} files=${files}`,
  );
}
