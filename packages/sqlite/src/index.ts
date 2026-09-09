import "./provider.ts";

export { connectSqlite, closeSqlite, pingSqlite } from "./client.ts";

export {
  getKnowledge,
  setKnowledgeCommit,
  setKnowledgeState,
  markKnowledgeFailed,
  markKnowledgeHalted,
  promoteHaltedToFailed,
  setKnowledgeBranch,
  updateKnowledgeProgress,
  upsertKnowledge,
  listKnowledge,
  deleteKnowledge,
} from "./knowledge.ts";
export type { KnowledgeListEntry, DeleteKnowledgeResult } from "./knowledge.ts";

export { upsertRawFile, listRawFileShas, deleteRawFiles } from "./raw.ts";

export { aggregateStats } from "./aggregateStats.ts";

export { incrementUsage, getMonthlyUsage, getGlobalUsage } from "./usage.ts";
export { recordActivity } from "./activity.ts";

export {
  startEnrichmentRun,
  getCompletedEnrichmentFiles,
  markFileEnriched,
  recordEnrichmentFailure,
  completeEnrichmentRun,
  failEnrichmentRun,
} from "./enrichment.ts";
