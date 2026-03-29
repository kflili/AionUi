# Copilot CLI ACP Permission Modes

**Date:** 2026-03-29
**Status:** Planned
**Branch:** `feat/copilot-acp-permission-modes`

---

## Problem

GitHub Copilot CLI is registered as an ACP backend in AionUi (`acpTypes.ts`) but has **no permission mode support**. The `AGENT_MODES` config in `agentModes.ts` has no `copilot` entry, so:

- `getAgentModes('copilot')` returns `[]`
- `supportsModeSwitch('copilot')` returns `false`
- The permission dropdown is **completely hidden** on both the Guid page and Rich UI sendbox

All other major backends (Claude, Qwen, iFlow, Codex, Gemini, Cursor) have mode support.

## Verified Findings (ACP Protocol Test)

Tested against `copilot --acp --stdio` (v1.0.13-1) with NDJSON protocol. Key results:

### 1. session/set_mode — uses URL-based ACP spec mode IDs

Copilot rejects plain strings like `plan`, `yolo`, `autopilot`. It requires full ACP-spec URLs:

| Mode URL                                                           | Label           | Test Result |
| ------------------------------------------------------------------ | --------------- | ----------- |
| `https://agentclientprotocol.com/protocol/session-modes#agent`     | Agent (default) | ✓ Success   |
| `https://agentclientprotocol.com/protocol/session-modes#plan`      | Plan            | ✓ Success   |
| `https://agentclientprotocol.com/protocol/session-modes#autopilot` | Autopilot       | ✓ Success   |

Each mode switch also emits a `config_option_update` notification confirming the change.

### 2. session/request_permission — Copilot DOES send permission events

In `agent` mode, Copilot sends standard ACP permission requests:

```json
{
  "method": "session/request_permission",
  "params": {
    "toolCall": { "title": "Access paths outside trusted directories", "kind": "read" },
    "options": [
      { "optionId": "allow_once", "kind": "allow_once", "name": "Allow once" },
      { "optionId": "allow_always", "kind": "allow_always", "name": "Always allow" },
      { "optionId": "reject_once", "kind": "reject_once", "name": "Deny" }
    ]
  }
}
```

This matches AionUi's existing `AcpPermissionOption` type exactly.

### 3. ACP-layer auto-approval already works

`BaseAgentManager.addConfirmation()` already auto-approves when `yoloMode=true`:

- Picks `options[0]` (allow_once) and auto-responds after 50ms
- No CLI flags (`--yolo`) needed — granular ACP-layer control is better

## Design: ACP-Layer Permission Control (No CLI Flags)

**Approach**: Match the existing Claude/Qwen pattern — use `session/set_mode` via ACP + Manager-layer auto-approval. No `--yolo` CLI flag needed.

**Why ACP-layer is better than CLI flags**:

- Mid-session switching works (no process restart)
- Granular control possible (could add per-tool logic later)
- Consistent UX across all backends
- Proven pattern — already works for Claude, Qwen, iFlow

## Changes Required

### 1. `src/renderer/utils/model/agentModes.ts` — Add copilot modes

```typescript
copilot: [
  { value: 'https://agentclientprotocol.com/protocol/session-modes#agent', label: 'Default' },
  { value: 'https://agentclientprotocol.com/protocol/session-modes#plan', label: 'Plan' },
  { value: 'https://agentclientprotocol.com/protocol/session-modes#autopilot', label: 'Autopilot (YOLO)' },
],
```

### 2. `src/process/task/AcpAgentManager.ts` — Extend `isYoloMode()`

```typescript
private isYoloMode(mode: string): boolean {
  return mode === 'yolo' || mode === 'bypassPermissions' || mode.endsWith('#autopilot');
}
```

This ensures:

- Constructor sets `this.yoloMode = true` when `sessionMode` ends with `#autopilot`
- `addConfirmation()` auto-approves all permission requests
- `setMode()` correctly tracks yolo state transitions
- Legacy yolo config clearing works for copilot too

### 3. `src/renderer/services/i18n/locales/*/agentMode.json` — Add i18n key

The mode labels are defined inline in `AGENT_MODES`, but the `AgentModeSelector` uses `t('agentMode.${mode.value}')` with `defaultValue: mode.label` as fallback. Since mode values are URLs, the i18n key lookup will miss and fall back to the label — which is correct behavior. No i18n changes strictly required.

However, add a comment in the agentModes.ts noting that Copilot uses URL-based mode IDs per the ACP spec.

### 4. `src/process/agent/acp/constants.ts` — Add Copilot YOLO constant (optional)

Add for consistency with other backends, even though the Manager-layer handles it:

```typescript
export const COPILOT_YOLO_SESSION_MODE = 'https://agentclientprotocol.com/protocol/session-modes#autopilot' as const;
```

### 5. `src/process/agent/acp/index.ts` — Add copilot to yoloModeMap (both instances)

In `start()` method yoloModeMap (~line 318):

```typescript
copilot: COPILOT_YOLO_SESSION_MODE,
```

In `enableYoloMode()` yoloModeMap (~line 392):

```typescript
copilot: COPILOT_YOLO_SESSION_MODE,
```

This ensures when yoloMode is set, `session/set_mode` is called with the autopilot URL — giving dual protection (Copilot runs autonomously AND AionUi auto-approves remaining prompts).

### 6. `src/process/task/AcpAgentManager.ts` — Add copilot to legacy yoloModeValues

In `initAgent()` legacy migration map (~line 209):

```typescript
copilot: 'https://agentclientprotocol.com/protocol/session-modes#autopilot',
```

## Files Summary

| File                                     | Change                                   | Risk |
| ---------------------------------------- | ---------------------------------------- | ---- |
| `src/renderer/utils/model/agentModes.ts` | Add `copilot` modes array + comment      | None |
| `src/process/task/AcpAgentManager.ts`    | Extend `isYoloMode()`, add to legacy map | Low  |
| `src/process/agent/acp/constants.ts`     | Add `COPILOT_YOLO_SESSION_MODE`          | None |
| `src/process/agent/acp/index.ts`         | Add copilot to 2x yoloModeMap            | Low  |

**No UI component changes needed** — `AgentModeSelector`, `GuidActionRow`, and `AcpSendBox` are all driven by `AGENT_MODES` config.

## Testing

1. Launch AionUi with `bun start`
2. Select Copilot agent on Guid page → verify permission dropdown appears with Default/Plan/Autopilot (YOLO)
3. Start a conversation in Default mode → verify permission dialog appears for tool use
4. Switch to Autopilot (YOLO) mid-session → verify permissions are auto-approved
5. Start a new conversation in Plan mode → verify read-only behavior
6. Start a new conversation in Autopilot (YOLO) → verify no permission prompts from first message
