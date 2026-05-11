/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  DEFAULT_HISTORY_FILTER,
  type HistoryDatePreset,
  type HistoryFilterCriteria,
  type HistorySortKey,
  type HistorySourceFilter,
  sectionKeyToInitialFilter,
} from '../utils/historyFilterHelpers';

export type UseHistoryFilterResult = {
  criteria: HistoryFilterCriteria;
  setSources: (next: ReadonlySet<HistorySourceFilter>) => void;
  toggleSource: (value: HistorySourceFilter) => void;
  setWorkspaces: (next: ReadonlySet<string>) => void;
  setPreset: (preset: HistoryDatePreset) => void;
  setCustomRange: (range: { from: number | null; to: number | null }) => void;
  setSearch: (search: string) => void;
  setIncludeMessageContent: (value: boolean) => void;
  setSort: (sort: HistorySortKey) => void;
  reset: () => void;
};

const initFromSearchParam = (sectionParam: string | null): HistoryFilterCriteria => {
  if (!sectionParam) return DEFAULT_HISTORY_FILTER;
  const { preset, customRange } = sectionKeyToInitialFilter(sectionParam);
  return { ...DEFAULT_HISTORY_FILTER, preset, customRange };
};

export const useHistoryFilter = (): UseHistoryFilterResult => {
  const [searchParams] = useSearchParams();
  const sectionParam = searchParams.get('section');
  const [criteria, setCriteria] = useState<HistoryFilterCriteria>(() => initFromSearchParam(sectionParam));

  // Re-apply the deep-link preset/customRange when the `?section=` param
  // changes while we're already on /history (e.g. user clicks "Show all" on
  // a different sidebar section). We track the last-applied param so user
  // interactions that change filter state (chip clicks, search, etc.) don't
  // get reset on every render — only true param transitions reapply.
  const lastAppliedSectionRef = useRef<string | null>(sectionParam);
  useEffect(() => {
    if (sectionParam === lastAppliedSectionRef.current) return;
    lastAppliedSectionRef.current = sectionParam;
    setCriteria(initFromSearchParam(sectionParam));
  }, [sectionParam]);

  const setSources = useCallback((next: ReadonlySet<HistorySourceFilter>) => {
    setCriteria((prev) => ({ ...prev, sources: next }));
  }, []);

  const toggleSource = useCallback((value: HistorySourceFilter) => {
    setCriteria((prev) => {
      const next = new Set(prev.sources);
      if (next.has(value)) {
        next.delete(value);
      } else {
        next.add(value);
      }
      return { ...prev, sources: next };
    });
  }, []);

  const setWorkspaces = useCallback((next: ReadonlySet<string>) => {
    setCriteria((prev) => ({ ...prev, workspaces: next }));
  }, []);

  const setPreset = useCallback((preset: HistoryDatePreset) => {
    setCriteria((prev) => {
      // Switching away from custom resets the custom range so a later return to
      // 'custom' starts clean. Switching INTO 'custom' preserves the existing range.
      const customRange = preset === 'custom' ? prev.customRange : { from: null, to: null };
      return { ...prev, preset, customRange };
    });
  }, []);

  const setCustomRange = useCallback((range: { from: number | null; to: number | null }) => {
    setCriteria((prev) => ({ ...prev, preset: 'custom', customRange: range }));
  }, []);

  const setSearch = useCallback((search: string) => {
    setCriteria((prev) => ({ ...prev, search }));
  }, []);

  const setIncludeMessageContent = useCallback((value: boolean) => {
    setCriteria((prev) => ({ ...prev, includeMessageContent: value }));
  }, []);

  const setSort = useCallback((sort: HistorySortKey) => {
    setCriteria((prev) => ({ ...prev, sort }));
  }, []);

  const reset = useCallback(() => {
    setCriteria(DEFAULT_HISTORY_FILTER);
  }, []);

  return useMemo(
    () => ({
      criteria,
      setSources,
      toggleSource,
      setWorkspaces,
      setPreset,
      setCustomRange,
      setSearch,
      setIncludeMessageContent,
      setSort,
      reset,
    }),
    [
      criteria,
      setSources,
      toggleSource,
      setWorkspaces,
      setPreset,
      setCustomRange,
      setSearch,
      setIncludeMessageContent,
      setSort,
      reset,
    ]
  );
};
