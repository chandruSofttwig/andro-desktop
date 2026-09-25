//! Hidden ChatGPT browser-agent session.
//!
//! Tempest drives a real ChatGPT web session end-to-end: a child webview is
//! created on the main window (same primitive as Live Preview's
//! `embed_ide_panel` in `lib.rs`), immediately hidden, and never shown again
//! after the one-time login onboarding step. An `initialization_script` runs
//! at the start of every page load inside that webview (chatgpt.com's own SPA
//! navigations included — Tauri/WRY re-injects it on each navigation, so no
//! manual re-install bookkeeping is needed) and reads the conversation via
//! ChatGPT's own `/backend-api/conversation/<id>` API (same technique as the
//! actively-maintained `pionxzh/chatgpt-exporter` userscript — see
//! `RELAY_SCRIPT`'s doc comment), writing the latest state into
//! `window.__tempestState` / `window.__tempestPromptResult`.
//!
//! Getting that state OUT of the page deliberately does NOT use a `fetch()`
//! to anything OUTSIDE chatgpt.com's own origin: a cross-origin request
//! (e.g. to a local Tempest port) runs in the page's own JS realm and is
//! subject to ChatGPT's Content-Security-Policy `connect-src` directive,
//! which has no reason to allowlist it — the request is silently blocked by
//! the browser engine itself, not by anything Tempest controls, and no
//! transport swap (WebSocket included — CSP `connect-src` governs `ws:`
//! the same way) fixes that from inside the page. (Same-origin fetches TO
//! chatgpt.com's own API, as `RELAY_SCRIPT` now makes, are unaffected — CSP
//! virtually always allows a page to call its own origin.) Instead,
//! `start_polling` below periodically calls `Webview::eval_with_callback`
//! from the Rust side: a native "evaluate this JS and hand me the result"
//! IPC call between the UI process and the web process, not a network
//! request the page initiates — CSP has no say over it. The frontend
//! receives the result as a `browser-agent-relay` event.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Window};
use tauri::webview::cookie::{time::OffsetDateTime, Cookie};

const CHATGPT_URL: &str = "https://chatgpt.com/";

/// Webview label for a session's hidden ChatGPT child webview.
fn panel_id(session_id: &str) -> String {
    format!("browser-agent-{session_id}")
}

/// Same event/body shape the loopback-server path used to emit (see
/// `agent_hooks::BrowserAgentRelayEvent`) — the frontend's listener
/// (`src/store/browserAgentRuntime.ts`) is unchanged by this module now being
/// a poller instead of an HTTP receiver.
#[derive(Clone, serde::Serialize)]
struct BrowserAgentRelayEvent {
    session: String,
    body: String,
}

