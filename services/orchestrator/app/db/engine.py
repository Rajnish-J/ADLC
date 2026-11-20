"""The async SQLAlchemy engine (psycopg 3). One per process, created in the app lifespan."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine, create_async_engine

_engine: AsyncEngine | None = None


def init_engine(url: str) -> AsyncEngine:
    global _engine
    _engine = create_async_engine(url, pool_size=10, max_overflow=5, pool_pre_ping=True)
    return _engine


def get_engine() -> AsyncEngine:
    if _engine is None:
        raise RuntimeError("The database engine is not initialised.")
    return _engine


async def dispose_engine() -> None:
    global _engine
    if _engine is not None:
        await _engine.dispose()
        _engine = None


@asynccontextmanager
async def read() -> AsyncIterator[AsyncConnection]:
    """A connection for reads (autocommit-free; nothing is written)."""
    async with get_engine().connect() as conn:
        yield conn


@asynccontextmanager
async def transaction() -> AsyncIterator[AsyncConnection]:
    """A connection inside one transaction: committed on success, rolled back on error."""
    async with get_engine().begin() as conn:
        yield conn
