import crypto from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { getPlumblineHome, getConfigValue } from "@bb/config";
import {
  plumblinePathsFor,
  commitBaseDirFor,
  Config,
  metaOutputRootFor,
  orgsRootFor,
  parseGithubOwnerRepo,
  parseGitlabOwnerRepo,
  repositoryDirFor,
  type RepoLocation as KernelRepoLocation,
} from "@bb/types";
import { knowledgeDb } from "@bb/db";
import { KnowledgeNotFoundError } from "@bb/errors";
import type { MetaPaths } from "#src/types/meta-paths.ts";

const DIR_MODE = 0o700;

/** Re-export the kernel `RepoLocation` so existing callers needn't import from `@bb/types`. */
export type RepoLocation = KernelRepoLocation;

// ─────────────────────────────────────────────────────────────────────────────
// Commit-scoped on-disk layout. Every artifact for a single (orgId,
// knowledge, repo, commit) tuple lives under one tree:
//
//   ~/.plumbline/orgs/<orgId>/<provider>/<knowledgeId>/<owner>/<repo>/<commit>/repository/
//   ~/.plumbline/orgs/<orgId>/<provider>/<knowledgeId>/<owner>/<repo>/<commit>/meta-output/...
//
// For local sources (no owner/repo) the branch collapses to:
//
//   ~/.plumbline/orgs/<orgId>/local/<knowledgeId>/<syntheticCommit>/repository/
//   ~/.plumbline/orgs/<orgId>/local/<knowledgeId>/<syntheticCommit>/meta-output/...
//
// Every commit gets its own self-contained snapshot — repository + analysis
// + summaries together — rather than scattering meta-output across a
// separate top-level .meta tree.
// ─────────────────────────────────────────────────────────────────────────────

/** Root of the orgs tree. Single tenant in OSS, but the path still carries orgId. */
export function orgsRoot(): string {
  return orgsRootFor(getPlumblineHome());
}

/**
 * The per-commit base directory. Everything for this `(orgId, provider,
 * knowledgeId, owner?, repo?, commitHash)` tuple lives under this path.
 */
export function commitBaseDir(loc: RepoLocation): string {
  return commitBaseDirFor(getPlumblineHome(), loc);
}

/** Clone destination — the cloned source tree for this commit. */
export function repositoryDir(loc: RepoLocation): string {
  return repositoryDirFor(getPlumblineHome(), loc);
}

/** Meta-output root — all analysis artifacts for this commit. */
export function metaOutputRoot(loc: RepoLocation): string {
  return metaOutputRootFor(getPlumblineHome(), loc);
}

/**
 * Org-level registries (keyword aggregation across knowledges in the same org).
 * Lives one level above the per-knowledge tree: `orgs/<orgId>/<provider>/`.
 */
export function orgRegistryDirV2(loc: RepoLocation): string {
  return path.join(orgsRoot(), loc.orgId, loc.provider);
}

/**
 * Build the full `MetaPaths` bundle for a `RepoLocation`. This is the single
 * source of truth for every per-commit meta artifact path.
 */
export function pathsFor(loc: RepoLocation): MetaPaths {
  return plumblinePathsFor(getPlumblineHome(), loc);
}

/** Business-context directory for a specific titled context, under this commit's meta-output. */
export function businessContextDirV2(loc: RepoLocation, sanitizedTitle: string): string {
  return path.join(metaOutputRoot(loc), "business-context", sanitizedTitle);
}

export async function ensureCommitDirs(loc: RepoLocation): Promise<void> {
  const paths = pathsFor(loc);
  await mkdir(paths.repositoryDir, { recursive: true, mode: DIR_MODE });
  await mkdir(paths.fileAnalysisDir, { recursive: true, mode: DIR_MODE });
  await mkdir(paths.folderSummariesDir, { recursive: true, mode: DIR_MODE });
  await mkdir(paths.bigFileAnalysisDir, { recursive: true, mode: DIR_MODE });
  await mkdir(paths.bigFileChunksDir, { recursive: true, mode: DIR_MODE });
}

// ─────────────────────────────────────────────────────────────────────────────
// knowledgeId-keyed resolvers. Now store-aware: they look up `KnowledgeDoc`
// to derive `(orgId, owner, repo, commitHash)` and delegate to the pure
// `pathsFor` resolver above. Used by callers that hold only a knowledgeId
// handle — primarily `@bb/ingest-business-context` and the migration
// command. Async because the lookup is async; the old sync legacy
// resolvers (`metaRootFor`, `metaPathsFor`, `repoCloneDir`, etc.) were
// deleted in the kube-v2 cutover.
//
// `commitHash` may be passed explicitly (e.g. business-context referencing a
// historical commit) or defaulted to the knowledge's current head via
// `source.commitId`.
// ─────────────────────────────────────────────────────────────────────────────