/// The relay script pulls conversation data from ChatGPT's OWN backend API
/// (`/api/auth/session` → access token → `/backend-api/conversation/<id>`)
/// rather than scraping rendered DOM/CSS — this is the same technique the
/// actively-maintained `pionxzh/chatgpt-exporter` userscript (2.7k GitHub
/// stars) uses, verified against its source. It's dramatically more robust
/// than guessing at class names like `.markdown`: the API returns the exact
/// message tree ChatGPT itself renders from, with explicit `author.role` and
/// `content.parts`, immune to CSS/markup churn. Both calls are same-origin
/// (chatgpt.com → chatgpt.com), so unlike the loopback-server `fetch()` this
/// module used to make (blocked by ChatGPT's CSP — see the module doc
/// comment above), these are NOT blocked: a page's CSP `connect-src`
/// virtually always allows same-origin requests, since the page needs them
/// for its own operation.
///
/// DOM access is still used for the two things it's legitimately good for:
/// login detection (composer presence) and streaming detection (stop-button
/// presence) — both cheap, synchronous, and not meaningfully improved by an
/// API round-trip.
const RELAY_SCRIPT: &str = r#"
(function () {
  if (window.__tempestRelayInstalled) return;
  window.__tempestRelayInstalled = true;

  function getChatId() {
    const m = location.pathname.match(/\/c\/([a-f0-9-]+)/i);
    return m ? m[1] : null;
  }

  // Cached for a minute so a 2s poll tick doesn't refetch the session token
  // every time — ChatGPT's own session cookie/token churn is much slower
  // than that.
  let cachedToken = null;
  let cachedTokenAt = 0;
  function checkResponse(res, label) {
    if (res.ok) return;
    const error = new Error(label + " fetch failed: " + res.status);
    const retry = res.headers.get("Retry-After");
    const seconds = retry === null ? NaN : Number(retry);
    error.retryAfterMs = Number.isFinite(seconds)
      ? Math.max(0, seconds * 1000)
      : Math.max(0, Date.parse(retry || "") - Date.now()) || 0;
    error.status = res.status;
    throw error;
  }

  async function getAccessToken() {
    const now = Date.now();
    if (cachedToken && now - cachedTokenAt < 60000) return cachedToken;
    const res = await fetch("/api/auth/session");
    checkResponse(res, "session");
    const data = await res.json();
    if (!data || !data.accessToken) throw new Error("session had no accessToken");
    cachedToken = data.accessToken;
    cachedTokenAt = now;
    return cachedToken;
  }

  function contentText(content) {
    if (!content) return "";
    if (content.content_type === "text" && Array.isArray(content.parts)) {
      return content.parts.filter((p) => typeof p === "string").join("\n").trim();
    }
    if (content.content_type === "code" && typeof content.text === "string") return content.text.trim();
    return "";
  }

  async function fetchConversationData() {
    const chatId = getChatId();
    if (!chatId) return { messages: [], toolCalls: [], apiOk: true, noActiveChat: true };

    const token = await getAccessToken();
    const res = await fetch("/backend-api/conversation/" + chatId, {
      headers: { Authorization: "Bearer " + token },
    });
    checkResponse(res, "conversation");
    const data = await res.json();
    const mapping = data.mapping || {};

    // Walk the parent chain from current_node back to the root, then
    // reverse — this is the actual linear conversation order (the mapping
    // itself is an unordered id → node dict, a tree, not a list, since
    // ChatGPT supports branching/regeneration).
    const chain = [];
    let curId = data.current_node;
    let guard = 0;
    while (curId && mapping[curId] && guard < 2000) {
      chain.push(mapping[curId]);
      curId = mapping[curId].parent;
      guard += 1;
    }
    chain.reverse();

    // Tool-call activity is NOT extracted here (deliberately, as of this
    // rewrite): ChatGPT's API only shows its own built-in browser/python
    // tool invocations, never a custom MCP connector's actual actions — the
    // user's real "what is Andro doing" signal is the browser-agent-mcp
    // server's own activity stream, consumed directly by Tempest's Rust
    // side (see `andro_activity.rs`), which carries real file paths,
    // command output, etc. that ChatGPT's conversation API never exposes.
    // This function only needs the chat text.
    const messages = [];
    for (const node of chain) {
      const msg = node.message;
      if (!msg || !msg.content) continue;
      const role = msg.author.role;
      if (role !== "user" && role !== "assistant") continue;
      if (msg.recipient && msg.recipient !== "all") continue; // tool invocation, not a chat turn
      if (msg.metadata && msg.metadata.is_visually_hidden_from_conversation) continue;
      const text = contentText(msg.content);
      if (!text) continue;
      // `create_time` (seconds since epoch, per ConversationNodeMessage) is
      // ChatGPT's own real timestamp for this turn — used instead of "when
      // Tempest happened to observe it" so this channel's timeline position
      // stays correct relative to the independently-timed andro-activity
      // SSE stream (poll vs. push cadences drift; only real event times
      // stay consistently ordered against each other).
      const createTimeMs = typeof msg.create_time === "number" ? Math.round(msg.create_time * 1000) : Date.now();
      messages.push({ id: msg.id || node.id, role, text: text.slice(0, 20000), createTimeMs });
    }
    return { messages: messages.slice(-200), toolCalls: [], apiOk: true };
  }

  function isStreaming() {
    return !!document.querySelector("button[data-testid='stop-button'], button[aria-label*='Stop']");
  }

  // The composer only exists once ChatGPT has finished loading a signed-in
  // session (a logged-out visitor sees a login/signup screen, not the chat
  // UI at all). Used by the frontend to auto-detect login completion instead
  // of relying solely on the user clicking a confirm button that a docked
  // native webview can end up occluding.
  function isLoggedIn() {
    return !!document.querySelector("div#prompt-textarea[contenteditable], [contenteditable='true']#prompt-textarea, form [contenteditable='true']");
  }

  // DOM mutations update local status only; they never bypass the request budget.
  let scanning = false;
  let nextFetchAt = 0;
  let failures = 0;
  let cachedChatId = null;
  let lastData = { messages: [], toolCalls: [] };
  let lastError = null;

  function publish() {
    window.__tempestState = {
      ...lastData, streaming: isStreaming(), loggedIn: isLoggedIn(),
      apiOk: lastError === null && lastData.apiOk === true,
      ...(lastError ? { error: lastError, retryAt: nextFetchAt } : {}),
    };
  }

  async function scan() {
    const chatId = getChatId();
    if (chatId !== cachedChatId) {
      cachedChatId = chatId;
      lastData = { messages: [], toolCalls: [] };
      // Navigation may refresh immediately, but must respect a failure cooldown.
      if (!failures) nextFetchAt = 0;
    }
    publish();
    if (scanning || Date.now() < nextFetchAt || !chatId || !isLoggedIn()) return;
    scanning = true;
    nextFetchAt = Date.now() + 15000;
    try {
      const data = await fetchConversationData();
      if (getChatId() === chatId) lastData = data;
      failures = 0;
      lastError = null;
      nextFetchAt = Date.now() + (isStreaming() ? 15000 : 60000);
    } catch (e) {
      failures += 1;
      const base = e.status === 429 ? 60000 : 15000;
      const backoff = Math.min(300000, base * Math.pow(2, Math.min(failures - 1, 5)));
      nextFetchAt = Math.ceil(Date.now() + Math.max(backoff, e.retryAfterMs || 0) + Math.random() * 1000);
      lastError = String((e && e.message) || e);
      if (e.status === 401) cachedToken = null;
    } finally {
      scanning = false;
      publish();
    }
  }

  // `initialization_script` runs at document-start (WRY injects it before
  // the DOM is parsed, so pages get it before their own scripts run) —
  // `document.body` does not exist yet at that point. Calling
  // `observer.observe(document.body, ...)` unconditionally would throw on
  // the null body and crash the entire IIFE right there, before ever
  // reaching `scan()` or `setInterval` below — which would silently mean
  // NOTHING in this script ever runs, with zero signal anywhere that this
  // happened. Deferring setup to DOMContentLoaded (or running immediately if
  // body already exists, e.g. on a same-document SPA re-injection) is the
  // fix.
  function startObserving() {
    let debounce = null;
    const observer = new MutationObserver(() => {
      clearTimeout(debounce);
      debounce = setTimeout(scan, 220);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    // Poll fallback in case the SPA swaps document.body or mutations are missed.
    setInterval(scan, 2000);
    scan();
  }

  if (document.body) {
    startObserving();
  } else {
    document.addEventListener("DOMContentLoaded", startObserving, { once: true });
  }
})();
"#;

/// Read back on each Rust-side poll tick — see module doc comment.
///
/// Deliberately NOT `JSON.stringify(...)`'d here: `eval_with_callback`
/// already serializes the script's return VALUE to JSON itself (WRY calls
/// `js_value().to_json()` on whatever this expression evaluates to). Adding
/// our own `JSON.stringify` on top meant the callback received a JSON string
/// of a JSON string — which then parsed in Rust as `Value::String(...)`, not
/// an object, so `.get("scrape")` always returned `None` and nothing was
/// ever emitted. The parens make this an object-literal expression rather
/// than a block statement (bare `{` at the start of a script is ambiguous).
const POLL_SCRIPT: &str =
    "({ scrape: window.__tempestState || null, promptResult: window.__tempestPromptResult || null })";

/// Off-window position for the hidden webview before `.hide()` takes effect
/// on the current platform (hide() is synchronous on most backends, but this
/// keeps a brief flash from ever landing over visible UI either way).
const OFFSCREEN: (f64, f64) = (-10000.0, -10000.0);
const DEFAULT_SIZE: (f64, f64) = (1200.0, 900.0);

/// Stop-flags for each session's polling thread, keyed by session id.
/// `destroy_browser_agent` flips the flag; the thread notices within one
/// poll interval and exits on its own rather than being force-killed.
static POLLERS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();

fn pollers() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    POLLERS.get_or_init(|| Mutex::new(HashMap::new()))
}

// Real tool-call activity now arrives push-based over SSE (andro_activity.rs)
// rather than riding on this poll — this only needs to catch message text
// and login/streaming state changing, none of which need sub-second
// latency. Relaxed from an original 700ms now that it isn't also the
// tool-call channel's only update path.
const POLL_INTERVAL: Duration = Duration::from_millis(1500);

/// Periodically reads `window.__tempestState`/`window.__tempestPromptResult`
/// out of the hidden webview via `eval_with_callback` (see module doc
/// comment for why this — not a page-initiated request — is the mechanism)
/// and re-emits each as a `browser-agent-relay` event whenever it changes,
/// matching exactly what the old HTTP-relay path used to emit so the
/// frontend listener needs no changes.
fn start_polling(app: AppHandle, window: Window, session_id: String) {
    let stop = Arc::new(AtomicBool::new(false));
    pollers().lock().unwrap().insert(session_id.clone(), stop.clone());

    std::thread::spawn(move || {
        let mut last_scrape = String::new();
        let mut last_prompt_result = String::new();
        loop {
            if stop.load(Ordering::Relaxed) {
                break;
            }
            std::thread::sleep(POLL_INTERVAL);
            if stop.load(Ordering::Relaxed) {
                break;
            }
            let Some(webview) = window.get_webview(&panel_id(&session_id)) else {
                break; // webview closed out from under us — nothing left to poll
            };

            let (tx, rx) = std::sync::mpsc::channel::<String>();
            if webview.eval_with_callback(POLL_SCRIPT, move |result| { let _ = tx.send(result); }).is_err() {
                continue;
            }
            let Ok(raw) = rx.recv_timeout(Duration::from_secs(2)) else { continue };
            let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) else { continue };

            if let Some(scrape) = parsed.get("scrape").filter(|v| !v.is_null()) {
                let text = scrape.to_string();
                if text != last_scrape {
                    last_scrape = text.clone();
                    let _ = app.emit("browser-agent-relay", BrowserAgentRelayEvent { session: session_id.clone(), body: text });
                }
            }
            if let Some(prompt_result) = parsed.get("promptResult").filter(|v| !v.is_null()) {
                let text = prompt_result.to_string();
                if text != last_prompt_result {
                    last_prompt_result = text.clone();
                    let body = serde_json::json!({ "promptResult": prompt_result }).to_string();
                    let _ = app.emit("browser-agent-relay", BrowserAgentRelayEvent { session: session_id.clone(), body });
                }
            }
        }
        pollers().lock().unwrap().remove(&session_id);
    });
}

