export enum JobType {
  GithubIndex = "github_index",
  GithubPull = "github_pull",
  LocalIngest = "local_ingest",
  BusinessContextProcessing = "CUSTOM_CONTEXT_PROCESSING",
}

export enum JobPriority {
  Low = 0,
  Normal = 1,
  High = 2,
}

/**
 * Optional per-job LLM credential overrides. When set, take precedence over
 * `Config.OpenrouterApiKey` and `Config.LlmProvider` for the duration of this
 * job's processing. Used by downstream consumers (e.g. the enterprise wrapper)
 * that resolve per-org credentials at the enqueue boundary and infuse them
 * into the payload — OSS standalone leaves all four unset.
 *
 * `llmProvider` is intentionally `string` rather than a closed union: OSS
 * standalone uses `"openrouter"` or `"ollama"` (the only values the LLM
 * client routes on today), but downstream consumers may carry richer
 * provider taxonomies (`"anthropic"`, `"gemini"`, `"mistral"`, …) that the
 * OSS client ignores. The `llmKeyId` field is opaque to OSS — kept as an
 * audit pointer back to the resolver's source of truth.
 */
export interface PayloadLlmOverrides {
  llmApiKey?: string;
  llmProvider?: string;
  llmModel?: string;
  llmKeyId?: string;
  /**
   * Optional model override for high-volume, fine-grained per-unit analysis.
   * Reuses the same `llmApiKey` / `llmProvider` as the main model but swaps the
   * model id — letting a job route thousands of small per-unit calls to a cheaper / faster model.
   * Unset → fine-grained analysis falls back to `llmModel`.
   */
  unitsLlmModel?: string;
}

/**
 * A copy-on-write delta against one category of built-in ignore defaults.
 * `add` adds patterns to the effective ignore set; `remove` un-ignores a
 * built-in default (its strings are matched verbatim against the seed lists).
 * Both are plain string arrays so the patch serializes cleanly into a queue
 * payload.
 */
export interface IgnoreOverridePatch {
  add?: string[];
  remove?: string[];
}

/**
 * Per-job ignore overrides, supplied by a downstream multi-tenant wrapper that
 * resolves an org's custom ignore config at the enqueue boundary and infuses it
 * into the payload. Each category overlays the worker's built-in seed defaults
 * (see `pipeline/skip-decisions/effective.ts`). OSS standalone leaves this unset
 * and the worker uses pure seed defaults — behavior identical to before this
 * field existed.
 *
 * `globs` removals are matched as exact pattern strings (not glob-evaluated)
 * against the seed glob list.
 */
export interface IgnoreOverrides {
  directories?: IgnoreOverridePatch;
  filenames?: IgnoreOverridePatch;
  extensions?: IgnoreOverridePatch;
  globs?: IgnoreOverridePatch;
}

export interface GithubIndexPayload extends PayloadLlmOverrides {
  knowledgeId: string;
  repoUrl: string;
  branch?: string;
  commitHash?: string;
  gitToken?: string;
  orgId?: string;
  /** Optional per-job ignore overrides; absent in OSS standalone runs. */
  ignoreOverrides?: IgnoreOverrides;
}

export interface GithubPullPayload extends PayloadLlmOverrides {
  knowledgeId: string;
  /**
   * Optional org binding. OSS standalone leaves this unset and the pipeline
   * reads `Config.OrgId` (locked to `"local"`). Downstream multi-tenant
   * deployments stamp it from the request so worker lookups can scope by org.
   */
  orgId?: string;
  /**
   * Optional commit to re-index the knowledge to. Must be a 40-character hex SHA
   * and must be reachable from `origin/<knowledge.branch>`. When omitted, the
   * worker resolves the branch's HEAD after clone. Direction does not matter —
   * the orchestrator handles forward, backward, and sideways targets through
   * the same diff machinery. See `docs/pull-plan.md`.
   */
  targetCommitHash?: string;
  /**
   * Optional previously-indexed commit, supplied by provider wrappers (e.g. GitLab)
   * whose source kind stores its head outside `source.commitId`. When set, runPull
   * uses it as the current commit; GitHub leaves it unset and falls back to
   * `source.commitId`.
   */
  previousCommit?: string;
  /**
   * Optional repo URL / branch pass-through for provider wrappers whose injected
   * `pullFactory` re-reads the payload to resolve the clone target (e.g. GitLab).
   * GitHub's runPull ignores these and reads `kDoc.info.repoUrl` / `kDoc.info.branch`.
   */
  repoUrl?: string;
  branch?: string;
  gitToken?: string;
  /** Optional per-job ignore overrides; absent in OSS standalone runs. */
  ignoreOverrides?: IgnoreOverrides;
  /**
   * Marks this pull as an unattended auto-pull / bulk refresh of already-indexed
   * knowledge. When true, a terminal failure preserves the prior `PROCESSED` state
   * instead of marking the knowledge `FAILED`/`HALTED` — a failed background refresh
   * must never degrade a healthy index. OSS standalone never sets this (no auto-pull),
   * so behavior there is unchanged. See `pull-failure.ts`.
   */
  isAutoPull?: boolean;
}

export interface LocalIngestPayload {
  knowledgeId: string;
  rootDir: string;
  orgId?: string;
}

/**
 * Payload for the BusinessContext processing job. A BusinessContext is a free-text
 * note authored by a human against a specific indexed commit of a GitHub knowledge.
 * The worker analyses the text into structured product/technical fields, persists
 * it to the per-commit meta tree on disk, and projects it into Neo4j as a
 * `:BusinessContext` node plus a `:BusinessContextVersion` snapshot keyed by
 * `(knowledgeId, commitHash)`.
 *
 * `orgId` is single-tenant (`"local"`) in OSS; downstream multi-tenant deployments
 * stamp it from the request so org-scoped keyword nodes stay isolated.
 */
export interface BusinessContextProcessingPayload extends PayloadLlmOverrides {
  knowledgeId: string;
  /** 40-char hex SHA of the commit this business context applies to. */
  commitHash: string;
  /** Raw, user-authored business-context text. */
  customText: string;
  /** Optional human-supplied description for the job-tracking record. */
  description?: string;
  /** Optional repo URL (carried for audit; ingestion does not re-clone). */
  repoUrl?: string;
  /** Optional branch (carried for audit). */
  branch?: string;
  /** Tenant binding. OSS standalone leaves this unset (defaults to `"local"`). */
  orgId?: string;
}

export interface JobMessage<P> {
  id: string;
  type: JobType;
  priority: JobPriority;
  knowledgeId: string;
  attempt: number;
  createdAt: string;
  payload: P;
}

export type PayloadFor<T extends JobType> = T extends JobType.GithubIndex
  ? GithubIndexPayload
  : T extends JobType.GithubPull
    ? GithubPullPayload
    : T extends JobType.LocalIngest
      ? LocalIngestPayload
      : T extends JobType.BusinessContextProcessing
        ? BusinessContextProcessingPayload
        : never;
