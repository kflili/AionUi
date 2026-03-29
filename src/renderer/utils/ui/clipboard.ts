/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/** Thrown when clipboard APIs fail and a manual-copy dialog was shown instead. */
export class CopyFallbackShown extends Error {
  constructor() {
    super('Clipboard unavailable — opened manual copy dialog');
    this.name = 'CopyFallbackShown';
  }
}

/**
 * Copy text to clipboard with fallback for non-secure contexts (e.g. WebUI over HTTP).
 * Uses navigator.clipboard when available, otherwise falls back to document.execCommand('copy').
 * On mobile insecure contexts where both fail, shows text in a selectable prompt.
 */
export const copyText = async (text: string): Promise<void> => {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    throw new Error('copyText requires a browser environment');
  }

  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }

  // Fallback for non-secure contexts (WebUI over HTTP)
  const previousActiveElement = document.activeElement as HTMLElement | null;
  const textArea = document.createElement('textarea');
  textArea.value = text;
  textArea.style.position = 'fixed';
  textArea.style.left = '-9999px';
  textArea.style.top = '-9999px';
  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();
  try {
    const success = document.execCommand('copy');
    if (!success) {
      throw new Error('execCommand copy returned false');
    }
  } catch {
    // execCommand failed (common on mobile) — show selectable text prompt
    document.body.removeChild(textArea);
    restoreFocus(previousActiveElement);
    showCopyFallbackModal(text);
    throw new CopyFallbackShown();
  } finally {
    if (document.body.contains(textArea)) {
      document.body.removeChild(textArea);
    }
    restoreFocus(previousActiveElement);
  }
};

function restoreFocus(element: HTMLElement | null): void {
  if (element && typeof element.focus === 'function' && document.contains(element)) {
    element.focus();
  }
}

/**
 * Show a modal with selectable text so the user can long-press to copy on mobile.
 * Uses plain DOM to avoid React dependency in this utility.
 */
function showCopyFallbackModal(text: string): void {
  const overlay = document.createElement('div');
  Object.assign(overlay.style, {
    position: 'fixed',
    inset: '0',
    background: 'rgba(0,0,0,0.5)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: '10000',
    padding: '16px',
  });

  const card = document.createElement('div');
  Object.assign(card.style, {
    background: 'var(--color-bg-2, #fff)',
    borderRadius: '8px',
    padding: '16px',
    maxWidth: '90vw',
    maxHeight: '60vh',
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    boxShadow: '0 4px 24px rgba(0,0,0,0.2)',
  });

  const label = document.createElement('div');
  label.textContent = 'Long-press to select and copy:';
  Object.assign(label.style, {
    fontSize: '14px',
    color: 'var(--color-text-2, #333)',
    fontWeight: '500',
  });

  const textEl = document.createElement('textarea');
  textEl.value = text;
  textEl.readOnly = true;
  Object.assign(textEl.style, {
    width: '100%',
    minHeight: '80px',
    maxHeight: '40vh',
    padding: '8px',
    border: '1px solid var(--color-border, #e5e5e5)',
    borderRadius: '4px',
    fontSize: '13px',
    fontFamily: 'monospace',
    wordBreak: 'break-all',
    boxSizing: 'border-box',
    resize: 'vertical',
    background: 'var(--color-bg-3, #f5f5f5)',
    color: 'var(--color-text-1, #000)',
  });

  const closeBtn = document.createElement('button');
  closeBtn.textContent = 'Close';
  Object.assign(closeBtn.style, {
    alignSelf: 'flex-end',
    padding: '6px 16px',
    borderRadius: '4px',
    border: 'none',
    background: 'var(--color-primary-light-1, #e8f3ff)',
    color: 'var(--color-primary-6, #165dff)',
    fontSize: '14px',
    cursor: 'pointer',
  });

  const close = () => {
    if (document.body.contains(overlay)) {
      document.body.removeChild(overlay);
    }
  };

  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  card.appendChild(label);
  card.appendChild(textEl);
  card.appendChild(closeBtn);
  overlay.appendChild(card);
  document.body.appendChild(overlay);

  // Auto-select text for easy copying
  textEl.focus();
  textEl.select();
}
