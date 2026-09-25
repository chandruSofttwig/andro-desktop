import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { BrowserToolCallEvent } from "../lib/browserAgent/types";
import { agentRuntime, type AgentSession } from "../lib/agentRuntime";
import { normalizeRelayPayload } from "../lib/browserAgent/normalize";
import { androActivity } from "./androActivity";
import type {
  BrowserAgentSessionState,
  BrowserMessageEvent,
  RawRelayPayload,
} from "../lib/browserAgent/types";

interface BrowserAgentRelayEvent {
  session: string;
  body: string;
}

export interface BrowserAgentSessionSnapshot {
  id: string;
  name: string;
  state: BrowserAgentSessionState;
  messages: BrowserMessageEvent[];
  toolCalls: BrowserToolCallEvent[];
  loggedInDetected: boolean | null;
  lastPromptResult: { ok: boolean; reason: string | null } | null;
  relayTickCount: number;
  lastRelayAt: number | null;
  lastRawScrapeBody: string | null;
  createdAt: number;
}

export interface BrowserAgentSnapshot {
  activeSessionId: string | null;
  sessions: BrowserAgentSessionSnapshot[];
  state: BrowserAgentSessionState;
  toolCalls: BrowserToolCallEvent[];
  messages: BrowserMessageEvent[];
  loggedInDetected: boolean | null;
  lastPromptResult: { ok: boolean; reason: string | null } | null;
  relayTickCount: number;
  lastRelayAt: number | null;
  lastRawScrapeBody: string | null;
}

interface BrowserSessionRecord {
  id: string;
  agentSession: AgentSession;
  name: string;
  state: BrowserAgentSessionState;
  toolCalls: Map<string, BrowserToolCallEvent>;
  messages: Map<string, BrowserMessageEvent>;
  lastPromptResult: { ok: boolean; reason: string | null } | null;
  loggedInDetected: boolean | null;
  relayTickCount: number;
  lastRelayAt: number | null;
  lastRawScrapeBody: string | null;
  pendingOptimisticIds: Set<string>;
  createdAt: number;
}

type Listener = () => void;