async function repoLocationFor(knowledgeId: string, commitHash?: string): Promise<RepoLocation> {
  const kDoc = await knowledgeDb.getKnowledge(knowledgeId);
  if (kDoc === null) {
    throw new KnowledgeNotFoundError(knowledgeId);
  }
  const orgId = getConfigValue(Config.OrgId);
  if (kDoc.source.kind === "local") {
    return {
      provider: "local",
      orgId,
      knowledgeId,
      branch: kDoc.info.branch ?? "main",
      commitHash: commitHash ?? kDoc.source.sourcePath, // best-effort fallback when no commit
    };
  }
  const repoUrl = kDoc.info.repoUrl;
  if (repoUrl === undefined || repoUrl.length === 0) {
    throw new Error(`paths: knowledge ${knowledgeId} has no info.repoUrl`);
  }
  // GitLab projects can be nested in subgroups, so its owner/repo derivation
  // differs from GitHub (subgroups collapse into the owner namespace). Both
  // providers share the on-disk `provider: "github"` segment — the GitLab
  // ingester writes there too — so only the owner/repo split is host-specific.
  const parsed = repoUrl.includes("gitlab.com") ? parseGitlabOwnerRepo(repoUrl) : parseGithubOwnerRepo(repoUrl);
  if (parsed === null) {
    throw new Error(`paths: could not parse owner/repo from ${repoUrl}`);
  }
  const effectiveCommit = commitHash ?? kDoc.source.commitId;
  if (effectiveCommit === undefined || effectiveCommit.length === 0) {
    throw new Error(`paths: knowledge ${knowledgeId} has no commitId; pass commitHash explicitly`);
  }
  return {
    provider: "github",
    orgId,
    knowledgeId,
    owner: parsed.owner,
    repo: parsed.repo,
    branch: kDoc.info.branch ?? "main",
    commitHash: effectiveCommit,
  };
}

/**
 * Per-knowledge meta-output root, resolved through the document store to the
 * commit-scoped kube-v2 directory for the current head commit.
 */
export async function metaRootFor(knowledgeId: string): Promise<string> {
  const loc = await repoLocationFor(knowledgeId);
  return metaOutputRoot(loc);
}

/**
 * Directory for business-context analyses authored against a specific commit.
 * Each business context lives at
 * `<meta-output>/business-context/<sanitizedTitle>/` and contains
 * `original.txt` (the raw user-authored text) and `analysis.json` (the LLM
 * analysis wrapped in its metadata envelope).
 */
export async function businessContextDir(
  knowledgeId: string,
  commitHash: string,
  sanitizedTitle: string,
): Promise<string> {
  const loc = await repoLocationFor(knowledgeId, commitHash);
  return businessContextDirV2(loc, sanitizedTitle);
}

/**
 * Org-level keyword registry directory. Under the kube-v2 layout this is
 * `orgs/<orgId>/<provider>/v2/` — one level above the per-knowledge tree,
 * shared across every knowledge in the same org.
 */
export async function orgRegistryDir(knowledgeId: string, _orgId: string): Promise<string> {
  const loc = await repoLocationFor(knowledgeId);
  return orgRegistryDirV2(loc);
}

const SLASH_RE = /\//gu;
const BACKSLASH_RE = /\\/gu;
const ENCODED_SLASH_RE = /__SL__/gu;
const ENCODED_BACKSLASH_RE = /__BS__/gu;

export function encodeMetaPath(relativePath: string): string {
  return relativePath.replace(SLASH_RE, "__SL__").replace(BACKSLASH_RE, "__BS__");
}

export function decodeMetaPath(encoded: string): string {
  return encoded.replace(ENCODED_SLASH_RE, "/").replace(ENCODED_BACKSLASH_RE, "\\");
}

/**
 * Deterministic, collision-safe, filesystem-safe id for a repo-relative path (or any path-shaped key:
 * folder paths, per-unit `<rel>__<qn>` / `<rel>:chunk-N__<qn>` ids). The storage-key scheme that REPLACES
 * `encodeMetaPath`: a single 64-hex SHA-256 component is always well under NAME_MAX (255) no matter how
 * deep the repo, so deeply-nested trees never hit `ENAMETOOLONG` (which `encodeMetaPath` does — it collapses
 * the whole path into one component). Deterministic (not a UUID) so a record stays locatable by recomputing
 * the hash and the cross-commit incremental cache still matches by name. Backslashes are normalised to `/`
 * so a key hashes identically regardless of scan platform; nothing else is normalised (paths are
 * case-sensitive — no lowercasing). The `<id> → path` inverse is persisted in `path-map.json` (see path-map.ts).
 */
export function metaId(key: string): string {
  return crypto.createHash("sha256").update(key.replace(BACKSLASH_RE, "/")).digest("hex");
}
