/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TChatConversation } from '../../../src/common/config/storage';
import type { IMessageSearchResponse } from '../../../src/common/types/database';

// ---------------------------------------------------------------------------
// Mocks
//
// The page composes Arco Select/Button/Checkbox/DatePicker, the source-badge
// (already its own test), the conversation list sync hook, Virtuoso, and the
// message-search IPC. We stub the leaves so the assertions target the page's
// filter/sort/empty-state logic — not Arco internals, not Virtuoso geometry,
// not the IPC transport.
// ---------------------------------------------------------------------------

const searchConversationMessagesInvoke =
  vi.fn<(args: { keyword: string; page: number; pageSize: number }) => Promise<IMessageSearchResponse>>();

vi.mock('@/common', () => ({
  ipcBridge: {
    database: {
      searchConversationMessages: {
        invoke: (args: { keyword: string; page: number; pageSize: number }) => searchConversationMessagesInvoke(args),
      },
    },
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { count?: number }) => {
      if (opts && typeof opts.count === 'number') {
        return `${key}:${opts.count}`;
      }
      return key;
    },
    i18n: { language: 'en-US' },
  }),
}));

// Stable Arco mock: replace Tag, Tooltip, Input, Checkbox, Select, DatePicker,
// Button with thin native elements so DOM queries are deterministic in jsdom.
vi.mock('@arco-design/web-react', () => {
  type Children = { children?: React.ReactNode };
  type Click = { onClick?: () => void };

  const Tag = ({
    children,
    color,
    className,
    'aria-label': ariaLabel,
  }: Children & { color?: string; className?: string; 'aria-label'?: string }) => (
    <span data-testid='source-badge' data-color={color} className={className} aria-label={ariaLabel}>
      {children}
    </span>
  );

  const Tooltip = ({ children }: Children) => <>{children}</>;

  const Button = ({
    children,
    onClick,
    type,
    'aria-pressed': pressed,
    'data-testid': dataTestId,
    disabled,
  }: Children &
    Click & {
      type?: string;
      'aria-pressed'?: boolean;
      'data-testid'?: string;
      disabled?: boolean;
      [k: string]: unknown;
    }) => (
    <button
      type='button'
      onClick={onClick}
      aria-pressed={pressed}
      data-testid={dataTestId}
      data-type={type}
      disabled={disabled}
    >
      {children}
    </button>
  );

  type InputProps = {
    value?: string;
    placeholder?: string;
    onChange?: (value: string) => void;
    'data-testid'?: string;
    [k: string]: unknown;
  };
  const Input = ({ value, placeholder, onChange, 'data-testid': dataTestId }: InputProps) => (
    <input
      data-testid={dataTestId}
      placeholder={placeholder}
      value={value ?? ''}
      onChange={(e) => onChange?.(e.target.value)}
    />
  );

  type CheckboxProps = {
    checked?: boolean;
    onChange?: (next: boolean) => void;
    children?: React.ReactNode;
    'data-testid'?: string;
  };
  const Checkbox = ({ checked, onChange, children, 'data-testid': dataTestId }: CheckboxProps) => (
    <label data-testid={dataTestId}>
      <input type='checkbox' checked={checked ?? false} onChange={(e) => onChange?.(e.target.checked)} />
      {children}
    </label>
  );

  type OptionEl = React.ReactElement<{ value: string; children: React.ReactNode }>;
  type SelectProps = {
    value?: string | string[];
    mode?: 'multiple';
    onChange?: (next: string | string[]) => void;
    children?: React.ReactNode;
    'data-testid'?: string;
    placeholder?: string;
    [k: string]: unknown;
  };
  const Select = ({ value, mode, onChange, children, 'data-testid': dataTestId, placeholder }: SelectProps) => {
    const options = React.Children.toArray(children).filter((child): child is OptionEl => React.isValidElement(child));
    if (mode === 'multiple') {
      return (
        <select
          data-testid={dataTestId}
          multiple
          aria-label={placeholder}
          value={Array.isArray(value) ? value : []}
          onChange={(e) => {
            const next = Array.from(e.target.selectedOptions).map((o) => o.value);
            onChange?.(next);
          }}
        >
          {options.map((opt) => (
            <option key={opt.props.value} value={opt.props.value}>
              {opt.props.children}
            </option>
          ))}
        </select>
      );
    }
    return (
      <select
        data-testid={dataTestId}
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange?.(e.target.value)}
      >
        {options.map((opt) => (
          <option key={opt.props.value} value={opt.props.value}>
            {opt.props.children}
          </option>
        ))}
      </select>
    );
  };
  Select.Option = ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  );

  const DatePicker = {
    RangePicker: ({
      onChange,
      'data-testid': dataTestId,
    }: {
      onChange?: (dateStrings: [string, string]) => void;
      'data-testid'?: string;
    }) => (
      <input
        data-testid={dataTestId}
        onChange={(e) => {
          const parts = e.target.value.split(',');
          if (parts.length === 2) onChange?.([parts[0]!, parts[1]!]);
        }}
      />
    ),
  };

  return { Tag, Tooltip, Button, Input, Checkbox, Select, DatePicker };
});

