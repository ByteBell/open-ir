// SPDX-License-Identifier: AGPL-3.0-only WITH non-commercial-clause
import path from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

// Per-tool adapter table for `plumbline mcp install`. Each target knows how to
// locate its config file, whether the tool looks installed, and the exact
// JSON shape its MCP server entry takes (the part that differs per tool).
//
// The server is HTTP-only, so every entry is a remote-URL type — there are no
// stdio (`command`/`args`) entries here.

export type TopLevelKey = "mcpServers" | "servers";

export interface McpTarget {
  id: string;
  label: string;
  /** Top-level object key the entry nests under. VS Code uses `servers`. */
  topLevelKey: TopLevelKey;
  /** Absolute config path, branched per platform. */
  configPath(): string;
  /** Heuristic "is this tool installed?" — config file or its app dir exists. */
  detect(): boolean;
  /** The `plumbline` server entry. Shape varies per tool. */
  entry(url: string): Record<string, unknown>;
}

function home(...segments: string[]): string {
  return path.join(homedir(), ...segments);
}

// App-support config root: macOS uses ~/Library/Application Support/<app>,
// Linux uses ~/.config/<app>.
function appSupport(appName: string): string {
  if (process.platform === "darwin") {
    return home("Library", "Application Support", appName);
  }
  return home(".config", appName);
}

function exists(p: string): boolean {
  return existsSync(p);
}

export const MCP_TARGETS: readonly McpTarget[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    topLevelKey: "mcpServers",
    configPath: () => home(".claude.json"),
    detect: () => exists(home(".claude.json")) || exists(home(".claude")),
    entry: (url) => ({ type: "http", url }),
  },
  {
    id: "cursor",
    label: "Cursor",
    topLevelKey: "mcpServers",
    configPath: () => home(".cursor", "mcp.json"),
    detect: () => exists(home(".cursor")),
    entry: (url) => ({ url }),
  },
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    topLevelKey: "mcpServers",
    configPath: () => path.join(appSupport("Claude"), "claude_desktop_config.json"),
    detect: () => exists(appSupport("Claude")),
    entry: (url) => ({ type: "http", url }),
  },
  {
    id: "windsurf",
    label: "Windsurf",
    topLevelKey: "mcpServers",
    configPath: () => home(".codeium", "windsurf", "mcp_config.json"),
    detect: () => exists(home(".codeium", "windsurf")) || exists(home(".codeium")),
    entry: (url) => ({ serverUrl: url }),
  },
  {
    id: "vscode",
    label: "VS Code",
    topLevelKey: "servers",
    configPath: () => path.join(appSupport("Code"), "User", "mcp.json"),
    detect: () => exists(appSupport("Code")),
    entry: (url) => ({ type: "http", url }),
  },
];
