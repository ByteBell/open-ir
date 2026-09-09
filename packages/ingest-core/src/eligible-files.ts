import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { logger } from "@bb/logger";
import type { ArchiveSink, SourceReader } from "#src/types/pipeline.ts";
import { affectedFolderPaths } from "./folder-path.ts";
import type { ScanManifest } from "./scan-manifest.ts";

export const ELIGIBLE_FILES_RELATIVE_PATH = ".plumbline/eligible_files.json";

export interface EligibleFilesDocument {
  knowledgeId: string;
  commitHash: string;
  generatedAt: string;
  files: string[];
  folders: string[];
}

export interface WriteEligibleFilesInput {
  knowledgeId: string;
  manifest: ScanManifest;
  source: SourceReader;
  archiveSink?: ArchiveSink;
}

/**
 * Persist the canonical list of files the analyzer is about to process,
 * BEFORE any small-file or big-file LLM call runs. The downstream
 * `@plumbline/knowledge-validation` service reads this artifact via the same
 * source layer to cross-check that every eligible file landed in Neo4j.
 *
 * Writes to whichever source layer is active: local disk when the source
 * reader is disk-backed (`source.localRepoDir !== ""`), the archive sink
 * otherwise. Fails the strategy if neither target is available, since a
 * successfully-indexed but un-validatable knowledge is not a state we want.
 */
export async function writeEligibleFiles(input: WriteEligibleFilesInput): Promise<void> {
  const files = input.manifest.entries
    .filter((entry) => entry.kind === "small" || entry.kind === "big")
    .map((entry) => entry.relativePath)
    .sort();
  const folders = affectedFolderPaths(files);
  const doc: EligibleFilesDocument = {
    knowledgeId: input.knowledgeId,
    commitHash: input.source.commitHash,
    generatedAt: new Date().toISOString(),
    files,
    folders,
  };
  const content = JSON.stringify(doc, null, 2);

  let wrote = false;
  if (input.source.localRepoDir.length > 0) {
    const targetDir = path.join(input.source.localRepoDir, ".plumbline");
    const targetFile = path.join(targetDir, "eligible_files.json");
    await mkdir(targetDir, { recursive: true });
    await writeFile(targetFile, content, "utf8");
    wrote = true;
  }
  if (input.archiveSink !== undefined) {
    await input.archiveSink.push({
      knowledgeId: input.knowledgeId,
      relativePath: ELIGIBLE_FILES_RELATIVE_PATH,
      content,
    });
    wrote = true;
  }
  if (!wrote) {
    throw new Error(
      `flat-folder: cannot persist eligible_files.json for ${input.knowledgeId}: source reader has no localRepoDir and no archiveSink is configured`,
    );
  }
  logger.info(
    `flat-folder: persisted eligible_files.json for ${input.knowledgeId} (files=${String(files.length)} folders=${String(folders.length)})`,
  );
}
