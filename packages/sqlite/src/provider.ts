import { connectSqlite, closeSqlite, pingSqlite } from "./client.ts";
import * as knowledgeRepo from "./knowledge.ts";
import * as rawRepo from "./raw.ts";
import * as statsRepo from "./aggregateStats.ts";
import * as activityRepo from "./activity.ts";
import * as usageRepo from "./usage.ts";
import * as enrichmentRepo from "./enrichment.ts";

import { registerDbProvider } from "@bb/db";
import type { IDocumentDatabaseProvider } from "@bb/db-core";

class SqliteDatabaseProvider implements IDocumentDatabaseProvider {
  knowledge = {
    setKnowledgeState: knowledgeRepo.setKnowledgeState,
    setKnowledgeCommit: knowledgeRepo.setKnowledgeCommit,
    setKnowledgeCommitHead: knowledgeRepo.setKnowledgeCommitHead,
    setKnowledgeBranch: knowledgeRepo.setKnowledgeBranch,
    updateKnowledgeProgress: knowledgeRepo.updateKnowledgeProgress,
    upsertKnowledge: knowledgeRepo.upsertKnowledge,
    deleteKnowledge: knowledgeRepo.deleteKnowledge,
    listKnowledge: knowledgeRepo.listKnowledge,
    getKnowledge: knowledgeRepo.getKnowledge,
    markKnowledgeFailed: knowledgeRepo.markKnowledgeFailed,
    markKnowledgeHalted: knowledgeRepo.markKnowledgeHalted,
    promoteHaltedToFailed: knowledgeRepo.promoteHaltedToFailed,
    markKnowledgeCorrupted: knowledgeRepo.markKnowledgeCorrupted,
  };

  raw = {
    upsertRawFile: rawRepo.upsertRawFile,
    listRawFileShas: rawRepo.listRawFileShas,
    deleteRawFiles: rawRepo.deleteRawFiles,
  };

  stats = {
    aggregateStats: statsRepo.aggregateStats,
  };

  activity = {
    recordActivity: activityRepo.recordActivity,
  };

  usage = {
    incrementUsage: usageRepo.incrementUsage,
    getMonthlyUsage: usageRepo.getMonthlyUsage,
    getGlobalUsage: usageRepo.getGlobalUsage,
  };

  enrichment = {
    startEnrichmentRun: enrichmentRepo.startEnrichmentRun,
    getCompletedEnrichmentFiles: enrichmentRepo.getCompletedEnrichmentFiles,
    markFileEnriched: enrichmentRepo.markFileEnriched,
    recordEnrichmentFailure: enrichmentRepo.recordEnrichmentFailure,
    completeEnrichmentRun: enrichmentRepo.completeEnrichmentRun,
    failEnrichmentRun: enrichmentRepo.failEnrichmentRun,
  };

  async connect(): Promise<void> {
    await connectSqlite();
  }

  async close(): Promise<void> {
    await closeSqlite();
  }

  async ping() {
    return pingSqlite();
  }
}

registerDbProvider("sqlite", () => new SqliteDatabaseProvider());
