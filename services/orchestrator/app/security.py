"""Who is calling. The gateway (apps/api) authenticates the user and forwards the request with the shared internal
token, the user's id and the client kind; this service trusts nothing else and binds to localhost only."""

from __future__ import annotations

import hmac
from dataclasses import dataclass

import sqlalchemy as sa
from fastapi import Request

from .config import get_settings
from .db import tables as t
from .db.engine import read
from .errors import unauthorized

TOKEN_HEADER = "x-sdlc-internal-token"
USER_HEADER = "x-sdlc-user-id"
VIA_HEADER = "x-sdlc-via"


@dataclass(frozen=True)
class AuthUser:
    id: str
    org_id: str
    email: str
    display_name: str
    org_role: str


@dataclass(frozen=True)
class Caller:
    user: AuthUser
    via: str


def check_internal_token(request: Request) -> None:
    sent = request.headers.get(TOKEN_HEADER, "")
    if not hmac.compare_digest(sent.encode(), get_settings().ORCHESTRATOR_TOKEN.encode()):
        raise unauthorized("This service only answers the platform gateway.")


async def load_user(user_id: str) -> AuthUser | None:
    async with read() as conn:
        row = (
            await conn.execute(
                sa.select(t.users.c.id, t.users.c.org_id, t.users.c.email, t.users.c.display_name, t.users.c.org_role)
                .where(t.users.c.id == user_id)
                .limit(1)
            )
        ).first()
    if row is None:
        return None
    return AuthUser(id=row.id, org_id=row.org_id, email=row.email, display_name=row.display_name, org_role=row.org_role)


async def current_caller(request: Request) -> Caller:
    """FastAPI dependency for every user-facing route."""
    check_internal_token(request)
    user_id = request.headers.get(USER_HEADER)
    if not user_id:
        raise unauthorized()
    try:
        user = await load_user(user_id)
    except Exception as e:  # a malformed uuid
        raise unauthorized() from e
    if user is None:
        raise unauthorized()
    return Caller(user=user, via=request.headers.get(VIA_HEADER) or "api")
