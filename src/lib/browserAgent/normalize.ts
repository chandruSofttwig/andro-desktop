import type { BrowserMessageEvent, BrowserToolCallEvent, RawRelayPayload, RawRelayScrapePayload } from "./types";

function isScrapePayload(payload: RawRelayPayload): payload is RawRelayScrapePayload {
  return "messages" in payload;
}

/** Normalizes one relay tick from the injected scraper (see
 * `browser_agent.rs`'s `fetchConversationData`) into Tempest's own event
 * shapes. Tool identity comes from ChatGPT's own conversation API (not DOM
 * guessing) — `toolName` is the tool-call's own description (e.g.
 * "browser: <query>"), which `getToolLabel`/`getToolIcon`
 * (`src/lib/chatModels.ts`) render verbatim since their `CLI_TOOL_META` map
 * won't match these names — acceptable, just no icon-guessing beyond the
 * generic Terminal icon. `status`/`result` come directly from the source,
 * which already merges a call with its result — no second-guessing needed
 * here the way a purely scraped source would require. */
export function normalizeRelayPayload(
  payload: RawRelayPayload,
): { toolCalls: BrowserToolCallEvent[]; messages: BrowserMessageEvent[]; loggedIn: boolean } | null {
  if (!isScrapePayload(payload)) return null;

  const messages: BrowserMessageEvent[] = payload.messages.map((m, i) => ({
    id: m.id,
    role: m.role,
    text: m.text,
    // Only the last assistant message can plausibly still be streaming.
    streaming: payload.streaming && m.role === "assistant" && i === payload.messages.length - 1,
    // ChatGPT's own real timestamp (see RawRelayScrapePayload's doc comment
    // on createTimeMs) — not "when this tick happened to be observed."
    timestamp: m.createTimeMs,
  }));

  // Always empty as of the andro-activity rewrite (see this file's doc
  // comment) — kept typed/mapped for shape-compatibility rather than
  // special-cased, in case a future ChatGPT-API-derived signal is worth
  // adding back.
  const toolCalls: BrowserToolCallEvent[] = payload.toolCalls.map((t) => ({
    type: "tool-call",
    id: t.id,
    toolName: t.label,
    args: {},
    status: t.status,
    result: t.status === "complete" ? { content: t.resultDetail ?? "" } : undefined,
    timestamp: Date.now(),
  }));

  return { toolCalls, messages, loggedIn: payload.loggedIn };
}
