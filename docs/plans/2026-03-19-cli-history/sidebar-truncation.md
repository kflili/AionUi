# Item 5 — Sidebar per-section truncation + "Show N more" expander

| Field       | Value                                                                                  |
| ----------- | -------------------------------------------------------------------------------------- |
| Status      | Implemented                                                                            |
| Priority    | High                                                                                   |
| Complexity  | Medium                                                                                 |
| Depends On  | Items 0–4 (CLI-history importer + source badge)                                        |
| Parent plan | `docs/plans/2026-03-19-cli-history/plan.md` (lines 119–136, 429–432, 514–525, 536–546) |
| Branch      | `feat/cli-history-sidebar-truncation`                                                  |

## TL;DR

The sidebar is a recent-work launcher, not an archive browser. After CLI-history import, sections like "Today" / "Earlier" can swell to hundreds of rows. Truncate each timeline section to a small default and reveal more with a "Show N more" expander per section. Workspace groups count as their _expanded_ row count, not 1 — collapsed they count as 1.

## Context

Items 1–2 (importer) populate the database with `conversation.source = 'claude_code' | 'copilot'`. Item 3 surfaced transcript mode; item 4 added the CC/CP source badge. The conversation list now mixes natively-created sessions with potentially hundreds of imported ones, all rendered by `WorkspaceGroupedHistory` (`src/renderer/pages/conversation/GroupedHistory/index.tsx`).

`groupConversationsByTimelineAndWorkspace` (in `utils/groupingHelpers.ts`) returns `TimelineSection[]`. Each `TimelineSection.items` is a mix of `{ type: 'workspace', workspaceGroup }` and `{ type: 'conversation', conversation }`. A workspace item, when expanded by the user via `WorkspaceCollapse`, reveals `workspaceGroup.conversations.length` rows; when collapsed, it contributes only its header row. **Note**: in the sidebar's _collapsed_ (narrow rail) mode, `WorkspaceCollapse.showContent = siderCollapsed || expanded` — so a workspace group always renders its children when the sidebar rail is collapsed, regardless of `expandedWorkspaces`. Row-counting must respect that.

The master plan (line 134, line 542–544) calls this out explicitly: **truncating by `section.items.length` would mis-count workspace groups**. Truncation must operate on _visible expanded rows_, not raw item count.

## Key Decisions

- ✅ Visible-row counting that respects per-workspace expand state (`expandedWorkspaces` already tracked in `useConversations`) AND the sidebar-rail collapsed mode (`collapsed` prop). Effective expansion rule: a workspace is "expanded" for row-counting iff `collapsed || expandedWorkspacesSet.has(workspace)`.
- ✅ Per-section **row-budget state**, not boolean expand state. `useSectionVisibleBudgets` tracks `Map<timelineKey, number>`. Missing key → use that section's default limit. One click of "Show N more" sets `budget = min(totalRows, max(currentBudget + baseLimit, nextRevealBudget))` so a click is guaranteed to reveal at least one previously-hidden item (avoids a click that reveals zero new rows when the next hidden row is a large expanded workspace).
- ✅ The truncation logic returns sliced `items` plus `{ hiddenRowCount, hiddenItemCount, nextRevealBudget }` so the section renderer can show "Show N more" with the correct count and the budget-bump click handler has a target.
- ✅ Add `timelineKey: SectionTimelineKey` field to `TimelineSection` so the limit lookup is locale-safe. `SectionTimelineKey` is a string-literal union of the four known keys.
- ✅ Memoization is a **single top-level `useMemo`** over all sections keyed by `[timelineSections, expandedWorkspaces, sectionBudgets, collapsed]`. `expandedWorkspaces` (currently `string[]` from `useConversations`) is converted to a `Set<string>` inside that memo for O(1) row-count checks.
- ✅ File placement: new files go under existing `hooks/` and `utils/` subfolders. `GroupedHistory/` direct-child cap is 10/10 (item 4 consumed the last slot per AionUi file-structure rules).
- ❌ Rejected: boolean `Set<string>` of "fully expanded sections". Conflicts with "Show N more per click" — a boolean toggle would expand everything in one click. Replaced by row-budget state.
- ❌ Rejected: per-section integer `visibleCount` that **only increments**. Would silently exceed `totalRows` if the dataset shrinks, leading to dead state. Bounded by `min(totalRows, ...)` instead.
- ❌ Rejected: tracking limit by translated section label. Locale changes would orphan state. Use the timeline key.
- ❌ Rejected: truncating `items` by `items.slice(0, limit)`. Would treat a workspace group with 8 children as 1 row toward the limit — plan line 134 explicitly forbids.
- ❌ Rejected: partial workspace inclusion (trim children of a workspace group). Two visible states for the same group is confusing; the existing `WorkspaceCollapse` already has its own expand/collapse. **Workspace groups are all-or-nothing.**
- ❌ Rejected: re-ordering items by size to fit more under the budget. Items are time-sorted (descending) — reordering would break the timeline contract. A newer oversized workspace blocks older smaller items behind it; the "Show N more" click resolves this by bumping budget to the next-reveal threshold.

