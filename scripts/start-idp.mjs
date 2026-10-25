// Runs NAV's mock-oauth2-server (the same server as the ghcr.io/navikt/mock-oauth2-server image)
// without Docker: Coursier fetches a JDK and the server's classpath into .tools/ on first run.
// With Docker available, `docker compose up idp` is equivalent.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { ROOT } from "./profile.mjs";

const MOCK_OAUTH2_SERVER = "no.nav.security:mock-oauth2-server:6.1.3";
const COURSIER = "v2.1.26";
const JVM = "temurin:21";

const tools = path.join(ROOT, ".tools");
const env = { ...process.env, COURSIER_CACHE: path.join(tools, "cache"), COURSIER_ARCHIVE_CACHE: path.join(tools, "arc") };

async function coursier() {
  const asset = {
    win32: "cs-x86_64-pc-win32.zip",
    linux: "cs-x86_64-pc-linux.gz",
    darwin: process.arch === "arm64" ? "cs-aarch64-apple-darwin.gz" : "cs-x86_64-apple-darwin.gz",
  }[process.platform];
  const exe = path.join(tools, process.platform === "win32" ? "cs-x86_64-pc-win32.exe" : "cs");
  if (fs.existsSync(exe)) return exe;
  fs.mkdirSync(tools, { recursive: true });
  console.log(`[idp] downloading Coursier ${COURSIER} (${asset})`);
  const res = await fetch(`https://github.com/coursier/coursier/releases/download/${COURSIER}/${asset}`);
  if (!res.ok) throw new Error(`Coursier download failed: ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (asset.endsWith(".zip")) {
    const zip = path.join(tools, asset);
    fs.writeFileSync(zip, bytes);
    // Windows 10+ ships bsdtar, which reads zip. Use it explicitly: Git Bash's GNU tar treats "C:" as a remote host.
    const tar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
    execFileSync(tar, ["-xf", zip, "-C", tools]);
    fs.rmSync(zip);
  } else {
    fs.writeFileSync(exe, zlib.gunzipSync(bytes), { mode: 0o755 });
  }
  return exe;
}

const cs = await coursier();
console.log(`[idp] resolving ${JVM} and ${MOCK_OAUTH2_SERVER} (cached after first run)`);
const javaHome = execFileSync(cs, ["java-home", "--jvm", JVM], { env }).toString().trim();
const classpath = execFileSync(cs, ["fetch", "--classpath", MOCK_OAUTH2_SERVER], { env }).toString().trim();
if (process.argv.includes("--fetch-only")) {  // used by `npm run setup`
  console.log("[idp] JDK and mock-oauth2-server are downloaded");
  process.exit(0);
}

const java = path.join(javaHome, "bin", process.platform === "win32" ? "java.exe" : "java");
const server = spawn(java, ["no.nav.security.mock.oauth2.StandaloneMockOAuth2ServerKt"], {
  env: {
    ...env,
    CLASSPATH: classpath,  // env var rather than -cp: no quoting issues with spaces, no command-line length limit
    SERVER_PORT: process.env.IDP_PORT || "9000",
    JSON_CONFIG_PATH: path.join(ROOT, "idp", "mock-oauth2-config.json"),
  },
  stdio: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.kill());
server.on("exit", (code) => process.exit(code ?? 0));
