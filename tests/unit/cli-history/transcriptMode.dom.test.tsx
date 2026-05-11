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
  isHydrationFresh,
  isImportedAcpConversation,
  isResumedImportedSession,
  validateResumeRequest,
  type HydrationPhase,
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
  sourceFilePath: '/Users/me/.claude/sessions/conv-abc.jsonl',
  showThinking: false,
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

describe('isHydrationFresh predicate (hydratedAt × hydratedSourceFilePath × hydratedShowThinking gate)', () => {
  it('returns false when hydratedAt is missing', () => {
    expect(isHydrationFresh(mkConv(), false)).toBe(false);
  });

  it('returns true when hydratedAt + hydratedSourceFilePath + hydratedShowThinking all match', () => {
    const conv = mkConv({
      extra: {
        workspace: '/ws',
        backend: 'claude',
        hydratedAt: 100,
        sourceFilePath: '/sessions/a.jsonl',
        hydratedSourceFilePath: '/sessions/a.jsonl',
        hydratedShowThinking: true,
      },
    } as unknown as Partial<TChatConversation>);
    expect(isHydrationFresh(conv, true)).toBe(true);
  });

  it('returns false when persisted hydratedShowThinking differs from current showThinking', () => {
    const conv = mkConv({
      extra: {
        workspace: '/ws',
        backend: 'claude',
        hydratedAt: 100,
        sourceFilePath: '/sessions/a.jsonl',
        hydratedSourceFilePath: '/sessions/a.jsonl',
        hydratedShowThinking: false,
      },
    } as unknown as Partial<TChatConversation>);
    expect(isHydrationFresh(conv, true)).toBe(false);
  });

  it('returns false when hydratedSourceFilePath differs from current sourceFilePath (importer scan moved the source)', () => {
    const conv = mkConv({
      extra: {
        workspace: '/ws',
        backend: 'claude',
        hydratedAt: 100,
        sourceFilePath: '/sessions/renamed.jsonl',
        hydratedSourceFilePath: '/sessions/old-name.jsonl',
        hydratedShowThinking: false,
      },
    } as unknown as Partial<TChatConversation>);
    expect(isHydrationFresh(conv, false)).toBe(false);
  });

  it('returns false when hydratedSourceFilePath is undefined (pre-Phase-2 row)', () => {
    const conv = mkConv({
      extra: {
        workspace: '/ws',
        backend: 'claude',
        hydratedAt: 100,
        sourceFilePath: '/sessions/a.jsonl',
      },
    } as unknown as Partial<TChatConversation>);
    expect(isHydrationFresh(conv, false)).toBe(false);
  });

  it('treats undefined hydratedShowThinking as false (importer normalization)', () => {
    const conv = mkConv({
      extra: {
        workspace: '/ws',
        backend: 'claude',
        hydratedAt: 100,
        sourceFilePath: '/sessions/a.jsonl',
        hydratedSourceFilePath: '/sessions/a.jsonl',
      },
    } as unknown as Partial<TChatConversation>);
    expect(isHydrationFresh(conv, false)).toBe(true);
    expect(isHydrationFresh(conv, true)).toBe(false);
  });

  it('returns false for null / undefined inputs', () => {
    expect(isHydrationFresh(undefined, false)).toBe(false);
    expect(isHydrationFresh(null, false)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TranscriptView DOM tests.
// ---------------------------------------------------------------------------

describe('TranscriptView (transcript mode surface)', () => {
  beforeEach(() => {
    hydrateInvoke.mockReset();
    // Default: a quiet `cached` response — no skeleton flash, no rev-bump.
    // Tests that exercise specific hydration paths override this mock.
    hydrateInvoke.mockResolvedValue(okCached());
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

  it('calls onResume on click with the current hydration phase and does NOT mount any live input as a side-effect', () => {
    const onResume = vi.fn();
    render(<TranscriptView {...baseProps} isHydrated={true} onResume={onResume} />);

    const btn = screen.getByTestId('transcript-resume-button');
    fireEvent.click(btn);

    expect(onResume).toHaveBeenCalledTimes(1);
    // Item-8 contract: the click handler threads its current hydration phase
    // up so the parent can detect `phase === 'unavailable'` (source gone +
    // no cache) before flipping the route gate. With `isHydrated=true` and
    // no hydrate-resolved error path triggered, the phase starts at 'ready'.
    expect(onResume).toHaveBeenCalledWith('ready');
    // The button click itself must not mount a live ACP / terminal input.
    // The actual live-launch happens after the parent stamps extra.resumedAt
    // and SWR re-routes; both are out of scope for this DOM test.
    expect(screen.queryByTestId('acp-send-box')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('threads phase === "unavailable" to onResume so the parent can short-circuit with sourceMissing', async () => {
    hydrateInvoke.mockResolvedValue(okUnavailable());
    const onResume = vi.fn();
    render(<TranscriptView {...baseProps} isHydrated={false} onResume={onResume} />);

    await waitFor(() => {
      expect(screen.getByTestId('transcript-unavailable')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('transcript-resume-button'));
    expect(onResume).toHaveBeenCalledWith('unavailable');
  });

  it('threads phase === "cached_warning" to onResume — cached transcript exists; parent decides whether to allow', async () => {
    hydrateInvoke.mockResolvedValue(okCachedMissing());
    const onResume = vi.fn();
    render(<TranscriptView {...baseProps} isHydrated={false} onResume={onResume} />);

    await waitFor(() => {
      expect(screen.getByTestId('transcript-cached-warning')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('transcript-resume-button'));
    expect(onResume).toHaveBeenCalledWith('cached_warning');
  });

  it('always calls hydrate on mount for the mtime / source-missing recheck (plan §Stale Data Handling)', async () => {
    hydrateInvoke.mockResolvedValue(okCached());
    render(<TranscriptView {...baseProps} isHydrated={true} />);
    await act(async () => {
      await Promise.resolve();
    });
    // For an already-hydrated row the hydrate IPC still runs — that's how the importer
    // detects `mtime > hydratedAt` and `warning: 'source_missing'`. Skeleton stays hidden
    // because we have cached content to render.
    expect(hydrateInvoke).toHaveBeenCalledTimes(1);
    expect(hydrateInvoke).toHaveBeenCalledWith({ conversationId: 'conv-abc', showThinking: false });
    expect(screen.queryByTestId('transcript-skeleton')).toBeNull();
    expect(screen.getByTestId('mock-message-list')).toBeInTheDocument();
  });

  it('does NOT call hydrate while showThinking is undefined (waits for config load)', async () => {
    render(<TranscriptView {...baseProps} isHydrated={true} showThinking={undefined} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(hydrateInvoke).not.toHaveBeenCalled();
  });

  it('fires hydrate once showThinking transitions from undefined to defined (config loaded)', async () => {
    hydrateInvoke.mockResolvedValue(okCached());
    const { rerender } = render(<TranscriptView {...baseProps} isHydrated={false} showThinking={undefined} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(hydrateInvoke).not.toHaveBeenCalled();

    rerender(<TranscriptView {...baseProps} isHydrated={false} showThinking={true} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(hydrateInvoke).toHaveBeenCalledTimes(1);
    expect(hydrateInvoke).toHaveBeenLastCalledWith({ conversationId: 'conv-abc', showThinking: true });
  });

  it('keeps the cached MessageList visible when a background recheck fails (error becomes banner-only)', async () => {
    hydrateInvoke.mockResolvedValue(fail('mock failure'));
    render(<TranscriptView {...baseProps} isHydrated={true} />);
    await waitFor(() => {
      expect(screen.getByTestId('transcript-error')).toBeInTheDocument();
    });
    // copilot round 5: a failed mtime/source-missing recheck on an already-hydrated
    // mount must NOT blank the transcript — the cached messages are still in SQLite.
    expect(screen.getByTestId('mock-message-list')).toBeInTheDocument();
  });

  it('hides the message list on error when the source was never hydrated (no cache to show)', async () => {
    hydrateInvoke.mockResolvedValue(fail('first-open failure'));
    render(<TranscriptView {...baseProps} isHydrated={false} />);
    await waitFor(() => {
      expect(screen.getByTestId('transcript-error')).toBeInTheDocument();
    });
    // For an unhydrated row there's nothing in SQLite to render; the error stands alone.
    expect(screen.queryByTestId('mock-message-list')).toBeNull();
  });

  it('re-hydrates when showThinking changes (cached cache key includes the option)', async () => {
    hydrateInvoke.mockResolvedValue(okCached());
    const { rerender } = render(<TranscriptView {...baseProps} isHydrated={true} showThinking={false} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(hydrateInvoke).toHaveBeenCalledTimes(1);
    expect(hydrateInvoke).toHaveBeenLastCalledWith({ conversationId: 'conv-abc', showThinking: false });

    // User toggles "Show Thinking" — parent re-renders. Hydrate must run again so the
    // importer can re-convert the transcript into the requested variant.
    rerender(<TranscriptView {...baseProps} isHydrated={false} showThinking={true} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(hydrateInvoke).toHaveBeenCalledTimes(2);
    expect(hydrateInvoke).toHaveBeenLastCalledWith({ conversationId: 'conv-abc', showThinking: true });
  });

  it('re-hydrates when sourceFilePath changes (importer scan moved the row source mid-mount)', async () => {
    hydrateInvoke.mockResolvedValue(okCached());
    const { rerender } = render(
      <TranscriptView {...baseProps} isHydrated={true} sourceFilePath='/sessions/old.jsonl' />
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(hydrateInvoke).toHaveBeenCalledTimes(1);

    // Incremental scan refreshes the source pointer. Parent re-renders with the new
    // path + `isHydrated=false` (per `isHydrationFresh`'s path-match check). The
    // hydrate effect must fire again — without `sourceFilePath` in the trigger key,
    // the ref dedup would skip this and the transcript would keep showing messages
    // from the old file.
    rerender(<TranscriptView {...baseProps} isHydrated={false} sourceFilePath='/sessions/renamed.jsonl' />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(hydrateInvoke).toHaveBeenCalledTimes(2);
  });

  it('refreshes the in-memory message list after status=hydrated (mtime advance re-converts cached row)', async () => {
    hydrateInvoke.mockResolvedValue(okHydrated());
    render(<TranscriptView {...baseProps} isHydrated={true} />);
    // Initial fetch fires when state.phase is already 'ready' from mount.
    await waitFor(() => {
      expect(getConversationMessagesInvoke).toHaveBeenCalled();
    });
    // After the mtime-recheck hydrate resolves with status='hydrated', the rev bump
    // forces a second fetch so newly-inserted messages from the importer batch
    // replace whatever the first fetch read.
    await waitFor(() => {
      expect(getConversationMessagesInvoke.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    expect(getConversationMessagesInvoke).toHaveBeenLastCalledWith(
      expect.objectContaining({ conversation_id: 'conv-abc', page: 0 })
    );
  });

  it('does NOT call getConversationMessages while the skeleton is showing (gates DB-read on phase)', async () => {
    let resolveHydrate: (v: HydrateResultLike) => void = noop;
    hydrateInvoke.mockImplementation(
      () =>
        new Promise<HydrateResultLike>((resolve) => {
          resolveHydrate = resolve;
        })
    );
    render(<TranscriptView {...baseProps} isHydrated={false} />);
    // Skeleton phase — DB read deferred to avoid caching an empty list before
    // the importer's INSERT lands (codex P1 / copilot dup).
    expect(getConversationMessagesInvoke).not.toHaveBeenCalled();
    expect(screen.getByTestId('transcript-skeleton')).toBeInTheDocument();

    await act(async () => {
      resolveHydrate(okHydrated());
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(getConversationMessagesInvoke).toHaveBeenCalled();
    });
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

// ---------------------------------------------------------------------------
// Item-8: Resume launch — predicate + pure-function validation tests
// ---------------------------------------------------------------------------
// These cover the test-plan §5 Resume rows (plan lines 547-555):
//
//   - resume launches Rich UI mode when Step 1 default is Rich
//   - resume launches Terminal mode when Step 1 default is Terminal
//   - failed resume (auth / cwd / source / backend) shows a clear error,
//     transcript stays read-only
//   - native ACP unaffected (regression — covered by `isResumedImportedSession`
//     and `isImportedAcpConversation` already returning false for native rows)
//
// The live-launch wiring itself is in ChatConversation.tsx — covered here
// indirectly by exhaustively testing the pure-function `validateResumeRequest`
// (the click handler's only behavior beyond calling Arco's `Message.error` and
// `ipcBridge.conversation.update`, both already extensively tested in the
// codebase). Mocking ChatConversation's full dependency graph (SWR, layout
// context, Arco header, model selectors) for one boolean gate would add 200+
// lines of fragile setup with no extra signal.

describe('isResumedImportedSession predicate (gate for transcript-mode override)', () => {
  it('returns false for an imported row that has NOT been resumed', () => {
    const conv = mkConv({
      extra: { workspace: '/ws', backend: 'claude', sourceFilePath: '/Users/me/.claude/sess.jsonl' },
    } as unknown as Partial<TChatConversation>);
    expect(isResumedImportedSession(conv)).toBe(false);
  });

  it('returns true once extra.resumedAt is stamped (Date.now from a successful Resume click)', () => {
    const conv = mkConv({
      extra: {
        workspace: '/ws',
        backend: 'claude',
        sourceFilePath: '/Users/me/.claude/sess.jsonl',
        resumedAt: 1_715_000_000_000,
      },
    } as unknown as Partial<TChatConversation>);
    expect(isResumedImportedSession(conv)).toBe(true);
  });

  it('returns false when extra.resumedAt is non-numeric (defensive: legacy / corrupted rows)', () => {
    const conv = mkConv({
      extra: { workspace: '/ws', backend: 'claude', resumedAt: 'yes' },
    } as unknown as Partial<TChatConversation>);
    expect(isResumedImportedSession(conv)).toBe(false);
  });

  it('returns false when extra is null (legacy row)', () => {
    expect(isResumedImportedSession({ ...mkConv(), extra: null as unknown as TChatConversation['extra'] })).toBe(false);
  });

  it('returns false for non-ACP conversation types', () => {
    expect(
      isResumedImportedSession({
        ...mkConv(),
        type: 'gemini',
        extra: { resumedAt: 1 } as unknown as TChatConversation['extra'],
      } as unknown as TChatConversation)
    ).toBe(false);
  });

  it('returns false for undefined / null inputs', () => {
    expect(isResumedImportedSession(undefined)).toBe(false);
    expect(isResumedImportedSession(null)).toBe(false);
  });
});

describe('validateResumeRequest (pure-function pre-flight for the click handler)', () => {
  const NOW = 1_715_555_555_555;

  const importedConv = (overrides: Record<string, unknown> = {}): TChatConversation =>
    mkConv({
      extra: {
        workspace: '/Users/me/proj',
        backend: 'claude',
        acpSessionId: 'sess-abc',
        sourceFilePath: '/Users/me/.claude/sess-abc.jsonl',
        ...overrides,
      },
    } as unknown as Partial<TChatConversation>);

  it('Step 1 default = Rich UI ("acp"): returns updates { resumedAt, currentMode: "acp" } without terminalSwitchedAt', () => {
    const result = validateResumeRequest(importedConv(), 'acp', 'ready', NOW);
    expect(result).toEqual({
      ok: true,
      updates: { extra: { resumedAt: NOW, currentMode: 'acp' } },
    });
  });

  it('Step 1 default = undefined (loaded-but-empty config = {}): falls back to Rich UI', () => {
    // `useAgentCliConfig()` returns `{}` when storage is loaded with no saved
    // preference. `defaultMode` is then `undefined` and the helper must treat
    // that as the documented default (Rich UI / 'acp'), NOT crash and NOT
    // accidentally route to terminal mode.
    const result = validateResumeRequest(importedConv(), undefined, 'ready', NOW);
    expect(result).toEqual({
      ok: true,
      updates: { extra: { resumedAt: NOW, currentMode: 'acp' } },
    });
  });

  it('Step 1 default = "terminal": returns updates { resumedAt, currentMode: "terminal", terminalSwitchedAt }', () => {
    const result = validateResumeRequest(importedConv(), 'terminal', 'ready', NOW);
    expect(result).toEqual({
      ok: true,
      updates: { extra: { resumedAt: NOW, currentMode: 'terminal', terminalSwitchedAt: NOW } },
    });
  });

  it('rejects unsupported backend with errorKey="unsupportedBackend" (Codex V2-deferred per plan)', () => {
    const result = validateResumeRequest(importedConv({ backend: 'codex' }), 'acp', 'ready', NOW);
    expect(result).toEqual({ ok: false, errorKey: 'unsupportedBackend' });
  });

  it('rejects a row whose backend tag is missing entirely', () => {
    const conv = mkConv({
      extra: { workspace: '/ws', acpSessionId: 'x', sourceFilePath: '/p' },
    } as unknown as Partial<TChatConversation>);
    expect(validateResumeRequest(conv, 'acp', 'ready', NOW)).toEqual({ ok: false, errorKey: 'unsupportedBackend' });
  });

  it('accepts backend="copilot"', () => {
    const result = validateResumeRequest(importedConv({ backend: 'copilot' }), 'acp', 'ready', NOW);
    expect(result.ok).toBe(true);
  });

  it('rejects when acpSessionId is missing — errorKey="sessionMissing"', () => {
    const result = validateResumeRequest(importedConv({ acpSessionId: '' }), 'acp', 'ready', NOW);
    expect(result).toEqual({ ok: false, errorKey: 'sessionMissing' });
  });

  it('rejects when acpSessionId is undefined', () => {
    const conv = mkConv({
      extra: { workspace: '/ws', backend: 'claude', sourceFilePath: '/p' },
    } as unknown as Partial<TChatConversation>);
    expect(validateResumeRequest(conv, 'acp', 'ready', NOW)).toEqual({ ok: false, errorKey: 'sessionMissing' });
  });

  it('rejects when workspace is missing — errorKey="cwdMissing" (terminal can\'t spawn / ACP can\'t bind without cwd)', () => {
    const result = validateResumeRequest(importedConv({ workspace: '' }), 'acp', 'ready', NOW);
    expect(result).toEqual({ ok: false, errorKey: 'cwdMissing' });
  });

  it('rejects when workspace is undefined', () => {
    const conv = mkConv({
      extra: { backend: 'claude', acpSessionId: 'x', sourceFilePath: '/p' },
    } as unknown as Partial<TChatConversation>);
    expect(validateResumeRequest(conv, 'acp', 'ready', NOW)).toEqual({ ok: false, errorKey: 'cwdMissing' });
  });

  it('rejects when hydration phase is "unavailable" — errorKey="sourceMissing" (source JSONL gone + no cache)', () => {
    // Even when every other field looks valid, an unavailable phase means the
    // live backend cannot resume — the JSONL is gone and nothing was cached.
    // Surface the dedicated `sourceMissing` error rather than let AcpChat /
    // TerminalChat fail opaquely after the route gate flips.
    const result = validateResumeRequest(importedConv(), 'acp', 'unavailable', NOW);
    expect(result).toEqual({ ok: false, errorKey: 'sourceMissing' });
  });

  it('"unavailable" phase is checked BEFORE backend / session / workspace — exposes the cleanest user-facing reason', () => {
    // If a row has multiple issues at once, the missing source file is the
    // most actionable for the user (the importer's earlier scan already told
    // them it's gone). Checking it first guarantees they get that message
    // instead of, e.g., "unsupportedBackend" from a row whose backend tag
    // happens to also be wrong.
    const conv = mkConv({
      extra: { backend: 'codex', acpSessionId: '', workspace: '' },
    } as unknown as Partial<TChatConversation>);
    expect(validateResumeRequest(conv, 'acp', 'unavailable', NOW)).toEqual({ ok: false, errorKey: 'sourceMissing' });
  });

  it('cached_warning phase still allows resume — cached transcript exists, live backend can still resume by sessionId', () => {
    // The cached-warning path = source JSONL is gone but SQLite has the
    // imported messages. The live ACP / terminal backend's resume is keyed on
    // `acpSessionId`, not the JSONL path, so resume can still succeed. We
    // surface no error and let the user proceed; if the backend rejects the
    // sessionId at connect-time, that's the backend's own surface.
    const result = validateResumeRequest(importedConv(), 'acp', 'cached_warning', NOW);
    expect(result.ok).toBe(true);
  });

  it("error phase still allows resume — failed mtime recheck doesn't block a session-id-based resume", () => {
    const result = validateResumeRequest(importedConv(), 'acp', 'error', NOW);
    expect(result.ok).toBe(true);
  });

  it('returns errorKey="unsupportedBackend" when given a null conversation (defensive)', () => {
    // The click handler in ChatConversation guards on `!conversation` before
    // calling, but the pure function defends against bad input by routing
    // through the backend-check path (no backend → unsupportedBackend).
    expect(validateResumeRequest(null, 'acp', 'ready', NOW)).toEqual({ ok: false, errorKey: 'unsupportedBackend' });
    expect(validateResumeRequest(undefined, 'acp', 'ready', NOW)).toEqual({
      ok: false,
      errorKey: 'unsupportedBackend',
    });
  });

  it('returns errorKey="unsupportedBackend" when extra is a non-object (corrupted row)', () => {
    const conv = { ...mkConv(), extra: 'oops' as unknown as TChatConversation['extra'] };
    expect(validateResumeRequest(conv, 'acp', 'ready', NOW)).toEqual({ ok: false, errorKey: 'unsupportedBackend' });
  });

  it('confirms updates.extra contains exactly the keys mergeExtra will merge — no unrelated stripping', () => {
    // Sanity check on the contract with ipcBridge.conversation.update +
    // mergeExtra: true. The returned `extra` patch contains ONLY the new keys
    // (resumedAt, currentMode, optional terminalSwitchedAt) so the merge
    // preserves the importer-owned fields (sourceFilePath, acpSessionId,
    // hydratedAt, etc.) that downstream code still reads.
    const result = validateResumeRequest(importedConv(), 'terminal', 'ready', NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.keys(result.updates.extra).toSorted()).toEqual(['currentMode', 'resumedAt', 'terminalSwitchedAt']);
    }
  });
});

// Cross-check: the routing predicates compose correctly so a resumed row
// flips from transcript-mode to live-mode without affecting any other row.
describe('shouldShowTranscript routing composition (ChatConversation gate)', () => {
  const importedExtra = {
    workspace: '/ws',
    backend: 'claude',
    acpSessionId: 'sess-abc',
    sourceFilePath: '/Users/me/.claude/sess-abc.jsonl',
  } as const;

  const shouldShowTranscript = (conv: TChatConversation | undefined | null): boolean =>
    isImportedAcpConversation(conv) && !isResumedImportedSession(conv);

  it('imported, not resumed → transcript', () => {
    const conv = mkConv({ extra: importedExtra } as unknown as Partial<TChatConversation>);
    expect(shouldShowTranscript(conv)).toBe(true);
  });

  it('imported, resumed → live route (no transcript)', () => {
    const conv = mkConv({
      extra: { ...importedExtra, resumedAt: 1_715_000_000_000 },
    } as unknown as Partial<TChatConversation>);
    expect(shouldShowTranscript(conv)).toBe(false);
  });

  it('native ACP, never resumed → live route (sanity: regression for item-3 native-ACP contract)', () => {
    // Native rows don't have sourceFilePath; isImportedAcpConversation returns
    // false, so they go straight to live without any resumed-state involved.
    const conv = mkConv({ extra: { workspace: '/ws', backend: 'claude' } } as unknown as Partial<TChatConversation>);
    expect(shouldShowTranscript(conv)).toBe(false);
  });

  it('native ACP with extra.resumedAt set (defensive: should not flip a non-imported row off transcript spuriously)', () => {
    // A native row with resumedAt is an unexpected state (we only stamp
    // resumedAt on imported rows), but defensively: it must still route live
    // because isImportedAcpConversation is false to begin with.
    const conv = mkConv({
      extra: { workspace: '/ws', backend: 'claude', resumedAt: 1 },
    } as unknown as Partial<TChatConversation>);
    expect(shouldShowTranscript(conv)).toBe(false);
  });
});

// Silence the "useless declared but never used" lint when the test file is
// the only consumer of `HydrationPhase` outside production code.
const _phaseAssertion: HydrationPhase = 'ready';
void _phaseAssertion;
