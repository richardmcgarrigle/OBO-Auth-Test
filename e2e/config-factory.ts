import { defineConfig, devices } from "@playwright/test";
import { ROOT, loadProfile, services } from "../scripts/profile.mjs";

/** One Playwright config per launch profile (env/<name>.env). Only the mock profile starts an IdP. */
export function makeConfig(profileName: "local" | "entra") {
  process.env.E2E_PROFILE = profileName;
  const profile = loadProfile(profileName);
  return defineConfig({
    testDir: `${ROOT}/e2e`,
    fullyParallel: false,
    workers: 1,
    timeout: profile.IDP_KIND === "entra" ? 90_000 : 30_000,
    reporter: [["list"], ["html", { open: "never" }]],
    use: { trace: "retain-on-failure", screenshot: "only-on-failure" },
    projects: [{ name: `chromium-${profileName}`, use: { ...devices["Desktop Chrome"] } }],
    webServer: services(profile).map((svc) => ({
      command: svc.command,
      url: svc.url,
      cwd: ROOT,
      env: { ...process.env, ...profile } as Record<string, string>,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,  // first IdP start downloads a JDK
      stdout: "ignore" as const,
      stderr: "pipe" as const,
    })),
  });
}