fn stop_polling(session_id: &str) {
    if let Some(stop) = pollers().lock().unwrap().get(session_id) {
        stop.store(true, Ordering::Relaxed);
    }
}

#[tauri::command]
pub async fn spawn_browser_agent(window: Window, session_id: String) -> Result<(), String> {
    let url = url::Url::parse(CHATGPT_URL).map_err(|e| e.to_string())?;

    let builder = tauri::WebviewBuilder::new(&panel_id(&session_id), tauri::WebviewUrl::External(url))
        .initialization_script(RELAY_SCRIPT);

    let webview = window
        .add_child(
            builder,
            LogicalPosition::new(OFFSCREEN.0, OFFSCREEN.1),
            LogicalSize::new(DEFAULT_SIZE.0, DEFAULT_SIZE.1),
        )
        .map_err(|e| e.to_string())?;
    webview.hide().map_err(|e| e.to_string())?;

    start_polling(window.app_handle().clone(), window, session_id);
    Ok(())
}

/// One-time onboarding only: brings the hidden session on-screen so the user
/// can log in. Callers must pair this with `hide_browser_agent` once the user
/// confirms they're signed in — nothing here re-hides automatically.
#[tauri::command]
pub async fn show_browser_agent_for_login(
    window: Window,
    session_id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let webview = window
        .get_webview(&panel_id(&session_id))
        .ok_or_else(|| "browser-agent session not found".to_string())?;
    webview
        .set_position(LogicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    webview
        .set_size(LogicalSize::new(width, height))
        .map_err(|e| e.to_string())?;
    webview.show().map_err(|e| e.to_string())?;
    webview.set_focus().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn hide_browser_agent(window: Window, session_id: String) -> Result<(), String> {
    let webview = window
        .get_webview(&panel_id(&session_id))
        .ok_or_else(|| "browser-agent session not found".to_string())?;
    // Belt-and-suspenders: some WRY/webkit2gtk combinations have had
    // unreliable child-webview `set_visible(false)` behavior on Linux, so
    // don't rely on `.hide()` alone. Shrinking to near-zero size AND moving
    // off-screen means even a visibility toggle that silently no-ops can't
    // leave anything covering the app.
    webview
        .set_size(LogicalSize::new(1.0, 1.0))
        .map_err(|e| e.to_string())?;
    webview
        .set_position(LogicalPosition::new(OFFSCREEN.0, OFFSCREEN.1))
        .map_err(|e| e.to_string())?;
    webview.hide().map_err(|e| e.to_string())
}

/// Finds the user's default Firefox profile's `cookies.sqlite`, the same
/// source andro-UI's `import-auth.mjs` reads from (Google OAuth refuses to
/// run inside an embedded/automated webview at all, so a fresh login there is
/// a dead end — importing an already-authenticated session cookie from a
/// real browser is the only path that works for a Google-backed ChatGPT
/// account, and it also means Firefox users never have to type credentials
/// into the hidden webview to begin with).
///
/// Profile discovery: `profiles.ini` lists each profile under a
/// `[Profile*]`/`[Install*]` section with `Path=` (`IsRelative=1` unless
/// noted) and marks exactly one `Default=1`. Falls back to the newest
/// `*.default*` directory if parsing finds nothing, since profiles.ini's
/// format has drifted across Firefox releases and this only needs to be
/// "right in practice," not spec-complete.
fn find_firefox_cookies_db() -> Option<std::path::PathBuf> {
    let base = super::global_home().join(".mozilla").join("firefox");
    let ini_path = base.join("profiles.ini");
    if let Ok(ini) = std::fs::read_to_string(&ini_path) {
        let mut path: Option<String> = None;
        let mut is_relative = true;
        let mut is_default = false;
        let mut best: Option<(String, bool)> = None;
        let flush = |path: &Option<String>, is_relative: bool, is_default: bool, best: &mut Option<(String, bool)>| {
            if let Some(p) = path {
                if is_default || best.is_none() {
                    *best = Some((p.clone(), is_relative));
                }
            }
        };
        for line in ini.lines() {
            let line = line.trim();
            if line.starts_with('[') {
                flush(&path, is_relative, is_default, &mut best);
                path = None;
                is_relative = true;
                is_default = false;
                continue;
            }
            if let Some(v) = line.strip_prefix("Path=") {
                path = Some(v.to_string());
            } else if let Some(v) = line.strip_prefix("IsRelative=") {
                is_relative = v.trim() == "1";
            } else if let Some(v) = line.strip_prefix("Default=") {
                is_default = v.trim() == "1";
            }
        }
        flush(&path, is_relative, is_default, &mut best);
        if let Some((p, relative)) = best {
            let dir = if relative { base.join(&p) } else { std::path::PathBuf::from(&p) };
            let db = dir.join("cookies.sqlite");
            if db.exists() {
                return Some(db);
            }
        }
    }

    // profiles.ini missing/unparsable — fall back to the newest *.default* dir.
    let entries = std::fs::read_dir(&base).ok()?;
    entries
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().contains("default"))
        .filter_map(|e| {
            let db = e.path().join("cookies.sqlite");
            let modified = std::fs::metadata(&db).ok()?.modified().ok()?;
            Some((db, modified))
        })
        .max_by_key(|(_, m)| *m)
        .map(|(db, _)| db)
}

#[derive(Debug)]
struct FirefoxCookie {
    name: String,
    value: String,
    host: String,
    path: String,
    expiry: i64,
    is_secure: bool,
    is_http_only: bool,
}

/// Firefox holds `cookies.sqlite` open (and may be actively writing to it) if
/// running, so read from a copy rather than the live file to avoid a locked
/// or torn read.
fn read_firefox_chatgpt_cookies() -> Result<Vec<FirefoxCookie>, String> {
    let db_path = find_firefox_cookies_db()
        .ok_or_else(|| "no Firefox profile with a cookies.sqlite was found".to_string())?;

    let tmp_dir = std::env::temp_dir();
    let tmp_path = tmp_dir.join(format!("tempest-ff-cookies-{}.sqlite", std::process::id()));
    std::fs::copy(&db_path, &tmp_path).map_err(|e| format!("failed to read Firefox cookie store: {e}"))?;

    let conn = rusqlite::Connection::open_with_flags(&tmp_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| e.to_string());
    let result = (|| -> Result<Vec<FirefoxCookie>, String> {
        let conn = conn?;
        let mut stmt = conn
            .prepare(
                "SELECT name, value, host, path, expiry, isSecure, isHttpOnly \
                 FROM moz_cookies WHERE host LIKE '%chatgpt.com%'",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(FirefoxCookie {
                    name: row.get(0)?,
                    value: row.get(1)?,
                    host: row.get(2)?,
                    path: row.get(3)?,
                    expiry: row.get(4)?,
                    is_secure: row.get::<_, i64>(5)? != 0,
                    is_http_only: row.get::<_, i64>(6)? != 0,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    })();

    let _ = std::fs::remove_file(&tmp_path);
    result
}

#[tauri::command]
pub async fn import_browser_agent_cookies_firefox(
    window: Window,
    session_id: String,
) -> Result<u32, String> {
    let webview = window
        .get_webview(&panel_id(&session_id))
        .ok_or_else(|| "browser-agent session not found".to_string())?;

    let cookies = read_firefox_chatgpt_cookies()?;
    if cookies.is_empty() {
        return Err("no chatgpt.com cookies found in Firefox — sign in to ChatGPT in Firefox first".to_string());
    }

    let mut imported = 0u32;
    for c in &cookies {
        let mut builder = Cookie::build((c.name.clone(), c.value.clone()))
            .domain(c.host.clone())
            .path(c.path.clone())
            .secure(c.is_secure)
            .http_only(c.is_http_only);
        // expiry == 0 means a Firefox session cookie (no persistent
        // expiration) — leave it as a session cookie rather than inventing
        // a date. A past expiry would just make set_cookie delete it.
        if c.expiry > 0 {
            if let Ok(dt) = OffsetDateTime::from_unix_timestamp(c.expiry) {
                builder = builder.expires(dt);
            }
        }
        if webview.set_cookie(builder.build()).is_ok() {
            imported += 1;
        }
    }

    // Cookies alone don't retroactively apply to whatever's already loaded —
    // reload so chatgpt.com re-requests with the imported session attached.
    let _ = webview.reload();
    Ok(imported)
}

#[tauri::command]
pub async fn destroy_browser_agent(window: Window, session_id: String) -> Result<(), String> {
    stop_polling(&session_id);
    if let Some(webview) = window.get_webview(&panel_id(&session_id)) {
        webview.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Starts a fresh ChatGPT conversation: navigates the hidden webview back to
/// the bare chatgpt.com root (no `/c/<id>` in the URL), which is what
/// prompts ChatGPT itself to begin a new chat on the next message. Frontend
/// state (the message/tool-call timeline) is cleared separately by the
/// caller — this command only owns the actual browser session.
#[tauri::command]
pub async fn new_browser_agent_chat(window: Window, session_id: String) -> Result<(), String> {
    let webview = window
        .get_webview(&panel_id(&session_id))
        .ok_or_else(|| "browser-agent session not found".to_string())?;
    let url = url::Url::parse(CHATGPT_URL).map_err(|e| e.to_string())?;
    webview.navigate(url).map_err(|e| e.to_string())
}

/// Injects text into ChatGPT's ProseMirror composer and submits it.
/// `document.execCommand('insertText', ...)` is the only method ProseMirror
/// (a contenteditable-based editor, not a `<textarea>`) reliably honors —
/// setting `.value`/`.textContent` directly leaves its internal state
/// desynced from what's rendered. Status is written to
/// `window.__tempestPromptResult` (not posted — see module doc comment) and
/// picked up by the same poller that reads scrape state.
#[tauri::command]
pub async fn send_prompt_to_browser_agent(
    window: Window,
    session_id: String,
    text: String,
) -> Result<(), String> {
    let webview = window
        .get_webview(&panel_id(&session_id))
        .ok_or_else(|| "browser-agent session not found".to_string())?;

    let encoded = serde_json::to_string(&text).map_err(|e| e.to_string())?;
    let script = format!(
        r#"
(function () {{
  function findSendButton(box) {{
    const scope = box && box.closest("form") || document;
    // ChatGPT also renders a labelled submit button without the test ID.
    return scope.querySelector("button[data-testid='send-button']")
      || scope.querySelector("button[type='submit'][aria-label='Send']");
  }}
  function report(ok, reason) {{
    window.__tempestPromptResult = {{ ok, reason: reason || null, ts: Date.now() }};
  }}

  const COMPOSER_SELECTOR = "div#prompt-textarea[contenteditable], [contenteditable='true']#prompt-textarea, form [contenteditable='true']";

  function typeAndSend(box) {{
    box.focus();
    document.execCommand("selectAll", false, null);
    document.execCommand("insertText", false, {text});
    setTimeout(() => {{
      if (!box.textContent || box.textContent.trim().length === 0) {{
        return report(false, "text did not land in composer");
      }}
      let tries = 0;
      const poll = setInterval(() => {{
        const btn = findSendButton(box);
        tries += 1;
        if (btn && !btn.disabled && btn.getAttribute("aria-disabled") !== "true") {{
          clearInterval(poll);
          btn.click();
          setTimeout(() => {{
            const cleared = !box.textContent || box.textContent.trim().length === 0;
            report(cleared, cleared ? null : "composer did not clear after send");
          }}, 300);
        }} else if (tries > 40) {{
          clearInterval(poll);
          report(false, btn ? "send button never enabled" : "send button not found");
        }}
      }}, 100);
    }}, 60);
  }}

  // Retry composer lookup for a few seconds rather than failing on the first
  // miss — a single synchronous check right when the user hits send can
  // catch the page mid-transition (e.g. just after a reload from cookie
  // import) even though the composer mounts moments later. A message that
  // actually reaches ChatGPT despite a reported "composer not found" is this
  // race: the earlier attempt gave up before the composer appeared, and
  // nothing here was retrying it.
  let findTries = 0;
  const findComposer = setInterval(() => {{
    const box = document.querySelector(COMPOSER_SELECTOR);
    findTries += 1;
    if (box) {{
      clearInterval(findComposer);
      typeAndSend(box);
    }} else if (findTries > 25) {{
      clearInterval(findComposer);
      report(false, "composer not found");
    }}
  }}, 200);
}})();
"#,
        text = encoded,
    );

    webview.eval(&script).map_err(|e| e.to_string())
}
