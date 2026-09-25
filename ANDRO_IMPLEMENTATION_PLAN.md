# Andro IDE Implementation Plan

## Phase 0 — IDE Foundation
- [x] Establish Tempest as the base repository
- [x] Confirm React + Tauri + Rust architecture
- [x] Confirm editor, terminal, Git/worktree and diff infrastructure
- [x] Start Andro implementation plan tracking
- [x] Change desktop product/window branding to Andro
- [ ] Replace remaining visible Tempest branding
- [ ] Establish Andro-specific theme/branding
- [ ] Verify desktop build

## Phase 1 — Agent Runtime
- [x] Agent registry
- [x] Agent manifests/configuration
- [x] Unified agent session model
- [x] Process launch plan / lifecycle contract
- [x] Unified agent event model
- [x] Permission/capability model
- [x] Agent hook events bridged into the runtime

## Phase 2 — Claude Code
- [x] Detect/configure Claude Code manifest
- [x] Launch/session adapter through unified Agent Runtime
- [x] Terminal integration through existing PTY
- [x] Lifecycle event integration through Claude hooks
- [x] Workspace/worktree integration
- [ ] Skills integration
- [ ] Browser capability
- [x] Claude hook self-checks and TypeScript validation

## Phase 3 — OpenCode
- [x] OpenCode adapter
- [x] Session/process integration
- [x] Terminal/event/worktree integration
- [ ] Skills integration
- [ ] Browser capability

## Phase 4 — Agy Code
- [x] Determine local CLI/API contract
- [x] Agy Code adapter
- [x] Session/process integration
- [x] Terminal/event/worktree integration
- [ ] Skills integration
- [ ] Browser capability

## Phase 5 — Andro Agent
- [ ] Native Andro agent runtime
- [ ] Code intelligence tools
- [ ] Context builder
- [ ] Search/index integration
- [ ] Browser/terminal/filesystem tools

## Phase 6 — Browser Runtime
- [ ] Browser session manager
- [ ] Navigate
- [ ] Click/type/scroll
- [ ] DOM/page extraction
- [ ] Screenshot
- [ ] Localhost support
- [ ] Per-agent browser sessions

## Phase 7 — Skills
- [ ] Global skills directory
- [ ] Project `.andro/skills`
- [ ] `SKILL.md` parser/loader
- [ ] Skills UI
- [ ] Enable/disable
- [ ] Agent/project assignment
- [ ] Skill precedence rules

## Phase 8 — Multi-Agent Workspace
- [ ] Multiple simultaneous agent sessions
- [ ] Independent worktrees
- [ ] Independent terminals
- [ ] Agent cards/tabs
- [ ] Start/pause/resume/stop controls

## Phase 9 — Unified Activity Stream
- [ ] Agent lifecycle events
- [ ] File read/write events
- [ ] Search events
- [ ] Terminal events
- [ ] Browser events
- [ ] Git events
- [ ] Errors/completion

## Phase 10 — Andro Intelligence
- [ ] Code indexing
- [ ] Symbol graph
- [ ] BM25
- [ ] Vector search
- [ ] Hybrid search/RRF
- [ ] Context builder

## Phase 11 — Permissions
- [ ] Filesystem permissions
- [ ] Terminal permissions
- [ ] Browser/network permissions
- [ ] Git push/commit permissions
- [ ] Package installation permissions
- [ ] Approval UI

## Phase 12 — End-to-End Testing
- [ ] Agent lifecycle tests
- [ ] Browser tests
- [ ] Skills tests
- [ ] Parallel-agent tests
- [ ] Worktree isolation tests
- [ ] Crash/recovery tests
