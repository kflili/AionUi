/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TChatConversation } from '../../../src/common/config/storage';

// ---------------------------------------------------------------------------
// Mocks — TranscriptView pulls in MessageList (Virtuoso, many sub-components),
// useMessageLstCache (ipcBridge.database.getConversationMessages), the i18n
// runtime, and the hydrate IPC. We replace all of those with thin stubs so
// the tests target *this* component's branching logic, not the dependency
// graph. The native-ACP regression test mocks AcpSendBox identically — the
// presence/absence of its testid is the assertion.
// ---------------------------------------------------------------------------

const hydrateInvoke = vi.fn();
const getConversationMessagesInvoke = vi.fn(async () => []);

vi.mock('@/common', () => ({
  ipcBridge: {
    cliHistory: {
      hydrate: {
        invoke: (...args: unknown[]) => hydrateInvoke(...args),
      },
    },
    database: {
      getConversationMessages: {
        invoke: (...args: unknown[]) => getConversationMessagesInvoke(...args),
      },
    },
  },
}));

vi.mock('@renderer/pages/conversation/Messages/MessageList', () => ({
  default: ({ className }: { className?: string }) => (
    <div data-testid='mock-message-list' className={className}>
      message-list
    </div>
  ),
}));

vi.mock('@renderer/components/layout/FlexFullContainer', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div data-testid='flex-container'>{children}</div>,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en-US' },
  }),
}));

