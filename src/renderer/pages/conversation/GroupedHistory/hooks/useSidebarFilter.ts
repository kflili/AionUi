/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useState } from 'react';

import { useAgentCliConfig } from '@/renderer/hooks/agent/useAgentCliConfig';

import {
  DEFAULT_SIDEBAR_FILTER,
  isSidebarFilterActive,
  type SidebarFilterCriteria,
  type SidebarFilterSource,
} from '../utils/sidebarFilterHelpers';

export type SidebarFilterState = {
  /** Whether the filter UI should render at all (true when CLI history import is enabled). */
  visible: boolean;
  criteria: SidebarFilterCriteria;
  /** True iff at least one of source/search is narrowed. */
  isActive: boolean;
  setSource: (source: SidebarFilterSource) => void;
  setSearch: (search: string) => void;
  reset: () => void;
};

/**
 * State + visibility for the sidebar source-filter + search controls.
 *
 * Visibility tracks whether CLI history import is enabled (either
 * `importClaudeCode` or `importCopilot` in `agentCli.config`). When neither
 * import flag is on, the filter bar stays hidden and the criteria stays at
 * its default so the existing sidebar surface is byte-identical for native
 * users.
 *
 * Visibility is also `false` while `useAgentCliConfig()` returns `undefined`
 * (initial load in flight) — avoids a flash of the bar before we know whether
 * to render it.
 */
export const useSidebarFilter = (): SidebarFilterState => {
  const config = useAgentCliConfig();
  const visible = Boolean(config?.importClaudeCode || config?.importCopilot);

  const [criteria, setCriteria] = useState<SidebarFilterCriteria>(DEFAULT_SIDEBAR_FILTER);

  const setSource = useCallback((source: SidebarFilterSource) => {
    setCriteria((prev) => (prev.source === source ? prev : { ...prev, source }));
  }, []);

  const setSearch = useCallback((search: string) => {
    setCriteria((prev) => (prev.search === search ? prev : { ...prev, search }));
  }, []);

  const reset = useCallback(() => {
    setCriteria(DEFAULT_SIDEBAR_FILTER);
  }, []);

  return {
    visible,
    criteria,
    isActive: isSidebarFilterActive(criteria),
    setSource,
    setSearch,
    reset,
  };
};
