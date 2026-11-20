"""Drizzle (apps/api) owns the schema and its migrations; app/db/tables.py mirrors the columns this service uses.
This reflects the dev database and fails when a mirrored table or column is missing — i.e. when a migration changed
something the mirror still relies on. Run `npm run db:migrate` first."""

from __future__ import annotations

import pytest
import sqlalchemy as sa

from app.config import get_settings
from app.db import tables as t

pytestmark = pytest.mark.db


def test_every_mirrored_column_exists_in_the_database() -> None:
    engine = sa.create_engine(get_settings().sqlalchemy_url)
    try:
        inspector = sa.inspect(engine)
        missing: list[str] = []
        for table in t.metadata.sorted_tables:
            if not inspector.has_table(table.name):
                missing.append(table.name)
                continue
            actual = {c["name"] for c in inspector.get_columns(table.name)}
            missing += [f"{table.name}.{c.name}" for c in table.columns if c.name not in actual]
        assert not missing, f"Mirrored in app/db/tables.py but not in the database: {', '.join(missing)}"
        # LangGraph's checkpoint tables live in their own schema, created by the orchestrator at startup.
        assert "orchestrator" in inspector.get_schema_names()
    finally:
        engine.dispose()
