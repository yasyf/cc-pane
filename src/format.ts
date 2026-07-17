// Compact human formatting shared across views: token counts, event clock times, ages.

export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  return `${(tokens / 1000).toFixed(1)}k`
}

// event.time is unix seconds; render HH:MM in the caller's timeZone (tests pin "UTC").
export function formatEventTime(unixSeconds: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(unixSeconds * 1000))
}

export function formatAge(fromMs: number, nowMs: number): string {
  const secs = Math.max(0, Math.floor((nowMs - fromMs) / 1000))
  if (secs < 60) return `${secs}s ago`
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
  return `${Math.floor(secs / 3600)}h ago`
}
