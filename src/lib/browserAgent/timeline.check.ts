import { buildTimeline } from "./timeline.ts";
import type { BrowserMessageEvent } from "./types.ts";
import type { BrowserToolCallEvent } from "./types.ts";

// Chronological ordering across mixed tool/message entries.
const msgs: BrowserMessageEvent[] = [
  { id: "u1", role: "user", text: "hi", streaming: false, timestamp: 100 },
  { id: "a1", role: "assistant", text: "hello", streaming: false, timestamp: 300 },
];
const tools: BrowserToolCallEvent[] = [
  { type: "tool-call", id: "t1", toolName: "Read", args: {}, status: "running", timestamp: 200 },
];
let entries = buildTimeline(tools, msgs);
if (entries.length !== 3) throw new Error(`expected 3 entries, got ${entries.length}`);
if (entries[0].kind !== "message" || entries[0].message.id !== "u1") throw new Error("first entry should be u1");

// A status transition updates the SAME entry in place (by id) rather than
// appending a duplicate, and must not move its position in the timeline.
const firstToolTs = entries.find((e) => e.kind === "tool")!.ts;
tools[0] = { ...tools[0], status: "complete", result: { content: "ok" } };
entries = buildTimeline(tools, msgs);
if (entries.length !== 3) throw new Error(`status update should not append, got ${entries.length} entries`);
const updated = entries.find((e) => e.kind === "tool");
if (!updated || updated.kind !== "tool") throw new Error("tool entry missing after update");
if (updated.part.status !== "complete") throw new Error("status update did not apply");
if (updated.ts !== firstToolTs) throw new Error("in-place update should preserve original timestamp/order");

// A streaming message settling to final text also updates in place.
const settledMsgs: BrowserMessageEvent[] = [
  msgs[0],
  { ...msgs[1], text: "hello there", streaming: false },
];
entries = buildTimeline(tools, settledMsgs);
if (entries.length !== 3) throw new Error("message update should not append");

console.log("browserAgent/timeline.check.ts: ok");
