# Plan: Source Badge (CC / CP chips on imported sidebar rows)

**Status:** Implemented in PR #21 (merged 2026-05-11, sha `846dac88`).

Sub-plan under `docs/plans/2026-03-19-cli-history/plan.md` — item 4 of the cli-history orchestration run.

## Context

The CLI-history importer (items 1+2, merged) populates `TChatConversation.source` with one of three populated values: `'claude_code'`, `'copilot'`, or (default for native rows) `'aionui'` / `undefined`. The current sidebar (`GroupedHistory/ConversationRow.tsx`) gives no visual indication of origin — users cannot tell at a glance whether a row was imported from a CLI tool or created natively inside AionUi.

The cli-history parent plan (lines 191–204) specifies a 2-letter source chip ("CC" orange for Claude Code, "CP" blue for Copilot, no chip for native, Codex "CX" deferred to V2) placed in the trailing area of the row, distinct from the leading agent-backend icon (different axes: backend = "who handles this conversation now", source = "where this conversation was started").

Test plan §4 (parent plan lines 560–567) names the file `sourceBadge.dom.test.ts` and lists six required cases.

## Objectives

- Users can visually distinguish imported (CC / CP) vs native rows in the sidebar at a glance.
- The badge does not collide with the leading icon, conversation name, unread dot, or hover-revealed action menu.
- Unknown / malformed source values render no badge (fail-soft — no crash on data drift).
- No new lint/format/type errors. All existing tests still pass.
- ≥ 80% unit-test coverage on the new component, covering every branch.

## Approach

### Component layout — single source-of-truth mapping table

A new `SourceBadge` component owns a small `Record`-style mapping from populated source literal to `{ chip, color, i18nKey }`. Any source not present in the map renders `null`. This is the fail-soft contract: native (`'aionui'` / `undefined`), unknown CLI source (`'codex'`, `'gemini'`, etc.), and malformed metadata (`null`, `number`, `object`) all hit the same default-return branch.

```
Source → { chip, color, i18nKey }
  'claude_code' → { 'CC', 'orange',  'conversation.history.source.claudeCode' }
  'copilot'     → { 'CP', 'arcoblue', 'conversation.history.source.copilot' }
  (anything else) → null
```

The mapping is exported alongside the component so unit tests can iterate it without re-declaring strings.

### Primitive: Arco `<Tag>`

The project already uses `<Tag color='arcoblue' size='small'>` (see `src/renderer/components/chat/ThoughtDisplay.tsx:45`) and `<Tag color='gray' size='small'>` (see `src/renderer/components/settings/SettingsModal/contents/channels/ChannelHeader.tsx`). `<Tag>` accepts Arco's named color palette (`'orange'`, `'arcoblue'`, etc.) which already maps to the project's theme tokens — no hardcoded hex, no new CSS Module needed.

Using `<Tag>` means we inherit:

- Light/dark theme adaptation via Arco color tokens
- Consistent typography (`size='small'`)
- No need to add a sibling `.module.css` (avoids exceeding the 10-direct-children cap in `GroupedHistory/`).

### Positioning inside ConversationRow

The row's existing structure (current `ConversationRow.tsx`):

```
<div className='chat-history__item ... flex justify-start items-center group'>
  [Checkbox if batchMode]
  [Spin if isGenerating ELSE leading icon]            <- agent backend
  <FlexFullContainer flex-1 collapsed-hidden ...>     <- name + tooltip
  {unread dot}                                        <- absolute right-10px, group-hover:hidden
  {trailing menu block}                               <- absolute, visible when isMobile||isPinned||menuVisible, else hover-revealed
</div>
```

The chip is rendered as a **flex sibling immediately after `FlexFullContainer` and before the absolute-positioned unread dot / trailing menu block**. It must handle three collision cases:

1. **Unread dot at `right-10px`** (visible without hover) — chip needs right-margin reservation to avoid overlap when both are present.
2. **Action area visible without hover** (`isMobile || isPinned || menuVisible`) — `group-hover:hidden` does NOT protect these states; chip must be unconditionally hidden when those apply.
3. **Hover state** — chip needs to disappear without causing flex-reflow of unrelated row content.

Implementation (centralizes the unread-dot condition in a hoisted variable so spacing and rendering stay in sync, and treats batch mode separately because the trailing action menu is suppressed in batch mode):

