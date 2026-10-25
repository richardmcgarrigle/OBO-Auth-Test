"""System One API: a separate backend that receives the user's token from the System One front end
and uses the OAuth 2.0 On-Behalf-Of flow (Entra's jwt-bearer grant) to act as that user towards System Two."""
import httpx
from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from common.oidc import Oidc, Principal, bearer_auth, env, env_list, user_summary

JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer"

oidc = Oidc(env("IDP_AUTHORITY"))
CLIENT_ID, CLIENT_SECRET = env("S1_API_CLIENT_ID"), env("S1_API_CLIENT_SECRET")
S2_BASE_URL, S2_OBO_SCOPE = env("S2_BASE_URL").rstrip("/"), env("S2_OBO_SCOPE")
http = httpx.Client(timeout=10)

app = FastAPI(title="System One API")
app.add_middleware(CORSMiddleware, allow_origins=[env("S1_WEB_BASE_URL").rstrip("/")],
                   allow_methods=["GET", "POST"], allow_headers=["Authorization", "Content-Type"])
require_user = bearer_auth(oidc, env_list("S1_API_AUDIENCES"), env("S1_API_REQUIRED_SCOPE"))


def on_behalf_of(user_token: str) -> dict:
    """Swaps the incoming user token (aud = System One API) for one with aud = System Two, same user."""
    r = http.post(oidc.token_endpoint, data={
        "grant_type": JWT_BEARER,
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "assertion": user_token,
        "scope": S2_OBO_SCOPE,
        "requested_token_use": "on_behalf_of",
    })
    if r.status_code != 200:
        # e.g. Entra invalid_grant / interaction_required (consent, MFA): the front end must sign in again.
        raise HTTPException(401 if r.status_code in (400, 401) else 502, f"on-behalf-of failed: {r.text}")
    return r.json()


@app.get("/api/me")
def me(user: Principal = Depends(require_user)):
    return user_summary(user.claims)


@app.post("/api/system-two/token")
def system_two_token(user: Principal = Depends(require_user)):
    """OBO token for the System Two iframe hand-off (postMessage, never in a URL)."""
    tokens = on_behalf_of(user.token)
    return {"access_token": tokens["access_token"], "expires_in": tokens.get("expires_in")}


@app.get("/api/system-two/profile")
def system_two_profile(user: Principal = Depends(require_user)):
    """Classic OBO: System One API calls System Two's API as the signed-in user."""
    tokens = on_behalf_of(user.token)
    r = http.get(f"{S2_BASE_URL}/api/me", headers={"Authorization": f"Bearer {tokens['access_token']}"})
    if r.status_code != 200:
        raise HTTPException(502, f"System Two API returned {r.status_code}: {r.text}")
    return {"caller": user_summary(user.claims), "system_two_says": r.json()}
