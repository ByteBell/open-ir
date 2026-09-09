import { readFile } from "node:fs/promises";
import { logger } from "@bb/logger";
import { filesGraph, foldersGraph, repoGraph, indexesGraph } from "@bb/graph-db";
import { rawDb } from "@bb/db";
import type { GithubIndexPayload } from "@bb/types";
import type { NodeScope, UpsertFileNodeInput } from "@bb/graph-core";
import type { MetaPaths } from "@bb/ingest-core";
import { throwIfCancelled } from "@bb/ingest-core";
import type { DiffResult } from "@bb/ingest-core";
import { readCondensed } from "@bb/ingest-core";
import { iterateFolderSummaries } from "#src/flat-folder/folder-summary.ts";
import { directFolderOf } from "@bb/ingest-core";
import { languageFromPath } from "@bb/ingest-core";
import type { FolderSummary, RepoSummary, RepoSummaryEnvelope } from "#src/flat-folder/types.ts";

export interface StorePullInput {
  scope: NodeScope;
  payload: GithubIndexPayload;
  branch: string;
  /** GitHub owner — persisted to RepoSummary.user_name (matches the on-disk clone path). */
  owner: string;
  /** Bare repo name — persisted to RepoSummary.repo_name (matches the on-disk clone path). */
  repo: string;
  /** Resolved commit hash — persisted to RepoSummary.commit_hash / Knowledge.commit_hash. */
  commitHash: string;
  metaPaths: MetaPaths;
  diff: DiffResult;
  affectedFolders: Set<string>;
}

export interface StorePullResult {
  filesUpserted: number;
  filesDeleted: number;
  foldersUpserted: number;
  repoUpserted: boolean;
}

/**
 * Pull-time graph store. Mirrors the structure of `storeFlatAnalysis` but
 * applies only the changes the diff specified:
 *
 * 1. Delete `:File` + document-store rows for deleted + renamed-from paths.
 * 2. Upsert `:File` nodes for added + modified + renamed-to paths.
 * 3. Upsert affected `:Folder` nodes from the freshly-written folder
 *    summaries on disk.
 * 4. Upsert the `:Repo` node with the new repo summary.
 *
 * Untouched paths and unaffected folders are not modified.
 */
export async function storePullAnalysis(input: StorePullInput): Promise<StorePullResult> {
  throwIfCancelled(input.scope.knowledgeId);
  await indexesGraph.ensureFlatFolderIndexes();

  let filesUpserted = 0;
  let filesDeleted = 0;
  let foldersUpserted = 0;

  const deletedPaths: string[] = [...input.diff.deleted, ...input.diff.renamed.map((r) => r.oldPath)];
  if (deletedPaths.length > 0) {
    await filesGraph.deleteFileNodes(input.scope.knowledgeId, deletedPaths);
    await rawDb.deleteRawFiles(input.scope.knowledgeId, deletedPaths);
    filesDeleted = deletedPaths.length;
  }

  const repoSummary = await readRepoSummary(input.metaPaths);
  let repoUpserted = false;
  if (repoSummary !== null) {
    await repoGraph.upsertRepoNode({
      scope: input.scope,
      repoUrl: input.payload.repoUrl,
      branch: input.branch,
      owner: input.owner,
      repo: input.repo,
      commitHash: input.commitHash,
      summary: {
        purpose: repoSummary.purpose,
        summary: repoSummary.summary,
        keywords: repoSummary.keywords,
        architecture: repoSummary.architecture,
        dataFlow: repoSummary.dataFlow,
        majorSubsystems: repoSummary.majorSubsystems,
        keyPatterns: repoSummary.keyPatterns,
      },
    });
    repoUpserted = true;
  } else {
    logger.warn(`pull-store: no repo summary on disk; skipping :Repo upsert`);
  }

  const folderPaths = new Set<string>();
  for await (const folder of iterateFolderSummaries(input.metaPaths)) {
    throwIfCancelled(input.scope.knowledgeId);
    if (!input.affectedFolders.has(folder.folderPath)) {
      continue;
    }
    await foldersGraph.upsertFolderNode({
      scope: input.scope,
      folderPath: folder.folderPath,
      summary: shapeFolderPayload(folder),
    });
    folderPaths.add(folder.folderPath);
    foldersUpserted += 1;
  }

  const upsertPaths: string[] = [
    ...input.diff.added,
    ...input.diff.modified,
    ...input.diff.renamed.map((r) => r.newPath),
  ];
  async function* yieldFiles() {
    const seen = new Set<string>();
    for (const relativePath of upsertPaths) {
      if (seen.has(relativePath)) {
        continue;
      }
      seen.add(relativePath);
      throwIfCancelled(input.scope.knowledgeId);

      const condensed = await readCondensed(input.metaPaths, relativePath);
      if (condensed === null) {
        logger.warn(`pull-store: condensed analysis missing for ${relativePath}; skipping file upsert`);
        continue;
      }

      const folderPath = directFolderOf(relativePath);
      if (!folderPaths.has(folderPath)) {
        await foldersGraph.upsertFolderNode({
          scope: input.scope,
          folderPath,
          summary: emptyFolderPayload(),
        });
        folderPaths.add(folderPath);
        foldersUpserted += 1;
      }

      const upsertInput: UpsertFileNodeInput = {
        orgId: input.scope.orgId,
        knowledgeId: input.scope.knowledgeId,
        repoId: input.scope.repoId,
        relativePath: condensed.relativePath,
        folderPath,
        language: condensed.language.length > 0 ? condensed.language : languageFromPath(condensed.relativePath),
        sha: condensed.sha256,
        sizeBytes: condensed.sizeBytes,
        analysis: condensed.analysis,
        isBigFile: condensed.isBigFile,
        totalChunks: condensed.totalChunks,
        totalTokenCount: condensed.totalTokenCount,
      };
      filesUpserted += 1;
      yield upsertInput;
    }
  }

  if (typeof filesGraph.bulkUpsertFiles === "function") {
    await filesGraph.bulkUpsertFiles(input.scope.knowledgeId, yieldFiles());
  } else {
    for await (const f of yieldFiles()) {
      await filesGraph.upsertFileNode(f);
    }
  }

  logger.info(
    `pull-store done: filesUpserted=${filesUpserted} filesDeleted=${filesDeleted} foldersUpserted=${foldersUpserted} repoUpserted=${repoUpserted}`,
  );
  return { filesUpserted, filesDeleted, foldersUpserted, repoUpserted };
}

function shapeFolderPayload(folder: FolderSummary): {
  purpose: string;
  summary: string;
  keywords: string[];
  classes: string[];
  functions: string[];
  importsInternal: string[];
  importsExternal: string[];
  dependencyGraph: string;
} {
  return {
    purpose: folder.purpose,
    summary: folder.summary,
    keywords: folder.keywords,
    classes: folder.classes,
    functions: folder.functions,
    importsInternal: folder.importsInternal,
    importsExternal: folder.importsExternal,
    dependencyGraph: folder.dependencyGraph,
  };
}

function emptyFolderPayload(): ReturnType<typeof shapeFolderPayload> {
  return {
    purpose: "",
    summary: "",
    keywords: [],
    classes: [],
    functions: [],
    importsInternal: [],
    importsExternal: [],
    dependencyGraph: "",
  };
}

async function readRepoSummary(metaPaths: MetaPaths): Promise<RepoSummary | null> {
  try {
    const raw = await readFile(metaPaths.repoSummaryJson, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const envelope = parsed as RepoSummaryEnvelope;
    return envelope.repoSummary ?? null;
  } catch {
    return null;
  }
}
