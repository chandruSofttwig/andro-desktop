import { activityEventToToolCall, mergeActivityEvent } from "./normalize.ts";
import type { ActivityEvent } from "./types.ts";

// A "started" event is running, with no result yet.
const started: ActivityEvent = {
  id: "t1", ts: 1, tool: "Read", status: "started",
  argsSummary: "src/foo.ts", paths: ["src/foo.ts"], args: { path: "src/foo.ts" },
};
const runningCall = activityEventToToolCall(started);
if (runningCall.status !== "running") throw new Error("started event should map to running status");
if (runningCall.result !== undefined) throw new Error("running tool call should have no result");
if (runningCall.toolName !== "Read") throw new Error("toolName should be the raw tool name (Read/Write/Grep/etc.)");
// Read/Write/Edit use `path` in browser-agent-mcp's own args, not Claude
// Code's `file_path` — adaptArgs must translate so argsPreview() still works.
if ((runningCall.args as { file_path?: string }).file_path !== "src/foo.ts") {
  throw new Error("Read args should be adapted to file_path for argsPreview() compatibility");
}

// An "ok" event completes with output as its result content.
const finishedOk: ActivityEvent = {
  id: "t1", ts: 2, tool: "Read", status: "ok",
  argsSummary: "src/foo.ts", paths: ["src/foo.ts"], args: { path: "src/foo.ts" },
  output: "export const x = 1;", durationMs: 42,
};
const completeCall = activityEventToToolCall(finishedOk);
if (completeCall.status !== "complete") throw new Error("ok event should map to complete status");
if ((completeCall.result as { content?: string })?.content !== "export const x = 1;") {
  throw new Error("complete tool call should carry output as result content");
}

// An "error" event completes with the error message, not output.
const finishedError: ActivityEvent = {
  id: "t2", ts: 3, tool: "Bash", status: "error",
  argsSummary: "npm test", paths: [], args: { command: "npm test" },
  error: "command exited 1",
};
const errorCall = activityEventToToolCall(finishedError);
if (errorCall.status !== "complete") throw new Error("error event should still map to complete status");
if ((errorCall.result as { error?: string })?.error !== "command exited 1") {
  throw new Error("errored tool call should carry the error message as its result");
}
if ((errorCall.args as { command?: string }).command !== "npm test") {
  throw new Error("Bash args should pass through the command for argsPreview()");
}

console.log("androActivity/normalize.check.ts: ok");

const first = mergeActivityEvent(started, { ...started, ts: 10, status: "progress", output: "first\n" });
const second = mergeActivityEvent(first, { ...started, ts: 20, status: "progress", output: "second\n" });
if (second.output !== "first\nsecond\n") throw new Error("progress chunks must accumulate");
if (second.ts !== started.ts) throw new Error("progress must preserve timeline position");
const live = activityEventToToolCall(second);
if (live.status !== "running" || (live.result as { content: string }).content !== second.output) throw new Error("running output must be visible");
const done = mergeActivityEvent(second, finishedOk);
if (done.output !== finishedOk.output) throw new Error("final snapshot must replace progress output");
