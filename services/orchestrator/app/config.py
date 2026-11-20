"""Settings, from the environment (and the repo-root .env in development)."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

_HERE = Path(__file__).resolve()
# The repo-root .env in a checkout (services/orchestrator/app/config.py → repo root); absent in the container image.
_ROOT_ENV = _HERE.parents[3] / ".env" if len(_HERE.parents) > 3 else _HERE.parent / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=(_ROOT_ENV, ".env"), extra="ignore")

    DATABASE_URL: str = "postgres://sdlc:sdlc_dev_password@127.0.0.1:5432/sdlc"
    ORCHESTRATOR_HOST: str = "127.0.0.1"
    ORCHESTRATOR_PORT: int = 4100
    # Shared secret between the gateway (apps/api) and this service. Every request must carry it.
    ORCHESTRATOR_TOKEN: str = "dev-orchestrator-token"
    # The gateway, for callbacks (memory capture when a run finishes).
    API_URL: str = "http://127.0.0.1:4000"
    NODE_ENV: str = "development"
    # Active-time budget for a platform run (agent steps run in a harness, so the 5-minute spec default is too short).
    RUN_TIMEOUT_MINUTES: int = 240
    # How long a run requested from the web waits for a VS Code window (matches RUN_REQUEST_TTL_MS).
    RUN_REQUEST_TTL_SECONDS: int = 120
    SWEEP_INTERVAL_SECONDS: int = 30
    LOG_LEVEL: str = "INFO"

    @property
    def sqlalchemy_url(self) -> str:
        url = self.DATABASE_URL
        for prefix in ("postgresql://", "postgres://"):
            if url.startswith(prefix):
                return "postgresql+psycopg://" + url[len(prefix) :]
        return url

    @property
    def psycopg_url(self) -> str:
        """libpq form, for LangGraph's AsyncPostgresSaver pool."""
        url = self.DATABASE_URL
        return "postgresql://" + url.split("://", 1)[1] if "://" in url else url


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    if settings.NODE_ENV == "production" and settings.ORCHESTRATOR_TOKEN == "dev-orchestrator-token":
        raise RuntimeError("Set ORCHESTRATOR_TOKEN in production.")
    return settings
