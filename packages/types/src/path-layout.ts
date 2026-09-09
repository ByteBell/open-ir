import crypto from "node:crypto";
import path from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// Pure-typed on-disk path resolver shared across packages that need to read
// or write knowledge artifacts. No I/O, no FS calls — every helper returns
// strings derived from the inputs (a sha256 of a branch name is such a
// derivation; `node:crypto` is a runtime builtin, not a package dependency).
// Callers compose with their own `getPlumblineHome()` (the package boundary
// that holds the home-dir state).
//
// Layout (per knowledge + provider + branch + commit):
//   `<home>/<provider>/<knowledgeId>/<owner>/<repo>/<branchId>/<commit>/repository/`
//   `<home>/<provider>/<knowledgeId>/<owner>/<repo>/<branchId>/<commit>/meta-output/`
// For local sources the `<owner>/<repo>` segments collapse:
//   `<home>/local/<knowledgeId>/<branchId>/<commit>/repository/`
//
// `<branchId>` is `branchIdFor(loc.branch)` — a sha256 of the branch name, so
// one repo knowledge can hold many indexed branches side by side, each a
// self-contained subtree (see `branchIdFor` for why it is hashed, not raw).
//
// `<home>` is the per-tenant base directory:
//   • OSS standalone: `~/.plumbline/` (single-tenant; no org segment)
//   • Enterprise: `<KNOWLEDGE_BASE_PATH>/orgs/<orgName>/` (via the
//     `setPlumblineHomeResolver` override in `seed-oss-config.ts`)
//
// The resolver deliberately stays org-agnostic. The org segment lives in
// `<home>` when the host requires per-tenant isolation — adding it again
// here would duplicate it for enterprise consumers.
//
// See `@bb/ingest-github/src/pipeline/paths.ts` for the I/O-aware wrappers
// that pair with this module.
// ─────────────────────────────────────────────────────────────────────────────

export type RepoLocation =
  | {
      provider: "github";
      orgId: string;
      knowledgeId: string;
      owner: string;
      repo: string;
      branch: string;
      commitHash: string;
    }
  | {
      provider: "local";
      orgId: string;
      knowledgeId: string;
      branch: string;
      commitHash: string;
    };

/**
 * Same `MetaPaths` shape that `@bb/ingest-github` exposes — duplicated here
 * so kernel-tier consumers can describe the surface without taking a Domain
 * dependency. Field semantics: see `@bb/ingest-github/types/meta-paths.ts`.
 */
export interface MetaPathsLayout {
  repositoryDir: string;
  metaOutputRoot: string;
  metaRoot: string;
  fileAnalysisDir: string;
  folderSummariesDir: string;
  bigFileAnalysisDir: string;
  bigFileChunksDir: string;
  bigFilesJson: string;
  scanManifestJson: string;
  repoSummaryJson: string;
}

/**
 * Deprecated. Kept as a back-compat shim for the migration tool, which
 * describes the legacy layout `<home>/orgs/<orgId>/…`. The active layout
 * no longer adds an `orgs/` segment here — that responsibility moved into
 * `<home>` itself (enterprise's `getPlumblineHome` resolver returns a
 * per-tenant `<base>/orgs/<orgName>/`).
 */
export function orgsRootFor(home: string): string {
  return path.join(home, "orgs");
}

const BRANCH_BACKSLASH_RE = /\\/gu;

/**
 * Deterministic, filesystem-safe id for a git branch name — the `<branchId>`
 * path segment and the `branchId` key on `:Branch`/`:FileVersion`/other
 * branch-scoped graph nodes. A single 64-hex SHA-256 component sidesteps every
 * branch-name hazard at once: embedded slashes (`feat/x`), length caps, and
 * case-insensitive filesystems (`Feature` vs `feature` hash differently, so no
 * collision). The human-readable name is kept on `knowledge.info.branch`
 * and the `:Branch` node, never on disk. Mirrors the hashing of
 * `@bb/ingest-core`'s `metaId`; kept here in the kernel so every tier can
 * derive a branch id without importing upward (same rationale as the
 * duplicated `parseGithubOwnerRepo`). Backslashes normalise to `/` so a name
 * hashes identically regardless of platform; nothing else is normalised
 * (branch names are case-sensitive).
 */
