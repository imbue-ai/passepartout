// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts

import { contextBridge, ipcRenderer } from 'electron';

// Status update type
export type StatusUpdate = {
  type: 'idle' | 'busy' | 'tool' | 'tool-completed' | 'tool-error' | 'reasoning' | 'generating' | 'retry';
  message?: string;
  // Additional details for the execution log
  details?: {
    toolName?: string;
    timestamp: number;
    // Tool-specific details
    input?: Record<string, unknown>;
    output?: string;
    error?: string;
    duration?: number; // in milliseconds
  };
};

// Expose a secure API to the renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  sendMessage: (message: string, providerID: string, modelID: string): Promise<string> => {
    return ipcRenderer.invoke('chat:sendMessage', message, providerID, modelID);
  },
  onStatusUpdate: (callback: (status: StatusUpdate) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: StatusUpdate) => {
      callback(status);
    };
    ipcRenderer.on('chat:statusUpdate', handler);
    // Return cleanup function
    return () => {
      ipcRenderer.removeListener('chat:statusUpdate', handler);
    };
  },
});
