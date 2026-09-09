import type {
  IDocumentDatabaseProvider,
  IKnowledgeRepository,
  IRawRepository,
  IAggregateStatsRepository,
  IActivityRepository,
  IUsageRepository,
  IEnrichmentRepository,
  DbPingResult,
} from "@bb/db-core";

let activeProvider: IDocumentDatabaseProvider | null = null;
const providers = new Map<string, () => IDocumentDatabaseProvider>();

export function registerDbProvider(name: string, factory: () => IDocumentDatabaseProvider) {
  providers.set(name, factory);
}

export function getDb(): IDocumentDatabaseProvider {
  if (!activeProvider) {
    throw new Error("Database provider not initialized. Call connectDb() first.");
  }
  return activeProvider;
}

export async function connectDb(providerName: string): Promise<void> {
  const factory = providers.get(providerName);
  if (!factory) {
    throw new Error(`Database provider '${providerName}' not registered.`);
  }
  activeProvider = factory();
  await activeProvider.connect();
}

export async function closeDb(): Promise<void> {
  if (activeProvider) {
    await activeProvider.close();
    activeProvider = null;
  }
}

export const knowledgeDb: IKnowledgeRepository = {
  setKnowledgeState: (...args) => getDb().knowledge.setKnowledgeState(...args),
  setKnowledgeCommit: (...args) => getDb().knowledge.setKnowledgeCommit(...args),
  setKnowledgeCommitHead: (...args) => getDb().knowledge.setKnowledgeCommitHead(...args),
  setKnowledgeBranch: (...args) => getDb().knowledge.setKnowledgeBranch(...args),
  updateKnowledgeProgress: (...args) => getDb().knowledge.updateKnowledgeProgress(...args),
  upsertKnowledge: (...args) => getDb().knowledge.upsertKnowledge(...args),
  deleteKnowledge: (...args) => getDb().knowledge.deleteKnowledge(...args),
  listKnowledge: (...args) => getDb().knowledge.listKnowledge(...args),
  getKnowledge: (...args) => getDb().knowledge.getKnowledge(...args),
  markKnowledgeFailed: (...args) => getDb().knowledge.markKnowledgeFailed(...args),
  markKnowledgeHalted: (...args) => getDb().knowledge.markKnowledgeHalted(...args),
  promoteHaltedToFailed: (...args) => getDb().knowledge.promoteHaltedToFailed(...args),
  markKnowledgeCorrupted: (...args) => getDb().knowledge.markKnowledgeCorrupted(...args),
};

export const rawDb: IRawRepository = {
  upsertRawFile: (...args) => getDb().raw.upsertRawFile(...args),
  listRawFileShas: (...args) => getDb().raw.listRawFileShas(...args),
  deleteRawFiles: (...args) => getDb().raw.deleteRawFiles(...args),
};

export const statsDb: IAggregateStatsRepository = {
  aggregateStats: (...args) => getDb().stats.aggregateStats(...args),
};

export const activityDb: IActivityRepository = {
  recordActivity: (...args) => getDb().activity.recordActivity(...args),
};

export const usageDb: IUsageRepository = {
  incrementUsage: (...args) => getDb().usage.incrementUsage(...args),
  getMonthlyUsage: (...args) => getDb().usage.getMonthlyUsage(...args),
  getGlobalUsage: (...args) => getDb().usage.getGlobalUsage(...args),
};

export const enrichmentDb: IEnrichmentRepository = {
  startEnrichmentRun: (...args) => getDb().enrichment.startEnrichmentRun(...args),
  getCompletedEnrichmentFiles: (...args) => getDb().enrichment.getCompletedEnrichmentFiles(...args),
  markFileEnriched: (...args) => getDb().enrichment.markFileEnriched(...args),
  recordEnrichmentFailure: (...args) => getDb().enrichment.recordEnrichmentFailure(...args),
  completeEnrichmentRun: (...args) => getDb().enrichment.completeEnrichmentRun(...args),
  failEnrichmentRun: (...args) => getDb().enrichment.failEnrichmentRun(...args),
};

export async function pingDb(): Promise<DbPingResult> {
  return getDb().ping();
}
