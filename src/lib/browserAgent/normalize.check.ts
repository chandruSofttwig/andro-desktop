import { normalizeRelayPayload } from "./normalize.ts";

// A non-scrape payload (prompt-submit result) is not this function's job.
if (normalizeRelayPayload({ promptResult: { ok: true, reason: null } }) !== null) {
  throw new Error("promptResult payload should be rejected, not normalized");
}

// Basic scrape tick: messages + tool calls pass through as given.
const tick1 = normalizeRelayPayload({
  messages: [
    { id: "u1", role: "user", text: "fix the bug" },
    { id: "a1", role: "assistant", text: "" },
  ],
  toolCalls: [{ id: "t1", label: "browser: search foo", status: "running", resultDetail: null }],
  streaming: true,
  loggedIn: true,
});
if (!tick1) throw new Error("expected a normalized result for tick1");
if (tick1.loggedIn !== true) throw new Error("loggedIn should pass through from the raw payload");
if (tick1.toolCalls.length !== 1 || tick1.toolCalls[0].status !== "running") {
  throw new Error("running tool call should stay running");
}
if (tick1.toolCalls[0].result !== undefined) throw new Error("running tool call should have no result");
// Only the LAST assistant message may be marked streaming — an earlier
// assistant turn that already finished must not flip back to "replying…".
if (tick1.messages[1].streaming !== true) throw new Error("last assistant message should be streaming");
if (tick1.messages[0].streaming !== false) throw new Error("user message can never be streaming");

// The source (browser_agent.rs) merges a tool call's invocation and result
// into ONE entry itself and reports status/resultDetail authoritatively —
// normalize must trust that directly, not infer/latch status itself.
const tick2 = normalizeRelayPayload({
  messages: [],
  toolCalls: [{ id: "t1", label: "browser: search foo", status: "complete", resultDetail: "3 results found" }],
  streaming: false,
  loggedIn: true,
});
if (!tick2 || tick2.toolCalls[0].status !== "complete") {
  throw new Error("complete status from source should pass through");
}
if (tick2.toolCalls[0].result === undefined || (tick2.toolCalls[0].result as { content: string }).content !== "3 results found") {
  throw new Error("complete tool call should carry resultDetail as its result content");
}
// The label (what the call WAS) must survive completion unchanged.
if (tick2.toolCalls[0].toolName !== "browser: search foo") {
  throw new Error("completing a tool call must not overwrite its own label with the result");
}

// An assistant message earlier in the list, with a newer one appended after
// it, must not be marked streaming even while the overall tick is streaming.
const tick3 = normalizeRelayPayload({
  messages: [
    { id: "a1", role: "assistant", text: "done with step one" },
    { id: "a2", role: "assistant", text: "" },
  ],
  toolCalls: [],
  streaming: true,
  loggedIn: true,
});
if (!tick3) throw new Error("expected a normalized result for tick3");
if (tick3.messages[0].streaming !== false) throw new Error("earlier assistant turn should not be streaming");
if (tick3.messages[1].streaming !== true) throw new Error("newest assistant turn should be streaming");

// Still on a login/signup screen — no composer found — loggedIn stays false.
const tick4 = normalizeRelayPayload({ messages: [], toolCalls: [], streaming: false, loggedIn: false });
if (!tick4 || tick4.loggedIn !== false) throw new Error("loggedIn:false should pass through as false");

console.log("browserAgent/normalize.check.ts: ok");