## Acceptance Criteria

- [ ] `Today` section's default budget is 15 _visible rows_. `Yesterday` → 10. `Recent 7 Days` → 20. `Earlier` → 20.
- [ ] Row-count rules: standalone conversation = 1 row. Workspace group with `expanded === true` = `1 + workspaceGroup.conversations.length`. Workspace group with `expanded === false` = 1.
- [ ] Effective expansion for a workspace = `collapsed || expandedWorkspacesSet.has(workspace)`. When the sidebar rail is collapsed, all workspaces are treated as expanded for row counting (because `WorkspaceCollapse` will render their children anyway).
- [ ] Items are admitted to the section in their original time-descending order. A workspace group is included whole if and only if including it does not push the section's visible-row count past the budget. If the _first_ item in the section already exceeds the budget, include it (guarantee ≥ 1 visible item per non-empty section).
- [ ] When rows remain hidden AND the sidebar rail is NOT in collapsed mode, render a "Show N more" button under the section. N = `hiddenRowCount` (visible rows hidden, including expanded workspace children — matches the row-budget mental model). A hidden expanded workspace with 10 children contributes 11 to `hiddenRowCount`, so the button reflects what the user will actually see appear.
- [ ] When `collapsed === true` (sidebar rail collapsed to icon-rail), still apply row-budget truncation using the effective-expansion rule, but do NOT render the "Show N more" button (section headers are also hidden in this mode). Hidden rows become reachable after the user expands the sidebar rail. The budget state survives the rail toggle, so previously-bumped budgets persist.
- [ ] Clicking "Show N more" bumps the section budget to `min(totalRows, max(currentBudget + baseLimit, nextRevealBudget))`. `nextRevealBudget` is the smallest budget that admits at least one currently-hidden item. So every click reveals ≥ 1 hidden item.
- [ ] Section visible window is monotonically bounded above by `totalRows`. No "Show 0 more" button. No negative count.
- [ ] Sections with `items.length === 0` are already filtered out by `groupConversationsByTimelineAndWorkspace` — no regression.
- [ ] Sections with all items fitting under the default budget show no expander.
- [ ] Pinned section is **unaffected** — truncation is timeline-sections only (master plan line 130–134 scopes this to "timeline groups").
- [ ] i18n key `conversation.history.showMore` with `{{count}}` interpolation, added under `history` in all 6 locales (`en-US`, `zh-CN`, `zh-TW`, `ja-JP`, `ko-KR`, `tr-TR`). Generated type file regenerated via `bun run i18n:types`; validated via `node scripts/check-i18n.js`. Button text is the visible label — no separate aria-label key needed.
- [ ] `useSectionVisibleBudgets` is a peer hook to `useConversations`; section-budget state is in-memory only (not persisted), per item-5 scope.
- [ ] All four pre-commit gates pass: `bun run lint:fix && bun run format && bunx tsc --noEmit && bun run test`.
- [ ] Tests at `tests/unit/cli-history/groupingHelpers.truncation.test.ts` cover every case in plan lines 540–546 plus the items listed below.

## Technical Approach

### New / changed files

| Path                                                                               | Change                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/renderer/pages/conversation/GroupedHistory/types.ts`                          | Add `SectionTimelineKey` string-literal union of the 4 timeline keys. Add `timelineKey: SectionTimelineKey` to `TimelineSection`.                                                                                      |
| `src/renderer/pages/conversation/GroupedHistory/utils/groupingHelpers.ts`          | Populate `timelineKey` on each section. Add: `getItemRowCount(item, isWorkspaceExpanded)`, `truncateSection({ items, isWorkspaceExpanded, budget })`, `getSectionDefaultLimit(timelineKey)`. Pure functions, no React. |
| `src/renderer/pages/conversation/GroupedHistory/hooks/useSectionVisibleBudgets.ts` | New hook: `{ getBudget(key), bumpBudget(key, totalRows, nextRevealBudget) }`. Stateful via `useState<Map<SectionTimelineKey, number>>`.                                                                                |
| `src/renderer/pages/conversation/GroupedHistory/index.tsx`                         | Wire helpers + hook. Compute a single `truncatedTimelineSections` via top-level `useMemo`. Render "Show N more" button via `<Button type='text' size='small'>` (Arco).                                                 |
| `src/renderer/services/i18n/locales/<lang>/conversation.json` (6 locales)          | Add `history.showMore` with `{{count}}` interpolation.                                                                                                                                                                 |
| `src/renderer/services/i18n/i18n-keys.d.ts`                                        | Regenerated via `bun run i18n:types`.                                                                                                                                                                                  |
| `tests/unit/cli-history/groupingHelpers.truncation.test.ts`                        | All cases listed under "Test cases" below.                                                                                                                                                                             |

### `truncateSection` contract

```ts
type SectionTimelineKey =
  | 'conversation.history.today'
  | 'conversation.history.yesterday'
  | 'conversation.history.recent7Days'
  | 'conversation.history.earlier';

