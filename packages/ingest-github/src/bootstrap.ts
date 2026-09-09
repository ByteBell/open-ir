import { seedConfig, getConfigValue } from "@bb/config";
import { seedLoggerFactory, type LoggerFactory } from "@bb/logger";
import { Config } from "@bb/types";
import { connectDb } from "@bb/db";
import { connectGraph, indexesGraph } from "@bb/graph-db";
import "@bb/sqlite";
import "@bb/neo4j";
// NOTE: provider packages (`@bb/sqlite`, `@bb/neo4j`, `@bb/ladybug`)
// are deliberately NOT imported here. Importing them is a side-effect that
// registers the provider AND loads its driver/native binding (e.g. `@bb/ladybug`
// pulls in the `@ladybugdb/core` native addon). Pulling them in from this shared
// runtime module would force every consumer of `@bb/ingest-github` to load ALL
// provider natives regardless of configuration — so a Neo4j-only deployment
// would still load the Ladybug/SQLite bindings it never uses.
//
// Provider registration is the composition root's responsibility: each binary
// (e.g. `@bb/server`) statically imports exactly the provider packages it wants
// registered before calling `bootstrapRuntime()` / `connectGraph()`. This keeps
// the domain package free of infra native bindings.

export interface BootstrapRuntimeOptions {
  config: unknown;
  loggerFactory: LoggerFactory;
  /**
   * Skip the OSS knowledge/concept-graph index bootstrap (`ensureKnowledgeIndexes`
   * / `ensureConceptGraphIndexes`). A composition root sets this when it owns the
   * Neo4j graph schema itself — e.g. the enterprise ingestion engine, whose
   * `ensureIrGraphSchema()` is the sole (branch-scoped) authority for the `:File`
   * / `:FileVersion` / … constraints; the OSS branchless `file_unique` here would
   * otherwise reject a second branch's file. Connections are still established.
   * Default `false` (OSS standalone keeps creating its own indexes).
   */
  skipGraphIndexes?: boolean;
}

export async function bootstrapRuntime(opts: BootstrapRuntimeOptions): Promise<void> {
  seedConfig(opts.config);
  seedLoggerFactory(opts.loggerFactory);

  const dbProvider = getConfigValue(Config.DbProvider);
  await connectDb(dbProvider);

  const graphProvider = getConfigValue(Config.GraphProvider);
  await connectGraph(graphProvider);

  // Fulltext indexes the MCP smart_search / keyword_lookup tools query against.
  // Idempotent (MERGE-based) so duplicate calls across composition roots are safe.
  // Skipped when the composition root owns the graph schema (see `skipGraphIndexes`).
  if (opts.skipGraphIndexes !== true) {
    await indexesGraph.ensureKnowledgeIndexes();
    await indexesGraph.ensureConceptGraphIndexes();
  }
}
