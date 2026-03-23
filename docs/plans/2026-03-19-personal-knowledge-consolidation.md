# Personal Knowledge Consolidation

**Date:** 2026-03-19 (updated 2026-03-20)
**Status:** Draft — pipeline design complete, no implementation yet
**Related:** `2026-03-19-cli-history-integration.md`, `2026-03-19-cli-history-storage-reference.md`
**Inspiration:** teleX Phase 3 memory design, [willynikes2/knowledge-base-server](https://github.com/willynikes2/knowledge-base-server) (Reddit/r/ClaudeAI)
**Dependency:** Does NOT depend on Step 2 (CLI History Integration) UI work. Only needs CLI history path knowledge from the storage reference doc. Can start independently.
**Optimization:** If Step 2 is already done, the consolidation pipeline can optionally read from AionUI's SQLite (messages already parsed as TMessages) instead of re-parsing raw JSONL files. Both paths should work.

---

## Motivation

You use multiple CLI agents (Claude Code, Copilot CLI) across multiple projects. Each conversation contains decisions, learnings, ideas, and context that's valuable beyond the immediate task. But conversations are scattered across CLI history directories and forgotten after the session ends.

The goal: **automatically extract durable knowledge from all your CLI conversations**, without changing how any CLI works.

---

## Core Principle: Read Source Histories, Don't Write Back

Every CLI already logs its own conversations as JSONL files. Don't duplicate this. Don't build a central logging layer. Just **read from where they already are.** The pipeline writes derived knowledge artifacts (journal, library) to a separate output directory — never modifies source CLI history files.

```
Old approach (teleX root agent):
  CLI → write to central conversations/YYYY/MM/ → scan → summarize

New approach (scanner over existing CLI history):
  Claude Code CLI → writes to ~/.claude/ (already happens)
  Copilot CLI     → writes to ~/.copilot/ (already happens)
  AionUI          → writes to aionui.db (already happens)
                              ↓
  Consolidation agent scans all locations → summarize → extract → library
```

No new write paths. No central conversation store. The CLIs don't need to change.

---

## Architecture

### Input: CLI history locations (from storage reference doc)

| Source                | Path                                                              | Format |
| --------------------- | ----------------------------------------------------------------- | ------ |
| Claude Code CLI       | `~/.claude/projects/{hash}/*.jsonl`                               | JSONL  |
| Copilot CLI           | `~/.copilot/session-state/{id}/events.jsonl`                      | JSONL  |
| AionUI                | `~/Library/Application Support/AionUi/aionui/aionui.db`           | SQLite |
| Claude Desktop Code   | `~/Library/Application Support/Claude/claude-code-sessions/`      | JSONL  |
| Claude Desktop Cowork | `~/Library/Application Support/Claude/local-agent-mode-sessions/` | JSONL  |

### Processing: Five-step consolidation pipeline

```
┌─────────────────────────────────────────┐
│ 1. SCAN                                 │
│    Read all CLI JSONL history locations  │
│    Incremental: skip already-processed  │
│    (byte offset checkpoints)            │
└─────────────┬───────────────────────────┘
              ↓
┌─────────────────────────────────────────┐
│ 2. EXTRACT per session                  │
│    Structured extraction template:      │
│    - Decisions (what was decided & why) │
│    - Open Loops (unfinished, follow-up) │
│    - Changes (files, systems modified)  │
│    - Learnings (generalizable insights) │
│    - Entities (projects, topics, ideas) │
│                                         │
│    If session > 50KB: map-reduce        │
│    (chunk → extract each → merge)       │
└─────────────┬───────────────────────────┘
              ↓
┌─────────────────────────────────────────┐
│ 3. DAILY SYNTHESIS                      │
│    Re-read all extractions for the day  │
│    Find patterns, contradictions,       │
│    connections across sessions          │
│    Write journal/YYYY/YYYY-MM-DD.md     │
└─────────────┬───────────────────────────┘
              ↓
┌─────────────────────────────────────────┐
│ 4. LIBRARY UPDATE                       │
│    Additive updates to:                 │
│    - library/projects/{name}.md         │
│    - library/topics/{topic}.md          │
│    - library/ideas/{idea}.md            │
│    Dedup via content hashing            │
│    Tag: confidence: auto                │
└─────────────┬───────────────────────────┘
              ↓
┌─────────────────────────────────────────┐
│ 5. WEEKLY SYNTHESIS                     │
│    Re-read dailies for the week         │
│    Cross-day patterns, learning arcs    │
│    Write journal/YYYY/YYYY-WNN.md       │
└─────────────────────────────────────────┘
```

### Output: Knowledge library

```
~/knowledge/                    (or wherever you choose)
├── journal/
│   ├── 2026/
│   │   ├── 2026-03-19.md      ← daily summary
│   │   ├── 2026-03-20.md
│   │   └── 2026-W12.md        ← weekly summary
├── library/
│   ├── projects/
│   │   ├── teleX.md           ← accumulated project knowledge
│   │   ├── aionui.md
│   │   └── claude-toolkit.md
│   ├── topics/
│   │   ├── acp-protocol.md    ← extracted topic knowledge
│   │   ├── jsonl-vs-sqlite.md
│   │   └── cli-architecture.md
│   └── ideas/
│       ├── terminal-wrapper-mode.md
│       └── knowledge-consolidation.md
└── index.md                    ← quick-reference index
```

---

## Pipeline Design Details

### Step 1: Scan

- Scan all CLI history locations listed above
- Uses the shared Session Source Provider registry (same as Step 2) for discovery and reading
- **Incremental processing:** JSONL files are append-only and grow over time. Whole-file content hashing doesn't work — a session file changes every time the user sends a message. Instead, use incremental checkpoints:

```
~/knowledge/.scan-state.json
{
  "sessions": {
    "~/.claude/projects/-Users-lili-Projects-teleX/abc123.jsonl": {
      "lastProcessedOffset": 524288,   // byte offset of last processed position
      "lastProcessedAt": "2026-03-20T10:00:00Z",
      "lineCount": 342                 // for sanity checking
    }
  }
}
```

- On re-scan: read from `lastProcessedOffset` to end of file, extract only new content
- If file is smaller than recorded offset (truncated/replaced): re-process from beginning
- For non-JSONL sources (AionUI SQLite): track by `MAX(created_at)` of processed messages

### Step 2: Extract per session

Extraction prompt template (adapted from teleX Phase 3):

```
You are extracting durable knowledge from an AI coding session.
Read the session and produce a structured extraction:

## Decisions
What was decided and why? Include the reasoning, not just the outcome.

## Open Loops
What was started but not finished? What needs follow-up?

## Changes
What files, systems, or configurations were modified?

## Learnings
What generalizable insights emerged? What would be useful in future sessions?

## Entities
- Projects mentioned: [list with brief context]
- Topics/concepts: [list]
- Ideas spawned: [list]
```

**Large session handling (>50KB):**
Map-reduce — split session into ~30KB chunks by message boundaries, extract from each chunk, merge extractions with a final synthesis pass.

### Step 3: Daily synthesis

**Key design decision (from teleX):** Re-read all session extractions from scratch, not just merge them. This lets the synthesizer see the full arc of the day.

Daily prompt focuses on:

- **Patterns** — three sessions touched auth code → maybe auth needs a refactor
- **Contradictions** — decided X in morning, reversed in afternoon
- **Connections** — idea from random chat relates to a project task
- **Progress** — what moved forward across all projects today

### Step 4: Library update

- **Additive only** — new information appended with date stamp, never overwrite
- **Source backlinks** — every extracted entry includes a source reference (session file path + approximate line range) so auto-generated knowledge remains auditable and traceable back to the original conversation
- **Confidence tagging** — auto-extracted entries tagged `confidence: auto`, user can promote to `confidence: confirmed`
- **Deduplication** — content-hash each extracted entity, skip if substantially similar entry already exists
- **Bidirectional links** — `[[wiki-style]]` links between related entries (Obsidian-compatible for future integration)

### Step 5: Weekly synthesis

- Re-read all dailies for the week (not merge — same principle as daily)
- Focus on **learning arcs** (Day 2 learned X → Day 3 refined to Y → Day 5 applied Z)
- Identify recurring themes, evolving decisions, unresolved open loops

---

## How CLI Agents Use the Knowledge

**No auto-updating instruction files.** CLAUDE.md (or equivalent) just includes guidance like:

```
If you need context from past sessions or accumulated knowledge:
- Check ~/knowledge/journal/ for recent daily/weekly summaries
- Check ~/knowledge/library/ for project/topic/idea knowledge
- Focus on current session first; consult knowledge library when needed
```

The CLI's built-in auto-compact handles current-session memory. The knowledge library is for **cross-session, cross-project** knowledge only.

---

## Search & Retrieval Phases

### Phase 1: Plain files + grep (start here)

- Knowledge library is plain markdown files
- Any CLI can `Read` any file, `grep` for keywords
- Sufficient when library is small (dozens of entries)
- **Zero infrastructure needed**

### Phase 2: SQLite FTS5 keyword search (when grep gets slow)

- One SQLite database indexes everything: chat sessions + journal + library
- Single table with `type` column differentiating content types:

```sql
CREATE TABLE knowledge (
    id TEXT PRIMARY KEY,
    type TEXT,          -- 'chat_session' | 'daily_summary' | 'weekly_summary' | 'knowledge' | 'idea'
    source TEXT,        -- 'claude_code' | 'copilot' | 'aionui' | 'consolidation'
    project TEXT,
    title TEXT,
    content TEXT,
    file_path TEXT,     -- points to original file
    created_at INTEGER,
    updated_at INTEGER
);

CREATE VIRTUAL TABLE knowledge_fts USING fts5(title, content, project, content=knowledge);
```

- One search query finds everything across all types
- `file_path` points back to original source for full content
- Batch indexer: scan all files → populate/update SQLite. Run after consolidation or on-demand.

### Phase 3: Local embeddings for semantic search (when keyword search misses semantic matches)

Add an embeddings column to the same Phase 2 SQLite database. Not a separate system.

```javascript
// ~50MB model, runs 100% locally on Mac, no API calls, no cost
import { pipeline } from '@xenova/transformers';
const embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
const result = await embedder('your text here', { pooling: 'mean', normalize: true });
const vector = Array.from(result.data); // 384 floats
```

- Each document gets a 384-float vector representing its meaning
- Search: embed the query, compare against all stored vectors (cosine similarity)
- Finds "auth middleware JWT" when you search "how does login work" (semantic match, no keyword overlap)
- Storage: vectors stored as BLOBs in SQLite alongside text, or use `sqlite-vss` extension for native vector search
- **Additive** — literally adding one column to the Phase 2 database and running each document through the embedding model once

**Each phase builds on the previous one. Same database, more capabilities.**

---

## Sensitive Data Filtering

CLI sessions may contain API keys, passwords, tokens, credentials, or other secrets (in commands, environment variables, tool outputs). The pipeline must filter these to prevent secret propagation into "evergreen" knowledge notes.

### Architecture: Post-extraction sanitization (not baked into providers)

Providers are dumb readers — they read JSONL/SQLite and yield transcript events. Secret filtering is a **separate pipeline stage** that runs after extraction, before writing output. This keeps providers simple and makes filtering testable, configurable, and reusable across all providers.

```
Provider (read raw) → Extractor (LLM summarize) → Sanitizer (redact secrets) → Write output
```

> **⚠ Secret exposure timing:** In this pipeline, raw transcripts (which may contain API keys, tokens, credentials) are sent to the LLM for extraction BEFORE post-extraction sanitization runs. If the LLM is a remote API (not local), secrets leave the device during the extraction step. Mitigation options: (1) Layer 1's prompt instruction ("do NOT include secrets") reduces leakage in outputs but the LLM still sees them in inputs, (2) add a pre-extraction sanitization pass on raw transcripts before sending to LLM, (3) use a local model for extraction (no data leaves device). For MVP, option (1) is acceptable if you trust your LLM provider. For higher security, add option (2).

### Two-layer approach

**Layer 1: LLM extraction prompt.** Include a redaction instruction: "Do NOT include any API keys, passwords, tokens, auth credentials, or secrets in the extraction. Replace with `[REDACTED]` if context is needed." The LLM naturally summarizes rather than copying verbatim, which reduces (but doesn't eliminate) secret leakage.

**Layer 2: Post-extraction regex scan.** Run the extracted text through a well-known secret detection tool to catch anything the LLM missed. Use existing pattern sets — don't reinvent.

### Recommended tooling (reuse existing pattern sets)

**Primary: [Secretlint](https://github.com/secretlint/secretlint)** — TypeScript-native, designed for programmatic use, has `lintSource()` API that scans arbitrary strings (not just files). The `@secretlint/secretlint-rule-preset-recommend` preset covers AWS, GCP, GitHub, Slack, OpenAI, Anthropic, Stripe, PEM keys, DB connection strings, and more.

```bash
bun add @secretlint/core @secretlint/secretlint-rule-preset-recommend
```

```typescript
import { lintSource } from '@secretlint/core';
import presetRecommend from '@secretlint/secretlint-rule-preset-recommend';

async function redactSecrets(text: string): Promise<string> {
  const result = await lintSource({
    source: { filePath: '<text>', content: text, contentType: 'text', ext: '.txt' },
    options: { locale: 'en', maskSecrets: true },
    config: {
      rules: [{ id: '@secretlint/secretlint-rule-preset-recommend', rule: presetRecommend }],
    },
  });
  return result.sourceContent; // text with secrets masked
}
```

**Fallback/supplement: [Gitleaks](https://github.com/gitleaks/gitleaks) TOML patterns.** The `gitleaks.toml` config has ~290 curated rules with keyword pre-filters for fast matching. Can parse the TOML and compile to JS RegExp for a second pass covering the long tail. No need to run the Go CLI — just vendor the pattern file.

**Not recommended:** `detect-secrets` npm wrapper (unmaintained 6+ years), `secrets-patterns-db` (1600+ patterns = too many false positives without per-rule tuning).

### Configurability

Users can add custom patterns via a config file (e.g., `consolidation.yaml` → `redact_patterns` list) for company-specific secrets that standard tools don't cover. Secretlint also supports `@secretlint/secretlint-rule-pattern` for custom regex rules.

## What This Does NOT Do

- Does NOT change how any CLI stores conversations
- Does NOT require a central conversation database
- Does NOT run during active sessions (only scans after the fact)
- Does NOT require AionUI specifically (works with raw CLI history files)
- Does NOT require real-time processing (batch is fine)
- Does NOT auto-update CLAUDE.md or instruction files
- Does NOT copy raw session content — only derived summaries and structured extractions

---

## Implementation Options

### Option A: Standalone script (simplest)

A script (Python/Node/Bash) that:

1. Scans CLI history directories
2. Calls an LLM API to summarize
3. Writes markdown files to the knowledge directory

Could be triggered by cron, manually, or as a Claude Code skill (`/consolidate`).

### Option B: AionUI integration

Add a "Consolidate" button or scheduled task in AionUI that:

1. Uses its existing CLI history scanning (from the history integration plan)
2. Runs summarization via any connected ACP agent
3. Writes to the knowledge directory

Benefits: visual UI for browsing the knowledge library alongside chat history.

### Option C: Claude Code skill

A `/consolidate` skill in claude-toolkit that:

1. Scans all history locations
2. Uses subagents for parallel summarization
3. Writes to the knowledge directory

Benefits: runs from any terminal, no GUI needed.

**Recommendation:** Start with Option C (skill). It's the fastest to build and test. Move to Option B later if you want it in AionUI's UI.

---

## Comparison with Other Systems

### vs teleX Phase 3 Memory Design

| teleX design                              | This plan                                            |
| ----------------------------------------- | ---------------------------------------------------- |
| Root agent owns all conversations         | No root agent — scan existing CLI history            |
| Write to central `conversations/YYYY/MM/` | No central store — CLIs write to their defaults      |
| Session-end trigger via SDK hooks         | Batch scan (daily cron or manual)                    |
| Tight coupling to teleX bot               | Works with any CLI, any project                      |
| Obsidian-compatible vault                 | Plain markdown with wiki links (Obsidian-compatible) |

The consolidation logic (extract → daily → weekly → library) and the extraction template (Decisions/Open Loops/Changes/Learnings) are preserved from the teleX design. Only the input path changed.

### vs willynikes2/knowledge-base-server

| Their system                          | This plan                                    |
| ------------------------------------- | -------------------------------------------- |
| 16 MCP tools for access               | File read + grep (SQLite + embeddings later) |
| Obsidian as source of truth           | CLI history as source of truth               |
| Seven-layer pipeline                  | Five-step pipeline (simpler, same outcome)   |
| Auto-updates instruction files        | CLAUDE.md just points to library             |
| Embeddings + SQLite FTS5 from day one | Phased: files → SQLite FTS5 → embeddings     |
| MCP-based access (context overhead)   | Direct file access (zero overhead)           |

**Borrowed from their system:** content hashing for dedup, three-tier hot/warm/cold concept, self-learning loop idea. **Skipped:** MCP access layer, heavy infrastructure upfront.

---

## Future Integrations

- **Obsidian vault** — knowledge library uses `[[wiki-style]]` links, making it Obsidian-compatible. Can add an Obsidian skill for richer note management later.
- **AionUI history browser** — knowledge entries show alongside chat history in the sidebar
- **Cross-CLI search** — unified SQLite index (Phase 2) enables searching across all CLIs and knowledge entries in one query

---

## Effort Estimate

| What                                | Effort                                       |
| ----------------------------------- | -------------------------------------------- |
| Option C skill: basic daily summary | ~1-2 days                                    |
| Library extraction                  | ~1 more day                                  |
| Weekly summaries                    | Trivial addition                             |
| Phase 2: SQLite FTS5 index          | ~1 day                                       |
| Phase 3: Local embeddings           | ~0.5 day (additive to Phase 2)               |
| Option B: AionUI integration        | ~2-3 days on top of history integration plan |

---

## Done Means

### MVP (`/consolidate` skill)

- [ ] Skill scans all CLI history locations and discovers sessions
- [ ] Incremental processing: only processes new/changed content since last run
- [ ] Produces structured extraction per session (Decisions/Open Loops/Changes/Learnings/Entities)
- [ ] Produces daily summary in `~/knowledge/journal/YYYY/YYYY-MM-DD.md`
- [ ] Sensitive data filtering: no API keys, tokens, or credentials in output
- [ ] Source backlinks: every extraction links back to source session file + location
- [ ] Idempotent: running twice on same day produces same output (no duplicates)

### Full Pipeline

- [ ] Library entries created/updated in `~/knowledge/library/`
- [ ] Weekly synthesis in `~/knowledge/journal/YYYY/YYYY-WNN.md`
- [ ] Large session handling via map-reduce (>50KB sessions)

### Search Phases (later)

- [ ] Phase 2: SQLite FTS5 index covers all knowledge + session metadata
- [ ] Phase 3: Local embeddings for semantic search
