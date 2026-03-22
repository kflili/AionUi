# CLI & Desktop App Chat History Storage Reference

**Date:** 2026-03-19 (updated 2026-03-20)
**Purpose:** Research findings on how each CLI/app stores conversation history. Reference for the CLI History Integration plan and Knowledge Consolidation plan.

---

## Summary

Every CLI and desktop app stores conversation history as **JSONL or JSON files** on disk. AionUI is the only one using SQLite for conversation content.

| App/Mode | Storage Format | History Location |
|----------|---------------|-----------------|
| Claude Code CLI | JSONL | `~/.claude/projects/{path-hash}/{session-id}.jsonl` |
| Claude Desktop — Code mode | JSONL | `~/Library/Application Support/Claude/claude-code-sessions/{account}/{org}/` |
| Claude Desktop — Cowork mode | JSONL | `~/Library/Application Support/Claude/local-agent-mode-sessions/{account}/{org}/{vm}/{session}/audit.jsonl` |
| Claude Desktop — Chat mode | Server-side | Stored on claude.ai, not locally |
| Copilot CLI | JSONL | `~/.copilot/session-state/{session-id}/events.jsonl` |
| Codex CLI | JSONL | `~/.codex/sessions/YYYY/MM/DD/rollout-{date}-{session-id}.jsonl` |
| Gemini CLI | JSON | `~/.gemini/tmp/{project-hash}/chats/session-{timestamp}-{id}.json` |
| Google Antigravity (VS Code) | Protobuf (.pb) | `~/.gemini/antigravity/conversations/{id}.pb` (NOT Gemini CLI) |
| **AionUI** | **SQLite only** | `~/Library/Application Support/AionUi/aionui/aionui.db` |

---

## JSON vs JSONL

| | JSON | JSONL (JSON Lines) |
|---|---|---|
| Structure | One big JSON object/array per file | One JSON object **per line**, newline-delimited |
| Write pattern | Must rewrite entire file on every update | Append one line to end of file |
| Read pattern | Parse entire file to access any part | Can stream line-by-line, or read specific lines |
| Crash safety | Crash during rewrite = corrupted file | Crash mid-append = lose only last incomplete line |
| Memory | Must hold full document in memory to write | Only need current event in memory |
| File size scaling | Rewrites get slower as file grows (O(n) per write) | Appends stay constant time (O(1) per write) |
| Human readability | Nicely formatted with indentation | One dense JSON object per line |
| Tool compatibility | `jq`, any JSON parser | `grep`, `head`, `tail`, `wc -l`, `jq` per line |
| Example | `{"messages": [{"role": "user", ...}, ...]}` | `{"role": "user", ...}\n{"role": "assistant", ...}\n` |

**JSONL is the clear winner for streaming agent conversations** because each event (user message, tool call, response chunk) can be appended as it happens with zero overhead. JSON requires loading + modifying + rewriting the whole file for every new event.

---

## Why Every CLI Uses JSONL (Not JSON, Not SQLite)

Research from multiple sources including Gemini CLI issue #15292 benchmarks:

### Performance (Gemini CLI benchmarks)
- **Standard payloads:** JSON rewrite ~1.07ms vs JSONL append ~0.04ms (**25x faster**)
- **Large payloads (~50KB):** JSON rewrite ~17.88ms vs JSONL append ~0.17ms (**100x faster**)
- **400MB session file:** JSON rewrite ~6.8 seconds vs JSONL append ~0.75ms (**9,000x faster**)

### Crash Safety
Each JSONL line is independently valid. If the process crashes mid-write, all previous lines remain intact. With JSON, a crash during full-file rewrite can corrupt the entire conversation.

### Memory Efficiency
JSON rewrite requires holding the entire serialized conversation in memory. Gemini CLI observed "Mark-Compact GC thrashing and OOM crashes with >4GB heap usage." JSONL never loads the full file to write.

### Event-Sourcing Architecture
Each JSONL line is an immutable event. Session state is reconstructed by replaying events. This enables session resumption, conversation branching (via parent IDs), sub-agent hierarchies, and session forking.

### Zero Dependencies
No database runtime, no schema migrations. Read with `cat`, search with `grep`, process with `jq`. Maximum portability.

### Key Insight
> "JSONL is the write-path optimization; SQLite is the read-path optimization. For a coding agent, the write path (streaming events) is the hot path."

Several CLIs (Copilot, Codex) use SQLite as a **complementary index** alongside JSONL files — JSONL for the conversation content, SQLite for fast listing/searching across sessions.

---

## Detailed Findings

### Claude Code CLI

