"""Run routes (same paths as the gateway's public API under /api/v1). `request` and `claim` return core facts the
gateway turns into StoryRun / RunLaunch; everything else is returned in its contract shape."""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Body, Depends, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator

from ..harness import assignments
from ..harnesses import HARNESS_ID
from ..http import parse
from ..runs import service
from ..security import Caller, current_caller

router = APIRouter(prefix="/api/v1")
CLIENT_ID = r"^[\w-]{8,64}$"


class SubmitPlanInput(BaseModel):
    plan: str = Field(min_length=1, max_length=60_000)
    tokensIn: int | None = Field(default=None, ge=0)
    tokensOut: int | None = Field(default=None, ge=0)


class CompleteStepInput(BaseModel):
    summary: str = Field(min_length=1, max_length=60_000)
    skillsUsed: list[str] = Field(default_factory=list, max_length=50)
    outputs: dict[str, Any] | None = None
    tokensIn: int | None = Field(default=None, ge=0)
    tokensOut: int | None = Field(default=None, ge=0)
    model: str | None = Field(default=None, max_length=120)
    # Workspace-relative paths the step changed (VS Code diffs a git snapshot taken around the step).
    changedFiles: list[Annotated[str, Field(max_length=1000)]] = Field(default_factory=list, max_length=500)


class NextStepQuery(BaseModel):
    harness: str
    clientId: str | None = Field(default=None, pattern=CLIENT_ID)
    wait: int = Field(default=25, ge=0, le=50)

    @field_validator("harness")
    @classmethod
    def _harness(cls, v: str) -> str:
        v = v.strip().lower()
        if not HARNESS_ID.match(v):
            raise ValueError("A harness id is lowercase letters, digits and dashes.")
        return v


# ─── Lifecycle ─────────────────────────────────────────────────────────────────────────────────────────────────


@router.post("/projects/{key}/runs", status_code=201)
async def request_run(key: str, body: Any = Body(None), caller: Caller = Depends(current_caller)) -> dict[str, Any]:
    return await service.request_run(caller, key, body)


@router.get("/me/runs/pending")
async def pending(caller: Caller = Depends(current_caller)) -> list[dict[str, Any]]:
    return await service.pending_runs(caller.user)


@router.get("/me/runs/active")
async def active(caller: Caller = Depends(current_caller)) -> list[dict[str, Any]]:
    return await service.active_runs(caller.user)


@router.post("/runs/{run_id}/claim")
async def claim(run_id: str, body: Any = Body(None), caller: Caller = Depends(current_caller)) -> dict[str, Any]:
    return await service.claim_run(caller, run_id, body)


@router.post("/projects/{key}/runs/{run_id}/cancel")
async def cancel(
    key: str, run_id: str, body: Any = Body(None), caller: Caller = Depends(current_caller)
) -> dict[str, Any]:
    return await service.cancel_run(caller, key, run_id, body)


@router.post("/projects/{key}/runs/{run_id}/approval")
async def approve(
    key: str, run_id: str, body: Any = Body(None), caller: Caller = Depends(current_caller)
) -> dict[str, Any]:
    return await service.approve_run(caller, key, run_id, body)


# ─── Activity ──────────────────────────────────────────────────────────────────────────────────────────────────


@router.post("/projects/{key}/runs/{run_id}/events")
async def report_events(
    key: str, run_id: str, body: Any = Body(None), caller: Caller = Depends(current_caller)
) -> dict[str, Any]:
    return await service.report_run_events(caller, key, run_id, body)


@router.get("/projects/{key}/runs/{run_id}/events")
async def list_events(
    key: str,
    run_id: str,
    after: int = Query(-1, ge=-1),
    limit: int = Query(500, ge=1, le=1_000),
    caller: Caller = Depends(current_caller),
) -> dict[str, Any]:
    return await service.list_run_events(caller.user, key, run_id, after, limit)


# ─── Agent steps, for the harness in VS Code ───────────────────────────────────────────────────────────────────


@router.get("/projects/{key}/runs/{run_id}/steps/next")
async def next_step(
    key: str,
    run_id: str,
    harness: str = Query(...),
    clientId: str | None = Query(None),  # noqa: N803 — the public query name
    wait: int = Query(25),
    caller: Caller = Depends(current_caller),
) -> JSONResponse:
    q = parse(NextStepQuery, {"harness": harness, "clientId": clientId, "wait": wait})
    return JSONResponse(await assignments.next_step(caller, key, run_id, q.harness, q.wait))


@router.post("/projects/{key}/runs/{run_id}/steps/{step_id}/plan")
async def submit_plan(
    key: str, run_id: str, step_id: str, body: Any = Body(None), caller: Caller = Depends(current_caller)
) -> dict[str, Any]:
    data = parse(SubmitPlanInput, body)
    return await assignments.submit_plan(
        caller, key, run_id, step_id, data.plan, data.tokensIn or 0, data.tokensOut or 0
    )


@router.post("/projects/{key}/runs/{run_id}/steps/{step_id}/complete")
async def complete_step(
    key: str, run_id: str, step_id: str, body: Any = Body(None), caller: Caller = Depends(current_caller)
) -> dict[str, Any]:
    data = parse(CompleteStepInput, body)
    result = {
        "summary": data.summary,
        "skillsUsed": data.skillsUsed,
        "outputs": data.outputs or {},
        "tokensIn": data.tokensIn or 0,
        "tokensOut": data.tokensOut or 0,
        "model": data.model,
        "changedFiles": data.changedFiles,
    }
    return await assignments.complete_step(caller, key, run_id, step_id, result)
