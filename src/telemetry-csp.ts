import { config } from "./config.js";

export function ownUiCsp(existing: string, admin: boolean): string {
  const directives = new Map(
    existing
      .split(";")
      .map((entry) => entry.trim().split(/\s+/))
      .filter(([name]) => name)
      .map(([name, ...values]) => [name, values]),
  );
  const add = (name: string, value: string) => {
    const values = (directives.get(name) || []).filter((item) => item !== "'none'");
    if (!values.includes(value)) values.push(value);
    directives.set(name, values);
  };
  add("script-src", "'self'");
  add("connect-src", "'self'");
  add("style-src", "'self'");
  if (!admin && config.telemetry.umamiUrl) {
    add("script-src", config.telemetry.umamiUrl);
    add("connect-src", config.telemetry.umamiUrl);
  }
  if (config.telemetry.glitchtipDsn)
    add("connect-src", new URL(config.telemetry.glitchtipDsn).origin);
  return [...directives].map(([name, values]) => `${name} ${values.join(" ")}`).join("; ");
}
