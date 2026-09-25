// Live "what is Andro doing" feed — receives events forwarded from Rust
// (andro_activity.rs, an SSE client of the user's local browser-agent-mcp
// server) and exposes them as ToolCallCard-ready entries.
//
// Browser Chat sessions own their activity history. A newly-created Chat session
// starts with an empty feed, while switching back restores that session's feed.
// Incoming activity is assigned to the currently active browser session.
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { BrowserToolCallEvent } from "../lib/browserAgent/types";
import { isActivityEvent, type ActivityEvent } from "../lib/androActivity/types";
import { activityEventToToolCall, mergeActivityEvent } from "../lib/androActivity/normalize";

type Listener = () => void;

class AndroActivityStore {
  private eventsBySession = new Map<string, Map<string, ActivityEvent>>();
  private activeSessionId: string | null = null;
  private listeners = new Set<Listener>();
  private snapshot: BrowserToolCallEvent[] = [];
  private unlisten: UnlistenFn | null = null;

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): BrowserToolCallEvent[] {
    return this.snapshot;
  }

  activateSession(sessionId: string): void {
    this.activeSessionId = sessionId;
    if (!this.eventsBySession.has(sessionId)) {
      this.eventsBySession.set(sessionId, new Map());
    }
    this.rebuildSnapshot();
  }

  closeSession(sessionId: string): void {
    this.eventsBySession.delete(sessionId);
    if (this.activeSessionId === sessionId) {
      this.activeSessionId = null;
      this.snapshot = [];
      this.notifyListeners();
    }
  }

  clearActiveSession(): void {
    if (!this.activeSessionId) return;
    this.eventsBySession.set(this.activeSessionId, new Map());
    this.rebuildSnapshot();
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) listener();
  }

  private rebuildSnapshot(): void {
    const events = this.activeSessionId
      ? this.eventsBySession.get(this.activeSessionId)
      : undefined;
    this.snapshot = events
      ? [...events.values()]
          .sort((a, b) => a.ts - b.ts)
          .map(activityEventToToolCall)
      : [];
    this.notifyListeners();
  }

  async start(): Promise<void> {
    if (this.unlisten) return;
    this.unlisten = await listen<string>("andro-activity", (evt) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(evt.payload);
      } catch {
        return;
      }
      // The server's ready sentinel is not a real activity event.
      if (!isActivityEvent(parsed) || !this.activeSessionId) return;

      let events = this.eventsBySession.get(this.activeSessionId);
      if (!events) {
        events = new Map();
        this.eventsBySession.set(this.activeSessionId, events);
      }

      // All lifecycle updates for one logical call share the same id.
      events.set(parsed.id, mergeActivityEvent(events.get(parsed.id), parsed));
      this.rebuildSnapshot();
    });
  }
}

export const androActivity = new AndroActivityStore();
