import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import type { ActivityEvent } from '@/lib/activity'
import { cn } from '@/lib/utils'

function statusVariant(status: ActivityEvent['status']) {
  if (status === 'ok') return 'ok' as const
  if (status === 'error') return 'error' as const
  return 'running' as const
}

function statusLabel(status: ActivityEvent['status']) {
  switch (status) {
    case 'ok':
      return 'ok'
    case 'error':
      return 'error'
    case 'progress':
      return 'running'
    default:
      return 'running'
  }
}

function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export function ActivityRow({ event }: { event: ActivityEvent }) {
  const [open, setOpen] = useState(false)
  const hasDetail = Boolean(event.args || event.error || event.paths.length)

  return (
    <div className="border-b border-[var(--color-border)] last:border-b-0">
      <button
        type="button"
        onClick={() => hasDetail && setOpen((v) => !v)}
        className={cn(
          'flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors',
          hasDetail && 'hover:bg-neutral-50/80',
          !hasDetail && 'cursor-default',
        )}
      >
        <span className="w-4 shrink-0 text-neutral-400">
          {hasDetail ? (
            open ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )
          ) : null}
        </span>
        <span className="w-[72px] shrink-0 font-mono text-[11px] text-[var(--color-muted)]">
          {formatTime(event.ts)}
        </span>
        <span className="w-14 shrink-0 text-sm font-semibold tracking-tight">{event.tool}</span>
        <Badge variant={statusVariant(event.status)}>{statusLabel(event.status)}</Badge>
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-[var(--color-muted)]">
          {event.argsSummary}
        </span>
        {typeof event.durationMs === 'number' ? (
          <span className="shrink-0 font-mono text-[11px] text-neutral-400">
            {event.durationMs}ms
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="border-t border-[var(--color-border)] bg-neutral-50/50 px-4 py-3 pl-12">
          {event.paths.length > 0 ? (
            <div className="mb-2">
              <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-neutral-400">
                Paths
              </div>
              <ul className="space-y-0.5">
                {event.paths.map((p) => (
                  <li key={p} className="font-mono text-[12px] text-[var(--color-fg)]">
                    {p}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {event.error ? (
            <div className="mb-2">
              <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-neutral-400">
                Error
              </div>
              <pre className="whitespace-pre-wrap font-mono text-[12px] text-[var(--color-err)]">
                {event.error}
              </pre>
            </div>
          ) : null}
          {event.args ? (
            <div>
              <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-neutral-400">
                Args
              </div>
              <pre className="overflow-x-auto rounded-md border border-[var(--color-border)] bg-white p-2 font-mono text-[11px] text-[var(--color-muted)]">
                {JSON.stringify(event.args, null, 2)}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
