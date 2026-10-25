import { APIRequestContext, Page, expect } from "@playwright/test";
import crypto from "node:crypto";
import { loadProfile } from "../scripts/profile.mjs";

export const profile: Record<string, string> = loadProfile(process.env.E2E_PROFILE || "local");
export const list = (name: string) => profile[name].split(",").map((s) => s.trim());

export function decodeJwt(token: string): Record<string, any> {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
}

export const audOf = (claims: Record<string, any>) => [claims.aud].flat() as string[];
export const callerOf = (claims: Record<string, any>) => claims.azp ?? claims.appid;  // v2 azp, v1 appid

export async function discovery(request: APIRequestContext) {
  const r = await request.get(`${profile.IDP_AUTHORITY}/.well-known/openid-configuration`);
  expect(r.ok()).toBeTruthy();
  return r.json();
}

/** Completes the IdP's sign-in UI, whichever IdP the profile points at. */
export async function completeIdpLogin(page: Page) {
  if (profile.IDP_KIND === "mock") {
    // mock-oauth2-server login form: any username; extra claims as JSON.
    await page.locator("input[name=username]").fill(profile.E2E_USERNAME);
    await page.locator("textarea[name=claims]").fill(JSON.stringify({ name: profile.E2E_DISPLAY_NAME }));
    await page.locator("input[type=submit]").click();
    return;
  }
  // Microsoft Entra sign-in (test user without MFA / Conditional Access prompts).
  if (!profile.E2E_PASSWORD) throw new Error("E2E_PASSWORD is required for the entra profile");
  await page.locator("input[name=loginfmt]").fill(profile.E2E_USERNAME);
  await page.locator("#idSIButton9").click();
  await page.locator("input[name=passwd]").fill(profile.E2E_PASSWORD);
  await page.locator("#idSIButton9").click();
  const staySignedIn = page.locator("#idBtn_Back");  // "Stay signed in?" -> No
  if (await staySignedIn.isVisible({ timeout: 10_000 }).catch(() => false)) await staySignedIn.click();
}

/** Signs a JWT with an attacker-controlled key. */
export function forgeToken(claims: Record<string, unknown>) {
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const signingInput = `${b64({ alg: "RS256", typ: "JWT", kid: "forged" })}.${b64(claims)}`;
  return `${signingInput}.${crypto.sign("RSA-SHA256", Buffer.from(signingInput), privateKey).toString("base64url")}`;
}