- Sessions: `~/.claude/projects/{path-hash}/{session-id}.jsonl`
- Index: `~/.claude/projects/{path-hash}/sessions-index.json`
- Global history: `~/.claude/history.jsonl`
- 172 sessions found on this Mac

### Claude Desktop — Code mode

- Sessions: `~/Library/Application Support/Claude/claude-code-sessions/{account-id}/{org-id}/`
- Managed by: `LocalSessionManager`
- **Separate from CLI** — does NOT share `~/.claude/` with the CLI
- Same Claude Code binary (bundled at `claude-code/2.1.78/claude.app`) but different session storage
- Note: directory didn't exist on this Mac (Code mode not yet used in Desktop)

### Claude Desktop — Cowork mode

- Sessions: `~/Library/Application Support/Claude/local-agent-mode-sessions/{account-id}/{org-id}/{vm-id}/`
- Managed by: `LocalAgentModeSessionManager`
- Each session has:
  - `local_{session-id}.json` — metadata (title, model, cwd, initialMessage)
  - `local_{session-id}/audit.jsonl` — full conversation (user messages, assistant responses, tool calls)
  - `local_{session-id}/.claude/projects/.../{cli-session-id}.jsonl` — Claude Code JSONL inside the VM's own `.claude/` directory
  - `local_{session-id}/outputs/` — files produced by the agent
- Runs inside a sandboxed Linux VM (`vm_bundles/claudevm.bundle`)
- Working directory inside VM: `/sessions/{process-name}` (e.g., `/sessions/quirky-tender-curie`)
- 2 sessions found on this Mac

### Claude Desktop — Chat mode

- Stored on Anthropic's servers (claude.ai)
- Local storage is only IndexedDB cache (~300K) and LevelDB session refs
- Shared with web version at claude.ai

### Copilot CLI

- Sessions: `~/.copilot/session-state/{session-id}/events.jsonl`
- Index: `~/.copilot/session-store.db` (SQLite — metadata only)
- Each session directory also contains:
  - `workspace.yaml` — project context
  - `session.db` — session-level SQLite
  - `checkpoints/`, `files/`, `research/`, `rewind-snapshots/`
- Logs: `~/.copilot/logs/process-{timestamp}-{pid}.log`

### Codex CLI

- Sessions: `~/.codex/sessions/YYYY/MM/DD/rollout-{date}-{session-id}.jsonl`
- Index: `~/.codex/state_5.sqlite` (SQLite — `threads` table with metadata)
- Global history: `~/.codex/history.jsonl` (user prompts only)
- Logs: `~/.codex/logs_1.sqlite` (SQLite)
- Also has: `memories/`, `skills/`, `shell_snapshots/`

### Gemini CLI

