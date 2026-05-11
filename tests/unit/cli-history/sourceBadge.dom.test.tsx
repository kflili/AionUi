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
// react-i18next: identity translator so aria-label / tooltip content surface
// the raw i18n key — assertions can compare against literals.
// arco Tag: replace with a stable inline element that forwards data-color /
// data-size / className / aria-label / children — assertions never depend on
// Arco's CSS class internals.
// arco Tooltip: render children plus a sibling carrying the resolved content
// in a `data-tooltip-content` attribute (item-3 pattern, ergonomic for assertions).
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
      <span data-testid='source-badge-tooltip' data-tooltip-content={String(content)}>
        {children}
      </span>
    ),
  };
});

import SourceBadge, {
  SOURCE_MAP,
  pickEntry,
} from '../../../src/renderer/pages/conversation/GroupedHistory/parts/SourceBadge';

afterEach(() => {
  cleanup();
});

describe('SourceBadge — known sources', () => {
  it('renders "CC" chip for source: claude_code', () => {
    render(<SourceBadge source='claude_code' />);
    const badge = screen.getByTestId('source-badge');
    expect(badge.textContent).toBe('CC');
  });

  it('renders "CP" chip for source: copilot', () => {
    render(<SourceBadge source='copilot' />);
    const badge = screen.getByTestId('source-badge');
    expect(badge.textContent).toBe('CP');
  });

  it('uses stable Tag attributes: CC → data-color="orange", data-size="small"', () => {
    render(<SourceBadge source='claude_code' />);
    const badge = screen.getByTestId('source-badge');
    expect(badge.getAttribute('data-color')).toBe('orange');
    expect(badge.getAttribute('data-size')).toBe('small');
  });

  it('uses stable Tag attributes: CP → data-color="arcoblue", data-size="small"', () => {
    render(<SourceBadge source='copilot' />);
    const badge = screen.getByTestId('source-badge');
    expect(badge.getAttribute('data-color')).toBe('arcoblue');
    expect(badge.getAttribute('data-size')).toBe('small');
  });

  it('exposes the right i18n aria-label for CC', () => {
    render(<SourceBadge source='claude_code' />);
    const badge = screen.getByTestId('source-badge');
    expect(badge.getAttribute('aria-label')).toBe('conversation.history.source.claudeCode');
  });

  it('exposes the right i18n aria-label for CP', () => {
    render(<SourceBadge source='copilot' />);
    const badge = screen.getByTestId('source-badge');
    expect(badge.getAttribute('aria-label')).toBe('conversation.history.source.copilot');
  });

  it('Tooltip content equals the i18n key (CC)', () => {
    render(<SourceBadge source='claude_code' />);
    const tooltip = screen.getByTestId('source-badge-tooltip');
    expect(tooltip.getAttribute('data-tooltip-content')).toBe('conversation.history.source.claudeCode');
  });

  it('Tooltip content equals the i18n key (CP)', () => {
    render(<SourceBadge source='copilot' />);
    const tooltip = screen.getByTestId('source-badge-tooltip');
    expect(tooltip.getAttribute('data-tooltip-content')).toBe('conversation.history.source.copilot');
  });
});

describe('SourceBadge — native rows render nothing', () => {
  it('returns null for source: aionui (DOM has no badge or tooltip)', () => {
    const { container } = render(<SourceBadge source='aionui' />);
    expect(container.querySelector('[data-testid="source-badge"]')).toBeNull();
    expect(container.querySelector('[data-testid="source-badge-tooltip"]')).toBeNull();
  });

  it('returns null for source: undefined', () => {
    const { container } = render(<SourceBadge source={undefined} />);
    expect(container.querySelector('[data-testid="source-badge"]')).toBeNull();
  });
});

describe('SourceBadge — unknown / unsupported strings render nothing', () => {
  it.each([['codex'], ['gemini'], ['random-xyz'], ['CLAUDE_CODE'], ['copilot-x'], ['']])(
    'returns null for unknown string: %s',
    (value) => {
      const { container } = render(<SourceBadge source={value} />);
      expect(container.querySelector('[data-testid="source-badge"]')).toBeNull();
    }
  );
});

describe('SourceBadge — inherited-property strings render nothing (prototype-pollution guard)', () => {
  it.each([['constructor'], ['toString'], ['__proto__'], ['hasOwnProperty'], ['valueOf'], ['isPrototypeOf']])(
    'returns null for prototype-resident name: %s',
    (value) => {
      const { container } = render(<SourceBadge source={value} />);
      expect(container.querySelector('[data-testid="source-badge"]')).toBeNull();
    }
  );

  it('pickEntry returns null for "constructor" instead of leaking Object.prototype.constructor', () => {
    expect(pickEntry('constructor')).toBeNull();
    expect(pickEntry('__proto__')).toBeNull();
  });
});

