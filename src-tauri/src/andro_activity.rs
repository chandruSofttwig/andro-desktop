//! Live activity stream from the user's local `browser-agent-mcp` server
//! ("Andro Agent") — the actual MCP server ChatGPT calls (via ChatGPT's
//! connector support) to run Read/Write/Edit/Grep/Bash and indexed-context
//! tools against the user's workspace. This is a fundamentally better source
//! of "what is Andro doing" than anything inferable from ChatGPT's own
//! conversation API: ChatGPT's API only shows its own built-in
//! browser/python tool calls, not custom MCP connector invocations, and
//! even where it does, it never carries this server's own args/output
//! detail (file paths, diffs, command output).
//!
//! The server already runs as a long-lived daemon (confirmed via systemd
//! user service on this machine) exposing a Server-Sent-Events endpoint at
//! `http://127.0.0.1:8787/activity/events`, Bearer-token authenticated. This
//! module is a plain client of an already-running service — it never starts
//! or manages the server process itself, matching `agent_hooks.rs`'s
//! best-effort posture: if the service isn't running (or the token can't be
//! found), this degrades to silently retrying rather than breaking anything.
//!
//! Token discovery order: `~/.config/browser-agent-mcp/token` (the file the
//! server itself writes), then `MCP_AUTH_TOKEN=` in
//! `~/.config/browser-agent-mcp/env`.
//!
//! Event shape (from the server's `src/activity-bus.ts`, `ActivityEvent`):
//! `{ id, ts, tool, status: "started"|"progress"|"ok"|"error", argsSummary,
//! paths, args?, durationMs?, error?, output?, outputType?, progress? }`.
//! Forwarded to the frontend verbatim (as the raw JSON text) via an
//! `andro-activity` event — normalization into Tempest's own types happens
//! in TS (`src/lib/androActivity/normalize.ts`), same split of
//! responsibility as `agent_hooks.rs`'s hook payloads.

use std::io::BufRead;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const ACTIVITY_URL: &str = "http://127.0.0.1:8787/activity/events";
const MAX_BACKOFF: Duration = Duration::from_secs(15);

fn read_token_file() -> Option<String> {
    let path = super::global_home()
        .join(".config")
        .join("browser-agent-mcp")
        .join("token");
    std::fs::read_to_string(path).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn read_token_from_env_file() -> Option<String> {
    let path = super::global_home()
        .join(".config")
        .join("browser-agent-mcp")
        .join("env");
    let contents = std::fs::read_to_string(path).ok()?;
    for line in contents.lines() {
        if let Some(v) = line.trim().strip_prefix("MCP_AUTH_TOKEN=") {
            let v = v.trim();
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    None
}

fn find_token() -> Option<String> {
    read_token_file().or_else(read_token_from_env_file)
}

/// Connects to the activity SSE stream and forwards each real event to the
/// frontend. Blocks the calling thread for the life of one connection;
/// callers loop this with backoff. Returns normally (to be retried) on any
/// connection error — never panics, since this runs unsupervised on a
/// background thread for the app's whole lifetime.
fn run_one_connection(app: &AppHandle, token: &str) {
    let result = ureq::get(ACTIVITY_URL)
        .set("Authorization", &format!("Bearer {token}"))
        .set("Accept", "text/event-stream")
        .call();

    let response = match result {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[andro-activity] connect failed: {e}");
            return;
        }
    };

    let reader = std::io::BufReader::new(response.into_reader());
    for line in reader.lines() {
        let Ok(line) = line else { break }; // stream ended or errored — reconnect
        // The server sends exactly one `data: <json>` line per event
        // (JSON.stringify never emits raw newlines) followed by a blank
        // line, plus periodic `: ping <ts>` comment lines as a heartbeat —
        // only `data:` lines carry real events.
        let Some(payload) = line.strip_prefix("data: ") else { continue };
        // The `{"type":"ready",...}` sentinel isn't a real ActivityEvent —
        // let the frontend's normalizer decide what to do with it rather
        // than filtering here, matching the reference client's own
        // `isActivityEvent()` guard living on the consumer side.
        let _ = app.emit("andro-activity", payload.to_string());
    }
}

/// Starts the reconnect-with-backoff loop on a background thread. Idempotent
/// posture matches `agent_hooks::start`: best-effort, never blocks app
/// startup, never surfaces a hard failure if the MCP server isn't running —
/// it just keeps retrying, so starting the server later (or fixing the
/// token) picks up automatically without restarting Tempest.
pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let mut backoff = Duration::from_secs(1);
        loop {
            match find_token() {
                Some(token) => {
                    run_one_connection(&app, &token);
                    backoff = Duration::from_secs(1); // reset after any successful connect
                }
                None => {
                    eprintln!("[andro-activity] no browser-agent-mcp token found; retrying");
                }
            }
            std::thread::sleep(backoff);
            backoff = std::cmp::min(backoff * 2, MAX_BACKOFF);
        }
    });
}