// Virtuoso replacement that renders every row — easier to assert row counts
// AND it still lets us check that the list rendered through Virtuoso path.
vi.mock('react-virtuoso', () => ({
  Virtuoso: <T,>({ data, itemContent }: { data: T[]; itemContent: (index: number, item: T) => React.ReactNode }) => (
    <div data-testid='history-virtuoso-mock'>
      {data.map((item, index) => (
        <React.Fragment key={index}>{itemContent(index, item)}</React.Fragment>
      ))}
    </div>
  ),
}));

const useConversationListSyncMock = vi.fn();
vi.mock('@renderer/pages/conversation/GroupedHistory/hooks/useConversationListSync', () => ({
  useConversationListSync: () => useConversationListSyncMock(),
}));

// Spy on react-router-dom's useNavigate so the row-click test can assert the
// production navigate(`/conversation/<id>`) call site. MemoryRouter is still
// the actual router — only useNavigate is intercepted.
const navigateSpy = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => navigateSpy,
  };
});

import HistoryPage from '../../../src/renderer/pages/history/HistoryPage';

// ---------------------------------------------------------------------------
// Test factories
// ---------------------------------------------------------------------------

type ConvOverrides = {
  id?: string;
  name?: string;
  source?: TChatConversation['source'];
  workspace?: string;
  modifyTime?: number;
  extraOverride?: unknown;
};

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.now();

const makeConv = ({
  id = 'c1',
  name = 'Some chat',
  source,
  workspace,
  modifyTime = NOW - DAY,
  extraOverride,
}: ConvOverrides = {}): TChatConversation => {
  const extra = extraOverride === undefined ? (workspace !== undefined ? { workspace } : {}) : extraOverride;
  return {
    id,
    createTime: 0,
    modifyTime,
    name,
    extra,
    source,
  } as unknown as TChatConversation;
};

const seedConversations = (): TChatConversation[] => [
  makeConv({ id: 'cc-1', name: 'cc one', source: 'claude_code', workspace: '/proj/a', modifyTime: NOW - 1 * DAY }),
  makeConv({ id: 'cc-2', name: 'cc two', source: 'claude_code', workspace: '/proj/b', modifyTime: NOW - 20 * DAY }),
  makeConv({ id: 'cp-1', name: 'cp one', source: 'copilot', workspace: '/proj/b', modifyTime: NOW - 3 * DAY }),
  makeConv({ id: 'na-1', name: 'native one', source: 'aionui', workspace: '/proj/a', modifyTime: NOW - 5 * DAY }),
  makeConv({ id: 'na-2', name: 'native two', source: 'aionui', workspace: '', modifyTime: NOW - 40 * DAY }),
];

const renderPage = (initialPath: string = '/history') =>
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <HistoryPage />
    </MemoryRouter>
  );

