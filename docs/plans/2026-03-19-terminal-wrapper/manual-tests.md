# Terminal Wrapper Mode — Manual Validation Checklist

**Date:** 2026-03-24
**Branch:** `feat/terminal-wrapper-mode`
**Plan:** [plan.md](./plan.md)

---

## How to use

Run `bun start` on the feature branch. Go through each scenario below.
Mark `[x]` when verified, add notes in the `Result` column if anything unexpected happens.

---

## 1. Mode Toggle

| #   | Scenario                      | Steps                                                                                     | Expected                                                                                           | Result |
| --- | ----------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------ |
| 1.1 | ACP → Terminal                | Open an ACP conversation (Claude/Copilot). Click "Terminal" in the header toggle.         | PTY spawns, xterm.js renders with blinking cursor. Input box disappears — terminal IS the input.   | [x]    |
| 1.2 | Terminal → ACP                | While in terminal mode, click "Rich UI" in the header toggle.                             | PTY killed, ACP chat with message list and input box renders. Previous ACP messages still visible. | [x]    |
| 1.3 | Mode persisted                | Switch to terminal mode, navigate away (sidebar), navigate back to the same conversation. | Conversation is still in terminal mode.                                                            | [x]    |
| 1.4 | Mode persisted across restart | Switch to terminal mode, fully quit and relaunch the app, open same conversation.         | Conversation remembers terminal mode (new PTY spawns).                                             | [ ]    |
| 1.5 | Rapid toggle                  | Click "Rich UI" / "Terminal" back and forth rapidly (~5 times in 2 seconds).              | No duplicate PTY processes, no blank screen, no JS errors in DevTools console.                     | [ ]    |
| 1.6 | Toggle only on ACP            | Open a Gemini conversation.                                                               | No mode toggle visible in header — toggle only appears for ACP conversations.                      | [ ]    |

---

## 2. Terminal Functionality

| #   | Scenario          | Steps                                                   | Expected                                                         | Result |
| --- | ----------------- | ------------------------------------------------------- | ---------------------------------------------------------------- | ------ |
| 2.1 | Keyboard input    | In terminal mode, type characters.                      | Characters appear in the terminal.                               | [ ]    |
| 2.2 | Command execution | Type a command (e.g. `echo hello`) and press Enter.     | Command executes, output displayed.                              | [ ]    |
| 2.3 | Ctrl+C            | Run `sleep 100`, then press Ctrl+C.                     | Sleep interrupted, prompt returns.                               | [ ]    |
| 2.4 | Resize — window   | Drag the window edge to resize.                         | Terminal content reflows to fit new dimensions. No clipped text. | [ ]    |
| 2.5 | Resize — sidebar  | Toggle the workspace sidebar open/closed.               | Terminal resizes to fill available space.                        | [ ]    |
| 2.6 | Scrollback        | Generate lots of output (e.g. `seq 1 5000`). Scroll up. | Can scroll back through output. At least 10000 lines preserved.  | [ ]    |
| 2.7 | Process exit      | Let the CLI agent finish or type `exit`.                | Grey `[Process exited with code 0]` message appears in terminal. | [ ]    |
| 2.8 | Copy/paste        | Select text in terminal, Cmd+C. Click elsewhere, Cmd+V. | Text copied from terminal and pasteable.                         | [ ]    |

---

## 3. CLI Resume (per backend)

| #   | Scenario       | Steps                                                                                      | Expected                                                                           | Result |
| --- | -------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- | ------ |
| 3.1 | Claude resume  | Start an ACP Claude session, send a message (to get `acpSessionId`). Toggle to terminal.   | Terminal shows `claude --resume <sessionId>` and the CLI resumes the conversation. | [ ]    |
| 3.2 | Claude new     | Create a new Claude conversation. Toggle to terminal immediately (before any ACP message). | Terminal starts `claude` fresh (no `--resume` flag).                               | [ ]    |
| 3.3 | Copilot resume | Same as 3.1 but with Copilot backend.                                                      | Spawns `copilot --resume=<sessionId>`.                                             | [ ]    |
| 3.4 | Codex resume   | Same as 3.1 but with Codex backend.                                                        | Spawns `codex resume --session-id <sessionId>`.                                    | [ ]    |

---

## 4. Settings Page

| #   | Scenario                 | Steps                                                            | Expected                                                                  | Result |
| --- | ------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------- | ------ |
| 4.1 | Settings page accessible | Navigate to Settings. Look for "Terminal" tab in sidebar.        | "Terminal" tab visible with terminal icon, between "Tools" and "Display". | [ ]    |
| 4.2 | Default mode = Terminal  | Set "Default Mode" to "Terminal". Create a new ACP conversation. | New conversation opens directly in terminal mode.                         | [ ]    |
| 4.3 | Default mode = Rich UI   | Set "Default Mode" to "Rich UI". Create a new ACP conversation.  | New conversation opens in ACP mode (normal chat).                         | [ ]    |
| 4.4 | Font size                | Set font size to 20. Toggle into terminal mode.                  | Terminal text is visibly larger (20px).                                   | [ ]    |
| 4.5 | Font size — small        | Set font size to 10. Toggle into terminal mode.                  | Terminal text is smaller, more lines visible.                             | [ ]    |
| 4.6 | Settings persistence     | Change font size, close settings, reopen settings.               | Font size value still reflects the saved value.                           | [ ]    |

