"""Shared test setup.

- Windows: psycopg's async mode cannot run on the default Proactor event loop.
- Tests never call back into a running gateway: the "run finished" callback goes to a closed port and is only logged.
"""

from __future__ import annotations

import asyncio
import os
import sys

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())  # type: ignore[attr-defined]

os.environ.setdefault("API_URL", "http://127.0.0.1:9")
