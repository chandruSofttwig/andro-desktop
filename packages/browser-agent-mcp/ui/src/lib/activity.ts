export type ActivityStatus =
  | 'started'
  | 'progress'
  | 'ok'
  | 'error'

export type ActivityEvent = {
  id: string
  ts: number
  tool: string
  status: ActivityStatus
  argsSummary: string
  paths: string[]
  args?: Record<string, unknown>
  durationMs?: number
  error?: string
  output?: string
  outputType?: 'stdout' | 'stderr' | 'info'
  progress?: number
  type?: string
}

/**
 * This UI is served by the agent itself, on loopback. It authenticates by
 * origin (the server enforces a local-Origin check on the `*-ui` routes)
 * rather than by a token in the URL.
 *
 * Tokens in query strings leak into access logs, browser history and Referer
 * headers, which is why the server no longer accepts `?token=` anywhere.
 * `apiBase()` returns a same-origin path, so no credential is needed here.
 */
export function apiBase(): string {
  const path = window.location.pathname.replace(/\/+$/, '')
  if (path.endsWith('/activity') || path.includes('/activity/')) {
    const idx = path.lastIndexOf('/activity')
    return path.slice(0, idx + '/activity'.length)
  }
  return '/activity'
}

function localOnlySuffix(): string {
  // The server rejects non-local Origins on these routes; the query flag is a
  // routing hint, not a credential.
  return '-ui'
}

export async function fetchSnapshot(): Promise<ActivityEvent[]> {
  const res = await fetch(`${apiBase()}/snapshot${localOnlySuffix()}`)
  if (!res.ok) {
    throw new Error(
      res.status === 403
        ? 'Activity is only available from a local browser'
        : `Snapshot failed (${res.status})`,
    )
  }
  const data = (await res.json()) as { events: ActivityEvent[] }
  return data.events ?? []
}

export async function clearServer(): Promise<void> {
  await fetch(`${apiBase()}/clear${localOnlySuffix()}`, { method: 'POST' })
}
