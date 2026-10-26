// One-time setup after `npm install`: Python venv + packages, Playwright's Chromium, and the local IdP's Docker image.
// Safe to re-run. Usage: npm run setup
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DOCKER } from "./idp.mjs";
import { ROOT, loadProfile } from "./profile.mjs";

const isWin = process.platform === "win32";
const venvPython = path.join(ROOT, ".venv", isWin ? "Scripts" : "bin", isWin ? "python.exe" : "python");

function run(cmd, args) {
  console.log(`\n> ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit" });
  if (r.error || r.status !== 0) throw new Error(`failed: ${cmd} ${args.join(" ")}`);
}

/** Returns the command's output if it runs successfully, else null. */
function probe(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return r.status === 0 ? `${r.stdout}${r.stderr}`.trim() : null;
}

// A Python >= 3.10 interpreter, if no uv. (On Windows, "python" may be the Microsoft Store stub, which fails the probe.)
function findPython() {
  const check = ["-c", "import sys; print(sys.version_info >= (3, 10))"];
  const candidates = [["py", ["-3"]], ["python3.12", []], ["python3", []], ["python", []]];
  for (const [cmd, pre] of candidates) {
    if (probe(cmd, [...pre, ...check]) === "True") return [cmd, pre];
  }
  return null;
}

const uv = probe("uv", ["--version"]) ? "uv" : null;

// 1. Python virtual environment in .venv (the launch scripts expect it there).
if (fs.existsSync(venvPython)) {
  console.log("Python venv: .venv already exists");
} else if (uv) {
  run(uv, ["venv", "--python", "3.12", ".venv"]);  // uv downloads Python 3.12 if needed
} else {
  const python = findPython();
  if (!python) {
    throw new Error("Need either uv (https://docs.astral.sh/uv/) or Python 3.10+ on PATH. See README > Prerequisites.");
  }
  run(python[0], [...python[1], "-m", "venv", ".venv"]);
}

// 2. Python packages.
if (uv) run(uv, ["pip", "install", "--python", venvPython, "-r", "requirements-dev.txt"]);
else run(venvPython, ["-m", "pip", "install", "-r", "requirements-dev.txt"]);

// 3. Playwright's browser.
run(process.execPath, [path.join(ROOT, "node_modules", "@playwright", "test", "cli.js"), "install", "chromium"]);

// 4. Local IdP: pull its Docker image now, so the first start isn't slow.
//    Without Docker, setup still finishes and says what to install.
console.log(`\n> ${DOCKER} compose pull idp`);
const pulled = spawnSync(DOCKER, ["compose", "pull", "idp"], { cwd: ROOT, stdio: "inherit" });
if (pulled.error) {
  console.log(`\nSetup complete, except the local IdP: it runs in Docker, and \`${DOCKER}\` wasn't found.` +
    "\nInstall Docker Desktop (or another Docker engine with Compose v2), start it, then: npm start");
} else if (pulled.status !== 0) {
  throw new Error("couldn't pull the IdP image (see above). Is Docker running? Behind a proxy? See README > Troubleshooting.");
} else {
  console.log(`\nSetup complete. Next: npm start  (then open ${loadProfile("local").S1_WEB_BASE_URL})`);
}
