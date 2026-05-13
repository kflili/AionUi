/**
 * Integration smoke test for Layout.tsx — asserts the global desktop sider
 * width is sourced from the resizable pixel-width hook, not the hardcoded
 * DEFAULT_SIDER_WIDTH constant. This regression-protects Phase O (feat:
 * resizable left sidebar). See Phase N findings.md for evidence chain.
 *
 * Rendering the full Layout component is heavy (many IPC, router, theme,
 * and tray dependencies). A focused source-level check is sufficient for
 * the contract: "Layout uses the hook." The hook itself is exhaustively
 * unit-tested in useResizablePixelWidth.dom.test.tsx.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const LAYOUT_PATH = path.resolve(__dirname, '../../src/renderer/components/layout/Layout.tsx');

describe('Layout.tsx — resizable left sider integration', () => {
  const source = fs.readFileSync(LAYOUT_PATH, 'utf8');

  it('imports useResizablePixelWidth', () => {
    expect(source).toMatch(
      /import\s*\{\s*useResizablePixelWidth\s*\}\s*from\s*['"]@renderer\/hooks\/ui\/useResizablePixelWidth['"]/
    );
  });

  it('invokes useResizablePixelWidth with the global sider storage key and bounds', () => {
    // Locate the hook call block and assert the four critical args.
    expect(source).toMatch(/useResizablePixelWidth\s*\(\s*\{[^}]*\}/);

    const hookCallMatch = source.match(/useResizablePixelWidth\s*\(\s*(\{[\s\S]*?\})\s*\)/);
    expect(hookCallMatch).toBeTruthy();
    const args = hookCallMatch![1];

    expect(args).toMatch(/defaultWidth:\s*DEFAULT_SIDER_WIDTH/);
    expect(args).toMatch(/minWidth:\s*MIN_SIDER_WIDTH/);
    expect(args).toMatch(/maxWidth:\s*MAX_SIDER_WIDTH/);
    expect(args).toMatch(/storageKey:\s*SIDER_WIDTH_STORAGE_KEY/);
  });

  it('declares the resizable sider bounds and storage key constants', () => {
    expect(source).toMatch(/const\s+MIN_SIDER_WIDTH\s*=\s*200\b/);
    expect(source).toMatch(/const\s+MAX_SIDER_WIDTH\s*=\s*400\b/);
    expect(source).toMatch(/const\s+SIDER_WIDTH_STORAGE_KEY\s*=\s*['"]aionui_global_sider_width['"]/);
  });

  it('desktop siderWidth comes from the hook, not the hardcoded DEFAULT_SIDER_WIDTH constant', () => {
    // The desktop fall-through must reference resizableSiderWidth (the hook's
    // returned value, destructured as `width`).
    expect(source).toMatch(/const\s+siderWidth\s*=\s*isMobile[\s\S]+:\s*resizableSiderWidth/);
    // Negative assertion: the desktop branch must NOT be the bare constant.
    expect(source).not.toMatch(/const\s+siderWidth\s*=\s*isMobile[\s\S]+:\s*DEFAULT_SIDER_WIDTH;/);
  });

  it('renders the drag handle inside the Sider, gated on desktop + expanded', () => {
    // Handle is conditionally rendered on !isMobile && !collapsed.
    expect(source).toMatch(/!isMobile\s*&&\s*!collapsed\s*&&\s*siderDragHandle/);
  });
});
