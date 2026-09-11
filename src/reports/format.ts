// Shared formatting for the daily/weekly digest renderers (email + Telegram).

/** Milliseconds to a short human age string, e.g. "3h", "2d". */
export function age(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${Math.max(0, minutes)}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

/** A dollar amount to two decimals, e.g. "$1.23". */
export function money(usd: number): string {
  return `$${usd.toFixed(2)}`
}

/** A timestamp as a date-only string in the operator's timezone (America/New_York),
 *  e.g. "2026-08-28". Matches the timezone the digest window and quiet hours use. */
export function dateInTz(ms: number): string {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}