beforeEach(() => {
  useConversationListSyncMock.mockReset();
  searchConversationMessagesInvoke.mockReset();
  navigateSpy.mockReset();
  useConversationListSyncMock.mockReturnValue({ conversations: seedConversations() });
  searchConversationMessagesInvoke.mockResolvedValue({
    items: [],
    total: 0,
    page: 0,
    pageSize: 200,
    hasMore: false,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const getRowIds = (): string[] =>
  Array.from(screen.queryAllByTestId('history-row')).map((el) => el.getAttribute('data-conversation-id') ?? '');

describe('HistoryPage — initial render', () => {
  it('renders the page title and full session count', () => {
    renderPage();
    expect(screen.getByTestId('history-page-title').textContent).toBe('conversation.fullHistory.pageTitle');
    expect(screen.getByTestId('history-page-count').textContent).toBe('conversation.fullHistory.sessionCount:5');
  });

  it('renders one row per seeded conversation', () => {
    renderPage();
    expect(getRowIds().toSorted()).toEqual(['cc-1', 'cc-2', 'cp-1', 'na-1', 'na-2']);
  });

  it('renders rows in date-descending order by default', () => {
    renderPage();
    expect(getRowIds()).toEqual(['cc-1', 'cp-1', 'na-1', 'cc-2', 'na-2']);
  });

  it('renders the All-sources chip in the active state initially', () => {
    renderPage();
    const allChip = screen.getByText('conversation.fullHistory.filter.allSources').closest('button');
    expect(allChip?.getAttribute('aria-pressed')).toBe('true');
  });

  it('reset button is disabled when no axis narrows', () => {
    renderPage();
    expect(screen.getByTestId('history-reset').hasAttribute('disabled')).toBe(true);
  });
});

describe('HistoryPage — source chip filtering', () => {
  it('clicking a single source chip narrows to that source', () => {
    renderPage();
    fireEvent.click(screen.getByTestId('history-source-chip-claude_code'));
    expect(getRowIds().toSorted()).toEqual(['cc-1', 'cc-2']);
    expect(screen.getByTestId('history-page-count').textContent).toBe('conversation.fullHistory.sessionCount:2');
  });

  it('clicking multiple source chips selects multiple sources (multi-select)', () => {
    renderPage();
    fireEvent.click(screen.getByTestId('history-source-chip-claude_code'));
    fireEvent.click(screen.getByTestId('history-source-chip-copilot'));
    expect(getRowIds().toSorted()).toEqual(['cc-1', 'cc-2', 'cp-1']);
  });

  it('clicking the same chip twice toggles it off', () => {
    renderPage();
    fireEvent.click(screen.getByTestId('history-source-chip-claude_code'));
    fireEvent.click(screen.getByTestId('history-source-chip-claude_code'));
    expect(getRowIds().length).toBe(5);
  });

  it("clicking 'All sources' resets source selection", () => {
    renderPage();
    fireEvent.click(screen.getByTestId('history-source-chip-claude_code'));
    fireEvent.click(screen.getByText('conversation.fullHistory.filter.allSources'));
    expect(getRowIds().length).toBe(5);
  });
});

describe('HistoryPage — date preset filtering', () => {
  it("'Last 7 days' narrows by date", () => {
    renderPage();
    fireEvent.click(screen.getByTestId('history-date-preset-last7'));
    // cc-1 (1d), cp-1 (3d), na-1 (5d) — cc-2 (20d) and na-2 (40d) excluded.
    expect(getRowIds().toSorted()).toEqual(['cc-1', 'cp-1', 'na-1']);
  });

  it("'Last 30 days' admits rows up to 30 days", () => {
    renderPage();
    fireEvent.click(screen.getByTestId('history-date-preset-last30'));
    // na-2 (40d) excluded; everything else admitted.
    expect(getRowIds().toSorted()).toEqual(['cc-1', 'cc-2', 'cp-1', 'na-1']);
  });

  it("'All time' resets the date narrowing", () => {
    renderPage();
    fireEvent.click(screen.getByTestId('history-date-preset-last7'));
    fireEvent.click(screen.getByTestId('history-date-preset-all'));
    expect(getRowIds().length).toBe(5);
  });
});

describe('HistoryPage — search', () => {
  it('typing in the search input narrows by name', () => {
    renderPage();
    const input = screen.getByTestId('history-search-input');
    fireEvent.change(input as HTMLInputElement, { target: { value: 'native' } });
    expect(getRowIds().toSorted()).toEqual(['na-1', 'na-2']);
  });

  it('search needle matches workspace substring', () => {
    renderPage();
    const input = screen.getByTestId('history-search-input');
    fireEvent.change(input as HTMLInputElement, { target: { value: '/proj/b' } });
    expect(getRowIds().toSorted()).toEqual(['cc-2', 'cp-1']);
  });
});

describe('HistoryPage — message-content toggle', () => {
  it('calling the IPC merges message-search results into the visible set', async () => {
    vi.useFakeTimers();
    searchConversationMessagesInvoke.mockResolvedValue({
      items: [
        {
          conversation: makeConv({ id: 'cp-1' }),
          messageId: 'm1',
          messageType: 'text',
          messageCreatedAt: 0,
          previewText: 'hello',
        },
      ],
      total: 1,
      page: 0,
      pageSize: 200,
      hasMore: false,
    } as unknown as IMessageSearchResponse);
    renderPage();
    const input = screen.getByTestId('history-search-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'totally-unique-keyword' } });
    const checkbox = screen
      .getByTestId('history-include-message-content')
      .querySelector('input[type="checkbox"]') as HTMLInputElement;
    fireEvent.click(checkbox);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(searchConversationMessagesInvoke).toHaveBeenCalledWith({
      keyword: 'totally-unique-keyword',
      page: 0,
      pageSize: 200,
    });
    expect(getRowIds()).toEqual(['cp-1']);
  });

  it('shows the index notice when non-hydrated imported rows exist in visible set', () => {
    useConversationListSyncMock.mockReturnValue({
      conversations: [
        makeConv({
          id: 'imported-not-hydrated',
          source: 'claude_code',
          extraOverride: { workspace: '/p', sourceFilePath: '/x.jsonl' },
          name: 'imported one',
        }),
      ],
    });
    renderPage();
    const checkbox = screen
      .getByTestId('history-include-message-content')
      .querySelector('input[type="checkbox"]') as HTMLInputElement;
    fireEvent.click(checkbox);
    expect(screen.getByTestId('history-message-index-notice')).toBeTruthy();
  });

  it('hides the index notice when no imported row is non-hydrated', () => {
    useConversationListSyncMock.mockReturnValue({
      conversations: [
        makeConv({
          id: 'imported-hydrated',
          source: 'claude_code',
          extraOverride: { workspace: '/p', sourceFilePath: '/x.jsonl', hydratedAt: 1234 },
          name: 'imported one',
        }),
      ],
    });
    renderPage();
    const checkbox = screen
      .getByTestId('history-include-message-content')
      .querySelector('input[type="checkbox"]') as HTMLInputElement;
    fireEvent.click(checkbox);
    expect(screen.queryByTestId('history-message-index-notice')).toBeNull();
  });
});

describe('HistoryPage — sort', () => {
  it("'By name' reorders the visible list", () => {
    renderPage();
    const select = screen.getByTestId('history-sort') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'name' } });
    // After sorting by name asc: cc one, cc two, cp one, native one, native two.
    expect(getRowIds()).toEqual(['cc-1', 'cc-2', 'cp-1', 'na-1', 'na-2']);
  });
});

describe('HistoryPage — empty + reset', () => {
  it('renders the no-matches empty state when filters narrow to zero rows', () => {
    renderPage();
    const input = screen.getByTestId('history-search-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '__no_such_row__' } });
    expect(screen.getByTestId('history-empty')).toBeTruthy();
    expect(screen.getByText('conversation.fullHistory.empty.noMatches')).toBeTruthy();
  });

  it('clicking Reset on the filter bar clears narrowing', () => {
    renderPage();
    fireEvent.click(screen.getByTestId('history-source-chip-claude_code'));
    expect(getRowIds().length).toBe(2);
    fireEvent.click(screen.getByTestId('history-reset'));
    expect(getRowIds().length).toBe(5);
  });

  it('renders no-history empty state when there are zero conversations and no filter', () => {
    useConversationListSyncMock.mockReturnValue({ conversations: [] });
    renderPage();
    expect(screen.getByText('conversation.history.noHistory')).toBeTruthy();
  });
});

describe('HistoryPage — workspace filter', () => {
  it('selecting workspaces from the multi-select narrows by workspace', () => {
    renderPage();
    const select = screen.getByTestId('history-workspace-select') as HTMLSelectElement;
    // Programmatically select an option in the multi-select.
    const optionA = Array.from(select.options).find((o) => o.value === '/proj/a');
    expect(optionA).toBeTruthy();
    optionA!.selected = true;
    fireEvent.change(select);
    expect(getRowIds().toSorted()).toEqual(['cc-1', 'na-1']);
  });
});

describe('HistoryPage — row click navigates to /conversation/:id', () => {
  it('clicking a row calls useNavigate with the conversation path', () => {
    renderPage();
    const firstRow = screen
      .getByTestId('history-virtuoso-mock')
      .querySelectorAll('[data-testid="history-row"]')[0] as HTMLElement;
    expect(firstRow).toBeTruthy();
    const expectedId = firstRow.getAttribute('data-conversation-id');
    fireEvent.click(firstRow);
    expect(navigateSpy).toHaveBeenCalledWith(`/conversation/${expectedId}`);
  });

  it('Enter key on a focused row also navigates', () => {
    renderPage();
    const firstRow = screen
      .getByTestId('history-virtuoso-mock')
      .querySelectorAll('[data-testid="history-row"]')[0] as HTMLElement;
    const expectedId = firstRow.getAttribute('data-conversation-id');
    fireEvent.keyDown(firstRow, { key: 'Enter' });
    expect(navigateSpy).toHaveBeenCalledWith(`/conversation/${expectedId}`);
  });
});

describe('HistoryPage — deep-link section param', () => {
  it("?section=conversation.history.today preselects 'custom' preset scoped to today (codex Ybq)", () => {
    renderPage('/history?section=conversation.history.today');
    // cc-1 is 1 day old in our seed and thus falls under yesterday, NOT today.
    // The custom range scoped to today excludes everything from the seed
    // because every seeded row was modified ≥ 1 day ago.
    expect(getRowIds().length).toBe(0);
    const customChip = screen.getByTestId('history-date-preset-custom');
    expect(customChip.getAttribute('aria-pressed')).toBe('true');
    // The All time chip should NOT be selected (was the bug — it was last7).
    expect(screen.getByTestId('history-date-preset-last7').getAttribute('aria-pressed')).toBe('false');
  });

  it("?section=conversation.history.recent7Days preselects 'custom' preset excluding today/yesterday (codex JuS)", () => {
    renderPage('/history?section=conversation.history.recent7Days');
    // Seed dates relative to NOW: cc-1 (1d → yesterday bucket, excluded),
    // cp-1 (3d → recent7Days), na-1 (5d → recent7Days), cc-2 (20d → earlier),
    // na-2 (40d → earlier). Expected admitted: cp-1, na-1.
    expect(getRowIds().toSorted()).toEqual(['cp-1', 'na-1']);
    const customChip = screen.getByTestId('history-date-preset-custom');
    expect(customChip.getAttribute('aria-pressed')).toBe('true');
  });

  it("?section=conversation.history.earlier preselects 'custom' preset excluding recent rows (codex JuS)", () => {
    renderPage('/history?section=conversation.history.earlier');
    // Expected admitted: cc-2 (20d), na-2 (40d). cc-1/cp-1/na-1 < 7d → excluded.
    expect(getRowIds().toSorted()).toEqual(['cc-2', 'na-2']);
    const customChip = screen.getByTestId('history-date-preset-custom');
    expect(customChip.getAttribute('aria-pressed')).toBe('true');
  });
});
