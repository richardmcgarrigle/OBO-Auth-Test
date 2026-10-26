// The local IdP: NAV's mock-oauth2-server in Docker (see docker-compose.yml).
// Used by scripts/run.mjs and the Playwright global setup; also `npm run idp:up` / `npm run idp:down`.
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { ROOT, loadProfile } from "./profile.mjs";

export async function isUp(url) {
  try { return (await fetch(url)).status < 500; } catch { return false; }
}

// The container CLI: Docker by default; DOCKER=podman for Podman (`podman compose`).
export const DOCKER = process.env.DOCKER || "docker";

function compose(args, profile, stdio = "inherit") {
  const r = spawnSync(DOCKER, ["compose", ...args], {
    cwd: ROOT, stdio, env: { ...process.env, IDP_PORT: profile.IDP_PORT || "9000" },
  });
  return r.error ? null : r.status;
}

/** Starts the IdP container unless the IdP is already answering. Returns true if this call started it. */
export async function startIdp(profile) {
  const discovery = `${profile.IDP_AUTHORITY}/.well-known/openid-configuration`;
  if (await isUp(discovery)) {
    console.log(`>>> idp already running at ${profile.IDP_AUTHORITY}, reusing it`);
    return false;
  }
  if (compose(["version"], profile, "ignore") !== 0) {
    throw new Error(`The local IdP needs Docker with Compose v2 (\`${DOCKER} compose version\` failed). ` +
      "Install and start Docker Desktop (or another Docker engine), then retry. See README > Prerequisites.");
  }
  console.log(">>> starting idp container (docker compose up -d idp)");
  if (compose(["up", "-d", "idp"], profile) !== 0) {
    throw new Error("`docker compose up -d idp` failed (see above). Is Docker running?");
  }
  for (let i = 0; i < 120; i++) {
    if (await isUp(discovery)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`idp did not become ready at ${discovery}. Check: docker compose logs idp`);
}

export function stopIdp(profile) {
  console.log(">>> stopping idp container");
  compose(["stop", "idp"], profile, "ignore");
}

// CLI: node scripts/idp.mjs up|down|pull
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  const profile = loadProfile("local");
  const command = process.argv[2];
  try {
    if (command === "up") {
      await startIdp(profile);
      console.log(`>>> idp is up at ${profile.IDP_AUTHORITY} (stop it with: npm run idp:down)`);
    } else if (command === "down") {
      process.exit(compose(["down"], profile) ?? 1);
    } else if (command === "pull") {
      process.exit(compose(["pull", "idp"], profile) ?? 2);
    } else {
      console.error("usage: node scripts/idp.mjs up|down|pull");
      process.exit(1);
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
