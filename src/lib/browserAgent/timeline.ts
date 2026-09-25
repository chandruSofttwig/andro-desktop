import type { BrowserMessageEvent, BrowserToolCallEvent, TimelineEntry } from "./types";

/** Merges tool-call and message events into one chronological log, updating
 * entries in place by id rather than re-appending — so a tool call's
 * running→complete transition (or an assistant reply settling from streaming
 * to final text) doesn't reorder the timeline. Ported from andro-UI's
 * `Transcript.tsx`/`events.ts` merge-by-id pattern.
 *
 * Ordering uses each entry's own real timestamp (`part.timestamp` /
 * `message.timestamp`), not "when this tick happened to be observed" —
 * tool calls (browser-agent-mcp's SSE, push-based) and chat messages
 * (ChatGPT's API, polled) arrive over two independently-timed channels, so
 * observation order can't be trusted to reflect true causal order (a tool
 * call that clearly ran before a response could get observed after it, if
 * the poll tick landed first). Real timestamps keep "tool calls before the
 * response they informed" true regardless of which channel's update lands
 * in the store first. */
export function buildTimeline(
  toolCalls: BrowserToolCallEvent[],
  messages: BrowserMessageEvent[],
): TimelineEntry[] {
  const entries = new Map<string, TimelineEntry>();

  for (const part of toolCalls) {
    entries.set(`tool:${part.id}`, { kind: "tool", ts: part.timestamp, part });
  }

  for (const message of messages) {
    entries.set(`message:${message.id}`, { kind: "message", ts: message.timestamp, message });
  }

  return [...entries.values()].sort((a, b) => a.ts - b.ts);
}
