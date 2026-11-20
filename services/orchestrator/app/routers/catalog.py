"""Catalog routes (port of apps/api/src/catalogRoutes.ts and the step-skills route of sessionRoutes.ts).

A project's agents and skills (list, read, enable, and create/edit/delete the platform-defined ones) and its
workflows (list, read, create, edit, make default, delete, and map an agent, skills or a harness onto a step).
Thin: check the path, call the service with the raw body (it parses it), return the contract shape. The gateway
forwards these paths unchanged.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Body, Depends

from ..catalog import agents, workflows
from ..catalog.agents import MISSING, ToggleAgentInput, ZodModel, max_len, min_len, uuid, zod, zstring
from ..http import parse
from ..security import Caller, current_caller

router = APIRouter()

CallerDep = Annotated[Caller, Depends(current_caller)]
JsonBody = Annotated[Any, Body()]

PROJECT = "/api/v1/projects/{key}"
AGENT = PROJECT + "/agents/{slug}"
WORKFLOW = PROJECT + "/workflows/{workflow_id}"
# `:path` so a percent-encoded `/` in a node id still routes (Fastify matches before decoding).
STEP = WORKFLOW + "/nodes/{node_id:path}"


# Path parameters, checked like the gateway's zod param schemas (routeKit.KeyParams and friends).
class _KeyParams(ZodModel):
    key: Annotated[str, zod(zstring(min_len(1), max_len(20)))] = MISSING


class _AgentParams(_KeyParams):
    slug: Annotated[str, zod(zstring(min_len(1), max_len(100)))] = MISSING


class _WorkflowParams(_KeyParams):
    id: Annotated[str, zod(zstring(uuid))] = MISSING


class _StepParams(_WorkflowParams):
    nodeId: Annotated[str, zod(zstring(min_len(1), max_len(200)))] = MISSING


# ─── Agents & skills ───────────────────────────────────────────────────────────────────────────────────────────


@router.get(PROJECT + "/agents")
async def list_agents(key: str, caller: CallerDep) -> list[dict[str, Any]]:
    parse(_KeyParams, {"key": key})
    return await agents.list_agents(caller.user, key)


@router.post(PROJECT + "/agents", status_code=201)
async def create_agent(key: str, caller: CallerDep, body: JsonBody = None) -> dict[str, Any]:
    parse(_KeyParams, {"key": key})
    return await agents.create_platform_agent(caller, key, body)


@router.get(AGENT)
async def get_agent(key: str, slug: str, caller: CallerDep) -> dict[str, Any]:
    parse(_AgentParams, {"key": key, "slug": slug})
    return await agents.get_agent(caller.user, key, slug)


@router.put(AGENT)
async def toggle_agent(key: str, slug: str, caller: CallerDep, body: JsonBody = None) -> dict[str, Any]:
    """Enable or disable any agent or skill in the project."""
    parse(_AgentParams, {"key": key, "slug": slug})
    enabled = parse(ToggleAgentInput, body).enabled
    return await agents.set_agent_enabled(caller, key, slug, enabled)


@router.patch(AGENT)
async def update_agent(key: str, slug: str, caller: CallerDep, body: JsonBody = None) -> dict[str, Any]:
    """Edit a platform agent or skill's definition."""
    parse(_AgentParams, {"key": key, "slug": slug})
    return await agents.update_platform_agent(caller, key, slug, body)


@router.delete(AGENT)
async def delete_agent(key: str, slug: str, caller: CallerDep) -> dict[str, Any]:
    parse(_AgentParams, {"key": key, "slug": slug})
    return await agents.delete_platform_agent(caller, key, slug)


# ─── Workflows ─────────────────────────────────────────────────────────────────────────────────────────────────


@router.get(PROJECT + "/workflows")
async def list_workflows(key: str, caller: CallerDep) -> list[dict[str, Any]]:
    parse(_KeyParams, {"key": key})
    return await workflows.list_workflows(caller.user, key)


@router.post(PROJECT + "/workflows", status_code=201)
async def create_workflow(key: str, caller: CallerDep, body: JsonBody = None) -> dict[str, Any]:
    parse(_KeyParams, {"key": key})
    return await workflows.create_workflow(caller, key, body)


@router.get(WORKFLOW)
async def get_workflow(key: str, workflow_id: str, caller: CallerDep) -> dict[str, Any]:
    parse(_WorkflowParams, {"key": key, "id": workflow_id})
    return await workflows.get_workflow(caller.user, key, workflow_id)


@router.patch(WORKFLOW)
async def update_workflow(key: str, workflow_id: str, caller: CallerDep, body: JsonBody = None) -> dict[str, Any]:
    parse(_WorkflowParams, {"key": key, "id": workflow_id})
    return await workflows.update_workflow(caller, key, workflow_id, body)


@router.post(WORKFLOW + "/default")
async def set_default_workflow(key: str, workflow_id: str, caller: CallerDep) -> dict[str, Any]:
    parse(_WorkflowParams, {"key": key, "id": workflow_id})
    return await workflows.set_default_workflow(caller, key, workflow_id)


@router.delete(WORKFLOW)
async def delete_workflow(key: str, workflow_id: str, caller: CallerDep) -> dict[str, Any]:
    parse(_WorkflowParams, {"key": key, "id": workflow_id})
    return await workflows.delete_workflow(caller, key, workflow_id)


@router.put(STEP + "/agent")
async def set_step_agent(
    key: str, workflow_id: str, node_id: str, caller: CallerDep, body: JsonBody = None
) -> dict[str, Any]:
    """Map an agent onto one agent step of a project workflow (null unbinds it)."""
    parse(_StepParams, {"key": key, "id": workflow_id, "nodeId": node_id})
    return await workflows.set_step_agent(caller, key, workflow_id, node_id, body)


@router.put(STEP + "/skills")
async def set_step_skills(
    key: str, workflow_id: str, node_id: str, caller: CallerDep, body: JsonBody = None
) -> dict[str, Any]:
    """The skills an agent step may use (replaces the list)."""
    parse(_StepParams, {"key": key, "id": workflow_id, "nodeId": node_id})
    return await workflows.set_step_skills(caller, key, workflow_id, node_id, body)


@router.put(STEP + "/harness")
async def set_step_harness(
    key: str, workflow_id: str, node_id: str, caller: CallerDep, body: JsonBody = None
) -> dict[str, Any]:
    """Pin an agent step to a harness, or null to run it in the harness the run starts with."""
    parse(_StepParams, {"key": key, "id": workflow_id, "nodeId": node_id})
    return await workflows.set_step_harness(caller, key, workflow_id, node_id, body)
