import { readFileSync } from "node:fs";

declare global {
  interface Window {
    Shoo?: {
      clearIdentity(): void;
      getIdentity(): { token?: string } | null;
      startSignIn(options: { returnTo: string; requestPii: boolean }): void;
    };
  }
}

export const tokenSetupClientScript = readFileSync(
  new URL("../public/scripts/token-setup.js", import.meta.url),
  "utf8",
);
export const adminFiltersClientScript = readFileSync(
  new URL("../public/scripts/admin-filters.js", import.meta.url),
  "utf8",
);
export const accountClientScript = readFileSync(
  new URL("../public/scripts/account.js", import.meta.url),
  "utf8",
);
