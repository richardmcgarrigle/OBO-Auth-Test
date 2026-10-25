"""Pins System One API's On-Behalf-Of request to Entra's contract. The mock IdP is lenient about
`requested_token_use` and the assertion, so this is where the exact request shape is checked."""
import os
from urllib.parse import parse_qs

os.environ.update(
    IDP_AUTHORITY="https://idp.test/tenant/v2.0", S1_WEB_BASE_URL="http://web.test",
    S1_API_CLIENT_ID="s1-api-id", S1_API_CLIENT_SECRET="s1-api-secret",
    S1_API_AUDIENCES="s1-api-id", S1_API_REQUIRED_SCOPE="access_as_user",
    S2_BASE_URL="http://s2.test", S2_OBO_SCOPE="api://s2-id/access_as_user",
)

import httpx
import pytest
from fastapi import HTTPException

import system_one_api.main as api

TOKEN_ENDPOINT = "https://idp.test/tenant/oauth2/v2.0/token"


@pytest.fixture(autouse=True)
def discovered(monkeypatch):
    monkeypatch.setattr(api.oidc, "_metadata", {"issuer": "https://idp.test/tenant/v2.0",
                                                "token_endpoint": TOKEN_ENDPOINT, "jwks_uri": "unused"})


def use_idp(monkeypatch, handler):
    monkeypatch.setattr(api, "http", httpx.Client(transport=httpx.MockTransport(handler)))


def test_obo_request_matches_entra_contract(monkeypatch):
    seen = {}

    def handler(request: httpx.Request):
        seen["method"], seen["url"] = request.method, str(request.url)
        seen["form"] = {k: v[0] for k, v in parse_qs(request.content.decode()).items()}
        return httpx.Response(200, json={"token_type": "Bearer", "access_token": "s2-token", "expires_in": 3599})

    use_idp(monkeypatch, handler)
    assert api.on_behalf_of("incoming-user-token")["access_token"] == "s2-token"
    assert (seen["method"], seen["url"]) == ("POST", TOKEN_ENDPOINT)
    assert seen["form"] == {
        "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
        "client_id": "s1-api-id",
        "client_secret": "s1-api-secret",
        "assertion": "incoming-user-token",
        "scope": "api://s2-id/access_as_user",
        "requested_token_use": "on_behalf_of",
    }


def test_obo_rejection_asks_front_end_to_reauthenticate(monkeypatch):
    use_idp(monkeypatch, lambda request: httpx.Response(400, json={
        "error": "invalid_grant", "suberror": "consent_required"}))
    with pytest.raises(HTTPException) as e:
        api.on_behalf_of("incoming-user-token")
    assert e.value.status_code == 401
    assert "consent_required" in e.value.detail


def test_idp_outage_is_a_bad_gateway(monkeypatch):
    use_idp(monkeypatch, lambda request: httpx.Response(503, text="unavailable"))
    with pytest.raises(HTTPException) as e:
        api.on_behalf_of("incoming-user-token")
    assert e.value.status_code == 502
