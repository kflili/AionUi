/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { app } from 'electron';

// Configure Chromium command-line flags for WebUI and CLI modes
// 为 WebUI 和 CLI 模式配置 Chromium 命令行参数

const isWebUI = process.argv.some((arg) => arg === '--webui');
const isResetPassword = process.argv.includes('--resetpass');

// Detect Linux without any display server (X11 or Wayland)
// 检测无显示服务器的 Linux 环境（X11 或 Wayland）
const isLinuxNoDisplay = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;

// For all modes: enable headless on Linux without display to prevent segfault
// 对所有模式：Linux 无显示时启用 headless 防止段错误崩溃
if (isLinuxNoDisplay) {
  app.commandLine.appendSwitch('headless');
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-software-rasterizer');
  // Prevent GPU sandbox init failure (error_code=1002) on servers without user namespaces
  app.commandLine.appendSwitch('no-sandbox');
  // Prevent network service crash caused by insufficient /dev/shm in container environments
  app.commandLine.appendSwitch('disable-dev-shm-usage');
}

// Detect Linux with Wayland display server
// Force X11/XWayland to avoid Electron-Wayland compatibility issues on GNOME + Wayland
const isLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;

if (isLinuxWayland) {
  app.commandLine.appendSwitch('ozone-platform', 'x11');
}

// For WebUI and --resetpass modes: disable sandbox for root user
// 仅 WebUI 和重置密码模式：root 用户禁用沙箱
if (isWebUI || isResetPassword) {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    app.commandLine.appendSwitch('no-sandbox');
  }
}