```tsx
const showCompletionUnreadDot = !batchMode && hasCompletionUnread && !isGenerating;
const hideSourceBadgeForActions = !batchMode && (isMobile || isPinned || menuVisible);
const hideSourceBadgeOnHover = !batchMode && !hideSourceBadgeForActions;

<SourceBadge
  source={conversation.source}
  className={classNames(
    'flex-shrink-0 collapsed-hidden',
    showCompletionUnreadDot ? 'mr-22px' : 'mr-2px', // 10px (dot offset) + 8px (dot size) + 4px gap
    hideSourceBadgeForActions && 'hidden', // unconditional action-area states
    hideSourceBadgeOnHover && 'group-hover:invisible' // chip yields to hover-revealed menu only in non-batch, non-pinned, non-mobile, non-menu-open rows
  )}
/>;
```

`renderCompletionUnreadDot()` is updated to use the same `showCompletionUnreadDot` variable (instead of its own inline `if (batchMode || !hasCompletionUnread || isGenerating) return null`), so the condition is asserted once.

Use `group-hover:invisible` (not `hidden`) for the hover case: `invisible` preserves the layout box so adjacent siblings (including the action menu's gradient mask) don't reflow when the user crosses the hover boundary. `hidden` is used for the always-hidden states where the action area takes over the right edge. In `batchMode`, neither hover nor action-menu trailing block is active, so the chip stays fully visible — supports the "bulk-select imported sessions" use case from the parent plan.

Native rows render `null` from `SourceBadge` itself, so the className-bearing wrapper does not appear in the DOM at all — no empty span left behind. (See "Component shape" below.)

### Batch / generating / native row behavior

- `batchMode`: chip stays visible. Batch operations benefit from source visibility (e.g., bulk-deleting all imported sessions).
- `isGenerating`: chip stays visible. Source axis is orthogonal to runtime state.
- Native rows (`source === 'aionui'` or `undefined`): no chip — absence signals native, per parent plan line 203.

### i18n

Six locale `conversation.json` files (`en-US`, `ja-JP`, `ko-KR`, `tr-TR`, `zh-CN`, `zh-TW`) gain a `history.source` sub-namespace with two keys:

```json
"source": {
  "claudeCode": "Imported from Claude Code",
  "copilot": "Imported from Copilot"
}
```

Each locale receives a real translation (zh-CN, zh-TW, ja-JP, ko-KR, tr-TR — translated; English fallback is NOT acceptable for these short, common phrases). After editing, regenerate `src/renderer/services/i18n/i18n-keys.d.ts` via the project's existing script (`bun run i18n:types`, which executes `scripts/generate-i18n-types.js`). Verify the two new keys appear in the regenerated `.d.ts`.

### Accessibility

The chip is decorative + meta. To stay accessible:

- Wrap `<Tag>` in Arco `<Tooltip>` with content from i18n (matches the row's existing tooltip pattern).
- Add `aria-label` on the `<Tag>` itself, also from i18n, so screen readers announce "Imported from Claude Code" instead of just "CC".

### Type handling and fail-soft contract

`TChatConversation.source` is typed `ConversationSource | undefined` where `ConversationSource = 'aionui' | 'telegram' | 'lark' | 'dingtalk' | (string & {})`. The `(string & {})` clause means any string is a valid source at the type level. The SourceBadge prop accepts `unknown` (not `ConversationSource`) so we can defensively handle malformed runtime values (`null`, `number`, `object`) without TS narrowing rejecting the test cases.

**Important: a bare `SOURCE_MAP[source] ?? null` lookup is not fully fail-soft** — values like `'constructor'`, `'toString'`, `'__proto__'`, `'hasOwnProperty'`, `'valueOf'` resolve to inherited Object.prototype properties and would return functions instead of `undefined`. The contract requires an own-property check:

```ts
import type { I18nKey } from '@/renderer/services/i18n';

type SourceBadgeEntry = {
  chip: 'CC' | 'CP';
  color: 'orange' | 'arcoblue';
  i18nKey: I18nKey;
};

export const SOURCE_MAP = {
  claude_code: {
    chip: 'CC',
    color: 'orange',
    i18nKey: 'conversation.history.source.claudeCode',
  },
  copilot: {
    chip: 'CP',
    color: 'arcoblue',
    i18nKey: 'conversation.history.source.copilot',
  },
} as const satisfies Record<string, SourceBadgeEntry>;

export function pickEntry(source: unknown): SourceBadgeEntry | null {
  if (typeof source !== 'string') return null;
  if (!Object.prototype.hasOwnProperty.call(SOURCE_MAP, source)) return null;
  return SOURCE_MAP[source as keyof typeof SOURCE_MAP];
}
```

If `I18nKey` import path differs in this codebase (verify with `grep -n 'export.*I18nKey' src/renderer/services/i18n/i18n-keys.d.ts`), fall back to `string` for the `i18nKey` field with a comment noting the type-source.

### Component shape

`SourceBadge` is a functional component that:

1. Calls `pickEntry(props.source)`. If `null`, returns `null` (renders nothing — no wrapper span, no className target — keeps the DOM tree minimal for native rows).
2. Otherwise renders `<Tooltip content={t(entry.i18nKey)}><Tag size='small' color={entry.color} aria-label={t(entry.i18nKey)} className={props.className}>{entry.chip}</Tag></Tooltip>`.
3. Accepts `className?: string` so the parent ConversationRow can apply flex spacing / hover classes.

## Implementation Steps

1. **Create `src/renderer/pages/conversation/GroupedHistory/SourceBadge.tsx`** (new — directory goes 9 → 10 children, at AGENTS.md cap).
   - Exports default `SourceBadge`, named `SOURCE_MAP`, and named `pickEntry` (for test re-use).
   - Component props: `{ source: unknown; className?: string }`.
   - Renders `<Tooltip><Tag size='small' color={...} aria-label={...} className={className}>{chip}</Tag></Tooltip>` for known sources; returns `null` otherwise.
   - No `.module.css` sibling — Tailwind-style classes only via `className` prop on `<Tag>` if needed.

2. **Wire into `ConversationRow.tsx`** (existing file, single edit site).
   - Import `SourceBadge`.
   - Hoist three predicates near the top of the component body: `showCompletionUnreadDot = !batchMode && hasCompletionUnread && !isGenerating`, `hideSourceBadgeForActions = !batchMode && (isMobile || isPinned || menuVisible)`, `hideSourceBadgeOnHover = !batchMode && !hideSourceBadgeForActions`.
   - Update `renderCompletionUnreadDot()` to use `showCompletionUnreadDot` (single source of truth for the dot's visibility).
   - Render `<SourceBadge source={conversation.source} className={classNames('flex-shrink-0 collapsed-hidden', showCompletionUnreadDot ? 'mr-22px' : 'mr-2px', hideSourceBadgeForActions && 'hidden', hideSourceBadgeOnHover && 'group-hover:invisible')} />` as a flex sibling between `FlexFullContainer` (line 134–153) and the `renderCompletionUnreadDot()` call (line 155).
   - No change to leading icon, action menu, unread dot positioning, or pin indicator logic.

3. **Add i18n keys to all 6 locales** at `src/renderer/services/i18n/locales/<locale>/conversation.json` under `history.source`:
   - `claudeCode`: "Imported from Claude Code" (en-US baseline; translate per locale — zh-CN, zh-TW, ja-JP, ko-KR, tr-TR each receive a real translation, NOT an English fallback).
   - `copilot`: "Imported from Copilot" (translate per locale per same rule).

4. **Regenerate `src/renderer/services/i18n/i18n-keys.d.ts`** via `bun run i18n:types` (the project's `scripts/generate-i18n-types.js`). Verify by `grep -c "conversation.history.source." src/renderer/services/i18n/i18n-keys.d.ts` → expect 2.

5. **Write DOM tests at `tests/unit/cli-history/sourceBadge.dom.test.tsx`** (Vitest 4, mirrors the `transcriptMode.dom.test.tsx` pattern). Mock `react-i18next` so `t(key) = key` (testid-friendly). Mock `@arco-design/web-react`'s `Tooltip` to render children + `data-tooltip-content` attribute. **Mock `Tag` to render a stable inline element with `data-testid='source-badge'`, `data-color`, `data-size`, `className`, and forwarded `aria-label` props**, so chip / color / class / aria assertions do not depend on Arco DOM internals. Cases:
   1. renders chip with text "CC" for `source: 'claude_code'`
   2. renders chip with text "CP" for `source: 'copilot'`
   3. returns `null` (no chip) for `source: 'aionui'`
   4. returns `null` for `source: undefined`
   5. returns `null` for unknown string sources (`'codex'`, `'gemini'`, `'random-xyz'`) — does not throw
   6. returns `null` for **inherited-property strings** (`'constructor'`, `'toString'`, `'__proto__'`, `'hasOwnProperty'`, `'valueOf'`) — does not throw, must not leak a function reference. This catches a real prototype-pollution-style bug in naïve map lookups.
   7. returns `null` for malformed sources (`null`, `42`, `{}`, `[]`, `true`, `Symbol('x')`) — does not throw
   8. Tag for CC has `data-color='orange'` and `data-size='small'`; Tag for CP has `data-color='arcoblue'` and `data-size='small'`. Assert only the stable mocked Tag attributes, not Arco-generated CSS classes.
   9. Each rendered chip exposes the right i18n aria-label (mocked `useTranslation` returns the key — assert via `getByLabelText` / `aria-label` attribute equals `conversation.history.source.claudeCode` or `…copilot`)
   10. Tooltip content equals the same i18n key (via the mocked-tooltip's `data-tooltip-content` attribute)
   11. `SOURCE_MAP` enumeration test: `Object.keys(SOURCE_MAP).sort()` equals `['claude_code', 'copilot']` — guards future drift (no silent Codex/Gemini additions).
   12. `pickEntry` returned object has stable `chip`/`color`/`i18nKey` shape (smoke against future re-shaping).
   13. `className` is forwarded to the rendered Tag: render `<SourceBadge source='claude_code' className='sentinel-class group-hover:invisible' />` and assert `getByTestId('source-badge')` has both classes.
   14. `ConversationRow` class composition: render an imported non-pinned, non-mobile row with `batchMode={false}` and assert the rendered `[data-testid='source-badge']` element has `group-hover:invisible` in its className; render the same row with `batchMode={true}` and assert the element has neither `hidden` nor `group-hover:invisible` (chip stays visible in batch mode). This locks the Round-2 batch carve-out at the integration boundary, not just the unit.

6. **Run pre-commit gates**: `bun run lint:fix && bun run format && bunx tsc --noEmit && bun run test`. The new `sourceBadge.dom.test.tsx` must pass. If an unrelated pre-existing failure appears, capture the exact failing test name and confirm it reproduces against `origin/main` before AND after this change; only then proceed. Do NOT blanket-ignore unrelated failures without verification (per AGENTS.md "find root cause, never bypass" guidance).

7. **Verify directory size cap**: `ls src/renderer/pages/conversation/GroupedHistory/ | wc -l` ≤ 10 after the change.

## Success Criteria

- [ ] `SourceBadge.tsx` exists and exports default component + named `SOURCE_MAP` + named `pickEntry`.
- [ ] `ConversationRow.tsx` renders `<SourceBadge>` in the trailing area; no other change to row layout.
- [ ] All 6 locale `conversation.json` files have `history.source.{claudeCode,copilot}` keys.
- [ ] `i18n-keys.d.ts` includes the two new keys (regenerated via `bun run i18n:types`, not hand-edited).
- [ ] `tests/unit/cli-history/sourceBadge.dom.test.tsx` exists with ≥ 14 test cases, including `className` forwarding and `ConversationRow` batch/non-batch source-badge class assertions.
- [ ] `bun run test` passes; if any failure appears, capture the exact failing test name and verify the same failure reproduces against `origin/main` before AND after this change before classifying it as pre-existing.
- [ ] `bunx tsc --noEmit` passes.
- [ ] `bun run lint:fix && bun run format` produces no errors.
- [ ] `src/renderer/pages/conversation/GroupedHistory/` has ≤ 10 direct children.
- [ ] Coverage on `SourceBadge.tsx` ≥ 80% (target 100% — small component with all branches reachable).

## Risks & Mitigations

- **Risk: Arco `<Tag color='orange'>` exact color may not match the parent plan's "orange" intent visually.**
  Mitigation: Arco's named colors are theme-aware and project-conventional (already used elsewhere). If the visual is wrong, the fix is a one-line `color=` change — no deeper rework needed. Out of scope for this PR to color-pick a custom hex.

- **Risk: i18n-keys.d.ts auto-regeneration script may not exist or have a different name.**
  Mitigation: If the script is missing, hand-add the two key entries (alphabetical insertion) with a `// TODO regenerate via script` note, and flag in `decisions.md`. The file header says it's auto-generated, so prefer running the script; hand-edit is the fallback.

- **Risk: Action-menu gradient (lines 165–169 of ConversationRow) covers the chip on hover, but the chip is hidden on hover anyway. Confusion if user looks for the chip while hovering.**
  Mitigation: `group-hover:invisible` makes the chip visually disappear during non-batch hover while preserving its layout box (no row reflow); unconditional action-area states (`isMobile || isPinned || menuVisible`) use `hidden`. In batch mode neither condition applies, so the chip stays fully visible. User releases hover → chip returns. Acceptable.

- **Risk: Directory-cap cliff — adding `SourceBadge.tsx` brings `GroupedHistory/` to exactly 10 children. Any future addition under this folder will exceed the cap.**
  Mitigation: Document the cliff in `decisions.md` as a heads-up to item-5 (sidebar truncation, may add files in this folder).

- **Risk: `(string & {})` in the source type means TS won't catch a typo at the import site. Mitigation depends on tests.**
  Mitigation: SOURCE_MAP is keyed on the exact literals used in `src/process/cli-history/providers/claude.ts:62` and `copilot.ts` — grep the codebase before declaring map keys to ensure parity. The snapshot test guards future drift.

- **Risk: E2E verification gap (no display attached, headless env, empty fixture).**
  Mitigation: Per Amendment 2026-05-10 step 5 and item-3's documented norm, document the gap in `decisions.md` with a precise manual-verification recipe. Do not spin cycles trying to drive a non-running app.

## Dependencies

- Items 1+2 (importer) — MERGED. `source: 'claude_code' | 'copilot'` is reliably populated for imported rows.
- Item 3 (transcript mode) — MERGED. Established the `tests/unit/cli-history/` test convention (no relocation needed).
- Item 0 (use-agent-cli-config hook) — MERGED. Not directly used here, but confirms import surface exists.

No downstream items block on this PR. Item 6 (sidebar filter) will read source labels from i18n — keys we add here are reusable.

## Out of Scope / Deferred

- **Codex `CX` chip** — parent plan line 202 defers to V2. Δ7 R3 deferral.
- **Color customization / user theme override** — not requested. Arco color tokens follow the global theme automatically.
- **Source-grouped sidebar sections** — separate concern (item 5/6 territory).
- **Source-aware row sort order** — item 5 (sidebar truncation) territory.
- **Live recoloring on theme switch** — handled by Arco's CSS-var-based color system; no extra code needed.

## Open Questions / Deferred Decisions

### Resolved in Round 1 (GPT review)

- **Q**: Is the chip-positioning approach (`mr-2px group-hover:hidden`) sufficient?
  **A**: No — naive positioning collides with the unread dot at `right-10px` and fails to hide the chip when the action area is unconditionally visible (`isMobile || isPinned || menuVisible`). Resolved by hoisting `showCompletionUnreadDot` / `hideSourceBadgeForActions` predicates and switching to `group-hover:invisible` (preserves layout box on hover).

- **Q**: Is `SOURCE_MAP[source] ?? null` after `typeof source === 'string'` fully fail-soft?
  **A**: No — strings like `'constructor'`, `'__proto__'`, `'toString'` resolve to inherited Object.prototype properties. Resolved by gating on `Object.prototype.hasOwnProperty.call(SOURCE_MAP, source)` and adding test cases for the inherited-property class.

- **Q**: i18n regeneration command?
  **A**: `bun run i18n:types` (executes `scripts/generate-i18n-types.js`).

- **Q**: English fallback for non-English locales?
  **A**: Not acceptable — these are short common phrases; translate each.

### Resolved in Round 2 (GPT review)

- **Q**: Does `group-hover:invisible` correctly handle batchMode?
  **A**: No — applying it whenever `hideSourceBadgeForActions` is false includes batchMode, contradicting "chip stays visible in batch mode". Resolved by adding `hideSourceBadgeOnHover = !batchMode && !hideSourceBadgeForActions` and gating `group-hover:invisible` on it.

- **Q**: Is `pickEntry` a named export?
  **A**: Yes — Step 1 and Success Criteria now explicitly list `pickEntry` alongside `SOURCE_MAP`.

- **Q**: How should tests guard against Arco DOM internals?
  **A**: Mock `Tag` too (not just `Tooltip`) with a stable inline element + forwarded `data-color`, `data-size`, `className`, `aria-label`, `data-testid='source-badge'`.

### Resolved in Round 3 (GPT review)

- **Q**: Should case 8 assert Arco-generated CSS classes?
  **A**: No — the plan mocks `Tag` with stable `data-color`/`data-size` attributes. Case 8 now asserts only those, not `.arco-tag-orange` / `.arco-tag-arcoblue`.

- **Q**: Are `className` forwarding and `ConversationRow` batch-mode behavior locked by tests?
  **A**: Now yes — added case 13 (`className` pass-through) and case 14 (`ConversationRow` class composition: `group-hover:invisible` in non-batch, neither `hidden` nor `group-hover:invisible` in batch). Total ≥14 test cases. Success Criteria updated.
