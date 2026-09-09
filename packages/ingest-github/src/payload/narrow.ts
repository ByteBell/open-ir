import type {
  GithubIndexPayload,
  IgnoreOverridePatch,
  IgnoreOverrides,
  LocalIngestPayload,
  PayloadLlmOverrides,
} from "@bb/types";
import { IngestError } from "@bb/errors";

const PATCH_CATEGORIES = ["directories", "filenames", "extensions", "globs"] as const;

function narrowStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value.filter((v): v is string => typeof v === "string" && v.length > 0);
  return strings.length > 0 ? strings : undefined;
}

function narrowPatch(value: unknown): IgnoreOverridePatch | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const rec = value as Record<string, unknown>;
  const patch: IgnoreOverridePatch = {};
  const add = narrowStringArray(rec["add"]);
  if (add !== undefined) {
    patch.add = add;
  }
  const remove = narrowStringArray(rec["remove"]);
  if (remove !== undefined) {
    patch.remove = remove;
  }
  return patch.add !== undefined || patch.remove !== undefined ? patch : undefined;
}

/**
 * Copy per-job ignore overrides off the queue payload, if present and
 * well-formed. The enqueue boundary (enterprise gateway) stamps this from the
 * org's stored ignore config; OSS standalone never sets it.
 */
function attachIgnoreOverrides(rec: Record<string, unknown>, target: { ignoreOverrides?: IgnoreOverrides }): void {
  const raw = rec["ignoreOverrides"];
  if (typeof raw !== "object" || raw === null) {
    return;
  }
  const rawRec = raw as Record<string, unknown>;
  const overrides: IgnoreOverrides = {};
  for (const category of PATCH_CATEGORIES) {
    const patch = narrowPatch(rawRec[category]);
    if (patch !== undefined) {
      overrides[category] = patch;
    }
  }
  if (Object.keys(overrides).length > 0) {
    target.ignoreOverrides = overrides;
  }
}

/**
 * Copies optional LLM credential / model overrides from a payload record onto
 * a typed payload. Enterprise wrappers resolve per-org credentials at the
 * enqueue boundary and stamp them on the queue payload; without this passthrough
 * the worker would always fall back to global config (and the resolver work is
 * wasted). OSS standalone leaves all four unset, so nothing happens here.
 */
function attachLlmOverrides(rec: Record<string, unknown>, target: PayloadLlmOverrides): void {
  const apiKey = rec["llmApiKey"];
  if (typeof apiKey === "string" && apiKey.length > 0) {
    target.llmApiKey = apiKey;
  }
  const provider = rec["llmProvider"];
  if (typeof provider === "string" && provider.length > 0) {
    target.llmProvider = provider;
  }
  const model = rec["llmModel"];
  if (typeof model === "string" && model.length > 0) {
    target.llmModel = model;
  }
  const keyId = rec["llmKeyId"];
  if (typeof keyId === "string" && keyId.length > 0) {
    target.llmKeyId = keyId;
  }
}

export function narrowGithubIngest(knowledgeId: string, payload: unknown): GithubIndexPayload {
  if (typeof payload !== "object" || payload === null) {
    throw new IngestError(knowledgeId, "github_index payload must be an object");
  }
  const rec = payload as Record<string, unknown>;
  const kid = rec["knowledgeId"];
  const repoUrl = rec["repoUrl"];
  if (typeof kid !== "string" || kid.length === 0) {
    throw new IngestError(knowledgeId, "github_index payload missing knowledgeId");
  }
  if (typeof repoUrl !== "string" || repoUrl.length === 0) {
    throw new IngestError(knowledgeId, "github_index payload missing repoUrl");
  }
  const out: GithubIndexPayload = { knowledgeId: kid, repoUrl };
  const branch = rec["branch"];
  if (typeof branch === "string" && branch.length > 0) {
    out.branch = branch;
  }
  const commitHash = rec["commitHash"];
  if (typeof commitHash === "string" && commitHash.length > 0) {
    out.commitHash = commitHash;
  }
  const gitToken = rec["gitToken"];
  if (typeof gitToken === "string" && gitToken.length > 0) {
    out.gitToken = gitToken;
  }
  const orgId = rec["orgId"];
  if (typeof orgId === "string" && orgId.length > 0) {
    out.orgId = orgId;
  }
  attachLlmOverrides(rec, out);
  attachIgnoreOverrides(rec, out);
  return out;
}

export function narrowLocalIngest(knowledgeId: string, payload: unknown): LocalIngestPayload {
  if (typeof payload !== "object" || payload === null) {
    throw new IngestError(knowledgeId, "local_ingest payload must be an object");
  }
  const rec = payload as Record<string, unknown>;
  const kid = rec["knowledgeId"];
  const rootDir = rec["rootDir"];
  if (typeof kid !== "string" || kid.length === 0) {
    throw new IngestError(knowledgeId, "local_ingest payload missing knowledgeId");
  }
  if (typeof rootDir !== "string" || rootDir.length === 0) {
    throw new IngestError(knowledgeId, "local_ingest payload missing rootDir");
  }
  const out: LocalIngestPayload = { knowledgeId: kid, rootDir };
  const orgId = rec["orgId"];
  if (typeof orgId === "string" && orgId.length > 0) {
    out.orgId = orgId;
  }
  attachLlmOverrides(rec, out as PayloadLlmOverrides);
  return out;
}

export function isEnvelopeCoherent(jobKnowledgeId: string, payloadKnowledgeId: string): boolean {
  return jobKnowledgeId === payloadKnowledgeId;
}
