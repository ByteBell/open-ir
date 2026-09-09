import path from "node:path";
import type { KnowledgeDoc, KnowledgeState } from "@bb/types";
import { _runCypher } from "./client.ts";

const UPSERT_KNOWLEDGE = `
MERGE (k:Knowledge {knowledgeId: $knowledgeId})
ON CREATE SET k.createdAt = $createdAt
SET k.sourceKind = $sourceKind,
    k.sourceUrl = $sourceUrl,
    k.branch = $branch,
    k.repoName = $repoName,
    k.state = $state,
    k.updatedAt = $updatedAt
`;

const SET_STATE = `
MATCH (k:Knowledge {knowledgeId: $knowledgeId})
SET k.state = $state, k.updatedAt = $updatedAt
`;

const SET_BRANCH = `
MATCH (k:Knowledge {knowledgeId: $knowledgeId})
SET k.branch = $branch, k.updatedAt = $updatedAt
`;

const DELETE_FILES_BY_KNOWLEDGE = `
MATCH (f:File {knowledgeId: $knowledgeId})
DETACH DELETE f
`;

const DELETE_REPOS_BY_KNOWLEDGE = `
MATCH (r:Repo {knowledgeId: $knowledgeId})
DETACH DELETE r
`;

const DELETE_FOLDERS_BY_KNOWLEDGE = `
MATCH (folder:Folder {knowledgeId: $knowledgeId})
DETACH DELETE folder
`;

const DELETE_KNOWLEDGE_NODE = `
MATCH (k:Knowledge {knowledgeId: $knowledgeId})
DETACH DELETE k
`;

// Defensive cleanup: wipe File nodes whose knowledgeId has no matching
// :Knowledge. Orphans accumulate when a worker writes files after the Knowledge
// node is deleted (interrupted runs, racing deletes, partial failures). The TUI
// delete picker reads from the document store, so orphan-only knowledgeIds are otherwise
// unreachable.
const DELETE_ORPHAN_FILES = `
MATCH (f:File)
WHERE NOT EXISTS { MATCH (:Knowledge {knowledgeId: f.knowledgeId}) }
DETACH DELETE f
`;

// Entity nodes (:Keyword/:Class/:Function/:Module) are global, MERGE-deduped
// across all knowledges. After deleting a knowledge's Files, any entity node
// that was ONLY referenced by those Files becomes an orphan with no incoming
// HAS_* edge. Sweep them so the graph stays tidy.
const DELETE_ORPHAN_ENTITIES = `
MATCH (n)
WHERE (n:Keyword OR n:Class OR n:Function OR n:Module)
  AND NOT EXISTS { MATCH (:File)-[]->(n) }
DETACH DELETE n
`;

export async function upsertKnowledgeNode(doc: KnowledgeDoc): Promise<void> {
  const sourceKind = doc.source.kind;
  const sourceUrl = doc.source.kind === "github" ? (doc.info.repoUrl ?? "") : doc.source.sourcePath;
  const branch = doc.source.kind === "github" ? (doc.info.branch ?? null) : null;
  await _runCypher(UPSERT_KNOWLEDGE, {
    knowledgeId: doc.knowledgeId,
    sourceKind,
    sourceUrl,
    branch,
    repoName: deriveRepoName(doc),
    state: doc.status.state,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  });
}

export async function setKnowledgeStateInGraph(knowledgeId: string, state: KnowledgeState): Promise<void> {
  await _runCypher(SET_STATE, {
    knowledgeId,
    state,
    updatedAt: new Date().toISOString(),
  });
}

export async function setKnowledgeBranchInGraph(knowledgeId: string, branch: string): Promise<void> {
  await _runCypher(SET_BRANCH, {
    knowledgeId,
    branch,
    updatedAt: new Date().toISOString(),
  });
}

export async function deleteKnowledgeGraph(knowledgeId: string): Promise<void> {
  await _runCypher(DELETE_FILES_BY_KNOWLEDGE, { knowledgeId });
  await _runCypher(DELETE_REPOS_BY_KNOWLEDGE, { knowledgeId });
  await _runCypher(DELETE_FOLDERS_BY_KNOWLEDGE, { knowledgeId });
  await _runCypher(DELETE_ORPHAN_FILES);
  await _runCypher(DELETE_KNOWLEDGE_NODE, { knowledgeId });
  await _runCypher(DELETE_ORPHAN_ENTITIES);
}

function deriveRepoName(doc: KnowledgeDoc): string {
  if (doc.source.kind === "local") {
    return path.basename(doc.source.sourcePath);
  }
  return repoNameFromGithubUrl(doc.info.repoUrl ?? "");
}

export function repoNameFromGithubUrl(repoUrl: string): string {
  let pathname: string;
  try {
    pathname = new URL(repoUrl).pathname;
  } catch {
    pathname = repoUrl;
  }
  const segments = pathname
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  const repo = segments.at(-1);
  const owner = segments.at(-2);
  if (owner === undefined || repo === undefined) {
    return repoUrl;
  }
  return `${owner}/${repo.replace(/\.git$/u, "")}`;
}
