import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Send, Power, LogIn, Cookie, ExternalLink, Plus, X, MessageSquare } from "lucide-react";
import { browserAgentRuntime } from "../store/browserAgentRuntime";
import { androActivity } from "../store/androActivity";
import { useSettings, updateSetting } from "../store/appSettings";
import { BrowserAgentTimeline } from "./BrowserAgentTimeline/BrowserAgentTimeline";
import "./BrowserAgentPage.css";

const CHATGPT_URL = "https://chatgpt.com/";

function useBrowserAgentState() {
  return useSyncExternalStore(
    (cb) => browserAgentRuntime.subscribe(cb),
    () => browserAgentRuntime.getSnapshot(),
  );
}

function useAndroActivityToolCalls() {
  return useSyncExternalStore(
    (cb) => androActivity.subscribe(cb),
    () => androActivity.getSnapshot(),
  );
}

type SignInMode = "idle" | "external" | "internal";

export function BrowserAgentPage() {
  const {
    activeSessionId,
    sessions,
    state,
    messages,
    loggedInDetected,
    lastPromptResult,
    relayTickCount,
    lastRelayAt,
    lastRawScrapeBody,
  } = useBrowserAgentState();
  const androToolCalls = useAndroActivityToolCalls();
  const [showRaw, setShowRaw] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<SignInMode>("idle");
  const loginRectRef = useRef<HTMLDivElement>(null);
  const autoFinishedRef = useRef(false);
  const loggedIn = useSettings().browserAgentLoggedIn;
  const [cookieImportStatus, setCookieImportStatus] = useState<string | null>(null);
  let syncWarning: string | null = null;
  if (lastRawScrapeBody) {
    try {
      const relay = JSON.parse(lastRawScrapeBody);
      if (typeof relay.error === "string") {
        const retry = typeof relay.retryAt === "number" && Number.isFinite(relay.retryAt)
          ? ` Automatic retry scheduled for ${new Date(relay.retryAt).toLocaleTimeString()}.`
          : " Waiting for the connection to recover.";
        syncWarning = (relay.error.includes("429")
          ? "ChatGPT is rate-limiting conversation updates."
          : "Conversation updates are temporarily unavailable.") + retry
          + " Previous messages are preserved. Command activity uses a separate connection.";
      }
    } catch { /* A malformed diagnostic payload must not interrupt the chat. */ }
  }

  useEffect(() => {
    if (!activeSessionId) void browserAgentRuntime.start();
  }, [activeSessionId]);

  useEffect(() => {
    if (mode !== "internal") return;
    autoFinishedRef.current = false;
    const rect = loginRectRef.current?.getBoundingClientRect();
    void browserAgentRuntime.showForLogin({
      x: rect?.left ?? 40,
      y: rect?.top ?? 40,
      width: rect?.width ?? 900,
      height: rect?.height ?? 700,
    });
  }, [mode]);

  async function finishSignIn() {
    try {
      await browserAgentRuntime.hideAfterLogin();
    } catch (e) {
      console.error("[browser-agent] hide after login failed", e);
    }
    updateSetting("browserAgentLoggedIn", true);
    setMode("idle");
    setCookieImportStatus(null);
  }

  useEffect(() => {
    if (mode === "idle" || loggedInDetected !== true || autoFinishedRef.current) return;
    autoFinishedRef.current = true;
    void finishSignIn();
  }, [mode, loggedInDetected]); // eslint-disable-line react-hooks/exhaustive-deps

  async function signInExternally() {
    setMode("external");
    autoFinishedRef.current = false;
    try {
      await openUrl(CHATGPT_URL);
    } catch (e) {
      console.error("[browser-agent] failed to open external browser", e);
    }
  }

  async function importFromFirefox() {
    setCookieImportStatus("Importing…");
    try {
      const count = await browserAgentRuntime.importCookiesFromFirefox();
      setCookieImportStatus(`Imported ${count} cookie${count === 1 ? "" : "s"} — checking sign-in…`);
    } catch (e) {
      setCookieImportStatus(String(e));
    }
  }

  async function createSession() {
    setMode("idle");
    setCookieImportStatus(null);
    await browserAgentRuntime.createNewSession();
  }

  async function switchSession(id: string) {
    setMode("idle");
    setCookieImportStatus(null);
    await browserAgentRuntime.activate(id);
  }

  async function closeSession(event: React.MouseEvent, id: string) {
    event.stopPropagation();
    await browserAgentRuntime.closeSession(id);
  }

  async function send() {
    const text = prompt.trim();
    if (!text || !activeSessionId) return;
    setPrompt("");
    try {
      await browserAgentRuntime.sendPrompt(text);
    } catch (e) {
      console.error("[browser-agent] send failed", e);
    }
  }

  return (
    <div className="browser-agent-page">
      <div className="browser-agent-header">
        <div className="browser-agent-title">
          <MessageSquare size={14} />
          <span>ChatGPT Agent</span>
          <span className={`browser-agent-status browser-agent-status--${state}`}>{state}</span>
        </div>
        <div className="browser-agent-header-actions">
          <button className="browser-agent-new-session-btn" onClick={() => void createSession()} title="New ChatGPT session">
            <Plus size={13} />
            New session
          </button>
          {mode !== "idle" ? (
            <button className="browser-agent-login-btn" onClick={() => void finishSignIn()}>
              <Power size={13} />
              Done
            </button>
          ) : !loggedIn && (
            <button className="browser-agent-login-btn" onClick={() => void signInExternally()}>
              <LogIn size={13} />
              Sign in to ChatGPT
            </button>
          )}
        </div>
      </div>

      <div className="browser-agent-sessions" role="tablist" aria-label="ChatGPT sessions">
        {sessions.map((session) => (
          <button
            key={session.id}
            className={`browser-agent-session-tab${session.id === activeSessionId ? " browser-agent-session-tab--active" : ""}`}
            onClick={() => void switchSession(session.id)}
            role="tab"
            aria-selected={session.id === activeSessionId}
            title={session.name}
          >
            <span className={`browser-agent-session-dot browser-agent-session-dot--${session.state}`} />
            <span className="browser-agent-session-name">{session.name}</span>
            {sessions.length > 1 && (
              <span
                className="browser-agent-session-close"
                onClick={(event) => void closeSession(event, session.id)}
                title="Close session"
              >
                <X size={11} />
              </span>
            )}
          </button>
        ))}
      </div>

      {mode === "external" && (
        <div className="browser-agent-external-panel">
          <ExternalLink size={22} />
          <p>ChatGPT just opened in your browser. Sign in there as usual, then come back here.</p>
          <button className="browser-agent-login-confirm" onClick={() => void importFromFirefox()}>
            <Cookie size={13} />
            I've signed in — import my session
          </button>
          {cookieImportStatus && <div className="browser-agent-onboarding-note">{cookieImportStatus}</div>}
          <button className="browser-agent-link-btn" onClick={() => setMode("internal")}>
            Not using Firefox? Sign in inside Tempest instead
          </button>
        </div>
      )}

      {mode === "internal" && (
        <>
          {!loggedIn && (
            <div className="browser-agent-onboarding-note">
              A ChatGPT window is now visible below — sign in and it'll return here automatically, or click "Done" above whenever you're ready.
            </div>
          )}
          <div className="browser-agent-login-rect" ref={loginRectRef} />
          <button className="browser-agent-login-confirm" onClick={() => void finishSignIn()}>
            <Power size={13} />
            I'm signed in — hide this
          </button>
        </>
      )}

      {mode === "idle" && !loggedIn && (
        <div className="browser-agent-onboarding-note">
          First-time setup: sign in to ChatGPT once. Tempest opens it in your default browser — each Tempest ChatGPT session reuses that authenticated browser context.
        </div>
      )}

      {mode === "idle" && (
        <>
          <BrowserAgentTimeline key={activeSessionId} toolCalls={androToolCalls} messages={messages} />
          {lastPromptResult && lastPromptResult.ok === false && (
            <div className="browser-agent-warning">
              Last message may not have reached ChatGPT: {lastPromptResult.reason ?? "unknown reason"}
            </div>
          )}
          <div className="browser-agent-composer">
            <input
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void send(); }}
              placeholder={activeSessionId ? `Message ${sessions.find((s) => s.id === activeSessionId)?.name ?? "ChatGPT"}…` : "Message ChatGPT…"}
              disabled={!loggedIn || state !== "active"}
            />
            <button onClick={() => void send()} disabled={!loggedIn || state !== "active" || !prompt.trim()}>
              <Send size={14} />
            </button>
          </div>
          <div className="browser-agent-diagnostics">
            {relayTickCount === 0
              ? "No activity received yet from the active ChatGPT session."
              : `${relayTickCount} update${relayTickCount === 1 ? "" : "s"} received — last ${lastRelayAt ? new Date(lastRelayAt).toLocaleTimeString() : "?"}.`}
            {lastRawScrapeBody && (
              <button className="browser-agent-link-btn" onClick={() => setShowRaw((s) => !s)}>
                {showRaw ? "hide raw" : "show raw"}
              </button>
            )}
          </div>
          {syncWarning && <div className="browser-agent-diagnostics" role="status">{syncWarning}</div>}
          {showRaw && lastRawScrapeBody && (
            <pre className="browser-agent-raw-debug">{lastRawScrapeBody}</pre>
          )}
        </>
      )}
    </div>
  );
}
