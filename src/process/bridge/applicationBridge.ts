/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { app } from 'electron';
import { ipcBridge } from '../../common';
import { getSystemDir, ProcessEnv } from '../initStorage';
import { copyDirectoryRecursively } from '../utils';
import WorkerManage from '../WorkerManage';
import { getZoomFactor, setZoomFactor } from '../utils/zoom';
import { getCdpStatus, updateCdpConfig, verifyCdpReady } from '../../utils/configureChromium';
import { apiDiagnosticsService } from '../services/ApiDiagnosticsService';

export function initApplicationBridge(): void {
  ipcBridge.application.restart.provider(() => {
    // 清理所有工作进程
    WorkerManage.clear();
    // 重启应用 - 使用标准的 Electron 重启方式
    app.relaunch();
    app.exit(0);
    return Promise.resolve();
  });

  ipcBridge.application.updateSystemInfo.provider(async ({ cacheDir, workDir }) => {
    try {
      const oldDir = getSystemDir();
      if (oldDir.cacheDir !== cacheDir) {
        await copyDirectoryRecursively(oldDir.cacheDir, cacheDir);
      }
      await ProcessEnv.set('aionui.dir', { cacheDir, workDir });
      return { success: true };
    } catch (e) {
      return { success: false, msg: e.message || e.toString() };
    }
  });

  ipcBridge.application.systemInfo.provider(() => {
    return Promise.resolve(getSystemDir());
  });

  ipcBridge.application.getPath.provider(({ name }) => {
    return Promise.resolve(app.getPath(name));
  });

  ipcBridge.application.openDevTools.provider(() => {
    // This will be handled by the main window when needed
    return Promise.resolve(false);
  });

  ipcBridge.application.getZoomFactor.provider(() => Promise.resolve(getZoomFactor()));

  ipcBridge.application.setZoomFactor.provider(({ factor }) => {
    return Promise.resolve(setZoomFactor(factor));
  });

  ipcBridge.application.getApiDiagnosticsState.provider(() => {
    return Promise.resolve({
      success: true,
      data: apiDiagnosticsService.getConfig(),
    });
  });

  ipcBridge.application.updateApiDiagnosticsConfig.provider((config) => {
    try {
      return Promise.resolve({
        success: true,
        data: apiDiagnosticsService.updateConfig(config),
      });
    } catch (e) {
      return Promise.resolve({
        success: false,
        msg: e instanceof Error ? e.message : String(e),
      });
    }
  });

  ipcBridge.application.captureApiDiagnosticsSnapshot.provider(({ sessionId, persist }) => {
    try {
      const capture = apiDiagnosticsService.captureRouteSample({
        route: '/ipc/application/api-diagnostics',
        reason: 'renderer_manual_snapshot',
        sessionId,
        force: true,
        persist,
        allowWhenDisabled: true,
      });

      if (!capture.recorded || !capture.snapshot) {
        return Promise.resolve({
          success: false,
          msg: 'No diagnostics snapshot was recorded',
        });
      }

      return Promise.resolve({
        success: true,
        data: {
          filePath: capture.filePath,
          snapshot: capture.snapshot,
        },
      });
    } catch (e) {
      return Promise.resolve({
        success: false,
        msg: e instanceof Error ? e.message : String(e),
      });
    }
  });

  ipcBridge.application.getApiDiagnosticsLiveSnapshot.provider((input: { sessionId?: string } | undefined) => {
    try {
      return Promise.resolve({
        success: true,
        data: {
          snapshot: apiDiagnosticsService.getLiveSnapshot({
            route: '/ipc/application/api-diagnostics/live',
            reason: 'renderer_live_snapshot',
            sessionId: input?.sessionId,
          }),
        },
      });
    } catch (e) {
      return Promise.resolve({
        success: false,
        msg: e instanceof Error ? e.message : String(e),
      });
    }
  });

  ipcBridge.application.getApiDiagnosticsHistory.provider((input: { limit?: number } | undefined) => {
    try {
      return Promise.resolve({
        success: true,
        data: {
          captures: apiDiagnosticsService.getRecentCaptures(input?.limit),
        },
      });
    } catch (e) {
      return Promise.resolve({
        success: false,
        msg: e instanceof Error ? e.message : String(e),
      });
    }
  });

  // CDP status and configuration
  ipcBridge.application.getCdpStatus.provider(async () => {
    try {
      const status = getCdpStatus();
      // If port is set, CDP is considered enabled (verification is optional)
      return { success: true, data: status };
    } catch (e) {
      return { success: false, msg: e.message || e.toString() };
    }
  });

  ipcBridge.application.updateCdpConfig.provider(async (config) => {
    try {
      const updatedConfig = updateCdpConfig(config);
      return { success: true, data: updatedConfig };
    } catch (e) {
      return { success: false, msg: e.message || e.toString() };
    }
  });
}
