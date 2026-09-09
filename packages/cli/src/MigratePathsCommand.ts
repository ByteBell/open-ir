import { Command } from "commander";
import { Config } from "@bb/types";
import { getPlumblineHome, getConfigValue } from "@bb/config";
import { connectDb, closeDb, knowledgeDb } from "@bb/db";
import "@bb/sqlite";
import { migrateLegacyPaths, type MigrationSummary } from "@bb/path-migration";
import { error, success } from "./output.ts";

// ─────────────────────────────────────────────────────────────────────────────
// `plumbline migrate paths`
//
// One-shot reconciliation of the legacy on-disk layout
// (`<home>/repos/<knowledgeId>/` for clones, `<home>/repos/.meta/<knowledgeId>/...`
// for meta) with the commit-scoped layout
// (`<home>/orgs/<orgId>/<provider>/<knowledgeId>/<owner>/<repo>/<commit>/...`).
//
// The disk work lives in `@bb/path-migration` so the server boot path shares
// it. This command just supplies the knowledge list (from the document
// store) and renders
// the summary. Knowledge with a DB record migrates; legacy dirs with no record
// are abandoned (deleted). The same reconciliation runs automatically at server
// boot — this command is for running it ahead of time or with `--dry-run`.
// ─────────────────────────────────────────────────────────────────────────────

export function buildMigrateCommand(): Command {
  const cmd = new Command("migrate");
  cmd.description("One-off migrations between on-disk layouts.");

  cmd
    .command("paths")
    .description(
      "Migrate the legacy `repos/.meta/<id>/` tree to the commit-scoped `orgs/<orgId>/<provider>/...` tree; delete unrecoverable orphans.",
    )
    .option("--dry-run", "Print what would change without touching disk.")
    .action(async (opts: { dryRun?: boolean }) => {
      const dryRun = opts.dryRun === true;
      try {
        await runPathsMigration({ dryRun });
      } catch (cause: unknown) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        error(`paths migration failed: ${msg}`);
        process.exitCode = 1;
      }
    });

  return cmd;
}

async function runPathsMigration(opts: { dryRun: boolean }): Promise<void> {
  await connectDb(getConfigValue(Config.DbProvider));
  try {
    const home = getPlumblineHome();
    const orgId = getConfigValue(Config.OrgId);
    const knowledgeDocs = await knowledgeDb.listKnowledge({ limit: 10_000 });
    const summary = await migrateLegacyPaths({ home, orgId, knowledgeDocs, dryRun: opts.dryRun });
    printSummary(summary, opts.dryRun);
  } finally {
    await closeDb();
  }
}

function printSummary(summary: MigrationSummary, dryRun: boolean): void {
  const tag = dryRun ? "[dry-run] " : "";
  success(`${tag}migrated: ${summary.migrated.length}`);
  for (const m of summary.migrated) {
    success(`  ${m}`);
  }
  if (summary.abandoned.length > 0) {
    error(`${tag}abandoned (no DB record; ${dryRun ? "would delete" : "deleted"}): ${summary.abandoned.length}`);
    for (const a of summary.abandoned) {
      error(`  ${a}`);
    }
  }
  if (summary.skippedAlready.length > 0) {
    success(`${tag}skipped (already in new layout): ${summary.skippedAlready.length}`);
    for (const s of summary.skippedAlready) {
      success(`  ${s}`);
    }
  }
  if (summary.skippedNoCommit.length > 0) {
    error(`skipped (no commitId; predate commit tracking): ${summary.skippedNoCommit.length}`);
    for (const s of summary.skippedNoCommit) {
      error(`  ${s}`);
    }
  }
  if (summary.skippedNoRepoUrl.length > 0) {
    error(`skipped (no info.repoUrl): ${summary.skippedNoRepoUrl.length}`);
    for (const s of summary.skippedNoRepoUrl) {
      error(`  ${s}`);
    }
  }
  if (summary.failed.length > 0) {
    error(`failed: ${summary.failed.length}`);
    for (const f of summary.failed) {
      error(`  ${f.knowledgeId}: ${f.reason}`);
    }
    process.exitCode = 1;
  }
}
