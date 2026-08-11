import { db } from "./db.js";

export interface InstanceSettings {
  writesLocked: boolean;
  signupsEnabled: boolean;
  loginsEnabled: boolean;
}

export function getInstanceSettings(): InstanceSettings {
  const rows = db()
    .prepare(
      `SELECT key, value FROM instance_settings
       WHERE key IN ('writes_locked', 'signups_enabled', 'logins_enabled')`,
    )
    .all() as unknown as Array<{ key: string; value: string }>;
  const values = new Map(rows.map((row) => [row.key, row.value === "true"]));
  return {
    writesLocked: values.get("writes_locked") || false,
    signupsEnabled: values.get("signups_enabled") ?? true,
    loginsEnabled: values.get("logins_enabled") ?? true,
  };
}

export function updateInstanceSettings(input: Partial<InstanceSettings>): InstanceSettings {
  const updates = [
    ["writes_locked", input.writesLocked],
    ["signups_enabled", input.signupsEnabled],
    ["logins_enabled", input.loginsEnabled],
  ] as const;
  const statement = db().prepare(
    `INSERT INTO instance_settings (key, value, updated_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
  );
  db().exec("BEGIN IMMEDIATE");
  try {
    for (const [key, value] of updates) {
      if (value !== undefined) statement.run(key, String(value));
    }
    if (input.loginsEnabled === false) db().prepare("DELETE FROM user_sessions").run();
    db().exec("COMMIT");
  } catch (error) {
    db().exec("ROLLBACK");
    throw error;
  }
  return getInstanceSettings();
}
