"""System Two: an embeddable page plus an API. Accepts only tokens issued for System Two (the OBO tokens
minted for System One API), from the iframe hand-off or as a bearer token on its API."""
import secrets
from pathlib import Path

import jwt
from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel

from common.oidc import InsufficientScope, Oidc, Principal, bearer_auth, env, env_list, user_summary

oidc = Oidc(env("IDP_AUTHORITY"))
AUDIENCES, REQUIRED_SCOPE = env_list("S2_AUDIENCES"), env("S2_REQUIRED_SCOPE")
ALLOWED_PARENT = env("S1_WEB_BASE_URL").rstrip("/")
STATIC = Path(__file__).parent / "static"
SESSIONS: dict[str, dict] = {}

app = FastAPI(title="System Two")
require_s2_token = bearer_auth(oidc, AUDIENCES, REQUIRED_SCOPE)


class TokenIn(BaseModel):
    token: str


@app.get("/embed")
def embed():
    html = (STATIC / "embed.html").read_text().replace("__PARENT_ORIGIN__", ALLOWED_PARENT)
    return Response(html, media_type="text/html",
                    headers={"Content-Security-Policy": f"frame-ancestors {ALLOWED_PARENT}"})


@app.post("/session")
def create_session(body: TokenIn, response: Response):
    try:
        claims = oidc.validate(body.token, AUDIENCES, REQUIRED_SCOPE)
    except jwt.PyJWTError as e:
        raise HTTPException(401, f"invalid token: {e}")
    except InsufficientScope as e:
        raise HTTPException(403, str(e))
    sid = secrets.token_urlsafe(32)
    SESSIONS[sid] = claims
    # Different localhost ports are same-site, so Lax works locally; cross-site prod needs SameSite=None; Secure.
    response.set_cookie("s2_session", sid, httponly=True, samesite="lax")
    return user_summary(claims)


@app.get("/session")
def current_session(request: Request):
    claims = SESSIONS.get(request.cookies.get("s2_session", ""))
    if not claims:
        raise HTTPException(401, "no System Two session")
    return user_summary(claims)


@app.get("/api/me")
def api_me(caller: Principal = Depends(require_s2_token)):
    return {"system": "System Two", "user": user_summary(caller.claims)}
