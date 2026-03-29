# AionUI — Backlog

Deferred features and improvements that are out of scope for current work but should be revisited.

---

## Terminal Wrapper Mode

### Auto-convert JSONL to TMessages in background (while in terminal mode)

**Source:** [terminal-wrapper/plan.md](./2026-03-19-terminal-wrapper/plan.md) (Performance: background pre-conversion)
**Status:** Blocked — needs spike
**Priority:** Nice-to-have (on-demand conversion on toggle is implemented as fallback)

Automatically convert CLI JSONL to TMessages after each CLI response completes while in terminal mode. This would make Terminal → Rich UI switches instant (messages already in SQLite) instead of requiring on-demand conversion on toggle.

**Why blocked:** "Response finished" detection in PTY mode is unreliable. There is no ACP signal — detection relies on heuristics like prompt string matching or PTY output idle timeout. These are fragile: programs can suppress prompts, custom PS1 strings vary, and long tool outputs can have natural pauses.

**Next step:** A spike must validate a reliable detection approach before building auto-convert infrastructure. Possible approaches to investigate:

- PTY output idle timeout (e.g., 2s of no output after a prompt-like pattern)
- CLI-specific prompt regex matching (per-backend patterns)
- Filesystem watch on the JSONL file (detect write bursts settling)

**Fallback (currently implemented):** On-demand conversion when user toggles Terminal → Rich UI.

---

### Shared `useAgentCliConfig()` hook

**Source:** Pre-PR review (Agent 5, finding #10)
**Status:** Deferred — works without it, cleanup only
**Priority:** Low

`ConfigStorage.get('agentCli.config')` is called independently in 9 places with separate `useEffect` + `useState` patterns. No shared hook means components don't sync when config changes while both are mounted.

**Fix:** Create `useAgentCliConfig()` hook with read + subscribe pattern (~20 lines), replace 9 call sites across 6 files. Straightforward refactor, ~30 min.

**Why deferred:** No user-facing bug. Each component reads config on mount which works for current usage. The only edge case (two views reading same config open simultaneously) is extremely unlikely.

---

### CLI `--resume` may skip middle conversation turns

**Source:** Manual testing of terminal wrapper mode
**Status:** Known limitation — not our bug
**Priority:** Awareness only

Claude Code CLI's `--resume` reconstructs conversation context in memory and may selectively display messages. In testing, middle-session turns were skipped in the terminal display (confirmed via GitHub issues [#14472](https://github.com/anthropics/claude-code/issues/14472), [#15837](https://github.com/anthropics/claude-code/issues/15837)). The model still "remembers" the full context — only the terminal display is affected.

**Impact:** When switching Rich UI → Terminal → Rich UI → Terminal, the terminal may not show all previous turns from earlier terminal sessions. Rich UI always shows the full history from SQLite.

**Mitigation (implemented):** Mode toggle tooltip explains this behavioral difference to users.
