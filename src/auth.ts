import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { config } from "./config.js";
import { db, type TokenRow, type TokenScope } from "./db.js";
import { AppError } from "./errors.js";

export interface AuthToken {
  id: string;
  name: string;
  scopes: Set<TokenScope>;
}

export const anonymousActorId = "anonymous";

export function hashToken(token: string): string {
  if (!config.tokenPepper) {
    throw new Error("SCHAFFA_TOKEN_PEPPER is required for token operations.");
  }
  return createHmac("sha256", config.tokenPepper).update(token).digest("hex");
}

export function generateToken(): string {
  return `sfa_${randomBytes(32).toString("base64url")}`;
}

export function createToken(
  name: string,
  scopes: TokenScope[] = ["upload"],
): { id: string; token: string } {
  const cleanName = name.trim();
  if (cleanName.length < 1 || cleanName.length > 80) {
    throw new AppError("Token name must contain 1 to 80 characters.");
  }
  if (scopes.length === 0 || scopes.some((scope) => !["upload", "admin"].includes(scope))) {
    throw new AppError("Token scopes must contain upload and/or admin.");
  }

  const id = randomUUID();
  const token = generateToken();
  db()
    .prepare("INSERT INTO tokens (id, name, token_hash, scopes) VALUES (?, ?, ?, ?)")
    .run(id, cleanName, hashToken(token), [...new Set(scopes)].join(","));
  return { id, token };
}

export function seedBootstrapToken(): void {
  if (!config.bootstrapToken) return;
  if (!config.bootstrapToken.startsWith("sfa_") || config.bootstrapToken.length < 40) {
    throw new Error("SCHAFFA_BOOTSTRAP_TOKEN must be a high-entropy sfa_ token.");
  }
  const tokenHash = hashToken(config.bootstrapToken);
  db()
    .prepare(
      `INSERT INTO tokens (id, name, token_hash, scopes)
       VALUES ('bootstrap', 'Bootstrap admin', ?, 'admin')
       ON CONFLICT(id) DO UPDATE SET token_hash = excluded.token_hash, revoked_at = NULL`,
    )
    .run(tokenHash);
}

export function seedAnonymousActor(): void {
  db()
    .prepare(
      `INSERT INTO tokens (id, name, token_hash, scopes)
       VALUES (?, 'Anonymous upload', 'system:anonymous', 'upload')
       ON CONFLICT(id) DO NOTHING`,
    )
    .run(anonymousActorId);
}

export function authenticateToken(token: string | undefined): AuthToken | null {
  if (!token?.startsWith("sfa_")) return null;
  const row = db()
    .prepare("SELECT * FROM tokens WHERE token_hash = ? AND revoked_at IS NULL LIMIT 1")
    .get(hashToken(token)) as unknown as TokenRow | undefined;
  if (!row) return null;

  db().prepare("UPDATE tokens SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?").run(row.id);
  return {
    id: row.id,
    name: row.name,
    scopes: new Set(row.scopes.split(",") as TokenScope[]),
  };
}

export function bearerToken(header: string | string[] | undefined): string | undefined {
  if (typeof header !== "string") return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1];
}

export function requireScope(auth: AuthToken | null, scope: TokenScope): AuthToken {
  if (!auth) throw new AppError("A valid bearer token is required.", 401, "unauthorized");
  if (!auth.scopes.has("admin") && !auth.scopes.has(scope)) {
    throw new AppError("This token does not have the required scope.", 403, "forbidden");
  }
  return auth;
}
