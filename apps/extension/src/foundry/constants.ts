// Azure / Foundry connection constants.
//
// Harvested verbatim from the analytics repo's `orka` feature
// (src/service/foundry.service.ts:19-29). These are the proven-working
// scopes and API versions. Re-verify against the latest Azure SDK at build
// time — the new Foundry projects API is the target (classic retires 2027-03-31).

// ─── OAuth scopes ─────────────────────────────────────────────────────────────
export const ARM_SCOPE = 'https://management.azure.com/.default'
export const FOUNDRY_SCOPE = 'https://ai.azure.com/.default'
// Azure DevOps resource app id (constant across all tenants). The Microsoft provider issues a
// token for this audience so the WIQL / work-item REST calls authenticate as the signed-in user.
export const ADO_SCOPE = '499b84ac-1321-427f-aa17-267ca6975798/.default'

// ─── REST API versions ────────────────────────────────────────────────────────
export const ARM_SUBSCRIPTIONS_API = '2022-12-01'
export const ARM_RESOURCES_API = '2022-12-01'
export const COGNITIVE_API = '2025-06-01'
export const FOUNDRY_DATA_API = '2025-05-01'

// ─── Token cache grace window ─────────────────────────────────────────────────
// Treat a token as expired this many ms early so it never lapses mid-request.
export const TOKEN_GRACE_MS = 60_000