// Arco Tooltip wraps children but does not render the trigger node by default in
// jsdom (it relies on getBoundingClientRect / popper positioning). The test
// stub renders the trigger inline so we can query the button reliably.
vi.mock('@arco-design/web-react', async () => {
  const actual = await vi.importActual<typeof import('@arco-design/web-react')>('@arco-design/web-react');
  return {
    ...actual,
    Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

import TranscriptView, {
  hasHydratedAt,
  isImportedAcpConversation,
} from '../../../src/renderer/pages/conversation/components/TranscriptView';

type HydrateResultLike = {
  success: boolean;
  data?: { status: 'hydrated' | 'cached' | 'unavailable'; warning?: 'source_missing'; warningCount?: number };
  msg?: string;
};

const okHydrated = (): HydrateResultLike => ({ success: true, data: { status: 'hydrated' } });
const okCached = (): HydrateResultLike => ({ success: true, data: { status: 'cached' } });
const okCachedMissing = (): HydrateResultLike => ({
  success: true,
  data: { status: 'cached', warning: 'source_missing' },
});
const okUnavailable = (): HydrateResultLike => ({ success: true, data: { status: 'unavailable' } });
const fail = (msg = 'boom'): HydrateResultLike => ({ success: false, msg });

const baseProps = {
  conversation_id: 'conv-abc',
  workspace: '/some/ws',
  backend: 'claude' as const,
};

const noop = (): void => undefined;

// ---------------------------------------------------------------------------
// Predicate tests (cheap, no DOM) — cover the native-ACP regression contract.
// ---------------------------------------------------------------------------

const mkConv = (overrides: Partial<TChatConversation> = {}): TChatConversation =>
  ({
    id: 'c1',
    type: 'acp',
    name: 'test',
    extra: { workspace: '/ws', backend: 'claude' },
    ...overrides,
  }) as unknown as TChatConversation;

describe('isImportedAcpConversation predicate (gate for transcript-mode routing)', () => {
  it('returns true for an ACP conversation with extra.sourceFilePath', () => {
    const conv = mkConv({
      extra: { workspace: '/ws', backend: 'claude', sourceFilePath: '/Users/me/.claude/sess.jsonl' },
    } as unknown as Partial<TChatConversation>);
    expect(isImportedAcpConversation(conv)).toBe(true);
  });

  it('returns false for a native ACP conversation (no sourceFilePath) — regression guard', () => {
    expect(isImportedAcpConversation(mkConv())).toBe(false);
  });

  it('returns false when sourceFilePath is an empty string', () => {
    const conv = mkConv({
      extra: { workspace: '/ws', backend: 'claude', sourceFilePath: '' },
    } as unknown as Partial<TChatConversation>);
    expect(isImportedAcpConversation(conv)).toBe(false);
  });

  it('returns false when extra is null (legacy row)', () => {
    expect(isImportedAcpConversation({ ...mkConv(), extra: null as unknown as TChatConversation['extra'] })).toBe(
      false
    );
  });

  it('returns false when extra is not an object (corrupted row)', () => {
    expect(isImportedAcpConversation({ ...mkConv(), extra: 'oops' as unknown as TChatConversation['extra'] })).toBe(
      false
    );
  });

  it('returns false for non-ACP conversation types', () => {
    expect(
      isImportedAcpConversation({
        ...mkConv(),
        type: 'gemini',
        extra: { sourceFilePath: '/file.jsonl' } as unknown as TChatConversation['extra'],
      } as unknown as TChatConversation)
    ).toBe(false);
  });

  it('returns false for undefined / null inputs', () => {
    expect(isImportedAcpConversation(undefined)).toBe(false);
    expect(isImportedAcpConversation(null)).toBe(false);
  });
});

describe('hasHydratedAt predicate', () => {
  it('returns true when extra.hydratedAt is a number', () => {
    const conv = mkConv({
      extra: { workspace: '/ws', backend: 'claude', hydratedAt: 1715000000000 },
    } as unknown as Partial<TChatConversation>);
    expect(hasHydratedAt(conv)).toBe(true);
  });

  it('returns false when extra.hydratedAt is undefined', () => {
    expect(hasHydratedAt(mkConv())).toBe(false);
  });

  it('returns false when extra.hydratedAt is a string (defensive: older / future rows)', () => {
    const conv = mkConv({
      extra: { workspace: '/ws', backend: 'claude', hydratedAt: 'never-mind' },
    } as unknown as Partial<TChatConversation>);
    expect(hasHydratedAt(conv)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TranscriptView DOM tests.
// ---------------------------------------------------------------------------

describe('TranscriptView (transcript mode surface)', () => {
  beforeEach(() => {
    hydrateInvoke.mockReset();
    getConversationMessagesInvoke.mockReset();
    getConversationMessagesInvoke.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the messages + Resume bar without an AcpSendBox (read-only by default)', async () => {
    hydrateInvoke.mockResolvedValue(okHydrated());
    render(<TranscriptView {...baseProps} isHydrated={true} />);

    expect(screen.getByTestId('transcript-resume-bar')).toBeInTheDocument();
    expect(screen.getByTestId('transcript-resume-button')).toBeInTheDocument();
    // No live send box should exist in transcript mode.
    expect(screen.queryByTestId('acp-send-box')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByTestId('mock-message-list')).toBeInTheDocument();
  });

  it('exposes "conversation.transcript.resumeSession" on the primary action button', () => {
    render(<TranscriptView {...baseProps} isHydrated={true} />);
    expect(screen.getByTestId('transcript-resume-button')).toHaveTextContent('conversation.transcript.resumeSession');
  });

  it('calls onResume on click and does NOT mount any live input as a side-effect', () => {
    const onResume = vi.fn();
    render(<TranscriptView {...baseProps} isHydrated={true} onResume={onResume} />);

    const btn = screen.getByTestId('transcript-resume-button');
    fireEvent.click(btn);

    expect(onResume).toHaveBeenCalledTimes(1);
    // Item-3 contract: clicking Resume must not mount a live ACP / terminal input.
    // Item 8 will replace the stub handler.
    expect(screen.queryByTestId('acp-send-box')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('does NOT call hydrate when isHydrated is true (cached open — re-open is cheap)', async () => {
    render(<TranscriptView {...baseProps} isHydrated={true} />);
    // useEffect should run synchronously after render; give it a microtask flush.
    await act(async () => {
      await Promise.resolve();
    });
    expect(hydrateInvoke).not.toHaveBeenCalled();
    expect(screen.getByTestId('mock-message-list')).toBeInTheDocument();
  });

  it('shows the skeleton while hydration is in progress', async () => {
    let resolveHydrate: (v: HydrateResultLike) => void = noop;
    hydrateInvoke.mockImplementation(
      () =>
        new Promise<HydrateResultLike>((resolve) => {
          resolveHydrate = resolve;
        })
    );

    render(<TranscriptView {...baseProps} isHydrated={false} />);

    expect(screen.getByTestId('transcript-skeleton')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-message-list')).toBeNull();
    // The Resume button stays visible during loading (per plan: "primary action").
    expect(screen.getByTestId('transcript-resume-button')).toBeInTheDocument();

    await act(async () => {
      resolveHydrate(okHydrated());
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByTestId('mock-message-list')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('transcript-skeleton')).toBeNull();
  });

  it('renders the "unavailable" empty state when hydrate returns status=unavailable', async () => {
    hydrateInvoke.mockResolvedValue(okUnavailable());

    render(<TranscriptView {...baseProps} isHydrated={false} />);

    await waitFor(() => {
      expect(screen.getByTestId('transcript-unavailable')).toBeInTheDocument();
    });
    // No message list rendered when source is unavailable + nothing cached.
    expect(screen.queryByTestId('mock-message-list')).toBeNull();
    // Resume button stays visible & clickable per plan — user can still retry.
    expect(screen.getByTestId('transcript-resume-button')).toBeInTheDocument();
  });

  it('renders the cached-warning banner + cached transcript when source file is missing post-cache', async () => {
    hydrateInvoke.mockResolvedValue(okCachedMissing());

    render(<TranscriptView {...baseProps} isHydrated={false} />);

    await waitFor(() => {
      expect(screen.getByTestId('transcript-cached-warning')).toBeInTheDocument();
    });
    // Plan line 257: "continue showing the cached SQLite transcript".
    expect(screen.getByTestId('mock-message-list')).toBeInTheDocument();
    expect(screen.queryByTestId('transcript-unavailable')).toBeNull();
  });

  it('renders the error banner when the IPC returns success=false', async () => {
    hydrateInvoke.mockResolvedValue(fail('mock failure'));

    render(<TranscriptView {...baseProps} isHydrated={false} />);

    await waitFor(() => {
      expect(screen.getByTestId('transcript-error')).toBeInTheDocument();
    });
    // Error path must still keep the transcript surface read-only — Resume button only.
    expect(screen.queryByTestId('acp-send-box')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByTestId('transcript-resume-button')).toBeInTheDocument();
  });

  it('renders the error banner when the hydrate promise rejects', async () => {
    hydrateInvoke.mockRejectedValue(new Error('disk on fire'));

    render(<TranscriptView {...baseProps} isHydrated={false} />);

    await waitFor(() => {
      expect(screen.getByTestId('transcript-error')).toBeInTheDocument();
    });
  });

  it('renders the message list on a clean cached path (no warning, no error)', async () => {
    hydrateInvoke.mockResolvedValue(okCached());

    render(<TranscriptView {...baseProps} isHydrated={false} />);

    await waitFor(() => {
      expect(screen.getByTestId('mock-message-list')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('transcript-cached-warning')).toBeNull();
    expect(screen.queryByTestId('transcript-error')).toBeNull();
  });

  it('exposes the current hydration phase on the wrapper for E2E + debugging', async () => {
    hydrateInvoke.mockResolvedValue(okHydrated());

    render(<TranscriptView {...baseProps} isHydrated={true} />);

    await act(async () => {
      await Promise.resolve();
    });

    const wrapper = screen.getByTestId('transcript-view');
    expect(wrapper.getAttribute('data-phase')).toBe('ready');
    expect(wrapper.getAttribute('data-backend')).toBe('claude');
  });
});
