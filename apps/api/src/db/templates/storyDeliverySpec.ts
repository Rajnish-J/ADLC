// "Story delivery" — the platform's default workflow. The spec lives in @sdlc/core so the VS Code extension
// serves the exact same workflow as its local default; this module keeps the API's import path stable.

export { QUICK_FIX_SPEC, STORY_DELIVERY_SPEC } from '@sdlc/core'

/** Platform workflow templates retired in favour of the skeleton — replaced in every project by the seed. */
export const RETIRED_TEMPLATE_NAMES = ['SDLC Default', 'SDLC Governance']
