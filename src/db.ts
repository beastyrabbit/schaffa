import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";

export type TokenScope = "upload" | "interactive" | "admin";
export type PageKind = "static" | "interactive";

export interface TokenRow {
  id: string;
  name: string;
  token_hash: string;
  scopes: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  user_id: string | null;
}

export interface UserRow {
  id: string;
  shoo_subject: string;
  email: string | null;
  name: string | null;
  picture: string | null;
  created_at: string;
  last_login_at: string;
  can_publish_interactive: number;
}

export interface PageRow {
  id: string;
  slug: string;
  title: string | null;
  current_version: number;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  purge_at: string | null;
  owner_token_id: string | null;
  kind: PageKind;
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

export type GuideStatus = "recording" | "draft" | "published";

export interface GuideRow {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  language: string;
  status: GuideStatus;
  owner_token_id: string;
  current_revision: number;
  edit_revision: number;
  created_at: string;
  updated_at: string;
}

export interface GuideStepRow {
  id: string;
  guide_id: string;
  position: number;
  title: string;
  description: string;
  action_type: string | null;
  action_target: string | null;
  verification: string | null;
  visible: number;
  capture: number;
  screenshot_id: string | null;
  screenshot_caption: string | null;
  created_at: string;
  updated_at: string;
}

export interface GuideImageRow {
  id: string;
  guide_id: string;
  storage_path: string;
  bytes: number;
  sha256: string;
  width: number;
  height: number;
  created_at: string;
}

let database: DatabaseSync | undefined;

export function db(): DatabaseSync {
  if (database) return database;

  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o750 });
  database = new DatabaseSync(path.join(config.dataDir, "schaffa.sqlite"));
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      shoo_subject TEXT NOT NULL UNIQUE,
      email TEXT,
      name TEXT,
      picture TEXT,
      can_publish_interactive INTEGER NOT NULL DEFAULT 0 CHECK(can_publish_interactive IN (0,1)),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_login_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) STRICT;

    CREATE TABLE IF NOT EXISTS tokens (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      scopes TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_used_at TEXT,
      revoked_at TEXT,
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS pages (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      title TEXT,
      current_version INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT,
      purge_at TEXT,
      owner_token_id TEXT REFERENCES tokens(id),
      kind TEXT NOT NULL DEFAULT 'static' CHECK(kind IN ('static','interactive'))
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

    CREATE TABLE IF NOT EXISTS instance_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) STRICT;

    CREATE TABLE IF NOT EXISTS upload_events (
      id INTEGER PRIMARY KEY,
      subject TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) STRICT;

    CREATE TABLE IF NOT EXISTS user_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS guides (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      description TEXT,
      language TEXT NOT NULL DEFAULT 'de',
      status TEXT NOT NULL DEFAULT 'recording' CHECK(status IN ('recording','draft','published')),
      owner_token_id TEXT NOT NULL REFERENCES tokens(id),
      current_revision INTEGER NOT NULL DEFAULT 0,
      edit_revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) STRICT;

    CREATE TABLE IF NOT EXISTS guide_images (
      id TEXT PRIMARY KEY,
      guide_id TEXT NOT NULL REFERENCES guides(id) ON DELETE CASCADE,
      storage_path TEXT NOT NULL UNIQUE,
      bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) STRICT;

    CREATE TABLE IF NOT EXISTS guide_steps (
      id TEXT PRIMARY KEY,
      guide_id TEXT NOT NULL REFERENCES guides(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      action_type TEXT,
      action_target TEXT,
      verification TEXT,
      visible INTEGER NOT NULL DEFAULT 1 CHECK(visible IN (0,1)),
      capture INTEGER NOT NULL DEFAULT 1 CHECK(capture IN (0,1)),
      screenshot_id TEXT REFERENCES guide_images(id) ON DELETE SET NULL,
      screenshot_caption TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(guide_id, position)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS guide_revisions (
      id TEXT PRIMARY KEY,
      guide_id TEXT NOT NULL REFERENCES guides(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,
      json_snapshot TEXT NOT NULL,
      markdown_snapshot TEXT NOT NULL,
      html_snapshot TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(guide_id, revision)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS guide_idempotency (
      guide_id TEXT NOT NULL REFERENCES guides(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      operation TEXT NOT NULL,
      response_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(guide_id, key)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS guide_revision_images (
      revision_id TEXT NOT NULL REFERENCES guide_revisions(id) ON DELETE CASCADE,
      image_id TEXT NOT NULL REFERENCES guide_images(id) ON DELETE RESTRICT,
      PRIMARY KEY(revision_id, image_id)
    ) STRICT;

    CREATE INDEX IF NOT EXISTS page_versions_page_idx ON page_versions(page_id, version DESC);
    CREATE INDEX IF NOT EXISTS files_created_idx ON files(created_at DESC);
    CREATE INDEX IF NOT EXISTS upload_events_subject_idx
      ON upload_events(subject, created_at DESC);
    CREATE INDEX IF NOT EXISTS user_sessions_user_idx ON user_sessions(user_id, expires_at);
    CREATE INDEX IF NOT EXISTS guides_owner_idx ON guides(owner_token_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS guide_steps_guide_idx ON guide_steps(guide_id, position);
    CREATE INDEX IF NOT EXISTS guide_images_guide_idx ON guide_images(guide_id);
    CREATE INDEX IF NOT EXISTS guide_revisions_guide_idx ON guide_revisions(guide_id, revision DESC);
  `);

  const tokenColumns = database.prepare("PRAGMA table_info(tokens)").all() as unknown as Array<{
    name: string;
  }>;
  if (!tokenColumns.some((column) => column.name === "user_id")) {
    database.exec(
      "ALTER TABLE tokens ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE SET NULL",
    );
  }

  const userColumns = database.prepare("PRAGMA table_info(users)").all() as unknown as Array<{
    name: string;
  }>;
  if (!userColumns.some((column) => column.name === "can_publish_interactive")) {
    database.exec(
      "ALTER TABLE users ADD COLUMN can_publish_interactive INTEGER NOT NULL DEFAULT 0 CHECK(can_publish_interactive IN (0,1))",
    );
  }

  const pageColumns = database.prepare("PRAGMA table_info(pages)").all() as unknown as Array<{
    name: string;
  }>;
  if (!pageColumns.some((column) => column.name === "expires_at")) {
    database.exec("ALTER TABLE pages ADD COLUMN expires_at TEXT");
  }
  if (!pageColumns.some((column) => column.name === "purge_at")) {
    database.exec("ALTER TABLE pages ADD COLUMN purge_at TEXT");
  }
  if (!pageColumns.some((column) => column.name === "owner_token_id")) {
    database.exec("ALTER TABLE pages ADD COLUMN owner_token_id TEXT REFERENCES tokens(id)");
  }
  if (!pageColumns.some((column) => column.name === "kind")) {
    database.exec("ALTER TABLE pages ADD COLUMN kind TEXT NOT NULL DEFAULT 'static'");
  }
  database.exec(`
    UPDATE pages
    SET owner_token_id = (
      SELECT pv.created_by_token_id
      FROM page_versions pv
      WHERE pv.page_id = pages.id
      ORDER BY pv.version ASC
      LIMIT 1
    )
    WHERE owner_token_id IS NULL;

    INSERT INTO instance_settings (key, value)
    VALUES ('writes_locked', 'false')
    ON CONFLICT(key) DO NOTHING;

    INSERT INTO instance_settings (key, value)
    VALUES ('signups_enabled', 'true')
    ON CONFLICT(key) DO NOTHING;

    INSERT INTO instance_settings (key, value)
    VALUES ('logins_enabled', 'true')
    ON CONFLICT(key) DO NOTHING;

    INSERT INTO instance_settings (key, value)
    VALUES ('interactive_publishing_enabled', 'false')
    ON CONFLICT(key) DO NOTHING;
  `);

  return database;
}

export function closeDb(): void {
  database?.close();
  database = undefined;
}
