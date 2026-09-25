# Andro Agent (`browser-agent-mcp`)

Local coding tools over **Streamable HTTP MCP**, reachable from **browser ChatGPT / Claude.ai** through **Tailscale Funnel**.

The browser AI is the brain. This server is the hands (local files + shell). No model API key required.

CLI binary: **`andro-agent`** (alias: `browser-agent-mcp`).

## Quick install

```bash
# From a clone of this repo
cd browser-agent-mcp
npm install
npm --prefix ui install
npm run build
npm install -g .

# First-time setup
andro-agent init
andro-agent funnel on
andro-agent start
```

Daily use after that: **`andro-agent start`** only.

| Command | Purpose |
|---------|---------|
| `andro-agent init` | Create `~/.config/browser-agent-mcp/token` + `env` (detects MagicDNS) |
| `andro-agent start` | Run MCP on `127.0.0.1:8787` (foreground) |
| `andro-agent status` | Health + config summary |
| `andro-agent funnel on` | Funnel `/agent` + `/.well-known` → `:8787` |
| `andro-agent funnel off` | Turn Funnel HTTPS off |
| `andro-agent funnel status` | Show Funnel routes |

Connect ChatGPT with **OAuth** (or Claude with **Bearer**) to the URL printed by `init` / `funnel on`, usually:

```text
https://<your-magicdns>/agent/mcp
```

Paste the token from `~/.config/browser-agent-mcp/token` on the OAuth consent page (ChatGPT) or as the Bearer key (Claude).

Activity UI: `http://127.0.0.1:8787/activity` (same token).

### Optional: pack without a global link

```bash
npm run build
npm pack
npm install -g ./browser-agent-mcp-1.0.0.tgz
```

The tarball includes compiled server + activity UI under `dist/` (including `dist/ui`).

### Optional: systemd (user unit)

Point `ExecStart` at `andro-agent start` (or `node …/dist/cli.js start`) and set:

```ini
EnvironmentFile=%h/.config/browser-agent-mcp/env
```

The CLI also loads that env file itself on `start`.

---

## Tools

### Local files and shell

| Tool | Purpose |
|------|---------|
| `Read` | Read a file under the workspace |
| `Glob` | Find files by glob pattern |
| `Grep` | Search contents with ripgrep |
| `Write` | Create/overwrite a file |
| `Edit` | Exact string replace in a file |
| `Bash` | Run a shell command confined to the workspace |

### Indexed team context

Served from your own local Andromedia core, so one MCP client gets both the code
and the reasons behind it — `Grep` finds the call site, `andro_investigate`
explains why it changed (the ticket, the thread, the commit).

| Tool | Purpose |
|------|---------|
| `andro_investigate` | Grounded answer over indexed Slack / Notion / Jira / Linear / git / CRM |
| `andro_search` | Hybrid search across the indexed corpus |
| `andro_list_sources` | What is indexed, how much, and when it last synced |

Read-only. Requires the core API (`ANDRO_BASE_URL`,
default `http://localhost:8083`) and `ANDRO_SERVICE` (default `local`).

> **Why not one server?** The hosted Andromedia MCP runs in a container with no
> filesystem access — deliberately. These context tools therefore run from the
> *local* agent over plain HTTP, which keeps the remote surface read-only while
> still putting file access and context access in front of the same model.

Default workspace root: `~/Documents/GitHub` (`WORKSPACE_ROOT`).

---

### Bash confinement

