import { startIdp, stopIdp } from "../scripts/idp.mjs";
import { loadProfile } from "../scripts/profile.mjs";

/** Starts the mock profile's IdP container; the returned function stops it afterwards, if this run started it. */
export default async function globalSetup() {
  const profile = loadProfile(process.env.E2E_PROFILE!);
  if (profile.IDP_KIND !== "mock") return;
  const started = await startIdp(profile);
  return () => { if (started) stopIdp(profile); };
}
