import { connectLadybug, closeLadybug, pingLadybug, _runCypher } from "./client.ts";
import * as knowledgeRepo from "./knowledge.ts";
import * as filesRepo from "./files.ts";
import * as fileVersionsRepo from "./fileVersions.ts";
import * as folderRepo from "./folder.ts";
import * as repoRepo from "./repo.ts";
import * as indexRepo from "./indexes.ts";
import * as flatFolderIndexRepo from "./flatFolderIndexes.ts";
import * as searchRepo from "./search/index.ts";
import * as conceptGraphIndexRepo from "./conceptGraphIndexes.ts";
import * as conceptsRepo from "./concepts.ts";
import * as contractsRepo from "./contracts.ts";
import * as guidepostsRepo from "./guideposts.ts";

import { registerGraphProvider } from "@bb/graph-db";
import type { IGraphDatabaseProvider } from "@bb/graph-core";
import type { LbugValue } from "@ladybugdb/core";

class LadybugGraphProvider implements IGraphDatabaseProvider {
  knowledge = {
    upsertKnowledgeNode: knowledgeRepo.upsertKnowledgeNode,
    setKnowledgeStateInGraph: knowledgeRepo.setKnowledgeStateInGraph,
    setKnowledgeBranchInGraph: knowledgeRepo.setKnowledgeBranchInGraph,
    deleteKnowledgeGraph: knowledgeRepo.deleteKnowledgeGraph,
  };

  files = {
    upsertFileNode: filesRepo.upsertFileNode,
    deleteFileNodes: filesRepo.deleteFileNodes,
    snapshotFilesToVersion: fileVersionsRepo.snapshotFilesToVersion,
    bulkUpsertFiles: filesRepo.bulkUpsertFiles,
  };

  folders = {
    upsertFolderNode: folderRepo.upsertFolderNode,
  };

  repo = {
    upsertRepoNode: repoRepo.upsertRepoNode,
  };

  indexes = {
    ensureKnowledgeIndexes: indexRepo.ensureKnowledgeIndexes,
    ensureFlatFolderIndexes: flatFolderIndexRepo.ensureFlatFolderIndexes,
    ensureConceptGraphIndexes: conceptGraphIndexRepo.ensureConceptGraphIndexes,
  };

  concepts = {
    upsertConcept: conceptsRepo.upsertConcept,
    attachFileToConcept: conceptsRepo.attachFileToConcept,
    upsertTestsEdge: conceptsRepo.upsertTestsEdge,
  };

  contracts = {
    upsertContract: contractsRepo.upsertContract,
    attachFileToContract: contractsRepo.attachFileToContract,
  };

  guideposts = {
    upsertGuidepost: guidepostsRepo.upsertGuidepost,
    attachGuidepost: guidepostsRepo.attachGuidepost,
  };

  search = {
    runSmartSearchChannel: searchRepo.runSmartSearchChannel,
    keywordLookup: searchRepo.keywordLookup,
    listKnowledgeBases: searchRepo.listKnowledgeBases,
    fetchFileMetadata: searchRepo.fetchFileMetadata,
    fetchRepoNames: searchRepo.fetchRepoNames,
  };

  async connect(): Promise<void> {
    await connectLadybug();
  }

  async close(): Promise<void> {
    await closeLadybug();
  }

  async ping() {
    return pingLadybug();
  }

  async runCypher(query: string, params?: Record<string, unknown>): Promise<unknown> {
    return _runCypher(query, params as Record<string, LbugValue>);
  }
}

registerGraphProvider("ladybug", () => new LadybugGraphProvider());

export { vacuumOrphanEntities } from "./knowledge.ts";
