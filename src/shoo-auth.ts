import { createRemoteJWKSet, jwtVerify } from "jose";
import { config } from "./config.js";

export interface ShooIdentity {
  subject: string;
  email?: string;
  name?: string;
  picture?: string;
}

export type ShooTokenVerifier = (idToken: string) => Promise<ShooIdentity>;

const jwks = createRemoteJWKSet(new URL("/.well-known/jwks.json", config.shooBaseUrl));

export const verifyShooToken: ShooTokenVerifier = async (idToken) => {
  const { payload } = await jwtVerify(idToken, jwks, {
    issuer: config.shooIssuer,
    audience: `origin:${new URL(config.baseUrl).origin}`,
    algorithms: ["ES256"],
  });
  if (typeof payload.pairwise_sub !== "string" || payload.pairwise_sub.length > 200) {
    throw new Error("Shoo token is missing a valid pairwise subject.");
  }
  return {
    subject: payload.pairwise_sub,
    ...(typeof payload.email === "string" ? { email: payload.email } : {}),
    ...(typeof payload.name === "string" ? { name: payload.name } : {}),
    ...(typeof payload.picture === "string" ? { picture: payload.picture } : {}),
  };
};
