"""Input parsing shared by every route: a validation failure becomes a 400 whose message names the field, like the
gateway's zod `parse()` ("spec.nodes: Field required")."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ValidationError

from .errors import bad_request


def parse[M: BaseModel](model: type[M], data: Any) -> M:
    try:
        return model.model_validate(data if data is not None else {})
    except ValidationError as e:
        issues = e.errors(include_url=False, include_context=False)
        first = issues[0] if issues else None
        where = ".".join(str(p) for p in first["loc"]) + ": " if first and first.get("loc") else ""
        message = first["msg"] if first else "Invalid input."
        raise bad_request(f"{where}{message}", [{"path": list(i["loc"]), "message": i["msg"]} for i in issues]) from e
