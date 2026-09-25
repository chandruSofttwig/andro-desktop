import { useCallback, useEffect, useRef, useState } from 'react'
import { type ActivityEvent, apiBase, fetchSnapshot } from '@/lib/activity'

function isActivityEvent(data: unknown): data is ActivityEvent {
  return (
    typeof data === 'object' &&
    data !== null &&
    'id' in data &&
    'tool' in data &&
    'status' in data
  )
}

/**
 * Live activity feed.
 *
 * No token: this UI is served by the agent on loopback and the `-ui` routes are
 * origin-authorised. Keeping the credential out of the URL is deliberate —
 * query strings get written to access logs and browser history.
 */
export function useActivityStream() {
  const [events, setEvents] = useState<ActivityEvent[]>([])
  const [live, setLive] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const esRef = useRef<EventSource | null>(null)
  const backoffRef = useRef(1000)
  const cancelledRef = useRef(false)

  const upsert = useCallback((incoming: ActivityEvent) => {
    setEvents((prev) => {
      const idx = prev.findIndex((e) => e.id === incoming.id)
      if (idx >= 0) {
        const next = [...prev]
        next[idx] = incoming
        return next
      }
      return [incoming, ...prev]
    })
  }, [])

  const connect = useCallback(() => {
    if (cancelledRef.current) return
    esRef.current?.close()
    setError(null)

    const es = new EventSource(`${apiBase()}/events-ui`)
    esRef.current = es

    es.onopen = () => {
      setLive(true)
      backoffRef.current = 1000
    }

    es.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data) as unknown
        if (
          typeof data === 'object' &&
          data !== null &&
          'type' in data &&
          (data as { type: string }).type === 'ready'
        ) {
          setLive(true)
          return
        }
        if (isActivityEvent(data)) upsert(data)
      } catch {
        // ignore malformed frames
      }
    }

    es.onerror = () => {
      setLive(false)
      es.close()
      esRef.current = null
      if (cancelledRef.current) return
      const delay = backoffRef.current
      backoffRef.current = Math.min(delay * 2, 15000)
      window.setTimeout(() => connect(), delay)
    }
  }, [upsert])

  useEffect(() => {
    cancelledRef.current = false

    void fetchSnapshot()
      .then((snap) => {
        if (cancelledRef.current) return
        // Newest first, one row per id.
        const map = new Map<string, ActivityEvent>()
        for (const e of snap) map.set(e.id, e)
        setEvents([...map.values()].sort((a, b) => b.ts - a.ts))
      })
      .catch((err: Error) => {
        if (!cancelledRef.current) setError(err.message)
      })
      .finally(() => connect())

    return () => {
      cancelledRef.current = true
      esRef.current?.close()
      esRef.current = null
    }
  }, [connect])

  const clearLocal = useCallback(() => setEvents([]), [])

  return { events, live, error, clearLocal, setError }
}
