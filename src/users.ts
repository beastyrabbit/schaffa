import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { createToken } from "./auth.js";
import { config } from "./config.js";
import { db, type TokenRow, type UserRow } from "./db.js";
import { AppError } from "./errors.js";
import { getInstanceSettings } from "./settings.js";
import type { ShooIdentity } from "./shoo-auth.js";

export interface UserSummary extends UserRow {
  token_count: number;
  active_token_count: number;
}

export interface UserSession {
  id: string;
  displayName: string;
  email: string | null;
}

export function createUserSession(identity: ShooIdentity): { user: UserSession; token: string } {
  const settings = getInstanceSettings();
  if (!settings.loginsEnabled) {
    throw new AppError("User logins are disabled on this instance.", 403, "logins_disabled");
  }
  const existing = db()
    .prepare("SELECT * FROM users WHERE shoo_subject = ?")
    .get(identity.subject) as unknown as UserRow | undefined;
  if (!existing && !settings.signupsEnabled) {
    throw new AppError("New user signups are disabled on this instance.", 403, "signups_disabled");
  }

  const userId = existing?.id || randomUUID();
  const email = cleanClaim(identity.email, 254);
  const name = cleanClaim(identity.name, 120);
  const picture = cleanPicture(identity.picture);
  db().exec("BEGIN IMMEDIATE");
  try {
    db().prepare("DELETE FROM user_sessions WHERE datetime(expires_at) <= CURRENT_TIMESTAMP").run();
    if (existing) {
      db()
        .prepare(
          `UPDATE users SET
             email = COALESCE(?, email), name = COALESCE(?, name),
             picture = COALESCE(?, picture), last_login_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
        )
        .run(email, name, picture, userId);
    } else {
      db()
        .prepare(
          `INSERT INTO users (id, shoo_subject, email, name, picture)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(userId, identity.subject, email, name, picture);
    }
    const sessionId = randomUUID();
    const token = `sus_${randomBytes(32).toString("base64url")}`;
    db()
      .prepare(
        `INSERT INTO user_sessions (id, user_id, token_hash, expires_at)
         VALUES (?, ?, ?, datetime('now', ?))`,
      )
      .run(sessionId, userId, hashSessionToken(token), `+${config.userSessionTtlHours} hours`);
    db().exec("COMMIT");
    return {
      user: {
        id: userId,
        displayName: name || existing?.name || email || existing?.email || "Shoo user",
        email: email || existing?.email || null,
      },
      token,
    };
  } catch (error) {
    db().exec("ROLLBACK");
    throw error;
  }
}

export function authenticateUserSession(token: string | undefined): UserSession | null {
  if (!token?.startsWith("sus_")) return null;
  const row = db()
    .prepare(
      `SELECT u.* FROM user_sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND datetime(s.expires_at) > CURRENT_TIMESTAMP`,
    )
    .get(hashSessionToken(token)) as unknown as UserRow | undefined;
  if (!row) return null;
  return {
    id: row.id,
    displayName: row.name || row.email || "Shoo user",
    email: row.email,
  };
}

export function revokeUserSession(token: string | undefined): void {
  if (!token?.startsWith("sus_")) return;
  db().prepare("DELETE FROM user_sessions WHERE token_hash = ?").run(hashSessionToken(token));
}

export function createUserToken(userId: string, name: string): { id: string; token: string } {
  const active = db()
    .prepare("SELECT COUNT(*) AS count FROM tokens WHERE user_id = ? AND revoked_at IS NULL")
    .get(userId) as unknown as { count: number };
  if (active.count >= 20) {
    throw new AppError("Revoke an existing token before creating another one.", 409, "token_limit");
  }
  return createToken(name, ["upload"], userId);
}

export function listUserTokens(userId: string): TokenRow[] {
  return db()
    .prepare(
      `SELECT id, name, '' AS token_hash, scopes, created_at, last_used_at, revoked_at, user_id
       FROM tokens WHERE user_id = ? ORDER BY created_at DESC`,
    )
    .all(userId) as unknown as TokenRow[];
}

export function revokeUserToken(userId: string, tokenId: string): void {
  const result = db()
    .prepare(
      `UPDATE tokens SET revoked_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
    )
    .run(tokenId, userId);
  if (result.changes === 0) throw new AppError("Token not found.", 404, "not_found");
}

export function listUsers(): UserSummary[] {
  return db()
    .prepare(
      `SELECT u.*,
              COUNT(t.id) AS token_count,
              COALESCE(SUM(CASE WHEN t.id IS NOT NULL AND t.revoked_at IS NULL THEN 1 ELSE 0 END), 0) AS active_token_count
       FROM users u
       LEFT JOIN tokens t ON t.user_id = u.id
       GROUP BY u.id
       ORDER BY u.created_at DESC`,
    )
    .all() as unknown as UserSummary[];
}

export function deleteUser(userId: string): void {
  db().exec("BEGIN IMMEDIATE");
  try {
    const user = db().prepare("SELECT 1 FROM users WHERE id = ?").get(userId);
    if (!user) {
      db().exec("ROLLBACK");
      throw new AppError("User not found.", 404, "not_found");
    }
    db()
      .prepare(
        `UPDATE tokens SET
           name = 'Deleted user token',
           revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP)
         WHERE user_id = ?`,
      )
      .run(userId);
    db().prepare("DELETE FROM users WHERE id = ?").run(userId);
    db().exec("COMMIT");
  } catch (error) {
    if (db().isTransaction) db().exec("ROLLBACK");
    throw error;
  }
}

function hashSessionToken(token: string): string {
  return createHmac("sha256", config.tokenPepper)
    .update("user-session\0")
    .update(token)
    .digest("hex");
}

function cleanClaim(value: string | undefined, maximum: number): string | null {
  const clean = value?.trim();
  return clean && clean.length <= maximum ? clean : null;
}

function cleanPicture(value: string | undefined): string | null {
  if (!value || value.length > 2048) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}
