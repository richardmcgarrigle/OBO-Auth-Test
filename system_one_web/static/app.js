// System One SPA: OIDC auth code + PKCE as a public client (what MSAL.js does for an Entra SPA),
// then every call to System One API carries the user's access token (aud = System One API).
const cfg = window.S1_CONFIG;
const $ = (id) => document.getElementById(id);

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const random = (n) => b64url(crypto.getRandomValues(new Uint8Array(n)));

async function discover() {
  const r = await fetch(`${cfg.authority}/.well-known/openid-configuration`);
  if (!r.ok) throw new Error(`discovery failed: ${r.status}`);
  return r.json();
}

async function signIn(meta) {
  const verifier = random(48), state = random(16), nonce = random(16);
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  sessionStorage.setItem("s1_pkce", JSON.stringify({ verifier, state }));
  const query = new URLSearchParams({
    client_id: cfg.clientId, response_type: "code", response_mode: "query", redirect_uri: cfg.redirectUri,
    scope: cfg.scopes, state, nonce, code_challenge: challenge, code_challenge_method: "S256",
  });
  location.assign(`${meta.authorization_endpoint}?${query}`);
}

async function redeemCode(meta, params) {
  const pending = JSON.parse(sessionStorage.getItem("s1_pkce") || "null");
  sessionStorage.removeItem("s1_pkce");
  if (!pending || pending.state !== params.get("state")) throw new Error("state mismatch");
  const r = await fetch(meta.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code", client_id: cfg.clientId, code: params.get("code"),
      redirect_uri: cfg.redirectUri, code_verifier: pending.verifier, scope: cfg.scopes,
    }),
  });
  if (!r.ok) throw new Error(`token request failed: ${await r.text()}`);
  const t = await r.json();
  sessionStorage.setItem("s1_tokens", JSON.stringify({
    access_token: t.access_token, expires_at: Date.now() + t.expires_in * 1000,
  }));
  history.replaceState(null, "", location.pathname);  // drop ?code=&state= from the address bar
}

function userToken() {
  const t = JSON.parse(sessionStorage.getItem("s1_tokens") || "null");
  return t && t.expires_at - 30_000 > Date.now() ? t.access_token : null;
}

async function callApi(meta, path, method = "GET") {
  const r = await fetch(`${cfg.apiBaseUrl}${path}`, { method, headers: { Authorization: `Bearer ${userToken()}` } });
  if (r.status === 401) {  // expired, revoked or OBO needs interaction: sign in again
    sessionStorage.removeItem("s1_tokens");
    await signIn(meta);
    throw new Error("re-authenticating");
  }
  if (!r.ok) throw new Error(`${path} failed: ${r.status} ${await r.text()}`);
  return r.json();
}

function embedSystemTwo(meta) {
  const frame = document.createElement("iframe");
  frame.id = "s2";
  frame.width = 600;
  frame.height = 200;
  window.addEventListener("message", async (event) => {
    if (event.origin !== cfg.systemTwoOrigin || event.source !== frame.contentWindow) return;
    if (event.data?.type !== "ready") return;
    const { access_token } = await callApi(meta, "/api/system-two/token", "POST");
    frame.contentWindow.postMessage({ type: "token", token: access_token }, cfg.systemTwoOrigin);
  });
  frame.src = `${cfg.systemTwoOrigin}/embed`;  // no token in the URL
  $("frame-slot").appendChild(frame);
}

async function main() {
  const meta = await discover();
  const params = new URLSearchParams(location.search);
  if (params.get("error")) throw new Error(`${params.get("error")}: ${params.get("error_description")}`);
  if (params.get("code")) await redeemCode(meta, params);
  if (!userToken()) return signIn(meta);

  const me = await callApi(meta, "/api/me");
  $("who").textContent = `Signed in as ${me.name} (${me.preferred_username ?? me.sub})`;
  $("signout").hidden = false;
  $("signout").onclick = () => { sessionStorage.clear(); location.reload(); };

  embedSystemTwo(meta);

  const profile = await callApi(meta, "/api/system-two/profile");
  const u = profile.system_two_says.user;
  $("obo").textContent = `System Two API sees ${u.name}, called by ${u.azp} on the user's behalf`;
}

main().catch((e) => { if (e.message !== "re-authenticating") $("who").textContent = `Error: ${e.message}`; });
