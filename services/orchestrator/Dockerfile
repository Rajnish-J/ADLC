# The orchestrator service image. Build from this folder: `docker build -t sdlc-orchestrator services/orchestrator`.
FROM python:3.13-slim

COPY --from=ghcr.io/astral-sh/uv:0.11.17 /uv /uvx /bin/

WORKDIR /srv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy PYTHONUNBUFFERED=1

# Dependencies first, so code changes don't reinstall them.
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY app ./app
ENV PATH="/srv/.venv/bin:$PATH" ORCHESTRATOR_HOST=0.0.0.0 ORCHESTRATOR_PORT=4100

RUN useradd --system --uid 10001 orchestrator
USER orchestrator

EXPOSE 4100
CMD ["python", "-m", "app.serve"]
