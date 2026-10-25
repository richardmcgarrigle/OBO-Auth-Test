// Starts every service for a profile and keeps them running until Ctrl+C.
// Usage: node scripts/run.mjs [local|entra]   (npm run start / npm run start:entra)
import { execSync, spawn } from "node:child_process";
import { ROOT, loadProfile, services } from "./profile.mjs";

const profileName = process.argv[2] || "local";
const profile = loadProfile(profileName);
const children = [];

function stopAll() {
  for (const child of children) {
    if (child.exitCode !== null) continue;
    // shell:true wraps each service in a shell, so kill the whole process tree.
    if (process.platform === "win32") execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: "ignore" });
    else child.kill("SIGTERM");
  }
}

async function waitFor(url, name) {
  for (let i = 0; i < 360; i++) {  // first IdP start downloads a JDK
    if (await isUp(url)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${name} did not become ready at ${url}`);
}

process.on("SIGINT", () => { stopAll(); process.exit(0); });

async function isUp(url) {
  try { return (await fetch(url)).status < 500; } catch { return false; }
}

for (const svc of services(profile)) {
  if (await isUp(svc.url)) {  // e.g. the IdP from `docker compose up idp`
    console.log(`>>> ${svc.name} already running at ${svc.url}, reusing it`);
    continue;
  }
  const child = spawn(svc.command, { cwd: ROOT, shell: true, env: { ...process.env, ...profile } });
  const prefix = (chunk) => chunk.toString().split(/\r?\n/).filter(Boolean).forEach((l) => console.log(`[${svc.name}] ${l}`));
  child.stdout.on("data", prefix);
  child.stderr.on("data", prefix);
  child.on("exit", (code) => console.log(`[${svc.name}] exited (${code})`));
  children.push(child);
}

try {
  for (const svc of services(profile)) {
    await waitFor(svc.url, svc.name);
    console.log(`>>> ${svc.name} ready (${svc.url})`);
  }
  console.log(`\n>>> Profile "${profileName}" is up. Open ${profile.S1_WEB_BASE_URL} (Ctrl+C to stop)\n`);
} catch (e) {
  console.error(e.message);
  stopAll();
  process.exit(1);
}
