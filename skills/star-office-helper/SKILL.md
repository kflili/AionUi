---
name: star-office-helper
description: Install, start, connect, and troubleshoot Star-Office-UI for Aion/OpenClaw visualization. Use when users ask for Star Office setup, URL/port connection, Unauthorized page diagnosis, Python venv/pip issues (PEP 668), preview panel wiring, or real-time monitor wake-up checks.
---

# Star Office Helper

Guide users from zero to usable Star-Office-UI, then keep the visualization stable inside Aion.

## Workflow

1. Confirm objective:
- Install and run Star-Office-UI locally.
- Connect Aion preview/monitor URL to a running Star-Office service.
- Diagnose why UI does not animate or shows `Unauthorized`.

2. Run environment diagnosis first:
- Execute `skills/star-office-helper/scripts/star_office_doctor.sh`.
- If `python3 -m pip install` fails with `externally-managed-environment`, switch to venv flow.

3. Install/repair setup:
- Execute `skills/star-office-helper/scripts/star_office_setup.sh`.
- This creates `.venv`, installs backend dependencies, and ensures `state.json` exists.

4. Start services and verify:
- Start backend and frontend from Star-Office-UI repo.
- Confirm preview URL (default recommend `http://127.0.0.1:19000`).
- Re-run doctor to verify port and HTTP response.

5. Connect in Aion:
- Open OpenClaw mode preview panel (TV icon).
- Input URL and save.
- If still blank/Unauthorized, inspect backend auth and state config with doctor output.

## Ground Rules

- Do not use `pip --break-system-packages` unless user explicitly asks for system-wide install.
- Prefer venv install on macOS/Homebrew Python.
- Treat OpenClaw task execution and Star Office animation as two systems:
  - OpenClaw can work without Star Office.
  - Star Office only animates when its own backend/frontend and event path are active.

## Quick Commands

```bash
# Diagnose current machine and ports
bash skills/star-office-helper/scripts/star_office_doctor.sh

# Bootstrap Star-Office-UI in ~/Star-Office-UI
bash skills/star-office-helper/scripts/star_office_setup.sh

# Bootstrap in a custom folder
bash skills/star-office-helper/scripts/star_office_setup.sh /path/to/Star-Office-UI
```

## References

- Read `references/troubleshooting.md` for:
  - `Unauthorized` root causes
  - wrong port (`18791` vs `19000`)
  - why "connected but not moving"
  - Aion preview URL mapping checklist
