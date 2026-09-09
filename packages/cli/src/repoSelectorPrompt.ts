import React from "react";
import { render } from "ink";
import type { CommitHashRecord } from "@bb/types";
import { getJson } from "./httpClient.ts";
import {
  RepoSelector,
  type RepoSelectorConfirm,
  type RepoSelectorItem,
  type RepoSelectorResult,
} from "./RepoSelector.tsx";

/**
 * One-stop helper for "fetch indexed repos and let the user pick".
 *
 * Used by `delete`, `pull`, and any future command that operates on a
 * previously-indexed knowledge entry. Filters by source kind so commands
 * that only apply to one kind (pull → github only) don't re-filter.
 *
 * Multi-pick is the default (matches the rest of the CLI). Pass
 * `multi: false` for the rare case where exactly one item is needed. The
 * result is **always an array**: length ≥1 in multi mode, length 1 in
 * single mode (cancel → `null`).
 *
 * The empty-list message is printed to stdout here so callers don't all
 * reinvent it.
 */

export interface RepoListEntry {
  knowledgeId: string;
  source:
    | {
        kind: "github";
        repoUrl: string;
        branch?: string;
        commitId?: string;
        commitHashes?: (string | CommitHashRecord)[];
      }
    | { kind: "local"; sourcePath: string };
  state: string;
  createdAt: string;
  updatedAt: string;
  fileCount: number;
}

interface ListResponse {
  repos: RepoListEntry[];
}

export interface RepoSelectorPromptOptions {
  /** Heading for the picker — e.g. "Select a repo to delete". */
  title: string;
  /** Restrict to a single source kind. Omit (or "all") to show everything. */
  filterKind?: "github" | "local" | "all";
  /** Multi-pick (default `true`). Pass `false` to require exactly one item. */
  multi?: boolean;
  /** Optional confirm phase (y/N) — set for destructive actions like delete. */
  confirm?: RepoSelectorConfirm;
  /** Message shown when the filtered list is empty. */
  emptyMessage?: string;
}

export interface RepoSelectorPromptResult {
  /** Picked items aligned with their raw repo records. Always non-empty. */
  picked: Array<{ item: RepoSelectorItem; repo: RepoListEntry }>;
}

/** Fetches `/api/v1/repos`, applies kind filter, renders selector. */
export async function promptRepoSelector(opts: RepoSelectorPromptOptions): Promise<RepoSelectorPromptResult | null> {
  const { repos } = await getJson<ListResponse>("/api/v1/repos");
  const filtered = filterByKind(repos, opts.filterKind ?? "all");

  if (filtered.length === 0) {
    process.stdout.write(`${opts.emptyMessage ?? "No matching repos. Run `plumbline index <url>` to add one."}\n`);
    return null;
  }

  const items = filtered.map(toSelectorItem);
  const pickedItems = await renderSelector(items, opts);
  if (pickedItems === null || pickedItems.length === 0) {
    return null;
  }
  // Pair every picked item with its underlying repo record so callers don't
  // need to re-look-up by id.
  const byId = new Map(filtered.map((r) => [r.knowledgeId, r]));
  const picked = pickedItems
    .map((item) => {
      const repo = byId.get(item.knowledgeId);
      return repo === undefined ? null : { item, repo };
    })
    .filter((x): x is { item: RepoSelectorItem; repo: RepoListEntry } => x !== null);
  if (picked.length === 0) {
    return null;
  }
  return { picked };
}

function filterByKind(repos: RepoListEntry[], kind: "github" | "local" | "all"): RepoListEntry[] {
  if (kind === "all") {
    return repos;
  }
  return repos.filter((r) => r.source.kind === kind);
}

function toSelectorItem(repo: RepoListEntry): RepoSelectorItem {
  return {
    knowledgeId: repo.knowledgeId,
    label: formatSourceLabel(repo.source),
    detail: formatDetail(repo),
  };
}

function formatDetail(repo: RepoListEntry): string {
  const idChunk = `${repo.knowledgeId.slice(0, 8)}…`;
  if (repo.source.kind !== "github") {
    return `${repo.state}  ${idChunk}  ${repo.fileCount} files`;
  }
  const head =
    repo.source.commitId !== undefined && repo.source.commitId.length > 0
      ? `head=${repo.source.commitId.slice(0, 8)}`
      : "head=-";
  const commits = `${repo.source.commitHashes?.length ?? 0} commits`;
  return `${repo.state}  ${idChunk}  ${head}  ${commits}  ${repo.fileCount} files`;
}

function formatSourceLabel(source: RepoListEntry["source"]): string {
  if (source.kind === "github") {
    const slug = parseGithubSlug(source.repoUrl);
    const suffix = source.branch !== undefined && source.branch.length > 0 ? `@${source.branch}` : "";
    return `github:${slug}${suffix}`;
  }
  return `local:${source.sourcePath}`;
}

function parseGithubSlug(repoUrl: string): string {
  try {
    const u = new URL(repoUrl);
    return u.pathname.replace(/^\/+/u, "").replace(/\.git$/u, "");
  } catch {
    return repoUrl;
  }
}

async function renderSelector(
  items: RepoSelectorItem[],
  opts: RepoSelectorPromptOptions,
): Promise<RepoSelectorItem[] | null> {
  return new Promise<RepoSelectorItem[] | null>((resolve) => {
    const onDone = (result: RepoSelectorResult): void => {
      if (result.picked !== undefined && result.picked.length > 0) {
        resolve(result.picked);
        return;
      }
      resolve(null);
    };
    const { waitUntilExit } = render(
      React.createElement(RepoSelector, {
        items,
        title: opts.title,
        multi: opts.multi,
        confirm: opts.confirm,
        onDone,
      }),
    );
    waitUntilExit().catch(() => undefined);
  });
}
