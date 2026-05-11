/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useMemo, useState } from 'react';

import type { SectionTimelineKey } from '../types';
import { getSectionDefaultLimit } from '../utils/groupingHelpers';

export type SectionVisibleBudgets = {
  /** Current row-budget for a section, falling back to its default limit. */
  getBudget: (key: SectionTimelineKey) => number;
  /**
   * Increase a section's visible-row budget by its default limit.
   * The new budget is clamped at `totalRowCount` and floored at `nextRevealBudget`
   * (when provided) so a click guarantees at least one previously-hidden item appears.
   */
  bumpBudget: (key: SectionTimelineKey, totalRowCount: number, nextRevealBudget: number | null) => void;
};

/**
 * Per-section row-budget state for the GroupedHistory sidebar.
 *
 * Budgets are stored as a Map keyed by timeline key. A missing entry means the
 * section is at its default limit (i.e., the user has never clicked "Show N more"
 * for that section in this session). State is in-memory only — not persisted
 * across sessions, per item-5 scope.
 */
export const useSectionVisibleBudgets = (): SectionVisibleBudgets => {
  const [budgets, setBudgets] = useState<ReadonlyMap<SectionTimelineKey, number>>(() => new Map());

  const getBudget = useCallback(
    (key: SectionTimelineKey): number => {
      const stored = budgets.get(key);
      return stored ?? getSectionDefaultLimit(key);
    },
    [budgets]
  );

  const bumpBudget = useCallback((key: SectionTimelineKey, totalRowCount: number, nextRevealBudget: number | null) => {
    setBudgets((prev) => {
      const baseLimit = getSectionDefaultLimit(key);
      const currentBudget = prev.get(key) ?? baseLimit;
      const incremented = currentBudget + baseLimit;
      const required = nextRevealBudget ?? 0;
      const nextBudget = Math.min(totalRowCount, Math.max(incremented, required));
      if (nextBudget === currentBudget) return prev;
      const next = new Map(prev);
      next.set(key, nextBudget);
      return next;
    });
  }, []);

  return useMemo(() => ({ getBudget, bumpBudget }), [getBudget, bumpBudget]);
};
