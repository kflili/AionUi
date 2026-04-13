# Copilot Gateway Integration

AionUi can automatically route Claude Code sessions through the [copilot-gateway](../../copilot-gateway/) — a local proxy that uses your GitHub Copilot subscription for Claude API access instead of a direct Anthropic API key.

## How It Works

When starting a Claude Code session (Rich UI or Terminal), AionUi checks if a copilot-gateway is running on `localhost:8787`. If detected, it automatically sets `ANTHROPIC_BASE_URL` and a dummy auth token so Claude routes through the gateway. If the gateway isn't running, Claude uses the default API path — no error, no delay.

The detection runs on every Claude spawn with a 300ms timeout. It skips detection if `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, or `ANTHROPIC_API_KEY` is already set in the environment.

## Setup

1. Start the copilot-gateway (`cg` or `python3 gateway.py` in the gateway repo)
2. Launch a Claude session in AionUi — it auto-detects and routes through the gateway
3. Verify in AionUi's main process log: `"Copilot gateway detected at localhost:8787 — routing Claude through gateway"`

No AionUi configuration changes required.

## Settings

**Settings > Agent CLI > Copilot Gateway** — toggle to enable/disable auto-detection (enabled by default).

## Known Limitations

- The Copilot API does not support Anthropic's `context_management` (server-side compaction). The gateway strips this field automatically. Claude Code handles context management client-side.
- The `anthropic-beta` header is stripped by the gateway, so beta features (compaction, etc.) are not available when routing through Copilot.

## Related

- [copilot-gateway README](../../copilot-gateway/README.md) — full gateway documentation
- [copilot-gateway Claude Code integration](../../copilot-gateway/docs/claude-code-integration.md) — CLI-specific setup
