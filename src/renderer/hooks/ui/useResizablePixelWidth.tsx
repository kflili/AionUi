/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useCallback } from 'react';
import type { CSSProperties } from 'react';
import classNames from 'classnames';
import { removeStack } from '@/renderer/utils/common';

const addWindowEventListener = <K extends keyof WindowEventMap>(
  key: K,
  handler: (e: WindowEventMap[K]) => void
): (() => void) => {
  if (typeof window === 'undefined') {
    return () => {};
  }
  window.addEventListener(key, handler);
  return () => {
    window.removeEventListener(key, handler);
  };
};

interface UseResizablePixelWidthOptions {
  /** 默认宽度（像素） / Default width in pixels */
  defaultWidth: number;
  /** 最小宽度（像素） / Minimum width in pixels */
  minWidth: number;
  /** 最大宽度（像素） / Maximum width in pixels */
  maxWidth: number;
  /** LocalStorage 存储键名（用于记录偏好） / LocalStorage key for saving user preference */
  storageKey?: string;
}

/**
 * 像素宽度可拖动 Hook，支持记录用户偏好
 * Pixel-width resizable Hook with user preference persistence.
 *
 * Pixel-mode counterpart to `useResizableSplit` (which is ratio-based and
 * intended for splits inside a known parent container). Use this for panes
 * whose width is independent of a parent split — e.g. the global left sider
 * whose width is the sider itself, not a fraction of an outer container.
 *
 * The drag handle reads `event.clientX` directly and clamps the resulting
 * pixel width to `[minWidth, maxWidth]`. The current width is persisted to
 * `localStorage` under `storageKey` if provided.
 */