type TruncateResult = {
  visibleItems: TimelineItem[];
  hiddenItemCount: number;
  hiddenRowCount: number;
  totalRowCount: number;
  /** Smallest budget value that would admit at least one currently-hidden item; null if nothing hidden. */
  nextRevealBudget: number | null;
};

function truncateSection(args: {
  items: TimelineItem[];
  isWorkspaceExpanded: (workspace: string) => boolean;
  budget: number;
}): TruncateResult;
```

Algorithm:

1. Walk items in original order, maintaining running `rowCount`.
2. For each item, compute `itemRows = getItemRowCount(item, isWorkspaceExpanded)`.
3. Admit the item iff `rowCount + itemRows ≤ budget`, OR the visible list is still empty (guarantee ≥ 1 item per non-empty section).
4. The first rejected item determines `nextRevealBudget = rowCount + itemRows` (i.e., the budget needed to reveal it). After the first rejection, stop admitting (preserves time order).
5. Hidden items contribute their `itemRows` to `hiddenRowCount`.

### `getItemRowCount`

```ts
function getItemRowCount(item: TimelineItem, isWorkspaceExpanded: (workspace: string) => boolean): number {
  if (item.type === 'workspace' && item.workspaceGroup) {
    return isWorkspaceExpanded(item.workspaceGroup.workspace) ? 1 + item.workspaceGroup.conversations.length : 1;
  }
  return 1;
}
```

The caller passes an `isWorkspaceExpanded` predicate that already encodes the `collapsed || expandedWorkspacesSet.has(workspace)` rule.

### `useSectionVisibleBudgets`

```ts
type SectionBudgets = ReadonlyMap<SectionTimelineKey, number>;

function useSectionVisibleBudgets(): {
  getBudget(key: SectionTimelineKey): number; // returns budget or default limit if unset
  bumpBudget(key: SectionTimelineKey, totalRows: number, nextRevealBudget: number | null): void;
};
```

`bumpBudget` sets `budget = min(totalRows, max(currentBudget + baseLimit, nextRevealBudget ?? 0))`. The `max(..., nextRevealBudget)` ensures every click reveals ≥ 1 hidden item even when the next hidden row is a large expanded workspace.

### `getSectionDefaultLimit`

```ts
const SECTION_DEFAULT_LIMIT: Record<SectionTimelineKey, number> = {
  'conversation.history.today': 15,
  'conversation.history.yesterday': 10,
  'conversation.history.recent7Days': 20,
  'conversation.history.earlier': 20,
};

function getSectionDefaultLimit(timelineKey: SectionTimelineKey): number {
  return SECTION_DEFAULT_LIMIT[timelineKey];
}
```

Exhaustive over the closed union — adding a new `SectionTimelineKey` member fails type-check until the record is updated. No silent fallback.

### `index.tsx` integration sketch

```ts
const sectionBudgets = useSectionVisibleBudgets();

