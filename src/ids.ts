import { randomBytes } from "node:crypto";

const pageAlphabet = "abcdefghijklmnopqrstuvwxyz234567";

export function randomPageSlug(): string {
  const bytes = randomBytes(12);
  return [...bytes].map((byte) => pageAlphabet.charAt(byte & 31)).join("");
}

export function randomFileId(): string {
  return randomBytes(16).toString("base64url");
}

export function isFileId(value: string): boolean {
  return /^[A-Za-z0-9_-]{22}$/.test(value);
}
