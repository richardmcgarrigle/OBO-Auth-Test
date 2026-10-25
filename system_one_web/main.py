"""System One front end: static SPA. The only server logic is publishing the (non-secret) IdP settings."""
import json
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, Response

from common.oidc import env

STATIC = Path(__file__).parent / "static"
CONFIG = {
    "authority": env("IDP_AUTHORITY").rstrip("/"),
    "clientId": env("S1_WEB_CLIENT_ID"),
    "redirectUri": env("S1_WEB_REDIRECT_URI"),
    "scopes": env("S1_WEB_SCOPES"),
    "apiBaseUrl": env("S1_API_BASE_URL").rstrip("/"),
    "systemTwoOrigin": env("S2_BASE_URL").rstrip("/"),
}

# No caching: config.js changes with the launch profile, and other apps may have been served from this origin.
NO_STORE = {"Cache-Control": "no-store"}

app = FastAPI(title="System One Web")


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html", headers=NO_STORE)


@app.get("/app.js")
def app_js():
    return FileResponse(STATIC / "app.js", media_type="text/javascript", headers=NO_STORE)


@app.get("/config.js")
def config_js():
    return Response(f"window.S1_CONFIG = {json.dumps(CONFIG)};", media_type="text/javascript", headers=NO_STORE)
