import type { ToolCallPart } from "../../types/chat";
import type { BrowserToolCallEvent } from "../browserAgent/types";
import type { ActivityEvent } from "./types";

export function mergeActivityEvent(previous: ActivityEvent | undefined, incoming: ActivityEvent): ActivityEvent {
  return {
    ...incoming,
    ts: previous?.ts ?? incoming.ts,
    output: incoming.status === "progress"
      ? ((previous?.output ?? "") + (incoming.output ?? "")).slice(-100000)
      : incoming.output ?? previous?.output,
  };
}

// browser-agent-mcp's tool names (Read/Write/Edit/Bash/Grep/Glob) are
// literally the same names Claude Code's CLI uses, so `getToolLabel`/
// `getToolIcon` (src/lib/chatModels.ts) already map them to sensible
// icons/labels for free. `argsPreview` (src/lib/chatTools.ts) also already
// knows how to summarize those tool names' args — but expects Claude Code's
// own key names (`file_path`, `command`, `pattern`), which don't quite match
// browser-agent-mcp's own arg shape (`path` instead of `file_path`, etc.).
// This adapts one to the other rather than duplicating argsPreview's switch.
function adaptArgs(event: ActivityEvent): Record<string, unknown> {
  const a = event.args ?? {};
  switch (event.tool) {
    case "Read":
    case "Write":
    case "Edit":
      return { file_path: event.paths[0] ?? a.path ?? "" };
    case "Bash":
      return { command: a.command ?? event.argsSummary };
    case "Grep":
    case "Glob":
      return { pattern: a.pattern ?? event.argsSummary };
    default:
      return a;
  }
}

/** Converts one browser-agent-mcp activity event (the latest known state for
 * a given tool-call id — started/progress/ok/error) into the same
 * `ToolCallPart` shape `ToolCallCard` already renders, carrying the
 * server's own real `ts` (used by `buildTimeline` for correct ordering
 * against the independently-timed ChatGPT message channel — see
 * `src/lib/browserAgent/timeline.ts`'s doc comment). */
export function activityEventToToolCall(event: ActivityEvent): BrowserToolCallEvent {
  const status: ToolCallPart["status"] =
    event.status === "ok" || event.status === "error" ? "complete" : "running";

  let result: unknown = event.output ? { content: event.output } : undefined;
  if (status === "complete") {
    result = event.status === "error"
      ? { error: event.error || "failed" }
      : { content: event.output || event.argsSummary || "done" };
  }

  return {
    type: "tool-call",
    id: event.id,
    toolName: event.tool,
    args: adaptArgs(event),
    status,
    result,
    timestamp: event.ts,
  };
}