---

## 5. Error Handling

| #   | Scenario          | Steps                                                                            | Expected                                                                             | Result |
| --- | ----------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------ |
| 5.1 | CLI not found     | Temporarily rename/hide the CLI binary (e.g. `claude`). Toggle to terminal mode. | Red error message in terminal: "Failed to start terminal: ..." — not a blank screen. | [ ]    |
| 5.2 | Invalid workspace | Set conversation workspace to a non-existent path. Toggle to terminal.           | Terminal starts (falls back to home dir) or shows clear error.                       | [ ]    |

---

## 6. Conversation Navigation

| #   | Scenario                              | Steps                                                                                  | Expected                                                                           | Result |
| --- | ------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------ |
| 6.1 | Switch conversations — mode isolation | Conversation A in terminal mode. Conversation B in ACP mode. Navigate A → B → A.       | Each conversation shows its own mode. B does not inherit A's terminal mode.        | [ ]    |
| 6.2 | Multiple terminal sessions            | Open conversation A in terminal, then conversation B in terminal. Switch between them. | Each has an independent PTY. Output doesn't leak between them.                     | [ ]    |
| 6.3 | New conversation from terminal        | While in terminal mode, click the "+" new conversation button.                         | New conversation created — does not inherit parent's terminal mode (uses default). | [ ]    |

---

## 7. Lifecycle & Cleanup

| #   | Scenario            | Steps                                                                              | Expected                                                                                                                                            | Result |
| --- | ------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 7.1 | App quit — clean    | Open terminal session. Quit app normally (Cmd+Q). Run `ps aux \| grep <cli-name>`. | No orphaned CLI processes left running.                                                                                                             | [ ]    |
| 7.2 | Conversation delete | While terminal session is active, delete the conversation from sidebar.            | PTY killed, no orphaned process.                                                                                                                    | [ ]    |
| 7.3 | Orphan cleanup      | Force-kill the app (`kill -9 <pid>`) with an active terminal. Relaunch.            | On startup, orphaned PTY from previous crash is detected and killed. Check console logs for `[TerminalSessionManager] Killed orphaned PTY process`. | [ ]    |
| 7.4 | PID file check      | After starting a terminal session, inspect `~/.aionui/terminal-pids.json`.         | File contains JSON array with `{ pid, startedAt }` entries.                                                                                         | [ ]    |

---

## 8. Session Transcript

| #   | Scenario           | Steps                                                                                            | Expected                                                           | Result |
| --- | ------------------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | ------ |
| 8.1 | Transcript created | Run some commands in terminal mode. Check `~/.aionui/terminal-transcripts/<conversationId>.txt`. | File exists and contains plain text output (no ANSI escape codes). | [ ]    |
| 8.2 | Transcript append  | Run more commands in the same session. Check transcript file.                                    | New output appended (file grows).                                  | [ ]    |
| 8.3 | No ANSI codes      | Inspect transcript file content (`cat -v` or hex viewer).                                        | No `\x1b[...` escape sequences — all stripped.                     | [ ]    |

---

## 9. Accessibility

| #   | Scenario             | Steps                                                                   | Expected                                                  | Result |
| --- | -------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------- | ------ |
| 9.1 | Mode toggle keyboard | Tab to the mode toggle in the chat header. Press arrow keys or Enter.   | Can switch modes using keyboard only. Focus ring visible. | [ ]    |
| 9.2 | Settings keyboard    | Tab to the default mode control in Settings > Terminal. Use arrow keys. | Can change default mode with keyboard.                    | [ ]    |

---

## 10. i18n

| #    | Scenario | Steps                                                                 | Expected                                                    | Result |
| ---- | -------- | --------------------------------------------------------------------- | ----------------------------------------------------------- | ------ |
| 10.1 | English  | Set language to English. Check mode toggle and settings page.         | Labels: "Rich UI", "Terminal", "Default Mode", "Font Size". | [ ]    |
| 10.2 | Chinese  | Set language to Chinese (zh-CN). Check mode toggle and settings page. | Labels: "富文本", "终端", "默认模式", "字体大小".           | [ ]    |
| 10.3 | Japanese | Set language to Japanese (ja-JP). Check settings page.                | Labels in Japanese.                                         | [ ]    |

---

## Sign-off

| Item                                             | Status |
| ------------------------------------------------ | ------ |
| All critical scenarios (1.x, 3.x, 5.x, 7.x) pass | [ ]    |
| All warning scenarios (2.x, 4.x, 6.x) pass       | [ ]    |
| All nice-to-have scenarios (8.x, 9.x, 10.x) pass | [ ]    |
| **Ready for PR**                                 | [ ]    |

**Tester:** **\*\***\_\_\_**\*\***
**Date:** **\*\***\_\_\_**\*\***
**Notes:**
