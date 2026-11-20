// Phase 3 — cost control: an Azure Consumption budget scoped to the Foundry
// resource group, with a percentage alert. Reuses the ARM token/scope; no new
// auth. Consumption writes often need elevated RBAC, so on failure we return the
// exact `az` command for the operator to run instead (graceful degrade).

import { ARM_SCOPE } from '../foundry/constants'
import type { TokenProvider } from '../foundry/foundryClient'

const BUDGET_API = '2023-05-01'
const BUDGET_NAME = 'sdlc-foundry-eval-budget'

export interface EnsureBudgetInput {
  subscriptionId: string
  resourceGroup: string
  amount: number
  /** Alert threshold as a percentage of the budget (e.g. 80). */
  alertPercent: number
}

export interface EnsureBudgetResult {
  created: boolean
  name: string
  /** A copy-paste `az` command to create the budget if the API call failed. */
  cliFallback: string
}

function cliFallback(input: EnsureBudgetInput): string {
  return (
    `az consumption budget create --budget-name ${BUDGET_NAME} ` +
    `--amount ${input.amount} --time-grain Monthly ` +
    `--resource-group ${input.resourceGroup} --subscription ${input.subscriptionId} ` +
    `--category Cost`
  )
}

export async function ensureBudget(
  getToken: TokenProvider,
  input: EnsureBudgetInput,
): Promise<EnsureBudgetResult> {
  const token = await getToken(ARM_SCOPE)
  const url =
    `https://management.azure.com/subscriptions/${encodeURIComponent(input.subscriptionId)}` +
    `/resourceGroups/${encodeURIComponent(input.resourceGroup)}` +
    `/providers/Microsoft.Consumption/budgets/${encodeURIComponent(BUDGET_NAME)}` +
    `?api-version=${BUDGET_API}`

  // A startDate must be the first of a month per the Consumption API.
  const now = new Date()
  const startDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()

  const body = {
    properties: {
      category: 'Cost',
      amount: input.amount,
      timeGrain: 'Monthly',
      timePeriod: { startDate },
      notifications: {
        alert: {
          enabled: true,
          operator: 'GreaterThanOrEqualTo',
          threshold: input.alertPercent,
          contactEmails: [] as string[],
          thresholdType: 'Actual',
        },
      },
    },
  }

  try {
    const res = await fetch(url, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      return { created: false, name: BUDGET_NAME, cliFallback: cliFallback(input) }
    }
    return { created: true, name: BUDGET_NAME, cliFallback: cliFallback(input) }
  } catch {
    return { created: false, name: BUDGET_NAME, cliFallback: cliFallback(input) }
  }
}
