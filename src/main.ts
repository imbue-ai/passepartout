import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { createOpencode } from '@opencode-ai/sdk';
import type { Client as OpencodeClient } from '@opencode-ai/sdk';

// OpenCode SDK client and session state
let opencodeClient: OpencodeClient | null = null;
let sessionId: string | null = null;

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

const fixupPath = () => {
  if (app.isPackaged) {
    const binPath = path.join(process.resourcesPath, 'bin');
    process.env.PATH = `${binPath}:${process.env.PATH}`;
  } else {
    // TODO: Make this platform-agnostic
    const binPath = path.resolve(__dirname, 'node_modules/opencode-darwin-arm64/bin');
    process.env.PATH = `${binPath}:${process.env.PATH}`;
  }
}

const createWindow = () => {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // and load the index.html of the app.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }
};

// Initialize OpenCode SDK and create a session
async function initOpencode() {
  try {
    const cwd = process.cwd();
    console.log('Initializing OpenCode SDK with cwd:', cwd);

    const { client } = await createOpencode({
      port: 14096,
    });

    opencodeClient = client;

    // Create a session for the chat
    const session = await client.session.create({
      body: {
        title: 'Chat Session',
      },
      query: {
        directory: cwd,
      },
    });

    sessionId = session.data?.id ?? null;
    console.log('OpenCode session created:', sessionId);
  } catch (error) {
    console.error('Failed to initialize OpenCode SDK:', error);
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', async () => {
  fixupPath();
  await initOpencode();
  createWindow();
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// IPC Handler: Server-side message processing using OpenCode SDK
ipcMain.handle('chat:sendMessage', async (_event, message: string) => {
  if (!opencodeClient || !sessionId) {
    return 'Error: OpenCode SDK not initialized. Please restart the app.';
  }

  try {
    // Send the message to the OpenCode session and get the response
    const response = await opencodeClient.session.prompt({
      path: { id: sessionId },
      body: {
        parts: [{ type: 'text', text: message }],
        model: {
          providerID: 'anthropic',
          modelID: 'claude-sonnet-4-5-20250929',
        },
      },
    });

    if (response.data?.parts) {
      // Extract text parts from the response
      const textParts = response.data.parts
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
        .map((part) => part.text);

      return textParts.join('\n') || 'No response received.';
    }

    return 'No response received.';
  } catch (error) {
    console.error('Error sending message:', error);
    return `Error: ${error instanceof Error ? error.message : 'Unknown error occurred'}`;
  }
});
