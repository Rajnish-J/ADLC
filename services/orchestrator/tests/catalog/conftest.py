"""Fixtures for the catalog API tests: the dev Postgres (seeded by apps/api's `db:seed`), a minimal app that mounts
only the catalog router (app.main's lifespan also starts the run engine), and a client that calls it as a seeded
user through the gateway's internal headers.

Everything a test creates is registered with `cleanup` and removed afterwards; seeded rows are never deleted.
"""

from __future__ import annotations

import asyncio
import sys
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

import httpx
import pytest
import pytest_asyncio
import sqlalchemy as sa
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.db import tables as t
from app.db.engine import dispose_engine, get_engine, init_engine, read, transaction
from app.errors import HttpError
from app.routers import catalog
from app.security import TOKEN_HEADER, USER_HEADER

if sys.platform == "win32":
    # psycopg's async mode cannot run on the Proactor loop Windows uses by default.
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())  # type: ignore[attr-defined]

SEED_EMAILS = {
    "admin": "admin@sdlc.local",  # org_admin
    "owner": "owner@sdlc.local",  # PAY owner
    "lead": "lead@sdlc.local",  # PAY lead, ONB owner
    "dev1": "dev1@sdlc.local",  # PAY developer, not in ONB
    "viewer": "viewer@sdlc.local",  # PAY viewer
}


def build_app() -> FastAPI:
    """The catalog router plus the same exception handlers as app.main.create_app."""
    app = FastAPI()

    @app.exception_handler(HttpError)
    async def http_error(_req: Request, err: HttpError) -> JSONResponse:
        return JSONResponse(status_code=err.status, content=err.body())

    @app.exception_handler(RequestValidationError)
    async def validation_error(_req: Request, err: RequestValidationError) -> JSONResponse:
        first = err.errors()[0] if err.errors() else None
        where = ".".join(str(p) for p in first["loc"][1:]) + ": " if first and len(first.get("loc", ())) > 1 else ""
        msg = f"{where}{first['msg']}" if first else "Invalid input."
        return JSONResponse(status_code=400, content={"error": "bad_request", "message": msg})

    app.include_router(catalog.router)
    return app


@pytest_asyncio.fixture(scope="package")
async def db_engine() -> AsyncIterator[None]:
    try:
        get_engine()
        owned = False  # another fixture set it up; leave it to them
    except RuntimeError:
        init_engine(get_settings().sqlalchemy_url)
        owned = True
    yield
    if owned:
        await dispose_engine()


@pytest_asyncio.fixture(scope="package")
async def user_ids(db_engine: None) -> dict[str, str]:
    async with read() as conn:
        rows = (
            await conn.execute(
                sa.select(t.users.c.id, t.users.c.email).where(
                    sa.func.lower(t.users.c.email).in_(list(SEED_EMAILS.values()))
                )
            )
        ).all()
    by_email = {r.email.lower(): r.id for r in rows}
    missing = [e for e in SEED_EMAILS.values() if e not in by_email]
    if missing:
        pytest.skip(f"Seed users missing ({', '.join(missing)}); run `npm run db:seed -w @sdlc/api`.")
    return {who: by_email[email] for who, email in SEED_EMAILS.items()}


@pytest_asyncio.fixture(scope="package")
async def http(db_engine: None) -> AsyncIterator[httpx.AsyncClient]:
    transport = httpx.ASGITransport(app=build_app())
    async with httpx.AsyncClient(transport=transport, base_url="http://catalog.test") as client:
        yield client


@dataclass
class Api:
    """Calls the catalog as one of the seeded users (by role name, e.g. "lead")."""

    http: httpx.AsyncClient
    users: dict[str, str]

    async def call(self, method: str, path: str, as_: str = "lead", json: Any = None) -> httpx.Response:
        headers = {TOKEN_HEADER: get_settings().ORCHESTRATOR_TOKEN, USER_HEADER: self.users[as_]}
        kwargs: dict[str, Any] = {"headers": headers}
        if json is not None:
            kwargs["json"] = json
        return await self.http.request(method, path, **kwargs)

    async def get(self, path: str, as_: str = "lead") -> httpx.Response:
        return await self.call("GET", path, as_)

    async def post(self, path: str, json: Any = None, as_: str = "lead") -> httpx.Response:
        return await self.call("POST", path, as_, json)

    async def put(self, path: str, json: Any = None, as_: str = "lead") -> httpx.Response:
        return await self.call("PUT", path, as_, json)

    async def patch(self, path: str, json: Any = None, as_: str = "lead") -> httpx.Response:
        return await self.call("PATCH", path, as_, json)

    async def delete(self, path: str, as_: str = "lead") -> httpx.Response:
        return await self.call("DELETE", path, as_)


@pytest.fixture
def api(http: httpx.AsyncClient, user_ids: dict[str, str]) -> Api:
    return Api(http, user_ids)


@dataclass
class Cleanup:
    """Rows a test created, removed after it (runs first, then workflows, then agents)."""

    runs: list[str] = field(default_factory=list)
    workflows: list[str] = field(default_factory=list)
    agents: list[str] = field(default_factory=list)
    finalizers: list[Callable[[], Awaitable[None]]] = field(default_factory=list)


@pytest_asyncio.fixture
async def cleanup(db_engine: None) -> AsyncIterator[Cleanup]:
    c = Cleanup()
    yield c
    for fin in reversed(c.finalizers):
        await fin()
    async with transaction() as conn:
        if c.runs:
            await conn.execute(t.runs.delete().where(t.runs.c.id.in_(c.runs)))
        if c.workflows:
            await conn.execute(t.workflows.delete().where(t.workflows.c.id.in_(c.workflows)))
        if c.agents:
            # project_agents rows go with them (ON DELETE CASCADE).
            await conn.execute(t.agents.delete().where(t.agents.c.id.in_(c.agents)))
