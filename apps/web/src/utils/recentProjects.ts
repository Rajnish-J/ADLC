// Projects this browser opened lately, for "Jump back in" in the new-project dialog. A per-viewer convenience kept
// in localStorage — it may be empty (private windows, cleared storage) and nothing depends on it.

const STORAGE_KEY = 'sdlc.recentProjects'
const MAX = 10

export interface RecentProject {
  key: string
  /** ISO time of the last visit. */
  at: string
}

export function recentProjects(): RecentProject[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return []
    return parsed.filter((p): p is RecentProject => typeof p?.key === 'string' && typeof p?.at === 'string')
  } catch {
    return []
  }
}

export function recordProjectVisit(key: string): void {
  try {
    const next = [{ key, at: new Date().toISOString() }, ...recentProjects().filter((p) => p.key !== key)].slice(0, MAX)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Storage unavailable — the list just stays empty.
  }
}
