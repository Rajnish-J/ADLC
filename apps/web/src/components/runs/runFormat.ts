// Small formatting helpers shared by the run views.

/** 2h 05m, 4m 12s, 38s. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

export const plural = (n: number, word: string, many = `${word}s`) => `${n.toLocaleString()} ${n === 1 ? word : many}`

/** `+12 −3` for added / removed lines. */
export const lineDelta = (additions: number, deletions: number) => `+${additions.toLocaleString()} −${deletions.toLocaleString()}`
