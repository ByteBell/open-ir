import path from "node:path";
import { readFile } from "node:fs/promises";
import { getPlumblineHome, getConfigValue } from "@bb/config";
import { knowledgeDb } from "@bb/db";
import { Config, parseGithubOwnerRepo, repositoryDirFor, type RepoLocation } from "@bb/types";
import { IngestError, KnowledgeNotFoundError } from "@bb/errors";

// ─────────────────────────────────────────────────────────────────────────────
// MCP file resolution. Under the commit-scoped layout, the cloned source tree
// for a knowledge lives under
// `~/.plumbline/orgs/<orgId>/github/<knowledgeId>/<owner>/<repo>/<commit>/repository/`,
// so resolving the clone dir for a `knowledgeId` is no longer a pure-string
// operation — it needs a document-store lookup to find the active commit and the
// repo coordinates. We do one `KnowledgeDoc` read per `retrieve_file` call.
//
// For local knowledges (`source.kind === "local"`) we point straight at
// `source.sourcePath` since we don't copy local sources into the managed
// `repository/` dir.
// ─────────────────────────────────────────────────────────────────────────────

export class PathTraversalError extends Error {
  constructor(relativePath: string) {
    super(`Invalid relative path: ${relativePath} — path traversal or absolute path rejected.`);
    this.name = "PathTraversalError";
  }
}

export class FileReadError extends Error {
  constructor(relativePath: string, cause: unknown) {
    super(`Failed to read ${relativePath}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "FileReadError";
  }
}

/**
 * Resolves the active clone directory for `knowledgeId`. Reads
 * `KnowledgeDoc.source` from the document store to find the active commit; for github
 * sources, parses `info.repoUrl` to get owner/repo; for local sources,
 * returns `source.sourcePath` unchanged.
 */
export async function resolveCloneDir(knowledgeId: string): Promise<string> {
  const kDoc = await knowledgeDb.getKnowledge(knowledgeId);
  if (kDoc === null) {
    throw new KnowledgeNotFoundError(knowledgeId);
  }
  if (kDoc.source.kind === "local") {
    return kDoc.source.sourcePath;
  }
  // github
  const commitId = kDoc.source.commitId;
  if (commitId === undefined || commitId.length === 0) {
    throw new IngestError(knowledgeId, "knowledge has no commitId; cannot resolve clone dir");
  }
  const repoUrl = kDoc.info.repoUrl;
  if (repoUrl === undefined || repoUrl.length === 0) {
    throw new IngestError(knowledgeId, "knowledge has no info.repoUrl; cannot resolve clone dir");
  }
  const parsed = parseGithubOwnerRepo(repoUrl);
  if (parsed === null) {
    throw new IngestError(knowledgeId, `could not parse owner/repo from ${repoUrl}`);
  }
  const orgId = getConfigValue(Config.OrgId);
  const loc: RepoLocation = {
    provider: "github",
    orgId,
    knowledgeId,
    owner: parsed.owner,
    repo: parsed.repo,
    // Read-side resolves the branch the KB was indexed under (info.branch is set
    // at index time). Multi-branch read selection is a separate MCP-side effort.
    branch: kDoc.info.branch ?? "main",
    commitHash: commitId,
  };
  return repositoryDirFor(getPlumblineHome(), loc);
}

export async function resolveFilePath(knowledgeId: string, relativePath: string): Promise<string> {
  const normalized = relativePath.replace(/\\/gu, "/").replace(/^\.\/+/u, "");
  if (normalized.length === 0 || normalized.startsWith("/") || normalized.includes("..")) {
    throw new PathTraversalError(relativePath);
  }
  // Canonicalize both sides via path.resolve so any non-canonical segments in
  // cloneDir (trailing slash, `.`, embedded `//`) don't break the string-prefix
  // containment check. Then verify containment with path.relative — if the
  // resolved target lives inside cloneDir, the relative form is a non-`..`,
  // non-absolute string.
  const cloneDir = path.resolve(await resolveCloneDir(knowledgeId));
  const target = path.resolve(cloneDir, normalized);
  const rel = path.relative(cloneDir, target);
  if (rel.length === 0) {
    // Asking for the clone dir itself — not a file, refuse.
    throw new PathTraversalError(relativePath);
  }
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new PathTraversalError(relativePath);
  }
  return target;
}

export async function readFileLines(knowledgeId: string, relativePath: string): Promise<string[]> {
  const target = await resolveFilePath(knowledgeId, relativePath);
  let content: string;
  try {
    content = await readFile(target, "utf8");
  } catch (cause: unknown) {
    throw new FileReadError(relativePath, cause);
  }
  return content.split(/\r?\n/u);
}

export interface SliceOptions {
  fromLine: number;
  toLine: number;
}

export function sliceLines(lines: readonly string[], opts: SliceOptions): string[] {
  const from = Math.max(1, opts.fromLine);
  const to = Math.max(from, Math.min(lines.length, opts.toLine));
  return lines.slice(from - 1, to);
}

export function prefixWithLineNumbers(lines: readonly string[], startLine: number): string {
  const width = String(startLine + lines.length - 1).length;
  return lines.map((line, idx) => `${String(startLine + idx).padStart(width, " ")} | ${line}`).join("\n");
}
