import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { runMigrations, type MigrationResult } from "../../../packages/core/src/migrations";
import { dataRoot } from "./paths";

const defaultDbPath = resolve(dataRoot, "opencorpo.db");

export type DbHandle = Database;

export function openDb(dbPath = defaultDbPath): DbHandle {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}

export function ensureSchema(db: DbHandle): MigrationResult {
  return runMigrations(db);
}
