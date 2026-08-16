import { randomBytes } from "node:crypto";

const pageAlphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
const pageAlphabetLimit = 252;
const guideAlphabet = "abcdefghijklmnopqrstuvwxyz234567";

export function randomPageSlug(): string {
  const slug: string[] = [];
  while (slug.length < 16) {
    for (const byte of randomBytes(16 - slug.length)) {
      if (byte >= pageAlphabetLimit) continue;
      slug.push(pageAlphabet.charAt(byte % pageAlphabet.length));
    }
  }
  return slug.join("");
}

export function randomGuideSlug(): string {
  return [...randomBytes(12)].map((byte) => guideAlphabet.charAt(byte & 31)).join("");
}

export function randomFileId(): string {
  return randomBytes(16).toString("base64url");
}

export function isFileId(value: string): boolean {
  return /^[A-Za-z0-9_-]{22}$/.test(value);
}
