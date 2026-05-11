/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useSectionVisibleBudgets } from '../../../src/renderer/pages/conversation/GroupedHistory/hooks/useSectionVisibleBudgets';

describe('useSectionVisibleBudgets', () => {
  it('returns the default limit for an untouched section', () => {
    const { result } = renderHook(() => useSectionVisibleBudgets());
    expect(result.current.getBudget('conversation.history.today')).toBe(15);
    expect(result.current.getBudget('conversation.history.yesterday')).toBe(10);
    expect(result.current.getBudget('conversation.history.recent7Days')).toBe(20);
    expect(result.current.getBudget('conversation.history.earlier')).toBe(20);
  });

  it('bumpBudget adds the section default limit on each call', () => {
    const { result } = renderHook(() => useSectionVisibleBudgets());
    act(() => {
      result.current.bumpBudget('conversation.history.today', 100, 16);
    });
    expect(result.current.getBudget('conversation.history.today')).toBe(30);
    act(() => {
      result.current.bumpBudget('conversation.history.today', 100, 31);
    });
    expect(result.current.getBudget('conversation.history.today')).toBe(45);
  });

  it('clamps the budget at totalRowCount (no overshoot)', () => {
    const { result } = renderHook(() => useSectionVisibleBudgets());
    act(() => {
      result.current.bumpBudget('conversation.history.today', 20, 16);
    });
    expect(result.current.getBudget('conversation.history.today')).toBe(20);
    act(() => {
      result.current.bumpBudget('conversation.history.today', 20, null);
    });
    expect(result.current.getBudget('conversation.history.today')).toBe(20);
  });

  it('uses nextRevealBudget when it exceeds currentBudget + baseLimit', () => {
    // A single click should reveal a large workspace even if it costs more than the baseLimit step.
    const { result } = renderHook(() => useSectionVisibleBudgets());
    act(() => {
      // Today base 15, currentBudget=15, nextRevealBudget=50 (huge workspace).
      // Expected: min(100, max(15+15=30, 50)) = 50.
      result.current.bumpBudget('conversation.history.today', 100, 50);
    });
    expect(result.current.getBudget('conversation.history.today')).toBe(50);
  });

  it('does not change state when the computed budget equals the current budget', () => {
    const { result } = renderHook(() => useSectionVisibleBudgets());
    const before = result.current;
    act(() => {
      // totalRowCount = currentBudget = default 15 means clamp keeps it at 15.
      result.current.bumpBudget('conversation.history.today', 15, null);
    });
    // The returned object reference should be stable when state didn't change.
    expect(result.current.getBudget('conversation.history.today')).toBe(15);
    // Functions are memoized: stable identity across no-op bumps.
    expect(result.current.getBudget).toBe(before.getBudget);
    expect(result.current.bumpBudget).toBe(before.bumpBudget);
  });

  it('tracks budgets per section independently', () => {
    const { result } = renderHook(() => useSectionVisibleBudgets());
    act(() => {
      result.current.bumpBudget('conversation.history.today', 100, null);
      result.current.bumpBudget('conversation.history.earlier', 100, null);
    });
    expect(result.current.getBudget('conversation.history.today')).toBe(30);
    expect(result.current.getBudget('conversation.history.yesterday')).toBe(10); // unchanged
    expect(result.current.getBudget('conversation.history.earlier')).toBe(40);
  });
});
