/** "AL" for "Asha Lead". */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/)
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '')).toUpperCase()
}

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
]

/** "3 minutes ago". */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000)
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit)
  }
  return 'just now'
}

/** Compact age for dense rows like board cards: "now", "12m", "5h", "3d", "2mo", "1y". */
export function shortAge(iso: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))
  if (seconds < 60) return 'now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 24 * 3600) return `${Math.floor(seconds / 3600)}h`
  if (seconds < 30 * 24 * 3600) return `${Math.floor(seconds / (24 * 3600))}d`
  if (seconds < 365 * 24 * 3600) return `${Math.floor(seconds / (30 * 24 * 3600))}mo`
  return `${Math.floor(seconds / (365 * 24 * 3600))}y`
}

/** A `YYYY-MM-DD` calendar date as a local Date at midnight — never `new Date('YYYY-MM-DD')`, which is UTC. */
function calendarDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/** Today as `YYYY-MM-DD` in the viewer's timezone. */
export function todayIso(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** A due date: "Nov 3", with the year only when it isn't this year. */
export function formatDueDate(iso: string, now: Date = new Date()): string {
  const date = calendarDate(iso)
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  })
}

export type DueState = 'overdue' | 'today' | 'soon' | 'later'

/** How urgent a due date is; a finished story is never overdue. */
export function dueState(iso: string, done: boolean, now: Date = new Date()): DueState {
  if (done) return 'later'
  const days = Math.round((calendarDate(iso).getTime() - calendarDate(todayIso(now)).getTime()) / 86_400_000)
  if (days < 0) return 'overdue'
  if (days === 0) return 'today'
  return days <= 2 ? 'soon' : 'later'
}

/** "Apr 3, 2026". */
export function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' })
}

/** "Apr 3, 2026, 14:05". */
export function dateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}
