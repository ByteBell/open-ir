import { Database, Connection, PreparedStatement, type LbugValue } from "@ladybugdb/core";
import { getConfigValue } from "@bb/config";
import { Config } from "@bb/types";

export interface PingResult {
  ok: boolean;
  latencyMs: number;
}

let db: Database | null = null;
let conn: Connection | null = null;
let connecting: Promise<void> | null = null;

export async function connectLadybug(): Promise<void> {
  if (conn !== null) {
    return;
  }
  if (connecting !== null) {
    return connecting;
  }
  connecting = doConnect().finally(() => {
    connecting = null;
  });
  return connecting;
}

async function doConnect(): Promise<void> {
  let dbPath = getConfigValue(Config.LadybugPath);
  if (dbPath === "") {
    dbPath = ":memory:";
  }

  try {
    db = new Database(dbPath);
    conn = new Connection(db);
    await ensureSchema(conn);
  } catch (cause: unknown) {
    if (db) {
      db = null;
    }
    conn = null;
    throw new Error(
      `Failed to connect to LadybugDB at '${dbPath}': ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}

async function ensureSchema(c: Connection): Promise<void> {
  const nodeTables = [
    `CREATE NODE TABLE Knowledge (
      knowledgeId STRING PRIMARY KEY,
      createdAt STRING,
      sourceKind STRING,
      sourceUrl STRING,
      branch STRING,
      repoName STRING,
      state STRING,
      updatedAt STRING
    )`,
    `CREATE NODE TABLE Repo (
      id STRING PRIMARY KEY,
      orgId STRING,
      knowledgeId STRING,
      repoId STRING,
      repoUrl STRING,
      branch STRING,
      purpose STRING,
      summary STRING,
      architecture STRING,
      dataFlow STRING,
      majorSubsystems STRING[],
      keyPatterns STRING[],
      updatedAt STRING
    )`,
    `CREATE NODE TABLE Folder (
      id STRING PRIMARY KEY,
      orgId STRING,
      knowledgeId STRING,
      repoId STRING,
      folderPath STRING,
      purpose STRING,
      summary STRING,
      dependencyGraph STRING,
      updatedAt STRING
    )`,
    `CREATE NODE TABLE File (
      id STRING PRIMARY KEY,
      orgId STRING,
      knowledgeId STRING,
      repoId STRING,
      relativePath STRING,
      language STRING,
      sha STRING,
      sizeBytes INT64,
      purpose STRING,
      summary STRING,
      businessContext STRING,
      dataFlowDirection STRING,
      ontologyConcepts STRING[],
      businessEntities STRING[],
      systemCapabilities STRING[],
      sideEffects STRING[],
      configDependencies STRING[],
      integrationSurface STRING[],
      contractsProvided STRING[],
      contractsConsumed STRING[],
      sectionNames STRING[],
      sectionDescriptions STRING[],
      isBigFile BOOLEAN,
      totalChunks INT64,
      totalTokenCount INT64,
      updatedAt STRING
    )`,
    `CREATE NODE TABLE FileVersion (
      id STRING PRIMARY KEY,
      knowledgeId STRING,
      relativePath STRING,
      commitHash STRING,
      language STRING,
      sha STRING,
      sizeBytes INT64,
      purpose STRING,
      summary STRING,
      businessContext STRING,
      dataFlowDirection STRING,
      ontologyConcepts STRING[],
      businessEntities STRING[],
      systemCapabilities STRING[],
      sideEffects STRING[],
      configDependencies STRING[],
      integrationSurface STRING[],
      contractsProvided STRING[],
      contractsConsumed STRING[],
      sectionNames STRING[],
      sectionDescriptions STRING[],
      snapshotAt STRING
    )`,
    `CREATE NODE TABLE Keyword (
      name STRING PRIMARY KEY
    )`,
    `CREATE NODE TABLE Class (
      signature STRING PRIMARY KEY
    )`,
    `CREATE NODE TABLE Function (
      signature STRING PRIMARY KEY
    )`,
    `CREATE NODE TABLE Module (
      name STRING PRIMARY KEY
    )`,
    `CREATE NODE TABLE Concept (
      id STRING PRIMARY KEY,
      orgId STRING,
      knowledgeId STRING,
      slug STRING,
      kind STRING,
      name STRING,
      rationale STRING,
      enrichmentRunId STRING,
      createdAt STRING,
      updatedAt STRING
    )`,
    `CREATE NODE TABLE Contract (
      id STRING PRIMARY KEY,
      orgId STRING,
      knowledgeId STRING,
      slug STRING,
      kind STRING,
      name STRING,
      enrichmentRunId STRING,
      createdAt STRING,
      updatedAt STRING
    )`,
    `CREATE NODE TABLE Guidepost (
      id STRING PRIMARY KEY,
      orgId STRING,
      knowledgeId STRING,
      slug STRING,
      kind STRING,
      note STRING,
      area STRING,
      enrichmentRunId STRING,
      createdAt STRING,
      updatedAt STRING
    )`,
  ];

  const relTables = [
    `CREATE REL TABLE HAS_REPO (FROM Knowledge TO Repo)`,
    `CREATE REL TABLE HAS_FILE (FROM Knowledge TO File)`,
    `CREATE REL TABLE CONTAINS (FROM Repo TO Folder, FROM Folder TO Folder, FROM Folder TO File)`,
    `CREATE REL TABLE HAS_KEYWORD (FROM File TO Keyword, FROM Folder TO Keyword, FROM Repo TO Keyword)`,
    `CREATE REL TABLE HAS_CLASS (FROM File TO Class)`,
    `CREATE REL TABLE HAS_FUNCTION (FROM File TO Function)`,
    `CREATE REL TABLE HAS_IMPORT_INTERNAL (FROM File TO Module)`,
    `CREATE REL TABLE HAS_IMPORT_EXTERNAL (FROM File TO Module)`,
    `CREATE REL TABLE HAS_VERSION (FROM File TO FileVersion)`,
    `CREATE REL TABLE HAS_CONCEPT (FROM File TO Concept, enrichmentRunId STRING, createdAt STRING, updatedAt STRING)`,
    `CREATE REL TABLE PLAYS_ROLE (FROM File TO Concept, enrichmentRunId STRING, createdAt STRING, updatedAt STRING)`,
    `CREATE REL TABLE BELONGS_TO_DOMAIN (FROM File TO Concept, enrichmentRunId STRING, createdAt STRING, updatedAt STRING)`,
    `CREATE REL TABLE TESTS (FROM File TO File, enrichmentRunId STRING, createdAt STRING, updatedAt STRING)`,
    `CREATE REL TABLE DEFINES (FROM File TO Contract, enrichmentRunId STRING, createdAt STRING, updatedAt STRING)`,
    `CREATE REL TABLE CONSUMES (FROM File TO Contract, enrichmentRunId STRING, createdAt STRING, updatedAt STRING)`,
    `CREATE REL TABLE ABOUT (FROM Guidepost TO File, FROM Guidepost TO Concept, FROM Guidepost TO Contract, enrichmentRunId STRING, createdAt STRING, updatedAt STRING)`,
  ];

  for (const q of [...nodeTables, ...relTables]) {
    try {
      await c.query(q);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (
        !msg.includes("already exists") &&
        !msg.includes("table already exists") &&
        !msg.includes("Binder exception")
      ) {
        throw e;
      }
    }
  }
}

export async function closeLadybug(): Promise<void> {
  conn = null;
  db = null;
}

export async function pingLadybug(): Promise<PingResult> {
  if (conn === null) {
    return { ok: false, latencyMs: 0 };
  }
  const start = performance.now();
  try {
    await conn.query("MATCH (k:Knowledge) RETURN count(k) LIMIT 1");
    return { ok: true, latencyMs: Math.round(performance.now() - start) };
  } catch {
    return { ok: false, latencyMs: Math.round(performance.now() - start) };
  }
}

export function _getConnection(): Connection {
  if (conn === null) {
    throw new Error("LadybugDB not connected. Call connectLadybug() first.");
  }
  return conn;
}
//OPTIMIZATION NEEDED
// export async function _runCypher<T = unknown>(query: string, params: Record<string, any> = {}): Promise<T[]> {
//   const c = _getConnection();
//   const prepared = await c.prepare(query);
//   if (!prepared.isSuccess()) {
//     throw new Error(`Failed to prepare query: ${prepared.getErrorMessage()}`);
//   }
//   const result = await c.execute(prepared, params);
//   const singleResult = Array.isArray(result) ? result[0] : result;
//   if (!singleResult) {
//     throw new Error("No query result returned from LadybugDB");
//   }
//   const rows = await singleResult.getAll();
//   return rows as T[];
// }

// Add a global cache map at the top of client.ts
const preparedCache = new Map<string, PreparedStatement>();

export async function _runCypher<T = unknown>(query: string, params: Record<string, LbugValue> = {}): Promise<T[]> {
  const c = _getConnection();

  // 1. Check if the query has already been compiled and compiled plan is cached
  let prepared = preparedCache.get(query);

  if (!prepared) {
    prepared = await c.prepare(query);
    if (!prepared.isSuccess()) {
      throw new Error(`Failed to prepare query: ${prepared.getErrorMessage()}`);
    }
    // 2. Store it for future iterations in the ingest loop
    preparedCache.set(query, prepared);
  }

  const result = await c.execute(prepared, params);
  const singleResult = Array.isArray(result) ? result[0] : result;
  if (!singleResult) {
    throw new Error("No query result returned from LadybugDB");
  }
  const rows = await singleResult.getAll();
  return rows as T[];
}

// Clear the cache if tests reset
export function __resetForTests(): void {
  db = null;
  conn = null;
  connecting = null;
  preparedCache.clear(); // Clear cache here
}
