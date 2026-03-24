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
