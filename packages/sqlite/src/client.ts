import { Database } from "bun:sqlite";
import path from "node:path";
import fs from "node:fs";
import { getConfigValue, getPlumblineHome } from "@bb/config";
import { Config } from "@bb/types";

let db: Database | null = null;
let dbPath: string = "";

export async function connectSqlite(): Promise<void> {
  if (db !== null) {
    return;
  }

  let sqlitePath = getConfigValue(Config.SqlitePath);
  if (!sqlitePath || sqlitePath.length === 0) {
    sqlitePath = path.join(getPlumblineHome(), "data.sqlite");
  }

  dbPath = sqlitePath;
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(dbPath);
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA foreign_keys = ON;");

  // Initialize tables
  db.run(`
    CREATE TABLE IF NOT EXISTS knowledge (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS raw_files (
      key TEXT PRIMARY KEY,
      knowledgeId TEXT NOT NULL,
      value TEXT NOT NULL
    );
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_raw_files_knowledgeId ON raw_files(knowledgeId);`);

  db.run(`
    CREATE TABLE IF NOT EXISTS activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      value TEXT NOT NULL
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS usage (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

export async function closeSqlite(): Promise<void> {
  if (db !== null) {
    db.close();
    db = null;
  }
}

export function getSqliteDb(): Database {
  if (db === null) {
    throw new Error("SQLite Database not connected. Call connectSqlite() first.");
  }
  return db;
}

export async function pingSqlite(): Promise<{ ok: boolean; latencyMs: number }> {
  const start = performance.now();
  try {
    const database = getSqliteDb();
    database.run("SELECT 1;");
    return { ok: true, latencyMs: Math.round(performance.now() - start) };
  } catch {
    return { ok: false, latencyMs: Math.round(performance.now() - start) };
  }
}
