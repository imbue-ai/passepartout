// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts

import { contextBridge, ipcRenderer } from 'electron';

// Status update type
export type StatusUpdate = {
  type: 'idle' | 'busy' | 'tool' | 'reasoning' | 'generating' | 'retry';
  message?: string;
};

// Model configuration type
export type ModelConfig = {
  providerID: string;
  modelID: string;
};

// Model option for the dropdown
export type ModelOption = {
  providerID: string;
  modelID: string;
  displayName: string;
};

// Expose a secure API to the renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  sendMessage: (message: string): Promise<string> => {
    return ipcRenderer.invoke('chat:sendMessage', message);
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
  getAvailableModels: (): Promise<ModelOption[]> => {
    return ipcRenderer.invoke('chat:getAvailableModels');
  },
  setModel: (model: ModelConfig): Promise<void> => {
    return ipcRenderer.invoke('chat:setModel', model);
  },
  getCurrentModel: (): Promise<ModelConfig> => {
    return ipcRenderer.invoke('chat:getCurrentModel');
  },
});