- Sessions: `~/.gemini/tmp/{project-hash}/chats/session-{timestamp}-{id}.json`
- Checkpoints: `~/.gemini/tmp/{project-hash}/checkpoints/checkpoint-{tag}.json`
- Logs: `~/.gemini/tmp/{project-hash}/logs.json`
- Format: **Plain JSON** (not JSONL) — uses `JSON.stringify(conversation, null, 2)`
- Source: `packages/core/src/services/chatRecordingService.ts`
- **Note:** Uses JSON full-rewrite, not JSONL append. Issue #15292 proposed switching to JSONL with benchmarks showing 25-9000x performance improvement. As of this writing, still uses JSON.
- **Important:** The `.pb` (protobuf) files at `~/.gemini/antigravity/conversations/` are from **Google Antigravity** (Google's VS Code fork), NOT Gemini CLI. They share the `~/.gemini/` directory but are completely separate products.

### Google Antigravity (VS Code fork — NOT Gemini CLI)

- Conversations: `~/.gemini/antigravity/conversations/{id}.pb` (Protocol Buffers — binary)
- Not human-readable, requires protobuf schema to decode
- Not open source in the same way as Gemini CLI
- Shares `~/.gemini/` config directory with Gemini CLI but uses separate storage

### AionUI

- All data: `~/Library/Application Support/AionUi/aionui/aionui.db` (SQLite via better-sqlite3)
- Tables: `conversations` (id, name, type, extra, status, created_at), `messages` (id, conversation_id, msg_id, type, content, position, created_at), `configs`
- Schema version: 15, WAL mode enabled
- **History:** AionUI originally used file-based storage (base64-encoded JSON in `.txt` files). Migrated to SQLite around late 2025 due to issues with deletion, search, and data corruption. Auto-migration code exists in `initStorage.ts`.
- No JSONL files — conversations are not readable by CLI agents via file path
- Agent can query via: `sqlite3 "~/Library/Application Support/AionUi/aionui/aionui.db" "SELECT content FROM messages WHERE conversation_id='{id}' ORDER BY created_at"`
- **Related issue #717** (open): "Built-in session history browser and search — leverage local Claude Code session data." Requests reading Claude Code's JSONL files from AionUI's UI.

---

## Cross-Platform Path Reference

All paths above are macOS. For cross-platform implementations:

| CLI | macOS | Linux | Windows |
|-----|-------|-------|---------|
| Claude Code | `~/.claude/` | `~/.claude/` | `%USERPROFILE%\.claude\` |
| Copilot | `~/.copilot/` | `~/.copilot/` | `%USERPROFILE%\.copilot\` |
| Codex | `~/.codex/` | `~/.codex/` | `%USERPROFILE%\.codex\` |
| Gemini | `~/.gemini/` | `~/.gemini/` | `%USERPROFILE%\.gemini\` |
| AionUI | `~/Library/Application Support/AionUi/` | `~/.config/AionUi/` | `%APPDATA%\AionUi\` |
| Claude Desktop | `~/Library/Application Support/Claude/` | `~/.config/Claude/` | `%APPDATA%\Claude\` |

Use `os.homedir()` for `~` expansion. For Electron app data paths, use `electron.app.getPath('appData')`.

---

## Key Observations

1. **JSONL is the industry standard** for CLI agent conversation history — Claude Code, Copilot, Codex all use it
2. **Gemini CLI is the exception** — uses JSON (full-rewrite), not JSONL. A community issue (#15292) with benchmarks proposes switching to JSONL
3. **SQLite is used for indexes**, not conversation content (Copilot, Codex both have SQLite indexes alongside JSONL files)
4. **Claude Desktop Code mode and CLI do NOT share history** — separate directories despite using the same binary
5. **Cowork mode has nested `.claude/` directories** — the VM runs its own Claude Code instance which creates its own JSONL history inside the session directory
6. **All file-based histories are directly readable by CLI agents** — AionUI's SQLite is the only one requiring a `sqlite3` shell command instead of a simple file read
7. **AionUI migrated FROM files TO SQLite** — the opposite direction from industry consensus, driven by GUI-specific needs (deletion, search, concurrent access)
8. **CLI switching costs are deceptive** — switching the raw model/CLI binary is easy, but switching the workflow ecosystem is not. Hooks, skills, memory stores, auth setup, team habits, session history, and editor integrations create real lock-in. Individual users can multi-home across CLIs; teams/orgs tend to standardize on one or two.
9. **Provider-native indexes exist** — Claude Code has `sessions-index.json`, Copilot has `session-store.db`, Codex has `state_5.sqlite`. Use these for session discovery/listing instead of scanning full JSONL files.

---

## Three Approaches to Desktop UI ↔ CLI Communication

### Approach 1: Claude Desktop — Proprietary IPC + PTY

> **Note:** The following is based on reverse-engineering Claude Desktop's minified Electron bundle (app.asar). These are inferred internals, not officially documented by Anthropic.

```
Main Process                              Renderer
┌──────────────────────────┐    IPC     ┌──────────────┐
│ node-pty → spawns CLI    │ ──────→    │ claude.ai    │
│ parses terminal output   │ ←──────    │ React UI     │
│ LocalSessions API        │            │ from server  │
└──────────────────────────┘            └──────────────┘
```

- **How CLI is spawned:** PTY (fake terminal) — CLI thinks it's in a real terminal, outputs ANSI text
- **What CLI outputs:** Terminal text (colors, TUI formatting, escape codes)
- **Who parses output:** Main process has a custom parser that converts terminal text → structured messages
- **Renderer:** claude.ai web app loaded from Anthropic's servers (NOT local code)
- **Protocol:** Proprietary `LocalSessions` API with methods like `start`, `sendMessage`, `setModel`, `setEffort`, `shareSession`
- **Works with other CLIs?** No — parser is specific to Claude Code's output format
- **Why this approach?** Anthropic controls both CLI and Desktop, shipped before ACP existed, `--experimental-acp` flag not yet stable enough for production

### Approach 2: AionUI — ACP (Agent Communication Protocol) over stdio

```
Main Process                              Renderer
┌──────────────────────────┐    IPC     ┌──────────────┐
│ child_process.spawn      │ ──────→    │ Local React  │
│ CLI with --acp --stdio   │ ←──────    │ components   │
│ forwards JSON-RPC msgs   │            │ (bundled)    │
└──────────────────────────┘            └──────────────┘
```

- **How CLI is spawned:** `child_process.spawn` with piped stdio (NOT PTY — no fake terminal needed)
- **What CLI outputs:** Structured JSON-RPC messages (the CLI itself formats its output as JSON)
- **Who parses output:** Nobody — output is already structured. AionUI just forwards it
- **Renderer:** Local React components bundled with the app
- **Protocol:** ACP = JSON-RPC 2.0 over stdio, with standard method names:
  - `session/new` — create session
  - `session/prompt` — send user message
  - `session/update` — CLI streams back tool calls, response chunks
  - `request_permission` — CLI asks user to approve a tool call
- **Works with other CLIs?** Yes — any CLI that supports `--acp` flag (Claude Code, Copilot, Codex, Qwen, Goose, 17+ backends)
- **ACP is NOT invented by AionUI.** It's JSON-RPC 2.0 over stdio, co-developed with Zed and JetBrains as the main public standardizers. Multiple CLIs adopted it. AionUI built a generic client supporting all of them. Claude Code's flag is `--experimental-acp`, Copilot's is `--acp --stdio`, Goose's is `goose acp`.

### Approach 3: Terminal Wrapper — PTY + xterm.js

```
Main Process                              Renderer
┌──────────────────────────┐    IPC     ┌──────────────┐
│ node-pty → spawns CLI    │ ──────→    │ xterm.js     │
│ forwards raw PTY bytes   │ ←──────    │ (terminal    │
│ no parsing               │            │  emulator)   │
└──────────────────────────┘            └──────────────┘
```

- **How CLI is spawned:** PTY (fake terminal) — CLI outputs full terminal experience
- **What CLI outputs:** Raw terminal bytes (ANSI escape codes, colors, TUI)
- **Who parses output:** Nobody — xterm.js renders the raw bytes as a terminal
- **Renderer:** xterm.js terminal emulator embedded in the page
- **Protocol:** Raw PTY bytes — `xterm.onData → pty.write` / `pty.onData → xterm.write`
- **Works with other CLIs?** Yes — any CLI that runs in a terminal
- **Trade-off:** Works with everything, but no structured UI (no expandable tool cards, no permission dialogs — just raw text)

### Comparison

| | Claude Desktop | AionUI (ACP) | Terminal wrapper |
|---|---|---|---|
| How CLI is spawned | PTY | child_process (piped stdio) | PTY |
| What CLI outputs | Terminal text (ANSI) | Structured JSON-RPC | Terminal text (ANSI) |
| Who parses output | Main process (custom) | Nobody — already structured | Nobody — render raw |
| Renderer | claude.ai webview (server) | Local React components | xterm.js |
| Structured tool cards | Yes | Yes | No |
| Works with other CLIs | No (proprietary) | Yes (open protocol) | Yes (any CLI) |
| Expandable details | Yes | Yes | No |
| Permission dialogs | Custom UI | Native UI dialogs | Type Y/N in terminal |

### Why ACP is the cleanest architecture

ACP pushes the structuring work to the CLI itself. The desktop app doesn't need to parse terminal output (fragile) or implement a proprietary protocol (vendor lock-in). The CLI says "here's a tool call, here's the result, here's my response" in a machine-readable format. The UI just renders it.

The trade-off: the CLI must support ACP. Not all CLIs do (yet). That's why the terminal wrapper mode (Approach 3) is proposed as an option in AionUI for CLIs that don't support ACP — see `2026-03-19-terminal-wrapper-mode.md`.

---

## Sources

- [Gemini CLI Issue #15292: Switch to JSONL for chat session storage](https://github.com/google-gemini/gemini-cli/issues/15292) — benchmarks
- [Gemini CLI Issue #5101: Automatic Chat Session Logging](https://github.com/google-gemini/gemini-cli/issues/5101)
- [Gemini CLI source: chatRecordingService.ts](https://github.com/google-gemini/gemini-cli) — JSON storage implementation
- [Codex CLI Session/Rollout Files Discussion](https://github.com/openai/codex/discussions/3827)
- [Claude Code System Architecture — DeepWiki](https://deepwiki.com/anthropics/claude-code/1.1-system-architecture)
- [Why Claude Code Feels So Stable — Milvus Blog](https://milvus.io/blog/why-claude-code-feels-so-stable-a-developers-deep-dive-into-its-local-storage-design.md)
- [AionUI Issue #717: Built-in session history browser](https://github.com/iOfficeAI/AionUi/issues/717)
- [AionUI Issue #75: Chat history deletion](https://github.com/iOfficeAI/AionUi/issues/75)
- [Coding Agent Session Search (11+ providers)](https://github.com/Dicklesworthstone/coding_agent_session_search)
