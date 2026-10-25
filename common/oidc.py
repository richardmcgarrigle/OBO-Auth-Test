"""IdP-agnostic OIDC helpers shared by the three apps.

Everything about the IdP comes from environment variables (see env/*.env) and from the authority's
discovery document, so the same code runs against the local mock and against Microsoft Entra ID.
"""
import os
from dataclasses import dataclass
from pathlib import Path

import httpx
import jwt
from fastapi import Header, HTTPException
from jwt import PyJWKClient


def _load_env_file():
    """When run by hand (`uvicorn ...`), ENV_FILE=env/local.env loads a profile. Real env vars win."""
    path = os.environ.get("ENV_FILE")
    if not path:
        return
    for line in Path(path).read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip())


_load_env_file()


def env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"missing required environment variable {name} (set ENV_FILE or export it)")
    return value


def env_list(name: str) -> list[str]:
    return [v.strip() for v in env(name).split(",") if v.strip()]


class InsufficientScope(Exception):
    pass


class Oidc:
    """Lazy discovery + JWKS cache, so apps can start before the IdP is reachable."""

    def __init__(self, authority: str):
        self.authority = authority.rstrip("/")
        self._metadata: dict | None = None
        self._jwks: PyJWKClient | None = None

    @property
    def metadata(self) -> dict:
        if self._metadata is None:
            r = httpx.get(f"{self.authority}/.well-known/openid-configuration", timeout=10)
            r.raise_for_status()
            self._metadata = r.json()
        return self._metadata

    @property
    def issuer(self) -> str:
        return self.metadata["issuer"]

    @property
    def token_endpoint(self) -> str:
        return self.metadata["token_endpoint"]

    def validate(self, token: str, audiences: list[str], required_scope: str) -> dict:
        """Checks signature (JWKS), iss, aud, exp/nbf and the delegated scope (`scp`)."""
        if self._jwks is None:
            self._jwks = PyJWKClient(self.metadata["jwks_uri"], cache_keys=True)
        key = self._jwks.get_signing_key_from_jwt(token).key
        claims = jwt.decode(token, key, algorithms=["RS256"], audience=audiences, issuer=self.issuer,
                            leeway=30, options={"require": ["exp", "iat", "iss", "aud", "sub"]})
        if required_scope not in claims.get("scp", "").split():
            raise InsufficientScope(f"token lacks scope {required_scope}")
        return claims


def user_summary(claims: dict) -> dict:
    """Display fields. Entra's `sub` is pairwise per app, so `oid` is the cross-app user id."""
    return {"name": claims.get("name") or claims.get("preferred_username") or claims["sub"],
            "preferred_username": claims.get("preferred_username"),
            "oid": claims.get("oid"), "sub": claims["sub"], "tid": claims.get("tid"),
            "azp": claims.get("azp") or claims.get("appid"), "aud": claims["aud"], "scp": claims.get("scp")}


@dataclass
class Principal:
    token: str
    claims: dict


def bearer_auth(oidc: Oidc, audiences: list[str], required_scope: str):
    """FastAPI dependency: requires `Authorization: Bearer <token>` issued for one of `audiences`."""

    def dependency(authorization: str | None = Header(None)) -> Principal:
        if not authorization or not authorization.lower().startswith("bearer "):
            raise HTTPException(401, "missing bearer token", headers={"WWW-Authenticate": "Bearer"})
        token = authorization[7:].strip()
        try:
            return Principal(token, oidc.validate(token, audiences, required_scope))
        except jwt.PyJWTError as e:
            raise HTTPException(401, f"invalid token: {e}", headers={"WWW-Authenticate": "Bearer"})
        except InsufficientScope as e:
            raise HTTPException(403, str(e))

    return dependency
