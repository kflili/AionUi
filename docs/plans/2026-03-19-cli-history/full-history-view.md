# Item 9 — Full History View (full-screen panel)

| Field       | Value                                                                         |
| ----------- | ----------------------------------------------------------------------------- |
| Status      | Implemented                                                                   |
| Priority    | High                                                                          |
| Complexity  | High                                                                          |
| Depends On  | Items 0–8 (importer + source badge + sidebar filter/truncation + resume)      |
| Parent plan | `docs/plans/2026-03-19-cli-history/plan.md` (lines 147–170, 453–460, 612–642) |
| Branch      | `feat/cli-history-full-history-view`                                          |

## TL;DR

The sidebar (items 4–6) is the recent-work launcher. The full history view is the archive browser — a dedicated full-screen route that lists **every** conversation in the database with rich filtering (source chips multi-select, workspace dropdown, date-range presets + custom, name+workspace search, sort by date/name) and virtuoso-backed virtual scrolling. Sidebar gets a "View all history" entry-point in the footer, and each timeline section gains a "Show all" link that deep-links into the page. Clicking a row from the history view honors the existing transcript-mode gate (item 3) and resume-imported gate (item 8) — same `useNavigate('/conversation/:id')` path the sidebar already uses.

## Context

- Plan §"Full History View" (lines 147-170) — entry points, layout, filters, sort, pagination.
- Plan §453-460 — acceptance checklist boxes.
- Plan §612-642 — Manual E2E checklist.
- Item 4 (`SourceBadge`, PR #21) — chip primitive at `src/renderer/pages/conversation/GroupedHistory/parts/SourceBadge.tsx`. Reuse verbatim.
- Item 6 (`applySidebarFilter`, PR #23) — pure filter helper at `src/renderer/pages/conversation/GroupedHistory/utils/sidebarFilterHelpers.ts` with `SidebarFilterSource = 'all' | 'claude_code' | 'copilot' | 'native'`. The history view extends this surface — multi-select source set, plus workspace + date-range filters layered on top.
- Item 5 (`groupingHelpers.ts`, PR #22) — `SectionTimelineKey` lookup; not used directly by the page module, but referenced by the "Show all" sidebar link that opens the history view scoped to a single timeline section.
- Item 3 + Item 8 — clicking a conversation row navigates to `/conversation/:id`; the existing `ChatConversation` already handles transcript-mode + resume-imported gating.
- Routing — `src/renderer/components/layout/Router.tsx` uses HashRouter with `withRouteFallback(...)`. Pattern: add a route under `<Route element={<ProtectedLayout layout={layout} />}>`.
- Virtual scroll — `react-virtuoso ^4.18.1` is already in `package.json` (no new dep needed).
- IPC — `ipcBridge.database.searchConversationMessages` exists and is already used by `ConversationSearchPopover.tsx` for hydrated-message search. The history view uses the same IPC when the user opts into message-content search.

## Key Decisions

- ✅ **New page module at `src/renderer/pages/history/`** rather than nesting inside `pages/conversation/GroupedHistory/` — the full-history view replaces the main content area (route-level), not the sidebar. Separate module = separate concerns.
- ✅ **Reuse `SourceBadge`** for the row's source chip. Reuse the source-mapping logic (`claude_code → CC orange`, `copilot → CP blue`, others/null → no badge).
- ✅ **Source filter is multi-select** via a `Set<SidebarFilterSource>` — extends item 6's single-value `SidebarFilterSource`. Empty set + active filter = no rows; the UI keeps an "All sources" affordance that selects every source at once, mapped to "filter inactive" internally. Native admits `source === 'aionui' || source == null` (same rule as item 6).
- ✅ **Workspace filter is a dropdown** (Arco `Select` with `mode='multiple'`) populated from the union of `extra.workspace` values across all conversations — same source as item 5's workspace expansion logic. Includes a special "(No workspace)" option for rows without `extra.workspace`.
- ✅ **Date range filter** — three quick presets (`Last 7 days`, `Last 30 days`, `All time`) plus a custom range via Arco `DatePicker.RangePicker`. The active preset persists in component state; "All time" is the default.
- ✅ **Search is name+workspace only by default**; checking a "Include message content" toggle layers in an async hydrated-only message search via `ipcBridge.database.searchConversationMessages`. The toggle surfaces a "Some sessions not yet indexed for message search" inline notice when non-hydrated rows exist in the current visible set (plan checkbox §642).
- ✅ **Sort options** — `<Select>` with `date` (default) / `name`. Sort happens after filter and respects current locale's `localeCompare` for name.
- ✅ **Virtual scrolling via `react-virtuoso`** — rendering thousands of rows without a virtualizer freezes the UI; `Virtuoso` is already in the dep tree. Fixed-height rows (~64px) + dynamic measurement disabled — keeps DOM-count low.
- ✅ **Sidebar entry-point** — "View all history" link in `Sider.tsx` footer (above the settings button). Navigates to `/history`.
- ✅ **Per-section "Show all" link** — appears in `GroupedHistory/index.tsx` next to each timeline section header. Navigates to `/history?section=<timelineKey>` (deep link). The history page reads the query param and pre-applies a date filter that matches the section.
- ✅ **Filter state lives in `useHistoryFilter`** — local component state (no persistence); navigating away clears it. Plan does not require persistence.
- ✅ **No keyboard shortcut** — plan line 156 says "TBD". R3 deferral; documented in `decisions.md`.
- ❌ Rejected: extending `applySidebarFilter` in-place to do multi-source. Would break item 6's call-sites (sidebar still uses single-source `Select`). Build `applyHistoryFilter` as a new pure helper that **calls** `matchesSource` / `matchesSearch` semantics consistent with item 6.
- ❌ Rejected: nesting the page under `GroupedHistory/`. That module is at the 10-child cap (item-4 decision). The page is a top-level surface, not a sidebar partial.
- ❌ Rejected: rendering via `WorkspaceGroupedHistory` directly. The grouped-by-timeline sidebar layout is wrong for an archive view — the user wants a flat scrollable list with rich filters, not collapsed workspace groups.
- ❌ Rejected: server-side / IPC-side filtering. All conversations already live in renderer state via `useConversationListSync`. Client-side filtering keeps the page snappy and reuses item-6 contracts. Only message-content search hits IPC.
- ❌ Rejected: persisting filter state across navigation. Plan does not require it; matches sidebar filter behavior (item 6) which is also non-persisting.

## Acceptance Criteria

- [ ] New route `/history` renders the `HistoryPage` component. Reachable via:
  - "View all history" link at the bottom of the sidebar
  - "Show all" link in each timeline section header (in `WorkspaceGroupedHistory`)
- [ ] Source filter renders as inline chips: `Claude Code`, `Copilot`, `Native`. Multi-select via toggling chips. "All sources" reset chip clears selection (returns to `Set{'all'}` semantics — no narrowing).
- [ ] Workspace filter renders as Arco `Select` with `mode='multiple'`. Options include every distinct `extra.workspace` value present in `conversations`, plus a special "(No workspace)" option matching rows where `extra.workspace` is missing/empty.
- [ ] Date range filter — preset buttons (`Last 7 days`, `Last 30 days`, `All time`) + custom range via `DatePicker.RangePicker`. Default = `All time`. Date matched against `conversation.modifyTime` (the most-recent activity timestamp the importer uses; ties to plan line 165 "by date").
- [ ] Search input — name+workspace match by default (case-insensitive, same `matchesSearch` semantics as item 6). Toggle "Include message content" performs an additional async IPC search restricted to hydrated sessions. While loading, show a small spinner; on completion merge the message-match IDs into the visible set. If the toggle is on AND any visible row is non-hydrated, show the notice "Some sessions not yet indexed for message search" (plan §642).
- [ ] Sort — Arco `Select` with `By date (newest)` (default) and `By name`. Stable sort for ties.
- [ ] Virtuoso-backed list renders rows of `~64px`. DOM contains only the visible window plus a small overscan (default Virtuoso behavior). Total row count is shown at the top of the page (`{{count}} sessions`).
- [ ] Each row shows: conversation title (with workspace as muted subtitle), CC/CP badge if imported (reuse `SourceBadge`), date (modifyTime, locale-formatted). Clicking the row navigates to `/conversation/:id` — opens transcript mode / resume / live conversation per items 3, 8.
- [ ] Empty state when filters narrow to zero rows: "No conversations match your filters" with a Reset button (matches item 6's empty-state pattern).
- [ ] Empty state when the database has zero conversations: "No chat history" (reuse existing `conversation.history.noHistory` key).
- [ ] i18n — every new user-facing string is keyed under `conversation.fullHistory.*` and translated in all 6 locales (`en-US`, `zh-CN`, `zh-TW`, `ja-JP`, `ko-KR`, `tr-TR`). `bun run i18n:types` regenerated; `node scripts/check-i18n.js` passes.
- [ ] **Sidebar "View all history" link** — rendered in `Sider.tsx` between `<WorkspaceGroupedHistory>` and the footer. Always visible; collapses to icon-only via existing `collapsed-hidden` class.
- [ ] **Sidebar "Show all" link** — rendered next to each `TimelineSection` header in `WorkspaceGroupedHistory/index.tsx`. Visible only when `!collapsed` and the section has at least one item. Navigates to `/history?section=<timelineKey>`.
- [ ] Tests — pure helpers (`applyHistoryFilter`, `sortConversations`, `collectWorkspaceOptions`, `matchesDateRange`), hook (`useHistoryFilter`), DOM render of the page (filter chip multi-select, workspace narrowing, date preset, search, sort, empty state, virtuoso DOM-count assertion, message-search toggle indicator, "View all" navigation, row-click handoff to `/conversation/:id`).
- [ ] All four pre-commit gates pass: `bun run lint:fix && bun run format && bunx tsc --noEmit && bun run test`.
- [ ] Directory cap — `src/renderer/pages/history/` (new) ≤ 10 direct children; `src/renderer/components/layout/` and `src/renderer/pages/conversation/GroupedHistory/` unchanged in direct-child count.

## Technical Approach

### New / changed files

| Path                                                                      | Change                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/renderer/pages/history/HistoryPage.tsx`                              | NEW — top-level route element. Composes filter bar + virtuoso list + empty state.                                                                                                                                                                                                                      |
| `src/renderer/pages/history/components/HistoryFilterBar.tsx`              | NEW — source chips multi-select + workspace `Select` + date `RangePicker` + presets + search input + message-content toggle + sort `Select` + reset button.                                                                                                                                            |
| `src/renderer/pages/history/components/HistoryRow.tsx`                    | NEW — row UI: title, workspace subtitle, source badge, date. Click handler navigates to `/conversation/:id`.                                                                                                                                                                                           |
| `src/renderer/pages/history/components/HistoryList.tsx`                   | NEW — `Virtuoso` wrapper that renders `HistoryRow` rows. Renders the "{{count}} sessions" header.                                                                                                                                                                                                      |
| `src/renderer/pages/history/hooks/useHistoryFilter.ts`                    | NEW — React hook holding filter state (source set, workspace set, date range, search, message-toggle, sort). Returns criteria + setters + `reset()`. Initializes from `?section=` query param.                                                                                                         |
| `src/renderer/pages/history/utils/historyFilterHelpers.ts`                | NEW — pure helpers: `HistoryFilterCriteria` type, `DEFAULT_HISTORY_FILTER`, `applyHistoryFilter`, `sortConversations`, `collectWorkspaceOptions`, `matchesDateRange`, preset → date-range conversion, `isHistoryFilterActive`.                                                                         |
| `src/renderer/components/layout/Router.tsx`                               | EDIT — add `<Route path='/history' element={withRouteFallback(History)} />` and lazy import.                                                                                                                                                                                                           |
| `src/renderer/components/layout/Sider.tsx`                                | EDIT — add "View all history" link above the settings button.                                                                                                                                                                                                                                          |
| `src/renderer/pages/conversation/GroupedHistory/index.tsx`                | EDIT — render "Show all" link next to each timeline section header (when `!collapsed`).                                                                                                                                                                                                                |
| `src/renderer/services/i18n/locales/<lang>/conversation.json` (6 locales) | EDIT — add `fullHistory.*` block with title, filter labels, sort labels, date presets, empty-state copy, "View all history", "Show all", row count, etc.                                                                                                                                               |
| `src/renderer/services/i18n/i18n-keys.d.ts`                               | REGEN — `bun run i18n:types`.                                                                                                                                                                                                                                                                          |
| `tests/unit/cli-history/historyFilterHelpers.test.ts`                     | NEW — pure-helper tests (filter + sort + workspace collection + date-range).                                                                                                                                                                                                                           |
| `tests/unit/cli-history/historyView.dom.test.tsx`                         | NEW — DOM render tests (filter chips, workspace narrowing, date preset, search, sort, virtuoso DOM, message-search toggle indicator, empty state, row click).                                                                                                                                          |
| `tests/e2e/specs/full-history.e2e.ts`                                     | NEW — Playwright + Electron spec automating the parts of plan §634 manual checklist that don't require real CLI history (sidebar "View all" → page renders, source chip narrows seeded fixtures, virtuoso scroll, row click navigates). Falls back to manual recipe if Electron e2e isn't viable here. |

### `HistoryFilterCriteria` shape

```ts
export type HistoryDatePreset = 'last7' | 'last30' | 'all' | 'custom';

export type HistorySortKey = 'date' | 'name';

export type HistoryFilterCriteria = {
  /** Multi-select source set. Empty Set means "filter inactive" (admit all). */
  sources: ReadonlySet<SidebarFilterSource>;
  /** Multi-select workspace set. Empty Set = inactive. Special token '__none__' = rows without extra.workspace. */
  workspaces: ReadonlySet<string>;
  preset: HistoryDatePreset;
  customRange: { from: number | null; to: number | null };
  search: string;
  /** When true, message-content search via searchConversationMessages IPC also contributes matches. */
  includeMessageContent: boolean;
  sort: HistorySortKey;
};
```

### Pipeline order

```
all conversations
  → applyHistoryFilter(criteria, messageMatchIds?)
  → sortConversations(criteria.sort)
  → virtuoso renders
```

`applyHistoryFilter` is pure. The async message-content match (when `includeMessageContent === true` and `search !== ''`) runs in `HistoryPage` via `useEffect` against `searchConversationMessages` IPC; the resulting `Set<conversationId>` is passed into `applyHistoryFilter` as an optional fourth argument and is OR-ed with the name+workspace match.

### `applyHistoryFilter` semantics

```ts
export const applyHistoryFilter = (
  conversations: TChatConversation[],
  criteria: HistoryFilterCriteria,
  messageMatchIds?: ReadonlySet<string>
): TChatConversation[] => {
  if (!isHistoryFilterActive(criteria) && !messageMatchIds) return conversations;
  const needle = criteria.search.trim().toLowerCase();
  return conversations.filter((conversation) => {
    if (!matchesSourceSet(conversation, criteria.sources)) return false;
    if (!matchesWorkspaceSet(conversation, criteria.workspaces)) return false;
    if (!matchesDateRange(conversation, criteria)) return false;
    if (needle === '') return true;
    // text needle: name+workspace OR message-content (if toggle on AND ID matched)
    const textMatch = matchesNameOrWorkspace(conversation, needle);
    const messageMatch = criteria.includeMessageContent && messageMatchIds?.has(conversation.id) === true;
    return textMatch || messageMatch;
  });
};
```

### Sidebar "View all history" + "Show all"

Sider footer addition (between WorkspaceGroupedHistory and the existing footer divider):

```tsx
<Tooltip {...siderTooltipProps} content={t('conversation.fullHistory.viewAllTooltip')} position='right'>
  <div onClick={() => navigate('/history')} className='...sider-link-classes...'>
    <BookOne theme='outline' size='20' fill={iconColors.primary} />
    <span className='collapsed-hidden text-t-primary'>{t('conversation.fullHistory.viewAll')}</span>
  </div>
</Tooltip>
```

`GroupedHistory/index.tsx` section header gets a `<Link>` (or onClick navigate) next to the section title — visible only when `!collapsed`.

### Routing

`Router.tsx`:

```tsx
const History = React.lazy(() => import('@renderer/pages/history/HistoryPage'));
// inside the protected layout block:
<Route path='/history' element={withRouteFallback(History)} />;
```

### i18n keys (new, under `conversation.fullHistory`)

- `pageTitle` — "All History"
- `viewAll` — "View all history"
- `viewAllTooltip` — "View all history"
- `showAll` — "Show all"
- `sessionCount` — "{{count}} session" (use ICU/plural pattern if the project already uses one; otherwise two keys `sessionCount_one` / `sessionCount_other`)
- `filter.sourceLabel` / `filter.workspaceLabel` / `filter.dateLabel` / `filter.sortLabel`
- `filter.allSources` — "All sources"
- `filter.workspacesPlaceholder` — "All workspaces"
- `filter.noneWorkspace` — "(No workspace)"
- `filter.datePreset.last7` / `filter.datePreset.last30` / `filter.datePreset.all` / `filter.datePreset.custom`
- `filter.search` — search input placeholder
- `filter.includeMessageContent` — "Include message content"
- `filter.messageIndexNotice` — "Some sessions not yet indexed for message search"
- `filter.reset` — "Reset filters"
- `sort.date` — "By date (newest)"
- `sort.name` — "By name"
- `empty.noMatches` — "No conversations match your filters"

All 6 locales translated.

### Tests

#### `tests/unit/cli-history/historyFilterHelpers.test.ts` (pure)

1. inactive criteria → returns input array identity (no allocation)
2. single-source filter (`{'claude_code'}`) → drops Copilot + Native
3. multi-source filter (`{'claude_code', 'copilot'}`) → drops Native only
4. workspace filter narrows to selected workspaces only
5. workspace filter with `'__none__'` token admits rows where `extra.workspace` is missing/empty
6. date preset `last7` → admits rows with `modifyTime >= now - 7d`
7. date preset `last30` → admits rows with `modifyTime >= now - 30d`
8. date preset `all` → admits everything regardless of modifyTime
9. date custom range → admits rows in `[from, to]` inclusive
10. search needle case-insensitive matches conversation `name`
11. search needle matches `extra.workspace` substring
12. search needle with `includeMessageContent` admits rows in `messageMatchIds` even if name/workspace don't match
13. combined criteria (source ∩ workspace ∩ date ∩ search) — AND semantics
14. `collectWorkspaceOptions` returns sorted unique workspace strings + `'__none__'` token when at least one row has no workspace
15. `collectWorkspaceOptions` returns no `'__none__'` token when all rows have workspaces
16. `sortConversations('date')` sorts by `modifyTime` descending, stable on ties
17. `sortConversations('name')` sorts by `name` ascending (locale-aware), stable on ties
18. `matchesDateRange` with `customRange.from === null` and `customRange.to === null` admits everything when preset === 'custom'
19. `matchesDateRange` boundary: row at `customRange.from` exact timestamp → admitted
20. `isHistoryFilterActive` — false for `DEFAULT_HISTORY_FILTER`, true when any axis narrows
21. Defensive: `extra: null` rows are not dropped (treated as "no workspace")
22. Defensive: `name: undefined` rows match an empty needle; do not match any non-empty needle

#### `tests/unit/cli-history/historyView.dom.test.tsx` (DOM)

1. Initial render shows full count of seeded conversations
2. Clicking a source chip narrows the list and updates the count
3. Clicking multiple source chips selects multiple sources (multi-select)
4. Clicking "All sources" resets source selection
5. Selecting workspaces from the dropdown narrows the list
6. Clicking "Last 7 days" preset narrows by date
7. Typing in the search input narrows by name+workspace
8. Toggling "Include message content" calls `ipcBridge.database.searchConversationMessages` and merges the results
9. When non-hydrated sessions exist and message-content toggle is on, the indicator notice is visible
10. Sort `By name` reorders the list
11. Virtuoso renders fewer DOM rows than total seeded (virtualization assertion)
12. Empty state appears when filters narrow to zero rows; clicking Reset clears the filter
13. Clicking a row navigates to `/conversation/:id` (via mocked `useNavigate`)
14. Deep link `?section=conversation.history.today` pre-selects the matching date range on mount
15. Page heading shows the localized `pageTitle`
16. Source-mapping: only CC and CP show a badge; aionui / undefined / null do not

#### `tests/e2e/specs/full-history.e2e.ts` (Playwright + Electron)

Best-effort automation of the items in plan §634-642. The repo's `tests/e2e/specs/file-attach.e2e.ts` and `docs/conventions/electron-e2e-testing.md` are the references for the Electron + Playwright harness. If the harness can't be brought up from this sub-session, the test file documents the recipe at the top and is left as a placeholder (matches item-5's documented-gap pattern).

### E2E verification per Amendment 2026-05-10

Item 9 is the largest UI surface in the run — `mac-computer-use` is required. Attempt to launch AionUi dev mode and drive it via screenshots + accessibility tree to verify:

- Sidebar "View all history" link opens the page.
- Source chip narrows seeded fixtures; count matches CC/CP imports.
- Workspace dropdown shows distinct workspaces.
- Date range presets narrow the list.
- Search input filters by name; message-content toggle adds message hits and shows the indicator.
- Virtuoso scroll renders smoothly with 100+ rows.
- Clicking a row opens transcript mode for imported rows / live conversation for native.

If `mac-computer-use` cannot drive AionUi from this sub-session, document the gap in `decisions.md` with the precise manual recipe (same outcome as items 3/4/5/6/7/8 in the run — see their `decisions.md` files).

## Risks

- **Virtuoso prop mistakes** — `data` vs `totalCount` vs `itemContent` patterns. Mitigation: test 11 asserts DOM count < total (virtualization actually happens) and the Virtuoso ref is exercised in the click test.
- **Message-content search races** — typing fast triggers many IPC calls. Mitigation: debounce 200ms in `HistoryPage` and ignore stale responses by tagging each call with a request ID.
- **Workspace option collection cost** — `collectWorkspaceOptions` is O(n) per render; memoize against the conversation array reference (which `useConversationListSync` already stabilizes).
- **i18n drift across 6 locales** — same risk as items 4, 5, 6, 8. Mitigation: run `node scripts/check-i18n.js` before commit.
- **Deep-link parsing** — `?section=conversation.history.today` must map deterministically to a date preset. Mitigation: a small lookup table in `useHistoryFilter`; unrecognized values fall back to `'all'`.
- **Boy Scout temptation: generalize `applySidebarFilter`** — declined. The sidebar uses single-source + name+workspace search, while history uses multi-source + workspace set + date range + optional message-content. Sharing internals (matchesSource, matchesNameOrWorkspace) is fine; sharing the top-level shape would require breaking item 6's call-sites. Keep separate, share leaf helpers.

## Out of scope

- Keyboard shortcut to open the history view — plan line 156 says "TBD". R3 deferral; surface in `decisions.md`.
- Persisting filter state across navigation — plan does not require.
- Multi-tab / chip-style workspace filter — chose `Select mode='multiple'` for compactness; chips can come later if UX demands.
- Bulk operations (batch export, batch delete) from the history view — out of scope; sidebar already covers batch operations.

## Done means

PR open against `kflili/AionUi`, `feat/cli-history-full-history-view` → `main`. All four pre-commit gates green. Tests at the required paths covering the acceptance list above. Bots clean (`/fix-pr-feedback-loop`). `/complete-pr` finishes the merge.
