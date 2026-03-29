# Agent Architecture Notes

**Date:** 2026-03-19
**Status:** Design notes — captures current thinking for future reference

---

## Current Architecture: No Root Agent Needed

The current CLI session already serves as the "root agent":

- Has filesystem access across all projects
- Can spawn subagents for parallel research
- Can read/write files in any project folder
- Can delegate work to background processes

No special infrastructure, SDK, or agent framework needed. Just a CLI with standard tools.

---

## Interaction Modes

### Normal mode (95% of the time)

Direct conversation with one CLI. It does the work or spawns subagents. Simple.

### Parallel delegation mode (rare, heavy/long-term tasks)

When you need something running in the background while you continue other work:

```
You ↔ Main CLI ("root agent")
        │
        ├── tmux session A: CLI working on long refactor
        ├── tmux session B: CLI running test suite and fixing failures
        │
        Main CLI periodically checks progress:
          tmux capture-pane -t A → reads output → reports to you
          tmux send-keys -t B "status?" → reads response
        │
        You never attach to A or B yourself
```

- Main CLI creates tmux sessions, launches CLIs in them
- Main CLI monitors progress and reports back
- No interactive input/output concerns — main CLI handles the bridge
- Each tmux CLI writes its own JSONL history as normal
- Knowledge consolidation pipeline picks up all sessions automatically

### Cost-saving escape hatch (optional)

If the bridge role is burning too many tokens, attach to the tmux session directly:

- In terminal: `tmux attach -t session-name` (native experience)
- In AionUI: terminal wrapper mode (requires terminal wrapper plan)
- Full interactive experience, same as starting a fresh CLI

---

## Why This Replaces the teleX Root Agent Design

| teleX design                      | Current approach                                      |
| --------------------------------- | ----------------------------------------------------- |
| Dedicated root agent process      | Current CLI session IS the root agent                 |
| Agent SDK for spawning workers    | `tmux` + CLI (no SDK needed)                          |
| Custom message bus between agents | `tmux send-keys` / `tmux capture-pane`                |
| Worker lifecycle management       | tmux session management (native)                      |
| Central conversation logging      | Each CLI writes its own history; scanner consolidates |

Same capabilities, zero custom infrastructure.

---

## Future Skill: `/delegate`

A skill that automates the tmux delegation pattern:

```
/delegate "refactor the auth module" --project ~/Projects/teleX --cli claude
```

Would:

1. Create a named tmux session
2. Launch the specified CLI in the target project directory
3. Send the initial task message
4. Return the tmux session name for monitoring
5. Optionally set up periodic progress checks

Not needed now — the manual tmux commands work fine. Build this when the pattern becomes frequent enough to justify automation.

---

## How This Connects to Other Plans

- **Terminal wrapper mode** (`2026-03-19-terminal-wrapper/plan.md`) — enables attaching to tmux sessions inside AionUI for the cost-saving escape hatch
- **CLI history integration** (`2026-03-19-cli-history/plan.md`) — tmux-delegated sessions write normal JSONL history, show up in the history browser
- **Knowledge consolidation** (`2026-03-19-personal-knowledge-consolidation.md`) — scanner picks up all sessions regardless of how they were launched
- **Default workspace for random chats** — use `temp_ideas/` or `workspace/` folder as default, daily consolidation captures everything

---

## Mobile / Random Chat Pattern

For non-project discussions (random ideas, topic exploration):

- Use a default workspace folder (e.g., `~/Projects/temp_ideas/`)
- Start different sessions for different topics
- AionUI's history sidebar makes them findable
- Daily/weekly consolidation extracts durable knowledge from random chats
- No need for ChatGPT web — all conversations go through the same system
