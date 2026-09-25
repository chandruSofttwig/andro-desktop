// Mirrors browser-agent-mcp's src/activity-bus.ts `ActivityEvent` exactly —
// keep in sync with that file if it changes. One tool call is 1-3 events
// sharing the same `id`: started -> zero-or-more progress -> ok|error.
export type ActivityStatus = "started" | "progress" | "ok" | "error";

export interface ActivityEvent {
  id: string;
  ts: number;
  tool: string;
  status: ActivityStatus;
  argsSummary: string;
  paths: string[];
  args?: Record<string, unknown>;
  durationMs?: number;
  error?: string;
  output?: string;
  outputType?: "stdout" | "stderr" | "info";
  progress?: number;
}

/** The server also sends a non-event sentinel once a client has been
 * replayed the buffered snapshot: `{"type":"ready","ts":...}`. Not a real
 * ActivityEvent — `isActivityEvent` below filters it out. */
export interface ActivityReadySentinel {
  type: "ready";
  ts: number;
}

export function isActivityEvent(v: unknown): v is ActivityEvent {
  return (
    !!v && typeof v === "object" &&
    "id" in v && "tool" in v && "status" in v &&
    typeof (v as ActivityEvent).id === "string"
  );
}
