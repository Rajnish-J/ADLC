"""The SDLC orchestrator service (FastAPI).

Owns the workflow and agent/skill catalog, and drives platform runs: every workflow node runs as a LangGraph node
(checkpointed in Postgres), and every agent step is handed to a harness in the user's VS Code. Only the platform
gateway (apps/api) calls it — see app/security.py.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from .config import get_settings
from .db.engine import dispose_engine, init_engine
from .errors import HttpError

log = logging.getLogger("orchestrator")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    logging.basicConfig(level=settings.LOG_LEVEL, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    init_engine(settings.sqlalchemy_url)
    from .engine.runner import start_runtime, stop_runtime

    await start_runtime(settings)
    log.info("Orchestrator ready on %s:%s", settings.ORCHESTRATOR_HOST, settings.ORCHESTRATOR_PORT)
    try:
        yield
    finally:
        await stop_runtime()
        await dispose_engine()


def create_app() -> FastAPI:
    app = FastAPI(title="SDLC orchestrator", version="0.1.0", lifespan=lifespan, docs_url="/docs", redoc_url=None)

    @app.exception_handler(HttpError)
    async def http_error(_req: Request, err: HttpError) -> JSONResponse:
        return JSONResponse(status_code=err.status, content=err.body())

    @app.exception_handler(RequestValidationError)
    async def validation_error(_req: Request, err: RequestValidationError) -> JSONResponse:
        first = err.errors()[0] if err.errors() else None
        where = ".".join(str(p) for p in first["loc"][1:]) + ": " if first and len(first.get("loc", ())) > 1 else ""
        msg = f"{where}{first['msg']}" if first else "Invalid input."
        return JSONResponse(status_code=400, content={"error": "bad_request", "message": msg})

    @app.exception_handler(Exception)
    async def unhandled(req: Request, err: Exception) -> JSONResponse:
        log.exception("Unhandled error on %s %s", req.method, req.url.path, exc_info=err)
        return JSONResponse(status_code=500, content={"error": "internal", "message": "Something went wrong."})

    @app.get("/healthz")
    async def healthz() -> dict[str, object]:
        from .engine.runner import runtime_status

        return {"ok": True, "service": "orchestrator", **runtime_status()}

    from .routers import catalog, runs

    app.include_router(catalog.router)
    app.include_router(runs.router)
    return app


app = create_app()
