"""HTTP errors with the gateway's shape and messages: `{error, message, details}`.

The gateway turns these back into its own `HttpError` (same status, code and message), so callers — the web app,
the extension and the chat assistant's tools — see exactly what the TypeScript services used to return.
"""

from __future__ import annotations

from typing import Any


class HttpError(Exception):
    def __init__(self, status: int, code: str, message: str, details: Any = None) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details

    def body(self) -> dict[str, Any]:
        out: dict[str, Any] = {"error": self.code, "message": self.message}
        if self.details is not None:
            out["details"] = self.details
        return out


def bad_request(message: str, details: Any = None) -> HttpError:
    return HttpError(400, "bad_request", message, details)


def unauthorized(message: str = "Sign in required.") -> HttpError:
    return HttpError(401, "unauthorized", message)


def forbidden(message: str = "You do not have permission to do that.") -> HttpError:
    return HttpError(403, "forbidden", message)


def not_found(what: str) -> HttpError:
    return HttpError(404, "not_found", f"{what} not found.")


def conflict(message: str, details: Any = None, code: str = "conflict") -> HttpError:
    return HttpError(409, code, message, details)


def gone(message: str) -> HttpError:
    return HttpError(410, "gone", message)


def is_unique_violation(err: BaseException) -> bool:
    e: BaseException | None = err
    for _ in range(5):
        if e is None:
            return False
        if getattr(e, "sqlstate", None) == "23505" or getattr(e, "pgcode", None) == "23505":
            return True
        e = getattr(e, "orig", None) or e.__cause__
    return False
