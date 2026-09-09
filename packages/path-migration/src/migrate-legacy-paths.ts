import { migrateOne } from "./move.ts";
import { sweepOrphans } from "./orphan-sweep.ts";
import type { MigrateLegacyPathsInput, MigrationSummary } from "./types.ts";

/**
 * Reconciles the legacy `repos/<id>/` + `repos/.meta/<id>/` layout against the
 * commit-scoped layout. For every knowledge with a DB record and a derivable
 * target it moves the clone + meta-output; legacy dirs with no DB record are
 * deleted and reported as `abandoned`.
 *
 * Pure disk work — the caller owns the DB connection and supplies the docs, so
 * both the CLI (`plumbline migrate paths`) and the server boot path can share
 * this without either reaching into the other.
 */
export async function migrateLegacyPaths(input: MigrateLegacyPathsInput): Promise<MigrationSummary> {
  const summary: MigrationSummary = {
    migrated: [],
    skippedNoCommit: [],
    skippedNoRepoUrl: [],
    skippedAlready: [],
    abandoned: [],
    failed: [],
  };

  for (const doc of input.knowledgeDocs) {
    try {
      await migrateOne({ home: input.home, orgId: input.orgId, doc, dryRun: input.dryRun, summary });
    } catch (cause: unknown) {
      summary.failed.push({
        knowledgeId: doc.knowledgeId,
        reason: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  const knownIds = new Set(input.knowledgeDocs.map((d) => d.knowledgeId));
  await sweepOrphans({ home: input.home, knownIds, dryRun: input.dryRun, summary });

  return summary;
}
