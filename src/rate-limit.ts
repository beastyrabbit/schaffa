import { createHmac } from "node:crypto";
import { config } from "./config.js";
import { db } from "./db.js";
import { AppError } from "./errors.js";

const windowSeconds = 60 * 60;

export function consumeAnonymousUpload(address: string): void {
  consume(`anonymous:${privateSubject(address)}`, config.anonymousUploadsPerHour, "Anonymous");
}

export function consumeAuthenticatedUpload(tokenId: string): void {
  consume(`token:${tokenId}`, config.authenticatedUploadsPerHour, "Authenticated");
}

export function consumeUserLogin(address: string): void {
  consume(`login:${privateSubject(address)}`, config.userLoginsPerHour, "User login");
}

function consume(subject: string, limit: number, label: string): void {
  db().exec("BEGIN IMMEDIATE");
  try {
    db().prepare("DELETE FROM upload_events WHERE created_at <= datetime('now', '-1 day')").run();
    const row = db()
      .prepare(
        `SELECT COUNT(*) AS count FROM upload_events
         WHERE subject = ? AND created_at > datetime('now', ?)`,
      )
      .get(subject, `-${windowSeconds} seconds`) as unknown as { count: number };
    if (row.count >= limit) {
      db().exec("ROLLBACK");
      throw new AppError(
        `${label} upload rate limit exceeded. Try again later.`,
        429,
        "rate_limited",
      );
    }
    db().prepare("INSERT INTO upload_events (subject) VALUES (?)").run(subject);
    db().exec("COMMIT");
  } catch (error) {
    if (db().isTransaction) db().exec("ROLLBACK");
    throw error;
  }
}

function privateSubject(value: string): string {
  return createHmac("sha256", config.tokenPepper).update(value).digest("hex");
}
