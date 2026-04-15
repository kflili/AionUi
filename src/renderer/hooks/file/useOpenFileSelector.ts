import { ipcBridge } from '@/common';
import { isElectronDesktop } from '@/renderer/utils/platform';
import { useCallback } from 'react';

interface UseOpenFileSelectorOptions {
  onFilesSelected: (files: string[]) => void;
}

interface UseOpenFileSelectorResult {
  openFileSelector: () => void;
  onSlashBuiltinCommand: (name: string) => void;
}

/**
 * Shared open-file selector behavior for send boxes.
 * Unifies '+' button and '/open' builtin command handling.
 *
 * In Electron: opens native file dialog.
 * In WebUI: triggers DirectorySelectionModal via bridge events.
 */
export function useOpenFileSelector(options: UseOpenFileSelectorOptions): UseOpenFileSelectorResult {
  const { onFilesSelected } = options;

  const openFileSelector = useCallback(() => {
    // Electron supports mixed file+folder selection on Mac (openFile + openDirectory).
    // WebUI uses a separate DirectorySelectionModal that infers mode from properties,
    // so only include openDirectory on Electron to avoid breaking WebUI's file mode.
    const properties: Array<'openFile' | 'openDirectory' | 'multiSelections'> = isElectronDesktop()
      ? ['openFile', 'openDirectory', 'multiSelections']
      : ['openFile', 'multiSelections'];
    void ipcBridge.dialog.showOpen
      .invoke({ properties })
      .then((files) => {
        if (!files || files.length === 0) {
          return;
        }
        onFilesSelected(files);
      })
      .catch((error) => {
        // In WebUI, dialog may fail if DirectorySelectionModal is not rendered
        // or bridge is not properly connected. Log error for debugging.
        console.warn('[useOpenFileSelector] Failed to open file selector:', error);
      });
  }, [onFilesSelected]);

  const onSlashBuiltinCommand = useCallback(
    (name: string) => {
      if (name === 'open') {
        openFileSelector();
      }
    },
    [openFileSelector]
  );

  return {
    openFileSelector,
    onSlashBuiltinCommand,
  };
}