export function branchIdFor(branch: string): string {
  return crypto.createHash("sha256").update(branch.replace(BRANCH_BACKSLASH_RE, "/")).digest("hex");
}

export function commitBaseDirFor(home: string, loc: RepoLocation): string {
  const branchId = branchIdFor(loc.branch);
  if (loc.provider === "github") {
    return path.join(home, "github", loc.knowledgeId, loc.owner, loc.repo, branchId, loc.commitHash);
  }
  return path.join(home, "local", loc.knowledgeId, branchId, loc.commitHash);
}

export function repositoryDirFor(home: string, loc: RepoLocation): string {
  return path.join(commitBaseDirFor(home, loc), "repository");
}

export function metaOutputRootFor(home: string, loc: RepoLocation): string {
  return path.join(commitBaseDirFor(home, loc), "meta-output");
}

export function plumblinePathsFor(home: string, loc: RepoLocation): MetaPathsLayout {
  const meta = metaOutputRootFor(home, loc);
  return {
    repositoryDir: repositoryDirFor(home, loc),
    metaOutputRoot: meta,
    metaRoot: meta,
    fileAnalysisDir: path.join(meta, "file-analysis"),
    folderSummariesDir: path.join(meta, "folder-summaries"),
    bigFileAnalysisDir: path.join(meta, "big-file-analysis"),
    bigFileChunksDir: path.join(meta, "big-file-analysis", "chunks"),
    bigFilesJson: path.join(meta, "bigFiles.json"),
    scanManifestJson: path.join(meta, "scan-manifest.json"),
    repoSummaryJson: path.join(meta, "repo-summary.json"),
  };
}

/**
 * Pure URL parser for GitHub repo URLs. Extracts owner and repo segments,
 * tolerating `.git` suffixes and `tree/branch` paths. Returns `null` on any
 * input that isn't a GitHub-hosted URL.
 *
 * Duplicates the public `parseGithubRepo` from `@bb/ingest-github/githubUrl`
 * deliberately — kernel-tier code can't import from Domain. The two
 * implementations must stay consistent; both are tiny and pure.
 */
export function parseGithubOwnerRepo(repoUrl: string): { owner: string; repo: string } | null {
  if (repoUrl.length === 0) {
    return null;
  }
  try {
    const url = new URL(repoUrl);
    if (!url.hostname.endsWith("github.com") && !url.hostname.endsWith("gitlab.com")) {
      return null;
    }
    const segments = url.pathname.split("/").filter((s) => s.length > 0);
    if (segments.length < 2) {
      return null;
    }
    const owner = segments[0];
    const repoRaw = segments[1];
    if (owner === undefined || repoRaw === undefined) {
      return null;
    }
    return { owner, repo: repoRaw.replace(/\.git$/u, "") };
  } catch {
    return null;
  }
}

/**
 * Pure URL parser for GitLab repo URLs that preserves subgroups. GitLab
 * projects can be nested arbitrarily deep (`group/subgroup/project`); the
 * canonical project path is "everything up to the last segment as the owner
 * namespace, last segment as the repo". Returns `null` for non-gitlab.com
 * hosts or paths with fewer than two segments.
 *
 * This MUST stay consistent with `deriveOwnerRepo` in
 * `@plumbline/.../ingest-gitlab/src/source-factory.ts`, which is what the GitLab
 * ingester uses to choose the on-disk `<owner>/<repo>` directory segments. The
 * business-context reader resolves the same path via `repoLocationFor`, so the
 * two derivations must agree or enrichment reads miss the directory.
 */
export function parseGitlabOwnerRepo(repoUrl: string): { owner: string; repo: string } | null {
  if (repoUrl.length === 0) {
    return null;
  }
  try {
    const url = new URL(repoUrl);
    if (!url.hostname.endsWith("gitlab.com")) {
      return null;
    }
    const segments = url.pathname.split("/").filter((s) => s.length > 0);
    if (segments.length < 2) {
      return null;
    }
    const repoRaw = segments[segments.length - 1];
    if (repoRaw === undefined) {
      return null;
    }
    return { owner: segments.slice(0, -1).join("/"), repo: repoRaw.replace(/\.git$/u, "") };
  } catch {
    return null;
  }
}