describe('SourceBadge — malformed runtime values render nothing (fail-soft)', () => {
  const cases: Array<[string, unknown]> = [
    ['null', null],
    ['number', 42],
    ['empty-object', {}],
    ['array', []],
    ['boolean-true', true],
    ['boolean-false', false],
    ['symbol', Symbol('x')],
    ['nan', NaN],
  ];

  it.each(cases)('returns null for %s', (_label, value) => {
    const { container } = render(<SourceBadge source={value} />);
    expect(container.querySelector('[data-testid="source-badge"]')).toBeNull();
  });
});

describe('SourceBadge — SOURCE_MAP enumeration', () => {
  it('SOURCE_MAP keys are exactly the supported sources (no Codex/Gemini drift)', () => {
    expect(Object.keys(SOURCE_MAP).toSorted()).toEqual(['claude_code', 'copilot']);
  });

  it('pickEntry returns the stable shape { chip, color, i18nKey }', () => {
    const cc = pickEntry('claude_code');
    const cp = pickEntry('copilot');
    expect(cc).toEqual({
      chip: 'CC',
      color: 'orange',
      i18nKey: 'conversation.history.source.claudeCode',
    });
    expect(cp).toEqual({
      chip: 'CP',
      color: 'arcoblue',
      i18nKey: 'conversation.history.source.copilot',
    });
  });
});

describe('SourceBadge — className forwarding', () => {
  it('forwards arbitrary className onto the rendered Tag', () => {
    render(<SourceBadge source='claude_code' className='sentinel-class group-hover:invisible' />);
    const badge = screen.getByTestId('source-badge');
    expect(badge.className).toContain('sentinel-class');
    expect(badge.className).toContain('group-hover:invisible');
  });

  it('does not render when source is unknown even with className supplied', () => {
    const { container } = render(<SourceBadge source='aionui' className='sentinel-class' />);
    expect(container.querySelector('[data-testid="source-badge"]')).toBeNull();
    expect(container.textContent).toBe('');
  });
});

// ---------------------------------------------------------------------------
// ConversationRow integration — locks the batch-mode carve-out at the
// integration boundary. A regression in ConversationRow class composition
// (e.g., dropping the !batchMode guard around group-hover:invisible) would
// pass the SourceBadge unit tests but fail here.
// ---------------------------------------------------------------------------

const noop = (): void => undefined;

const mkRowProps = (
  overrides: Partial<import('@/renderer/pages/conversation/GroupedHistory/types').ConversationRowProps> = {}
) => ({
  conversation: {
    id: 'c-cc-1',
    type: 'acp' as const,
    name: 'imported session',
    createTime: Date.now(),
    modifyTime: Date.now(),
    extra: { workspace: '/ws', backend: 'claude' },
    model: {} as never,
    source: 'claude_code' as const,
  } as unknown as import('@/common/config/storage').TChatConversation,
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
  ...overrides,
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

import ConversationRow from '../../../src/renderer/pages/conversation/GroupedHistory/ConversationRow';

describe('ConversationRow — source-badge class composition (batch carve-out)', () => {
  it('non-batch imported row: badge has "group-hover:invisible" and no standalone "hidden"', () => {
    render(<ConversationRow {...(mkRowProps({ batchMode: false }) as never)} />);
    const badge = screen.getByTestId('source-badge');
    const tokens = badge.className.split(/\s+/);
    expect(tokens).toContain('group-hover:invisible');
    expect(tokens).not.toContain('hidden');
  });

  it('batchMode imported row: badge has neither "hidden" nor "group-hover:invisible"', () => {
    render(<ConversationRow {...(mkRowProps({ batchMode: true }) as never)} />);
    const badge = screen.getByTestId('source-badge');
    const tokens = badge.className.split(/\s+/);
    expect(tokens).not.toContain('hidden');
    expect(tokens).not.toContain('group-hover:invisible');
  });

  it('non-batch row without unread dot uses mr-2px spacing', () => {
    render(<ConversationRow {...(mkRowProps({ batchMode: false, hasCompletionUnread: false }) as never)} />);
    const badge = screen.getByTestId('source-badge');
    expect(badge.className).toContain('mr-2px');
    expect(badge.className).not.toContain('mr-22px');
  });

  it('non-batch row with unread dot uses mr-22px spacing (reserves dot width)', () => {
    render(<ConversationRow {...(mkRowProps({ batchMode: false, hasCompletionUnread: true }) as never)} />);
    const badge = screen.getByTestId('source-badge');
    expect(badge.className).toContain('mr-22px');
  });

  it('native row (source=aionui) renders no badge', () => {
    const props = mkRowProps({
      conversation: {
        ...mkRowProps().conversation,
        source: 'aionui',
      } as unknown as import('@/common/config/storage').TChatConversation,
    });
    const { container } = render(<ConversationRow {...(props as never)} />);
    expect(container.querySelector('[data-testid="source-badge"]')).toBeNull();
  });
});
