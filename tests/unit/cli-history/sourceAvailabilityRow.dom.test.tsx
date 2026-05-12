/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// react-i18next identity translator + Arco Tooltip stub mirror the patterns in
// sourceBadge.dom.test.tsx so the rotated-icon assertion can read i18n keys
// directly off DOM attributes without coupling to Arco's CSS internals.
// ---------------------------------------------------------------------------

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en-US' },
  }),
}));

vi.mock('@arco-design/web-react', async () => {
  const actual = await vi.importActual<typeof import('@arco-design/web-react')>('@arco-design/web-react');
  return {
    ...actual,
    Tag: ({
      children,
      color,
      size,
      className,
      'aria-label': ariaLabel,
    }: {
      children?: React.ReactNode;
      color?: string;
      size?: string;
      className?: string;
      'aria-label'?: string;
    }) => (
      <span data-testid='source-badge' data-color={color} data-size={size} className={className} aria-label={ariaLabel}>
        {children}
      </span>
    ),
    Tooltip: ({ children, content }: { children: React.ReactNode; content: React.ReactNode }) => (
      <span data-testid='tooltip' data-tooltip-content={String(content)}>
        {children}
      </span>
    ),
  };
});

vi.mock('@/renderer/hooks/agent/usePresetAssistantInfo', () => ({
  usePresetAssistantInfo: () => ({ info: null }),
}));

vi.mock('@/renderer/hooks/context/LayoutContext', () => ({
  useLayoutContext: () => ({ isMobile: false }),
}));

vi.mock('@/renderer/utils/ui/siderTooltip', () => ({
  cleanupSiderTooltips: () => undefined,
  getSiderTooltipProps: () => ({}),
}));

vi.mock('@/renderer/utils/model/agentLogo', () => ({
  getAgentLogo: () => null,
}));

vi.mock('@/renderer/pages/cron', () => ({
  CronJobIndicator: () => null,
}));

vi.mock('@/renderer/components/layout/FlexFullContainer', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div data-testid='flex-container'>{children}</div>,
}));

import ConversationRow, {
  isSourceRotated,
} from '../../../src/renderer/pages/conversation/GroupedHistory/ConversationRow';
import type { TChatConversation } from '@/common/config/storage';

afterEach(() => {
  cleanup();
});

const noop = (): void => undefined;

function mkConversation(extraOverrides: Record<string, unknown> = {}): TChatConversation {
  return {
    id: 'c-cp-rotated',
    type: 'acp' as const,
    name: 'rotated copilot session',
    createTime: Date.now(),
    modifyTime: Date.now(),
    extra: {
      workspace: '/ws',
      backend: 'copilot',
      sourceFilePath: '/Users/lili/.copilot/session-state/abc/events.jsonl',
      importMeta: {
        autoNamed: true,
        generatedName: 'rotated copilot session',
        hidden: false,
        ...extraOverrides,
      },
    },
    model: {} as never,
    source: 'copilot' as const,
  } as unknown as TChatConversation;
}

const mkRowProps = (conversation: TChatConversation) =>
  ({
    conversation,
    isGenerating: false,
    hasCompletionUnread: false,
    collapsed: false,
    tooltipEnabled: false,
    batchMode: false,
    checked: false,
    selected: false,
    menuVisible: false,
    onToggleChecked: noop,
    onConversationClick: noop,
    onOpenMenu: noop,
    onMenuVisibleChange: noop,
    onEditStart: noop,
    onDelete: noop,
    onExport: noop,
    onTogglePin: noop,
    onCopyReference: noop,
    getJobStatus: () => 'none' as const,
  }) as never;

// ---------------------------------------------------------------------------
// isSourceRotated — pure predicate
// ---------------------------------------------------------------------------

describe('isSourceRotated', () => {
  it('returns true when extra.importMeta.sourceAvailable === false', () => {
    expect(isSourceRotated(mkConversation({ sourceAvailable: false }))).toBe(true);
  });

  it('returns false when sourceAvailable === true', () => {
    expect(isSourceRotated(mkConversation({ sourceAvailable: true }))).toBe(false);
  });

  it('returns false when sourceAvailable is undefined (pre-sweep row)', () => {
    expect(isSourceRotated(mkConversation())).toBe(false);
  });

  it('returns false when conversation is null/undefined', () => {
    expect(isSourceRotated(null)).toBe(false);
    expect(isSourceRotated(undefined)).toBe(false);
  });

  it('returns false when extra is malformed (no importMeta)', () => {
    const conv = {
      id: 'x',
      type: 'acp' as const,
      name: 'malformed',
      createTime: 0,
      modifyTime: 0,
      source: 'copilot' as const,
      extra: { workspace: '/ws' },
    } as unknown as TChatConversation;
    expect(isSourceRotated(conv)).toBe(false);
  });

  it('returns false when extra is non-object (defensive read on legacy rows)', () => {
    const conv = {
      id: 'x',
      type: 'acp' as const,
      name: 'legacy',
      createTime: 0,
      modifyTime: 0,
      source: 'copilot' as const,
      extra: null,
    } as unknown as TChatConversation;
    expect(isSourceRotated(conv)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ConversationRow integration — Bug 3b UI affordance
// ---------------------------------------------------------------------------

describe('ConversationRow — rotated source affordance', () => {
  it('renders the rotated icon with i18n tooltip when sourceAvailable=false', () => {
    render(<ConversationRow {...mkRowProps(mkConversation({ sourceAvailable: false }))} />);
    const icon = screen.getByTestId('conversation-source-rotated');
    expect(icon).not.toBeNull();
    expect(icon.getAttribute('aria-label')).toBe('conversation.history.sourceRotated.tooltip');
    // The Tooltip stub forwards content as a data attribute on its wrapper.
    const tooltips = screen.getAllByTestId('tooltip');
    const rotatedTooltip = tooltips.find(
      (n) => n.getAttribute('data-tooltip-content') === 'conversation.history.sourceRotated.tooltip'
    );
    expect(rotatedTooltip).toBeDefined();
  });

  it('does NOT render the rotated icon when sourceAvailable=true', () => {
    const { container } = render(<ConversationRow {...mkRowProps(mkConversation({ sourceAvailable: true }))} />);
    expect(container.querySelector('[data-testid="conversation-source-rotated"]')).toBeNull();
  });

  it('does NOT render the rotated icon on pre-sweep rows (sourceAvailable undefined)', () => {
    const { container } = render(<ConversationRow {...mkRowProps(mkConversation())} />);
    expect(container.querySelector('[data-testid="conversation-source-rotated"]')).toBeNull();
  });

  it('dims the title (opacity-60) when source is rotated', () => {
    const { container } = render(<ConversationRow {...mkRowProps(mkConversation({ sourceAvailable: false }))} />);
    const title = container.querySelector('[data-source-rotated="true"]');
    expect(title).not.toBeNull();
    expect(title!.className).toContain('opacity-60');
  });

  it('does NOT dim the title when source is available', () => {
    const { container } = render(<ConversationRow {...mkRowProps(mkConversation({ sourceAvailable: true }))} />);
    // No element carries data-source-rotated="true" — the title block is undimmed.
    expect(container.querySelector('[data-source-rotated="true"]')).toBeNull();
    const name = container.querySelector('.chat-history__item-name');
    expect(name).not.toBeNull();
    expect(name!.className).not.toContain('opacity-60');
  });
});