class BrowserAgentRuntime {
  private activeSessionId: string | null = null;
  private sessions = new Map<string, BrowserSessionRecord>();
  private listeners = new Set<Listener>();
  private unlisten: UnlistenFn | null = null;
  private snapshot: BrowserAgentSnapshot = {
    activeSessionId: null,
    sessions: [],
    state: "idle",
    toolCalls: [],
    messages: [],
    loggedInDetected: null,
    lastPromptResult: null,
    relayTickCount: 0,
    lastRelayAt: null,
    lastRawScrapeBody: null,
  };

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): BrowserAgentSnapshot {
    return this.snapshot;
  }

  getSessionId(): string | null {
    return this.activeSessionId;
  }

  getSessions(): BrowserAgentSessionSnapshot[] {
    return this.snapshot.sessions;
  }

  private makeSessionSnapshot(s: BrowserSessionRecord): BrowserAgentSessionSnapshot {
    return {
      id: s.id,
      name: s.name,
      state: s.state,
      messages: [...s.messages.values()],
      toolCalls: [...s.toolCalls.values()],
      loggedInDetected: s.loggedInDetected,
      lastPromptResult: s.lastPromptResult,
      relayTickCount: s.relayTickCount,
      lastRelayAt: s.lastRelayAt,
      lastRawScrapeBody: s.lastRawScrapeBody,
      createdAt: s.createdAt,
    };
  }

  private notify(): void {
    const sessions = [...this.sessions.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((s) => this.makeSessionSnapshot(s));
    const active = this.activeSessionId ? this.sessions.get(this.activeSessionId) : undefined;

    this.snapshot = {
      activeSessionId: this.activeSessionId,
      sessions,
      state: active?.state ?? "idle",
      toolCalls: active ? [...active.toolCalls.values()] : [],
      messages: active ? [...active.messages.values()] : [],
      loggedInDetected: active?.loggedInDetected ?? null,
      lastPromptResult: active?.lastPromptResult ?? null,
      relayTickCount: active?.relayTickCount ?? 0,
      lastRelayAt: active?.lastRelayAt ?? null,
      lastRawScrapeBody: active?.lastRawScrapeBody ?? null,
    };

    for (const listener of this.listeners) listener();
  }

  private async ensureListening(): Promise<void> {
    if (this.unlisten) return;
    this.unlisten = await listen<BrowserAgentRelayEvent>("browser-agent-relay", (evt) => {
      const session = this.sessions.get(evt.payload.session);
      if (!session) return;
      this.handleRelay(session, evt.payload.body);
    });
  }

  private handleRelay(session: BrowserSessionRecord, body: string): void {
    let parsed: RawRelayPayload;
    try {
      parsed = JSON.parse(body);
    } catch {
      return;
    }

    session.relayTickCount += 1;
    session.lastRelayAt = Date.now();

    if ("promptResult" in parsed) {
      session.lastPromptResult = parsed.promptResult;
      agentRuntime.publish(session.id, "browser-prompt-result", parsed.promptResult);
      this.notify();
      return;
    }

    session.lastRawScrapeBody = body;
    const normalized = normalizeRelayPayload(parsed);
    if (!normalized) {
      this.notify();
      return;
    }

    for (const toolCall of normalized.toolCalls) session.toolCalls.set(toolCall.id, toolCall);

    for (const message of normalized.messages) {
      if (message.role === "user" && session.pendingOptimisticIds.size > 0) {
        for (const optimisticId of session.pendingOptimisticIds) {
          const optimistic = session.messages.get(optimisticId);
          if (optimistic && optimistic.text === message.text) {
            session.messages.delete(optimisticId);
            session.pendingOptimisticIds.delete(optimisticId);
            break;
          }
        }
      }

      session.messages.set(message.id, message);

      if (message.role === "user" && session.name.startsWith("Chat ")) {
        const title = message.text.trim().replace(/\s+/g, " ");
        if (title) session.name = title.slice(0, 48) + (title.length > 48 ? "…" : "");
      }
    }

    session.loggedInDetected = normalized.loggedIn;
    agentRuntime.publish(session.id, "browser-tool-call", normalized.toolCalls);
    agentRuntime.publish(session.id, "browser-message", normalized.messages);
    this.notify();
  }

  private createRecord(): BrowserSessionRecord {
    const agentSession = agentRuntime.createSession({
      agent: {
        id: "browser-agent",
        name: "ChatGPT (browser)",
        hint: "",
        iconSrc: "",
        sessionIdArgs: null,
        resumeArgs: null,
      },
      projectRoot: "",
      capabilities: ["browser"],
    });

    const number = this.sessions.size + 1;
    return {
      id: agentSession.id,
      agentSession,
      name: `Chat ${number}`,
      state: "starting",
      toolCalls: new Map(),
      messages: new Map(),
      lastPromptResult: null,
      loggedInDetected: null,
      relayTickCount: 0,
      lastRelayAt: null,
      lastRawScrapeBody: null,
      pendingOptimisticIds: new Set(),
      createdAt: Date.now(),
    };
  }

  async start(): Promise<string> {
    if (this.activeSessionId && this.sessions.has(this.activeSessionId)) {
      androActivity.activateSession(this.activeSessionId);
      await androActivity.start();
      return this.activeSessionId;
    }

    if (this.sessions.size > 0) {
      const first = [...this.sessions.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
      this.activeSessionId = first.id;
      androActivity.activateSession(first.id);
      await androActivity.start();
      this.notify();
      return first.id;
    }

    return this.createNewSession();
  }

  async createNewSession(): Promise<string> {
    await this.ensureListening();

    const session = this.createRecord();
    this.sessions.set(session.id, session);
    this.activeSessionId = session.id;
    androActivity.activateSession(session.id);
    this.notify();

    try {
      await androActivity.start();
      await invoke("spawn_browser_agent", { sessionId: session.id });
      session.state = "active";
      agentRuntime.setState(session.id, "working");
    } catch (e) {
      session.state = "error";
      agentRuntime.setState(session.id, "error", String(e));
    }

    this.notify();
    return session.id;
  }

  async activate(sessionId: string): Promise<void> {
    if (!this.sessions.has(sessionId)) return;
    this.activeSessionId = sessionId;
    androActivity.activateSession(sessionId);
    this.notify();
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    try {
      await invoke("destroy_browser_agent", { sessionId });
    } catch {
      // best-effort teardown
    }

    agentRuntime.stopSession(sessionId);
    agentRuntime.removeSession(sessionId);
    this.sessions.delete(sessionId);
    androActivity.closeSession(sessionId);

    if (this.activeSessionId === sessionId) {
      const next = [...this.sessions.values()].sort((a, b) => b.createdAt - a.createdAt)[0];
      this.activeSessionId = next?.id ?? null;
      if (this.activeSessionId) androActivity.activateSession(this.activeSessionId);
    }

    this.notify();
  }

  async stop(): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map((id) => this.closeSession(id)));
    this.activeSessionId = null;
    this.notify();
  }

  private active(): BrowserSessionRecord {
    if (!this.activeSessionId) throw new Error("browser-agent session not started");
    const session = this.sessions.get(this.activeSessionId);
    if (!session) throw new Error("active browser-agent session not found");
    return session;
  }

  async showForLogin(rect: { x: number; y: number; width: number; height: number }): Promise<void> {
    await invoke("show_browser_agent_for_login", { sessionId: this.active().id, ...rect });
  }

  async hideAfterLogin(): Promise<void> {
    await invoke("hide_browser_agent", { sessionId: this.active().id });
  }

  async importCookiesFromFirefox(): Promise<number> {
    return invoke<number>("import_browser_agent_cookies_firefox", { sessionId: this.active().id });
  }

  async newChatInActiveSession(): Promise<void> {
    await invoke("new_browser_agent_chat", { sessionId: this.active().id });
    const session = this.active();
    session.messages.clear();
    session.toolCalls.clear();
    session.lastPromptResult = null;
    session.lastRawScrapeBody = null;
    session.pendingOptimisticIds.clear();
    androActivity.clearActiveSession();
    session.name = `Chat ${this.sessions.size}`;
    this.notify();
  }

  async sendPrompt(text: string): Promise<void> {
    const session = this.active();
    const id = `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    session.messages.set(id, {
      id,
      role: "user",
      text,
      streaming: false,
      timestamp: Date.now(),
    });
    session.pendingOptimisticIds.add(id);
    this.notify();
    await invoke("send_prompt_to_browser_agent", { sessionId: session.id, text });
  }
}

export const browserAgentRuntime = new BrowserAgentRuntime();
