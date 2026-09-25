import { agentRuntime } from "./agentRuntime";

const session = agentRuntime.createSession({ agent: "claude", projectRoot: "/tmp/project" });
if (session.state !== "starting") throw new Error("new session state failed");
if (!agentRuntime.hasCapability(session.id, "terminal")) throw new Error("terminal capability missing");
agentRuntime.setState(session.id, "working");
if (agentRuntime.getSession(session.id)?.state !== "working") throw new Error("state transition failed");
agentRuntime.stopSession(session.id);
if (agentRuntime.getSession(session.id)?.state !== "stopped") throw new Error("stop failed");
agentRuntime.removeSession(session.id);
if (agentRuntime.getSession(session.id)) throw new Error("remove failed");
console.log("agentRuntime.check.ts: ok");
