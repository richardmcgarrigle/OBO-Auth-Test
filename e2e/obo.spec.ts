import { BrowserContext, Page, expect, test } from "@playwright/test";
import { audOf, callerOf, completeIdpLogin, decodeJwt, discovery, forgeToken, list, profile } from "./support";

const S1_WEB = profile.S1_WEB_BASE_URL;
const S1_API = profile.S1_API_BASE_URL;
const S2 = profile.S2_BASE_URL;
const IDP_ORIGIN = new URL(profile.IDP_AUTHORITY).origin;

// One real sign-in, then every test inspects what that single journey produced.
test.describe.serial(`On-Behalf-Of hand-off (${process.env.E2E_PROFILE} profile)`, () => {
  let context: BrowserContext;
  let page: Page;
  let meta: Record<string, any>;
  let userToken: string;   // SPA -> System One API (aud = System One API)
  let oboToken: string;    // System One API -> System Two (aud = System Two), minted via OBO
  const idpNavigations: string[] = [];

  test.beforeAll(async ({ browser, request }) => {
    meta = await discovery(request);
    context = await browser.newContext();
    page = await context.newPage();
    page.on("framenavigated", (f) => {
      if (f === page.mainFrame() && f.url().startsWith(IDP_ORIGIN)) idpNavigations.push(f.url());
    });

    const userTokenResponse = page.waitForResponse((r) =>
      r.url() === meta.token_endpoint && r.request().method() === "POST", { timeout: 60_000 });
    const oboResponse = page.waitForResponse((r) =>
      r.url() === `${S1_API}/api/system-two/token` && r.request().method() === "POST", { timeout: 60_000 });

    await page.goto(S1_WEB, { waitUntil: "commit" });  // the SPA immediately redirects to the IdP
    await page.waitForURL((u) => u.origin === IDP_ORIGIN, { timeout: 30_000, waitUntil: "domcontentloaded" });
    await completeIdpLogin(page);

    userToken = (await (await userTokenResponse).json()).access_token;
    oboToken = (await (await oboResponse).json()).access_token;
  });

  test.afterAll(async () => context?.close());

  test("the SPA signs in with auth code + PKCE and lands back on System One", async () => {
    await expect(page.locator("#who")).toHaveText(/^Signed in as /);
    if (profile.E2E_DISPLAY_NAME) await expect(page.locator("#who")).toContainText(profile.E2E_DISPLAY_NAME);
    const authorize = new URL(idpNavigations[0]);
    expect(authorize.searchParams.get("client_id")).toBe(profile.S1_WEB_CLIENT_ID);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(page.url()).toBe(`${S1_WEB}/`);  // ?code=&state= removed
  });

  test("the user token is issued to the SPA for System One API only", async () => {
    const claims = decodeJwt(userToken);
    expect(claims.iss).toBe(meta.issuer);
    expect(audOf(claims).some((a) => list("S1_API_AUDIENCES").includes(a))).toBe(true);
    expect(callerOf(claims)).toBe(profile.S1_WEB_CLIENT_ID);
    expect(claims.scp.split(" ")).toContain(profile.S1_API_REQUIRED_SCOPE);
  });

  test("System One API's OBO token is for System Two, same user, issued to System One API", async () => {
    const user = decodeJwt(userToken);
    const obo = decodeJwt(oboToken);
    expect(oboToken).not.toBe(userToken);
    expect(obo.iss).toBe(meta.issuer);
    expect(audOf(obo).some((a) => list("S2_AUDIENCES").includes(a))).toBe(true);
    expect(audOf(obo).some((a) => list("S1_API_AUDIENCES").includes(a))).toBe(false);
    expect(callerOf(obo)).toBe(profile.S1_API_CLIENT_ID);  // the middle tier, not the SPA
    expect(obo.scp.split(" ")).toContain(profile.S2_REQUIRED_SCOPE);
    expect(obo.oid).toBe(user.oid);  // same user (Entra's sub is pairwise per app; oid is stable)
    expect(obo.tid).toBe(user.tid);
    expect(obo.exp - obo.iat).toBeLessThanOrEqual(5400);
  });

  test("System One API calls System Two API on the user's behalf", async () => {
    await expect(page.locator("#obo")).toHaveText(
      new RegExp(`^System Two API sees .+, called by ${profile.S1_API_CLIENT_ID} on the user's behalf$`));
    if (profile.E2E_DISPLAY_NAME) await expect(page.locator("#obo")).toContainText(profile.E2E_DISPLAY_NAME);
  });

  test("the embedded System Two signs the user in from the OBO token via postMessage", async () => {
    const frame = page.frameLocator("#s2");
    await expect(frame.locator("#status")).toHaveText(
      new RegExp(`^Signed in as .+, token issued to ${profile.S1_API_CLIENT_ID} on behalf of the user$`));
    await expect(frame.locator("#session")).toHaveText("System Two session active");
    expect(await page.locator("#s2").getAttribute("src")).toBe(`${S2}/embed`);  // no token in the URL
    const cookie = (await context.cookies(S2)).find((c) => c.name === "s2_session");
    expect(cookie?.httpOnly).toBe(true);
    await page.screenshot({ path: "test-results/obo-success.png", fullPage: true });
  });

  test("the user signed in to the IdP exactly once", async () => {
    expect(idpNavigations).toHaveLength(1);
  });

  // ---- negative checks, using the real tokens from the journey above ----

  test("System One API requires a user token for System One API", async ({ request }) => {
    expect((await request.get(`${S1_API}/api/me`)).status()).toBe(401);
    const withObo = await request.get(`${S1_API}/api/me`, { headers: { Authorization: `Bearer ${oboToken}` } });
    expect(withObo.status()).toBe(401);
    expect((await withObo.json()).detail).toMatch(/audience/i);
    // ...so an OBO token can't be replayed to mint another OBO token.
    const replay = await request.post(`${S1_API}/api/system-two/token`, { headers: { Authorization: `Bearer ${oboToken}` } });
    expect(replay.status()).toBe(401);
  });

  test("System Two accepts the OBO token but rejects the user's System One token", async ({ request }) => {
    const ok = await request.get(`${S2}/api/me`, { headers: { Authorization: `Bearer ${oboToken}` } });
    expect(ok.status()).toBe(200);
    expect((await ok.json()).user.azp).toBe(profile.S1_API_CLIENT_ID);

    for (const res of [
      await request.get(`${S2}/api/me`, { headers: { Authorization: `Bearer ${userToken}` } }),
      await request.post(`${S2}/session`, { data: { token: userToken } }),
    ]) {
      expect(res.status()).toBe(401);
      expect((await res.json()).detail).toMatch(/audience/i);
    }
    expect((await request.get(`${S2}/api/me`)).status()).toBe(401);
  });

  test("System Two rejects a token signed by anyone but the IdP", async ({ request }) => {
    const forged = forgeToken({ ...decodeJwt(oboToken), name: "Mallory" });
    const res = await request.post(`${S2}/session`, { data: { token: forged } });
    expect(res.status()).toBe(401);
  });

  test("System Two can only be framed by System One and ignores foreign messages", async ({ request, browser }) => {
    const embed = await request.get(`${S2}/embed`);
    expect(embed.headers()["content-security-policy"]).toBe(`frame-ancestors ${S1_WEB}`);

    const other = await browser.newPage();
    let sessionCalls = 0;
    other.on("request", (r) => { if (r.url() === `${S2}/session`) sessionCalls++; });
    await other.goto(`${S2}/embed`);
    await other.evaluate((t) => window.postMessage({ type: "token", token: t }, "*"), oboToken);
    await other.waitForTimeout(500);
    expect(sessionCalls).toBe(0);
    await expect(other.locator("#status")).toHaveText("Waiting for token from System One...");
    await other.close();
  });
});
