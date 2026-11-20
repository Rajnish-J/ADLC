"""Run the orchestrator: `uv run python -m app.serve`.

On Windows, asyncio's default Proactor loop cannot run psycopg in async mode, so the server runs on a selector loop.
(`uvicorn --reload`, used by `npm run dev:orchestrator`, already does that in its worker process; Linux and the
container image are unaffected.)
"""

from __future__ import annotations

import asyncio
import sys

import uvicorn

from .config import get_settings


def main() -> None:
    settings = get_settings()
    config = uvicorn.Config(
        "app.main:app",
        host=settings.ORCHESTRATOR_HOST,
        port=settings.ORCHESTRATOR_PORT,
        log_level=settings.LOG_LEVEL.lower(),
        proxy_headers=False,
    )
    server = uvicorn.Server(config)
    if sys.platform == "win32":
        asyncio.run(server.serve(), loop_factory=asyncio.SelectorEventLoop)
    else:
        asyncio.run(server.serve())


if __name__ == "__main__":
    main()
