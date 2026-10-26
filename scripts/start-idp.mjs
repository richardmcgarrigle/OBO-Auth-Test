// Runs NAV's mock-oauth2-server (the same server as the ghcr.io/navikt/mock-oauth2-server image) without Docker,
// on the machine's own JDK (JAVA_HOME, else `java` on PATH). Coursier, itself a jar run on that JDK, fetches the
// server's jars from Maven Central into .tools/ on first run. No native executables are downloaded.
// With Docker available, `docker compose up idp` is equivalent.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./profile.mjs";

const MOCK_OAUTH2_SERVER = "no.nav.security:mock-oauth2-server:6.1.3";
const COURSIER = "v2.1.26";
const MIN_JAVA = 17;  // mock-oauth2-server 6.x is compiled for Java 17

const tools = path.join(ROOT, ".tools");
const env = { ...process.env, COURSIER_CACHE: path.join(tools, "cache") };

/** The system JDK's java executable, or exit with instructions. */
function findJava() {
  const exe = process.platform === "win32" ? "java.exe" : "java";
  const java = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", exe) : "java";
  const r = spawnSync(java, ["-version"], { encoding: "utf8" });
  // `java -version` prints e.g. `openjdk version "21.0.4"` or `java version "1.8.0_402"` to stderr.
  const version = /version "(\d+)(?:\.(\d+))?/.exec(`${r.stderr}${r.stdout}`);
  const major = version ? Number(version[1] === "1" ? version[2] : version[1]) : 0;
  if (r.error || major < MIN_JAVA) {
    const found = r.error ? `no Java found (${process.env.JAVA_HOME ? `JAVA_HOME=${process.env.JAVA_HOME}` : "not on PATH"})`
                          : `Java ${major} found at ${java}`;
    console.error(`[idp] Needs a JDK ${MIN_JAVA} or newer: ${found}.\n` +
      `[idp] Install one, or set JAVA_HOME to it, or run the IdP in Docker instead: docker compose up -d idp\n` +
      `[idp] See README > Prerequisites.`);
    process.exit(2);
  }
  return java;
}

/** Coursier's JVM launcher (a plain jar), downloaded once. */
async function coursierJar() {
  const jar = path.join(tools, `coursier-${COURSIER}.jar`);
  if (fs.existsSync(jar)) return jar;
  fs.mkdirSync(tools, { recursive: true });
  console.log(`[idp] downloading Coursier ${COURSIER} (coursier.jar)`);
  const res = await fetch(`https://github.com/coursier/coursier/releases/download/${COURSIER}/coursier.jar`);
  if (!res.ok) throw new Error(`Coursier download failed: ${res.status}`);
  fs.writeFileSync(`${jar}.part`, Buffer.from(await res.arrayBuffer()));
  fs.renameSync(`${jar}.part`, jar);
  return jar;
}

const java = findJava();
const cs = await coursierJar();
console.log(`[idp] resolving ${MOCK_OAUTH2_SERVER} (cached after first run)`);
const classpath = execFileSync(java, ["-jar", cs, "fetch", "--classpath", MOCK_OAUTH2_SERVER], { env }).toString().trim();
if (process.argv.includes("--fetch-only")) {  // used by `npm run setup`
  console.log(`[idp] mock-oauth2-server is downloaded; it will run on ${java}`);
  process.exit(0);
}

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
