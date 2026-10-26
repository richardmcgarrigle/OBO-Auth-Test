// Launch profiles: env/<name>.env describes where the IdP is and how the apps are registered with it.
// Used by scripts/run.mjs (manual runs) and the Playwright configs (e2e runs).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PYTHON = process.platform === "win32"
  ? path.join(ROOT, ".venv", "Scripts", "python.exe")
  : path.join(ROOT, ".venv", "bin", "python");

/** Reads env/<name>.env; real environment variables override file values (e.g. secrets from CI). */
export function loadProfile(name) {
  const file = path.join(ROOT, "env", `${name}.env`);
  if (!fs.existsSync(file)) {
    throw new Error(`Profile ${file} not found. Copy env/${name}.env.example to env/${name}.env and fill it in.`);
  }
  const vars = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) vars[m[1]] = m[2];
  }
  for (const key of Object.keys(vars)) if (process.env[key]) vars[key] = process.env[key];
  const placeholders = Object.entries(vars).filter(([, v]) => v.includes("<")).map(([k]) => k);
  if (placeholders.length) throw new Error(`Profile ${name} still has placeholder values: ${placeholders.join(", ")}`);
  return vars;
}

/** The app processes to run for a profile. The mock profile's IdP is a Docker container: see scripts/idp.mjs. */
export function services(profile) {
  const port = (url) => new URL(url).port;
  const list = [];
  for (const [name, module, baseUrl] of [
    ["system-one-web", "system_one_web.main", profile.S1_WEB_BASE_URL],
    ["system-one-api", "system_one_api.main", profile.S1_API_BASE_URL],
    ["system-two", "system_two.main", profile.S2_BASE_URL],
  ]) {
    list.push({ name, command: `"${PYTHON}" -m uvicorn ${module}:app --port ${port(baseUrl)}`, url: `${baseUrl}/docs` });
  }
  return list;
}
