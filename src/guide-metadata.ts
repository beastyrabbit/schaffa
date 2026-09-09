import type { DatabaseSync } from "node:sqlite";

// Counters share the source transaction, including rollbacks and cascading deletes.
// The reserved '*' row holds the instance total.
export function initializeGuideMetadata(database: DatabaseSync): void {
  const sources = [
    {
      table: "guides",
      key: "id",
      fields: ["title", "description", "target_url", "video_url", "language"],
    },
    {
      table: "guide_steps",
      key: "guide_id",
      fields: [
        "title",
        "description",
        "action_type",
        "action_target",
        "verification",
        "screenshot_caption",
      ],
    },
    {
      table: "guide_revisions",
      key: "guide_id",
      fields: ["json_snapshot", "markdown_snapshot", "html_snapshot"],
    },
    { table: "guide_idempotency", key: "guide_id", fields: ["key", "operation", "response_json"] },
  ];
  const bytes = (fields: string[], prefix = "") =>
    fields.map((field) => `length(CAST(COALESCE(${prefix}${field}, '') AS BLOB))`).join(" + ");
  database.exec("BEGIN IMMEDIATE");
  try {
    const exists = database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'guide_metadata_usage'")
      .get();
    if (!exists) {
      database.exec(`
        CREATE TABLE guide_metadata_usage (guide_id TEXT PRIMARY KEY, bytes INTEGER NOT NULL) STRICT;
        INSERT INTO guide_metadata_usage
          SELECT guide_id, SUM(bytes) FROM (${sources
            .map(
              ({ table, key, fields }) =>
                `SELECT ${key} AS guide_id, ${bytes(fields)} AS bytes FROM ${table}`,
            )
            .join(" UNION ALL ")}) GROUP BY guide_id;
        INSERT INTO guide_metadata_usage SELECT '*', COALESCE(SUM(bytes), 0) FROM guide_metadata_usage;
      `);
    }
    for (const { table, key, fields } of sources) {
      const adjust = (row: "NEW" | "OLD", sign: string) => `
        INSERT INTO guide_metadata_usage VALUES (${row}.${key}, ${sign}(${bytes(fields, `${row}.`)}))
          ON CONFLICT(guide_id) DO UPDATE SET bytes = bytes + excluded.bytes;
        UPDATE guide_metadata_usage SET bytes = bytes ${sign} (${bytes(fields, `${row}.`)}) WHERE guide_id = '*';
      `;
      database.exec(`
        CREATE TRIGGER IF NOT EXISTS ${table}_metadata_insert AFTER INSERT ON ${table} BEGIN ${adjust("NEW", "+")} END;
        CREATE TRIGGER IF NOT EXISTS ${table}_metadata_update AFTER UPDATE OF ${[key, ...fields].join(",")} ON ${table}
          BEGIN ${adjust("OLD", "-")} ${adjust("NEW", "+")} END;
        CREATE TRIGGER IF NOT EXISTS ${table}_metadata_delete AFTER DELETE ON ${table}
          BEGIN ${adjust("OLD", "-")}
          ${table === "guides" ? "DELETE FROM guide_metadata_usage WHERE guide_id = OLD.id;" : ""} END;
      `);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
