import type { AgentConfig } from "./agentManifest";
import { getAgent, getAgents } from "./agentRegistry";
import { buildAgentArgs, type AgentArgContext } from "./agentArgs";

export type AgentCapability = "filesystem" | "terminal" | "git" | "browser" | "network" | "skills" | "secrets";
export type AgentSessionState = "starting" | "working" | "waiting" | "idle" | "stopped" | "error";
export interface AgentSession { id: string; agentId: string; agentName: string; projectRoot: string; worktree?: string; state: AgentSessionState; startedAt: number; updatedAt: number; capabilities: Set<AgentCapability>; metadata?: Record<string, string>; }
export interface AgentLaunchPlan {
  sessionId: string;
  agentId: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export type AgentRuntimeEvent = { type: "session-created"; session: AgentSession } | { type: "session-state"; sessionId: string; state: AgentSessionState; message?: string } | { type: "session-event"; sessionId: string; event: string; data?: unknown } | { type: "session-stopped"; sessionId: string } | { type: "runtime-error"; sessionId?: string; error: string };
type Listener = (event: AgentRuntimeEvent) => void;
const DEFAULT_CAPABILITIES: AgentCapability[] = ["filesystem", "terminal", "git", "skills"];
class AgentRuntime {
  private sessions = new Map<string, AgentSession>(); private listeners = new Set<Listener>();
  subscribe(listener: Listener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(event: AgentRuntimeEvent): void { for (const listener of this.listeners) listener(event); }
  listSessions(): AgentSession[] { return [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt); }
  getSession(id: string): AgentSession | undefined { return this.sessions.get(id); }
  createSession(options: { agent: string | AgentConfig; projectRoot: string; worktree?: string; capabilities?: AgentCapability[]; metadata?: Record<string, string>; sessionId?: string }): AgentSession {
    const config = typeof options.agent === "string" ? getAgent(options.agent) : options.agent;
    if (!config) throw new Error(`Unknown agent: ${typeof options.agent === "string" ? options.agent : options.agent.id}`);
    const id = options.sessionId ?? crypto.randomUUID(); const now = Date.now();
    const session: AgentSession = { id, agentId: config.id, agentName: config.name, projectRoot: options.projectRoot, worktree: options.worktree, state: "starting", startedAt: now, updatedAt: now, capabilities: new Set(options.capabilities ?? DEFAULT_CAPABILITIES), metadata: options.metadata };
    this.sessions.set(id, session); this.emit({ type: "session-created", session }); return session;
  }
  setState(sessionId: string, state: AgentSessionState, message?: string): void { const s = this.sessions.get(sessionId); if (!s) return; s.state = state; s.updatedAt = Date.now(); this.emit({ type: "session-state", sessionId, state, message }); }
  publish(sessionId: string, event: string, data?: unknown): void { const s = this.sessions.get(sessionId); if (!s) return; s.updatedAt = Date.now(); this.emit({ type: "session-event", sessionId, event, data }); }
  stopSession(sessionId: string): void { const s = this.sessions.get(sessionId); if (!s) return; s.state = "stopped"; s.updatedAt = Date.now(); this.emit({ type: "session-stopped", sessionId }); }
  removeSession(sessionId: string): void { this.sessions.delete(sessionId); }
  hasCapability(sessionId: string, capability: AgentCapability): boolean { return this.sessions.get(sessionId)?.capabilities.has(capability) ?? false; }
  setCapabilities(sessionId: string, capabilities: AgentCapability[]): void { const s = this.sessions.get(sessionId); if (!s) return; s.capabilities = new Set(capabilities); s.updatedAt = Date.now(); this.publish(sessionId, "capabilities-changed", capabilities); }
  resolveAgent(agentIdOrHint: string): AgentConfig | undefined {
    return getAgent(agentIdOrHint) ?? getAgents().find((agent) => agent.id === agentIdOrHint);
  }

  createLaunchPlan(options: {
    sessionId: string;
    agent: string | AgentConfig;
    cwd: string;
    prompt?: string;
    conversationId?: string;
    model?: string;
    context?: AgentArgContext;
    env?: Record<string, string>;
  }): AgentLaunchPlan {
    const config = typeof options.agent === "string" ? this.resolveAgent(options.agent) : options.agent;
    if (!config) throw new Error(`Unknown agent: ${typeof options.agent === "string" ? options.agent : options.agent.id}`);
    if (!config.hint) throw new Error(`Agent ${config.id} has no launch command`);
    return {
      sessionId: options.sessionId,
      agentId: config.id,
      command: config.hint,
      args: buildAgentArgs(config.id, options.sessionId, options.conversationId, options.prompt, options.model, options.context),
      cwd: options.cwd,
      env: options.env ?? {},
    };
  }
}
export const agentRuntime = new AgentRuntime();
export type { AgentRuntime };