const truncatedTimelineSections = useMemo(() => {
  const expandedWorkspaceSet = new Set(expandedWorkspaces);
  const isWorkspaceExpanded = (ws: string) => collapsed || expandedWorkspaceSet.has(ws);
  return timelineSections.map((section) => {
    const budget = sectionBudgets.getBudget(section.timelineKey);
    const result = truncateSection({
      items: section.items,
      isWorkspaceExpanded,
      budget,
    });
    return { section, result };
  });
}, [timelineSections, expandedWorkspaces, sectionBudgets, collapsed]);
```

Single top-level memo: `expandedWorkspaceSet` and the predicate are created inside the memo body, not as separate hooks. Memo recomputes when any input ref changes.

### i18n entries

`src/renderer/services/i18n/locales/<lang>/conversation.json` under `history`:

```json
"showMore": "Show {{count}} more"
```

Translations to add for all 6 locales — values should match each locale's existing tone for adjacent `history.*` keys. After editing JSON: `bun run i18n:types` then `node scripts/check-i18n.js`.

## Test cases (`groupingHelpers.truncation.test.ts`)

From plan §2 lines 540–546 plus the items below. Each item = at least one `it()` block. Identity translator + fake timers per the existing `tests/unit/groupingHelpers.test.ts` pattern.

1. truncates "Today" to N visible rows with correct hidden-item count
2. truncates "Earlier" independently from "Today" — separate budgets, no bleed
3. workspace group counts as `1 + children` when expanded (predicate returns true)
4. workspace group counts as `1` when collapsed (predicate returns false)
5. budget large enough → returns all items + hidden counts = 0 + `nextRevealBudget === null`
6. budget = 0 with items present → still admits the first item (always-include-first guarantee)
7. empty section → `{ visibleItems: [], hiddenItemCount: 0, hiddenRowCount: 0, totalRowCount: 0, nextRevealBudget: null }`
8. **all-or-nothing workspace inclusion** — a workspace whose addition would push past the budget is excluded entirely, and admission stops (no later smaller item is shown out of order)
9. budget boundary: section with total rows exactly equal to budget → no hidden items
10. mixed standalone-conversations + workspace groups in a single section: admitted in order until budget exhausted, then stop
11. `nextRevealBudget` equals the row count needed to admit the next hidden item
12. `getSectionDefaultLimit` returns the correct limit per timeline **key** (exhaustive over `SectionTimelineKey`). Adding a new key must fail type-check until `SECTION_DEFAULT_LIMIT` is updated.
13. `getItemRowCount` returns `1` for collapsed workspace, `1 + n` for expanded workspace, `1` for standalone conversation
14. multiple budget bumps via `useSectionVisibleBudgets.bumpBudget` reach the totalRows ceiling (no overshoot)
15. `bumpBudget` with `nextRevealBudget > currentBudget + baseLimit` uses `nextRevealBudget` (click reveals ≥ 1 hidden item even when the next hidden row is large)
16. **Pinned isolation**: render-level test asserting that with `pinnedConversations.length > 30`, all pinned rows render and no "Show N more" button appears in the pinned region. (Structural guarantee — pinned rendering does not pass through `truncateSection`.)
17. **Collapsed rail mode**: render-level test asserting that with `collapsed === true`, "Show N more" buttons are NOT rendered even if rows are hidden.

Coverage target ≥ 80% on the new module + new hook (the hook is a React hook, tested via `renderHook`).

## E2E verification (per Amendment 2026-05-10)

Item 5 is sidebar UI. `mac-computer-use` is **required**. Attempt to launch AionUi dev mode and drive it via screenshots + accessibility tree to verify:

- Sections truncate to the configured defaults after seeding ≥ 30 conversations in "Today".
- Clicking "Show N more" extends the visible window by the default limit (or further when the next hidden row is a big workspace).
- All imported rows are reachable after enough clicks — total rendered eventually == total imported (no silent drops).
- Workspace-group rows expand independently and contribute to the section's row count correctly.

If `mac-computer-use` cannot drive AionUi from this sub-session (no display, Electron headless restrictions — same outcome as items 3/4 per `decisions.md` history), document the gap with a precise manual-verification recipe in `decisions.md`. Do NOT silently skip.

## Risks

- **Stale budget state if dataset shrinks**: budget is clamped to `totalRows` on each bump and on each render via the `min(totalRows, ...)` in `bumpBudget`. The render path itself ignores out-of-range budgets because `truncateSection` re-derives `visibleItems` from scratch.
- **Workspace toggle re-renders sections containing that workspace**: truncation depends on `expandedWorkspaceSet`. The top-level memo's dependency on `expandedWorkspaceSet` causes re-truncation only when that set changes. Cost is O(sections × items) per re-truncation — bounded by `4 × items.length`, which is fine.
- **i18n drift**: untranslated locale would surface raw key. Mitigation: add the key in all 6 locales in the same commit; `node scripts/check-i18n.js` enforces parity.
- **Off-by-one in greedy truncation**: easy to write `<` vs `<=`. Mitigation: tests 9 (exact-budget) + 6 (always-include-first) + 8 (stop-on-first-overflow) catch the common cases.

## Out of scope (item 6+)

- Filter dropdown (source = all / claude_code / copilot / native) → item 6.
- Search bar → item 6.
- "View all history" / full-history view link → item 9.
- Persisting expand/budget state across sessions → not in this item.
- Conversation-name truncation (existing CSS-clip behavior) → unchanged.

## Done means

PR open against `kflili/AionUi`, `feat/cli-history-sidebar-truncation` → `main`. All four pre-commit gates green. Tests at the required path covering every plan line 540–546 case + decisions documented above. Bots clean. `/complete-pr` finishes the merge.
