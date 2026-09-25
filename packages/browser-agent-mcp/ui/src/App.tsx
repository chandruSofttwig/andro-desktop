import { Activity, Radio, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { ActivityRow } from '@/components/activity-row'
import { useActivityStream } from '@/hooks/use-activity-stream'
import { clearServer } from '@/lib/activity'

function Feed() {
  const { events, live, error, clearLocal } = useActivityStream()

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-[var(--color-border)] bg-[var(--color-panel)] px-4 py-3">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-[var(--color-fg)]" />
          <h1 className="text-[15px] font-semibold tracking-tight">Andro Agent</h1>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-[var(--color-muted)]">
          <Radio className={`h-3 w-3 ${live ? 'text-[var(--color-ok)]' : 'text-neutral-400'}`} />
          {live ? 'Live' : 'Reconnecting…'}
        </div>
        <div className="ml-auto">
          <Button
            variant="outline"
            size="sm"
            type="button"
            onClick={() => {
              clearLocal()
              void clearServer()
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
            Clear
          </Button>
        </div>
      </header>

      {error ? (
        <div className="border-b bg-[var(--color-err-bg)] px-4 py-2 text-xs text-[var(--color-err)]">
          {error}
        </div>
      ) : null}

      <ScrollArea className="min-h-0 flex-1 bg-[var(--color-panel)]">
        {events.length === 0 ? (
          <div className="flex h-full min-h-[320px] flex-col items-center justify-center gap-2 px-6 text-center">
            <p className="text-sm font-medium text-[var(--color-fg)]">Waiting for tool calls…</p>
            <p className="max-w-sm text-xs text-[var(--color-muted)]">
              When your AI client invokes Read, Glob, Grep, Write, Edit, Bash, or any andro_*
              context tool, rows appear here in real time.
            </p>
          </div>
        ) : (
          <div>
            {events.map((event) => (
              <ActivityRow key={`${event.id}-${event.status}-${event.ts}`} event={event} />
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  )
}

/**
 * No token gate: this page is served by the agent itself on loopback, and the
 * server authorises these routes by origin.
 */
export default function App() {
  return <Feed />
}
