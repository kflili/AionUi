/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { TChatConversation } from '@/common/config/storage';

/**
 * Emit a `conversation.list-changed` IPC event so renderer-side subscribers can
 * refresh their conversation list when a row is added, updated, or removed.
 *
 * Kept in its own module (rather than exported from `conversationBridge.ts`) to
 * avoid a circular import: `conversationBridge.ts` imports `isSessionIdle` from
 * `cliHistoryBridge.ts`, which in turn loads `cli-history/importer.ts` — the
 * importer needs to call this emitter, so the helper lives in a leaf module
 * that no bridge file depends on.
 */
export function emitConversationListChanged(
  conversation: Pick<TChatConversation, 'id' | 'source'>,
  action: 'created' | 'updated' | 'deleted'
): void {
  ipcBridge.conversation.listChanged.emit({
    conversationId: conversation.id,
    action,
    source: conversation.source || 'aionui',
  });
}
