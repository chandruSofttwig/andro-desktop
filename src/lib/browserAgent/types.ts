import type { ToolCallPart } from "../../types/chat";

/** A tool-call row from ChatGPT's own conversation API (a message whose
 * `recipient` isn't "all", or whose role is "tool" — browser/python/etc.
 * activity), normalized to the same shape the canvas chat's `ToolCallCard`
 * already renders (see `src/components/ChatPane/ToolCallCard.tsx`) — zero
 * translation needed at render time. */
export interface BrowserToolCallEvent extends ToolCallPart {
  timestamp: number;
}

/** A message from ChatGPT's conversation API, or one the user sent via
 * Tempest's own composer. */
export interface BrowserMessageEvent {
  id: string;
  role: "user" | "assistant";
  text: string;
  streaming: boolean;
  timestamp: number;
}

export type TimelineEntry =
  | { kind: "tool"; ts: number; part: BrowserToolCallEvent }
  | { kind: "message"; ts: number; message: BrowserMessageEvent };

export type BrowserAgentSessionState = "idle" | "starting" | "active" | "error";

/** Raw shape posted by the injected relay script (`browser_agent.rs`'s
 * `RELAY_SCRIPT`) — one of a scrape tick or a prompt-submit result. Messages
 * and tool calls come from ChatGPT's own `/backend-api/conversation/<id>`
 * response (same-origin fetch, not DOM scraping — see the Rust module's doc
 * comment); `streaming`/`loggedIn` are still read from the DOM since that's
 * the cheap, reliable case for those two signals. */
export interface RawRelayScrapePayload {
  /** `createTimeMs` is ChatGPT's own real timestamp for the turn
   * (`create_time` from its conversation API, seconds → ms) — used for
   * timeline ordering instead of "when Tempest happened to observe it",
   * since that drifts against the independently-timed andro-activity SSE
   * stream (poll vs. push cadences aren't synchronized, only real event
   * times stay consistently ordered against each other). */
  messages: { id: string; role: "user" | "assistant"; text: string; createTimeMs: number }[];
  /** `status`/`resultDetail` are authoritative from the source (the relay
   * script merges a tool call's invocation and result nodes into one entry
   * itself — see `browser_agent.rs`'s `fetchConversationData`), not
   * inferred client-side. `resultDetail` is the tool's output text, kept
   * separate from `label` (the invocation's own description) so becoming
   * "complete" doesn't overwrite what the call WAS with what it returned. */
  toolCalls: { id: string; label: string; status: "running" | "complete"; resultDetail: string | null }[];
  streaming: boolean;
  /** Whether ChatGPT's composer is present — a signed-in session loaded the
   * chat UI rather than a login/signup screen. */
  loggedIn: boolean;
}

export interface RawRelayPromptResult {
  promptResult: { ok: boolean; reason: string | null };
}

export type RawRelayPayload = RawRelayScrapePayload | RawRelayPromptResult;
