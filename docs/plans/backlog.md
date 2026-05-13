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

### CLI `--resume` may skip middle conversation turns

**Source:** Manual testing of terminal wrapper mode
**Status:** Known limitation — not our bug
**Priority:** Awareness only

Claude Code CLI's `--resume` reconstructs conversation context in memory and may selectively display messages. In testing, middle-session turns were skipped in the terminal display (confirmed via GitHub issues [#14472](https://github.com/anthropics/claude-code/issues/14472), [#15837](https://github.com/anthropics/claude-code/issues/15837)). The model still "remembers" the full context — only the terminal display is affected.

**Impact:** When switching Rich UI → Terminal → Rich UI → Terminal, the terminal may not show all previous turns from earlier terminal sessions. Rich UI always shows the full history from SQLite.

**Mitigation (implemented):** Mode toggle tooltip explains this behavioral difference to users.

---

## File Attach

### Temp file cleanup for paste/drag attachments

**Source:** GPT review of file-attach-raw-paths implementation
**Status:** Deferred — no user-facing impact
**Priority:** Low

After removing `copyFilesToDirectory`, temp files created by paste/drag-drop (in `cacheDir/temp/`) are no longer cleaned up per-message. The old copy helper was the only cleanup path. Temp files now persist until app restart or manual cleanup.

**Why deferred:** Temp files are small (individual paste/drag items), accumulate slowly, and live in the app cache directory. The race condition from eager cleanup was worse than the storage leak.

**Next step:** Add periodic cleanup of `cacheDir/temp/` files older than 24h, either on app startup or via a timer.
