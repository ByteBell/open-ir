// SPDX-License-Identifier: AGPL-3.0-only WITH non-commercial-clause
import path from "node:path";
import { existsSync, mkdirSync, readFileSync, copyFileSync, writeFileSync, renameSync } from "node:fs";
import React from "react";
import { render } from "ink";
import { Config } from "@bb/types";
import { getConfigValue } from "@bb/config";
import { success, error, info, table } from "./output.ts";
import { MCP_TARGETS, type McpTarget } from "./mcpTargets.ts";
import { McpToolSelector, type McpToolSelectorItem, type McpToolSelectorResult } from "./McpToolSelector.tsx";

type Status = "configured" | "failed";

interface InstallResult {
  label: string;
  status: Status;
  detail: string;
}

export interface McpInstallSummary {
  detected: number;
  configured: number;
  failed: number;
}

export async function runMcpInstall(): Promise<McpInstallSummary> {
  const port = getConfigValue(Config.ServerPort);
  const url = `http://127.0.0.1:${port}/mcp`;

  const detected = MCP_TARGETS.filter((t) => t.detect());
  if (detected.length === 0) {
    info("No supported coding tools detected (Claude Code, Cursor, Claude Desktop, Windsurf, VS Code).");
    return { detected: 0, configured: 0, failed: 0 };
  }

  const picked = await pickTargets(detected);
  if (picked === null || picked.length === 0) {
    info("Nothing selected — no changes made.");
    return { detected: detected.length, configured: 0, failed: 0 };
  }

  const results = picked.map((t) => applyTarget(t, url));
  printSummary(results, url);
  return {
    detected: detected.length,
    configured: results.filter((r) => r.status === "configured").length,
    failed: results.filter((r) => r.status === "failed").length,
  };
}

// Merge the plumbline entry into one tool's config. Never clobbers: reads the
// existing JSON, backs it up, injects only the `plumbline` key under the tool's
// top-level key, and atomic-writes. A malformed existing file fails this tool
// (caught below) rather than being overwritten.
function applyTarget(target: McpTarget, url: string): InstallResult {
  const file = target.configPath();
  try {
    const doc = readJsonObject(file);
    if (existsSync(file)) {
      copyFileSync(file, `${file}.plumbline.bak`);
    } else {
      mkdirSync(path.dirname(file), { recursive: true });
    }
    const servers = asObject(doc[target.topLevelKey]);
    servers["plumbline"] = target.entry(url);
    doc[target.topLevelKey] = servers;
    atomicWriteJson(file, doc);
    return { label: target.label, status: "configured", detail: file };
  } catch (err: unknown) {
    return { label: target.label, status: "failed", detail: describeError(err) };
  }
}

async function pickTargets(detected: readonly McpTarget[]): Promise<McpTarget[] | null> {
  // Non-interactive (piped stdin / CI): can't prompt, so configure all detected.
  if (process.stdin.isTTY !== true) {
    return [...detected];
  }
  const items: McpToolSelectorItem[] = detected.map((t) => ({ id: t.id, label: t.label, detail: t.configPath() }));
  const pickedItems = await renderSelector(items);
  if (pickedItems === null) {
    return null;
  }
  const pickedIds = new Set(pickedItems.map((i) => i.id));
  return detected.filter((t) => pickedIds.has(t.id));
}

async function renderSelector(items: McpToolSelectorItem[]): Promise<McpToolSelectorItem[] | null> {
  return new Promise<McpToolSelectorItem[] | null>((resolve) => {
    const onDone = (result: McpToolSelectorResult): void => {
      resolve(result.picked !== undefined && result.picked.length > 0 ? result.picked : null);
    };
    const { waitUntilExit } = render(React.createElement(McpToolSelector, { items, onDone }));
    waitUntilExit().catch(() => undefined);
  });
}

function printSummary(results: readonly InstallResult[], url: string): void {
  table(
    ["Tool", "Status", "Detail"],
    results.map((r) => [r.label, r.status, r.detail]),
  );
  const configured = results.filter((r) => r.status === "configured").length;
  const failed = results.filter((r) => r.status === "failed").length;
  if (configured > 0) {
    success(`Configured ${configured} tool(s) → ${url}`);
    info("Restart the tool (or reload its MCP servers) to pick up the change.");
  }
  if (failed > 0) {
    error(`${failed} tool(s) failed — see the table above.`);
    process.exitCode = 1;
  }
}

function readJsonObject(file: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err: unknown) {
    if (isENOENT(err)) {
      return {};
    }
    throw err;
  }
  if (raw.trim().length === 0) {
    return {};
  }
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("existing config is not a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return { ...(value as Record<string, unknown>) };
  }
  return {};
}

function atomicWriteJson(file: string, doc: unknown): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

function isENOENT(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as { code?: unknown }).code === "ENOENT";
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