export const useResizablePixelWidth = (options: UseResizablePixelWidthOptions) => {
  const { defaultWidth, minWidth, maxWidth, storageKey } = options;

  // 从 LocalStorage 读取保存的宽度 / Read saved width from LocalStorage
  const getStoredWidth = (): number => {
    if (!storageKey) return defaultWidth;
    if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') return defaultWidth;
    try {
      const stored = window.localStorage.getItem(storageKey);
      if (stored) {
        const px = parseFloat(stored);
        if (!isNaN(px) && px >= minWidth && px <= maxWidth) {
          return px;
        }
      }
    } catch (error) {
      console.error('Failed to read pixel width from localStorage:', error);
    }
    return defaultWidth;
  };

  const [width, setWidthState] = useState(() => getStoredWidth());

  // 保存宽度到 LocalStorage / Save width to LocalStorage
  const setWidth = useCallback(
    (px: number) => {
      const clamped = Math.max(minWidth, Math.min(maxWidth, px));
      setWidthState(clamped);
      if (storageKey && typeof window !== 'undefined' && typeof window.localStorage !== 'undefined') {
        try {
          window.localStorage.setItem(storageKey, clamped.toString());
        } catch (error) {
          console.error('Failed to save pixel width to localStorage:', error);
        }
      }
    },
    [storageKey, minWidth, maxWidth]
  );

  // 处理拖动开始事件 / Handle drag start event
  const handleDragStart = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.pointerType !== 'touch' && event.button !== 0) {
        return;
      }
      event.preventDefault();

      const dragHandle = event.currentTarget as HTMLElement;
      const startX = event.clientX;
      const startWidth = width;
      const pointerId = event.pointerId;
      let rafId: number | null = null;
      let pendingWidth: number | null = null;
      let latestWidth = startWidth;
      let isDragging = true;
      let cleanupListeners: (() => void) | null = null;

      const flushPendingWidth = () => {
        if (pendingWidth === null) {
          return;
        }
        latestWidth = pendingWidth;
        setWidthState(pendingWidth);
      };

      // 初始化拖动样式 / Initialize drag styles
      const initDragStyle = () => {
        const originalUserSelect = document.body.style.userSelect;
        document.body.style.userSelect = 'none';
        document.body.style.cursor = 'col-resize';

        const layoutSider = dragHandle.closest('.layout-sider');
        if (layoutSider) {
          layoutSider.classList.add('layout-sider--dragging');
        }

        return () => {
          document.body.style.userSelect = originalUserSelect;
          document.body.style.cursor = '';
          if (rafId !== null) {
            cancelAnimationFrame(rafId);
            rafId = null;
          }
          if (layoutSider) {
            layoutSider.classList.remove('layout-sider--dragging');
          }
        };
      };

      const finishDrag = (e?: PointerEvent | MouseEvent | FocusEvent) => {
        if (!isDragging) {
          return;
        }
        isDragging = false;

        if (rafId !== null) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
        flushPendingWidth();

        let finalWidth = latestWidth;
        if (e && 'clientX' in e && typeof e.clientX === 'number') {
          const deltaX = e.clientX - startX;
          finalWidth = Math.max(minWidth, Math.min(maxWidth, startWidth + deltaX));
          latestWidth = finalWidth;
        }

        setWidth(finalWidth);
        cleanupListeners?.();
      };

      const handlePointerMove = (e: PointerEvent) => {
        if (!isDragging) {
          return;
        }
        if (e.buttons === 0) {
          finishDrag(e);
          return;
        }
        const deltaX = e.clientX - startX;
        pendingWidth = Math.max(minWidth, Math.min(maxWidth, startWidth + deltaX));
        if (rafId === null) {
          rafId = requestAnimationFrame(() => {
            rafId = null;
            flushPendingWidth();
          });
        }
      };

      const handleLostPointerCapture = () => finishDrag();
      const handlePointerUp = (e: PointerEvent) => finishDrag(e);
      const handlePointerCancel = (e: PointerEvent) => finishDrag(e);
      const handleMouseUp = (e: MouseEvent) => finishDrag(e);

      if (dragHandle.setPointerCapture) {
        try {
          dragHandle.setPointerCapture(pointerId);
          dragHandle.addEventListener('lostpointercapture', handleLostPointerCapture);
        } catch (error) {
          // 忽略 pointer capture 失败 / Ignore pointer capture failures silently
        }
      }

      const releasePointerCapture = () => {
        if (dragHandle.releasePointerCapture && dragHandle.hasPointerCapture?.(pointerId)) {
          dragHandle.releasePointerCapture(pointerId);
        }
        dragHandle.removeEventListener('lostpointercapture', handleLostPointerCapture);
      };

      cleanupListeners = removeStack(
        initDragStyle(),
        releasePointerCapture,
        addWindowEventListener('pointermove', handlePointerMove),
        addWindowEventListener('pointerup', handlePointerUp),
        addWindowEventListener('pointercancel', handlePointerCancel),
        addWindowEventListener('mouseup', handleMouseUp),
        addWindowEventListener('blur', () => finishDrag())
      );
    },
    [width, minWidth, maxWidth, setWidth]
  );

  const renderHandle = ({
    className,
    style,
    lineClassName,
    lineStyle,
    ariaLabel,
  }: {
    className?: string;
    style?: CSSProperties;
    lineClassName?: string;
    lineStyle?: CSSProperties;
    ariaLabel?: string;
  } = {}) => (
    <div
      className={classNames(
        'group absolute top-0 bottom-0 z-20 cursor-col-resize flex items-center justify-end',
        className
      )}
      style={{ width: '12px', ...style }}
      onPointerDown={handleDragStart}
      onDoubleClick={() => setWidth(defaultWidth)}
      role='separator'
      aria-orientation='vertical'
      aria-label={ariaLabel}
      data-testid='global-sider-resize-handle'
    >
      <span
        className={classNames(
          'pointer-events-none block h-full w-2px bg-bg-3 opacity-90 rd-full transition-all duration-150 group-hover:w-6px group-hover:bg-aou-6 group-active:w-6px group-active:bg-aou-6',
          lineClassName
        )}
        style={lineStyle}
      />
    </div>
  );

  return {
    width,
    setWidth,
    dragHandle: renderHandle({ className: 'right-0' }),
    createDragHandle: renderHandle,
  };
};