`Bash` runs arbitrary shell strings, so validating the working directory alone
is **not** a jail — `cat /etc/passwd` does not care about `cwd`. Commands are
therefore wrapped in [`bwrap`](https://github.com/containers/bubblewrap):

| Inside the sandbox | Outside the sandbox |
|---|---|
| The workspace (read/write) | Everything else is unreachable |
| System paths `/usr`, `/bin`, `/lib`, `/etc` (read-only) | `$HOME` dotfiles, `~/.ssh`, other repos |
| A private `/tmp` | The MCP token file |
| `HOME` redirected to `<workspace>/.sandbox-home` | |

Networking is **not** isolated, so `npm install`, `git fetch` and test suites
that reach the network keep working. `node`, `git`, `npm` and friends are on
`PATH` regardless of how the server was started.

If `bwrap` is missing or cannot create user namespaces (some hardened hosts and
containers), `Bash` **refuses to run** rather than silently executing
unconfined. Install it with `apt install bubblewrap`, or set `SANDBOX_MODE=off`
to accept that `Bash` can read and write anything your user account can.

Check what's active at any time:

```bash
andro-agent status
```

> **Note:** `SANDBOX_MODE=off` is only reasonable when the whole machine is
> already the trust boundary (a throwaway VM). With it on, anyone holding the
> Funnel URL and token can run commands as you.

---

## Tailscale prerequisites

```bash
tailscale version
tailscale status
tailscale funnel status
```

Enable Funnel in the admin console if needed: [Tailscale Funnel docs](https://tailscale.com/kb/1223/funnel).

Find your MagicDNS name:

```bash
tailscale status --json | python3 -c 'import sys,json; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))'
```

`andro-agent init` fills `ALLOWED_HOSTS` and `PUBLIC_*` from this when Tailscale is available.

### Funnel paths (MCP only)

| Public path | Proxies to | Purpose |
|-------------|------------|---------|
| `/agent` | `http://127.0.0.1:8787` | MCP + OAuth + activity UI |
| `/.well-known` | `http://127.0.0.1:8787` | OAuth discovery for ChatGPT |

(`andro-agent funnel on` sets both. Omni on `/` → `:20128` is optional and separate.)

Equivalent manual commands:

```bash
tailscale funnel --bg --yes --set-path /agent http://127.0.0.1:8787
tailscale funnel --bg --yes --set-path /.well-known http://127.0.0.1:8787
tailscale funnel status
# off:
tailscale funnel --https=443 off
```

---

## Connect ChatGPT (OAuth)

1. ChatGPT → Settings → Apps & connectors (Developer Mode if required).
2. Add custom connector / MCP server.
3. **URL:** `https://<magicdns>/agent/mcp`
4. **Auth:** OAuth.
5. On authorize, paste `cat ~/.config/browser-agent-mcp/token`.
6. New chat → `@` connector → try a Glob/Read.

## Connect Claude.ai (Bearer)

1. Claude.ai → Connectors → Add custom connector.
2. URL: `https://<magicdns>/agent/mcp`
3. Auth: Bearer → same token file.
4. Save and use tools in a chat.

---

## Auth summary

| Client | How to authenticate |
|--------|---------------------|
| ChatGPT | OAuth → paste MCP token on consent page |
| Claude.ai | Bearer header = MCP token |
| Activity UI | Paste MCP token once (sessionStorage) |
| curl | `Authorization: Bearer $(cat ~/.config/browser-agent-mcp/token)` |

| File | Role |
|------|------|
| `~/.config/browser-agent-mcp/token` | Canonical token |
| `~/.config/browser-agent-mcp/env` | Loaded by CLI + systemd |
| `~/.config/browser-agent-mcp/oauth-store.json` | OAuth clients/tokens (auto) |

---

## Local smoke test

```bash
andro-agent status
curl -s http://127.0.0.1:8787/healthz

TOKEN=$(tr -d '\n' < ~/.config/browser-agent-mcp/token)
curl -s http://127.0.0.1:8787/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"1.0.0"}}}'
```

---

## Config

| Variable | Default | Meaning |
|----------|---------|---------|
| `HOST` | `127.0.0.1` | Bind address |
| `PORT` | `8787` | Local port |
| `WORKSPACE_ROOT` | `~/Documents/GitHub` | Path jail root |
| `MCP_AUTH_TOKEN` | from `token` file | Bearer + OAuth consent password |
| `PUBLIC_BASE_URL` | `http://127.0.0.1:8787/agent` until `init` | OAuth issuer prefix |
| `PUBLIC_MCP_URL` | `…/mcp` | MCP resource URL |
| `ALLOWED_HOSTS` | `127.0.0.1,localhost` (+ MagicDNS after `init`) | Host header allowlist |
| `BASH_TIMEOUT_MS` | `30000` | Bash tool timeout |
| `SANDBOX_MODE` | `auto` | `auto` confines Bash with bwrap; `off` disables confinement |
| `ANDRO_BASE_URL` | `http://localhost:8083` | Local Andromedia core API for the context tools |
| `ANDRO_SERVICE` | `local` | Default Andromedia service/workspace name |

### Tests

```bash
npm test        # node:test via tsx — sandbox escapes, path jail, auth
npm run typecheck
```

The sandbox tests execute real `bwrap` calls and assert that reading/writing
outside the workspace, reaching `$HOME`, and touching sibling directories all
fail. They skip loudly if `bwrap` is unavailable on the host.

### Security notes

Two independent layers, weakest link first:

1. **Sandbox** — Bash commands run in bwrap and cannot reach anything
   outside the workspace. Defends against the workspace not being the boundary.
2. **Auth** — bearer token on every surface. The token is accepted only via the
   `Authorization: Bearer` header or `x-api-key`, **not** `?token=`, because
   query strings leak into proxy and access logs.

There is **no approval step**: `Write`, `Edit` and `Bash` execute as soon as
the model calls them. The sandbox bounds where they can act, not whether they
run — review the activity feed if you need to know what was changed.

### Speed defaults (built-in)

- Glob max **100** paths; skips `node_modules`, `.git`, `dist`, caches, etc.
- Grep default **30** hits (max 100)
- Read default **250** lines (max 800) unless you pass `limit`
- Bash stdout/stderr truncated; default timeout **30s**

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Funnel missing `/.well-known` or `/agent` | `andro-agent funnel on` |
| ChatGPT connector create fails | Funnel public + well-known `curl` 200; use **OAuth** |
| Tools listed but disabled | ChatGPT Developer Mode + new chat; watch activity UI |
| `401` on MCP | Wrong token; re-check `token` / `env`, restart |
| Activity UI 503 | Rebuild package (`npm run build`) so `ui/dist` ships |
| MagicDNS wrong after rename | Re-run `andro-agent init` or edit `PUBLIC_*` + `ALLOWED_HOSTS` |

---

## Security notes

- Bound to localhost; Tailscale Funnel is the only public edge.
- Anyone with the Funnel URL **and** token can read/write your workspace.
- Rotate: `andro-agent init` keeps an existing token; replace `token` + `MCP_AUTH_TOKEN` in `env` to rotate, then reconnect clients.
- Do not commit `token`, `env`, or `oauth-store.json` to Git.
