import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { config } from "./config.js";

export type TokenScope = "upload" | "admin";

export interface TokenRow {
  id: string;
  name: string;
  token_hash: string;
  scopes: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface PageRow {
  id: string;
  slug: string;
  title: string | null;
  current_version: number;
  created_at: string;
  updated_at: string;
}

export interface PageVersionRow {
  id: string;
  page_id: string;
  version: number;
  storage_path: string;
  bytes: number;
  sha256: string;
  created_by_token_id: string;
  created_at: string;
}

export interface FileRow {
  id: string;
  filename: string;
  storage_path: string;
  media_type: string;
  bytes: number;
  sha256: string;
  created_by_token_id: string;
  created_at: string;
}

let database: DatabaseSync | undefined;

export function db(): DatabaseSync {
  if (database) return database;

  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o750 });
  database = new DatabaseSync(path.join(config.dataDir, "mumpitz.sqlite"));
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec(`
    CREATE TABLE IF NOT EXISTS tokens (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      scopes TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_used_at TEXT,
      revoked_at TEXT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS pages (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      title TEXT,
      current_version INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) STRICT;

    CREATE TABLE IF NOT EXISTS page_versions (
      id TEXT PRIMARY KEY,
      page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      storage_path TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      created_by_token_id TEXT NOT NULL REFERENCES tokens(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(page_id, version)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      filename TEXT NOT NULL UNIQUE,
      storage_path TEXT NOT NULL,
      media_type TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      created_by_token_id TEXT NOT NULL REFERENCES tokens(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) STRICT;

    CREATE INDEX IF NOT EXISTS page_versions_page_idx ON page_versions(page_id, version DESC);
    CREATE INDEX IF NOT EXISTS files_created_idx ON files(created_at DESC);
  `);

  return database;
}

export function run(sql: string, ...params: SQLInputValue[]): void {
  db()
    .prepare(sql)
    .run(...params);
}

export function closeDb(): void {
  database?.close();
  database = undefined;
}
