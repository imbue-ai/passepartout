import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { createOpencodeServer } from '@opencode-ai/sdk/server';
import { createOpencodeClient } from '@opencode-ai/sdk/client';
import type { OpencodeClient, Event, Part, ToolPart } from '@opencode-ai/sdk';
import getPort from 'get-port';
import crypto from 'node:crypto';

// OpenCode SDK client and session state
let opencodeClient: OpencodeClient | null = null;
let closeOpencodeServer: (() => void) | null = null;
let sessionId: string | null = null;
let mainWindow: BrowserWindow | null = null;

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

const fixupPathEnvs = () => {
  const nativeToolsPath = app.isPackaged ? path.join(process.resourcesPath, 'native_tools') : path.resolve(__dirname, '../../native_tools');
  process.env.PATH = `${nativeToolsPath}:${process.env.PATH}`;
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(nativeToolsPath, 'playwright_browsers');
}

const createWindow = () => {
  // Create the browser window.
  mainWindow = new BrowserWindow({
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

// Status update type for the renderer
type StatusUpdateDetails = {
  toolName?: string;
  timestamp: number;
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
  duration?: number;
};

// Helper to send status updates to the renderer
function sendStatusUpdate(status: { type: string; message?: string; details?: StatusUpdateDetails }) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('chat:statusUpdate', status);
  }
}

// Helper to get a human-readable description for a tool
function getToolDescription(toolName: string, title?: string): string {
  if (title) {
    return title;
  }
  // Map common tool names to friendly descriptions
  const toolDescriptions: Record<string, string> = {
    'read': 'Reading file',
    'write': 'Writing file',
    'edit': 'Editing file',
    'bash': 'Running command',
    'glob': 'Searching files',
    'grep': 'Searching content',
    'list_directory': 'Listing directory',
    'web_search': 'Searching the web',
    'web_fetch': 'Fetching webpage',
  };
  return toolDescriptions[toolName.toLowerCase()] || `Running ${toolName}`;
}

// Helper to format tool input for display
function formatToolInput(toolName: string, input?: Record<string, unknown>): string {
  if (!input) return '';

  const tool = toolName.toLowerCase();

  // Extract the most relevant input field based on tool type
  if (tool === 'read' || tool === 'write' || tool === 'edit') {
    const filePath = input.file_path || input.path || input.filename;
    if (filePath && typeof filePath === 'string') {
      return filePath;
    }
  } else if (tool === 'bash') {
    const command = input.command;
    if (command && typeof command === 'string') {
      return command;
    }
  } else if (tool === 'glob') {
    const pattern = input.pattern;
    if (pattern && typeof pattern === 'string') {
      return pattern;
    }
  } else if (tool === 'grep') {
    const pattern = input.pattern;
    if (pattern && typeof pattern === 'string') {
      return `"${pattern}"`;
    }
  } else if (tool === 'web_search') {
    const query = input.query;
    if (query && typeof query === 'string') {
      return `"${query}"`;
    }
  } else if (tool === 'web_fetch') {
    const url = input.url;
    if (url && typeof url === 'string') {
      return url;
    }
  }

  return '';
}

// Subscribe to OpenCode events for real-time status updates
async function subscribeToEvents() {
  if (!opencodeClient) return;

  try {
    const result = await opencodeClient.event.subscribe();

    // Process events from the stream
    for await (const eventData of result.stream) {
      if (!eventData) continue;

      // eventData is already the Event type
      const event = eventData as Event;

      switch (event.type) {
        case 'session.status': {
          const props = event.properties;
          if (props?.sessionID === sessionId && props?.status) {
            const status = props.status;
            if (status.type === 'busy') {
              sendStatusUpdate({
                type: 'busy',
                message: 'Thinking...',
                details: { timestamp: Date.now() }
              });
            } else if (status.type === 'idle') {
              sendStatusUpdate({ type: 'idle', details: { timestamp: Date.now() } });
            } else if (status.type === 'retry') {
              sendStatusUpdate({
                type: 'retry',
                message: `Retrying (attempt ${status.attempt})...`,
                details: { timestamp: Date.now() }
              });
            }
          }
          break;
        }

        case 'message.part.updated': {
          const part = event.properties?.part as Part | undefined;
          if (part?.sessionID === sessionId) {
            if (part.type === 'tool') {
              const toolPart = part as ToolPart;
              const state = toolPart.state;

              if (state?.status === 'running') {
                const description = getToolDescription(toolPart.tool, state.title);
                // Extract useful input details
                const input = state.input as Record<string, unknown> | undefined;
                const inputSummary = formatToolInput(toolPart.tool, input);

                sendStatusUpdate({
                  type: 'tool',
                  message: inputSummary ? `${description}: ${inputSummary}` : description,
                  details: {
                    toolName: toolPart.tool,
                    timestamp: Date.now(),
                    input: input,
                  }
                });
              } else if (state?.status === 'completed') {
                const duration = state.time?.end && state.time?.start
                  ? state.time.end - state.time.start
                  : undefined;
                const description = getToolDescription(toolPart.tool, state.title);

                sendStatusUpdate({
                  type: 'tool-completed',
                  message: `${description} completed`,
                  details: {
                    toolName: toolPart.tool,
                    timestamp: Date.now(),
                    output: state.output,
                    duration,
                  }
                });
              } else if (state?.status === 'error') {
                const duration = state.time?.end && state.time?.start
                  ? state.time.end - state.time.start
                  : undefined;

                sendStatusUpdate({
                  type: 'tool-error',
                  message: `Error: ${state.error}`,
                  details: {
                    toolName: toolPart.tool,
                    timestamp: Date.now(),
                    error: state.error,
                    duration,
                  }
                });
              }
            } else if (part.type === 'reasoning') {
              sendStatusUpdate({
                type: 'reasoning',
                message: 'Reasoning...',
                details: { timestamp: Date.now() }
              });
            } else if (part.type === 'text') {
              sendStatusUpdate({
                type: 'generating',
                message: 'Generating response...',
                details: { timestamp: Date.now() }
              });
            }
          }
          break;
        }

        case 'session.idle': {
          if (event.properties?.sessionID === sessionId) {
            sendStatusUpdate({ type: 'idle', details: { timestamp: Date.now() } });
          }
          break;
        }
      }
    }
  } catch (error) {
    console.error('Event subscription error:', error);
  }
}

// Initialize OpenCode SDK and create a session
async function initOpencode() {
  try {
    const username = 'passepartout';
    const password = crypto.randomBytes(32).toString('hex');
    process.env.OPENCODE_SERVER_USERNAME = username;
    process.env.OPENCODE_SERVER_PASSWORD = password;
    const server = await createOpencodeServer({
      port: await getPort(),
    });
    process.env.OPENCODE_SERVER_USERNAME = '';
    process.env.OPENCODE_SERVER_PASSWORD = '';

    const basicAuth = Buffer.from(`${username}:${password}`).toString('base64');
    const client = await createOpencodeClient({
      baseUrl: server.url,
      headers: {
        'Authorization': `Basic ${basicAuth}`,
      },
      directory: app.isPackaged ? path.join(process.resourcesPath, 'opencode_workspace') : path.resolve(__dirname, '../../opencode_workspace'),
    });

    opencodeClient = client;
    closeOpencodeServer = server.close;
    console.log('OpenCode server started on', server.url);

    // Create a session for the chat
    const session = await client.session.create({
      body: {
        title: 'Chat Session',
      },
    });

    sessionId = session.data?.id ?? null;
    console.log('OpenCode session created:', sessionId);

    // Start subscribing to events for real-time updates
    subscribeToEvents();
  } catch (error) {
    console.error('Failed to initialize OpenCode SDK:', error);
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', async () => {
  fixupPathEnvs();
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

app.on('will-quit', () => {
  if (closeOpencodeServer) {
    closeOpencodeServer();
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
ipcMain.handle('chat:sendMessage', async (_event, message: string, providerID: string, modelID: string) => {
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
          providerID,
          modelID,
        },
      },
    });

    if (response.data?.parts) {
      // Extract text parts from the response
      const textParts = response.data.parts
        .filter((part) => part.type === 'text')
        .map((part) => (part as { type: 'text'; text: string }).text);

      return textParts.join('\n') || 'No response received.';
    }

    return 'No response received.';
  } catch (error) {
    console.error('Error sending message:', error);
    return `Error: ${error instanceof Error ? error.message : 'Unknown error occurred'}`;
  }
});
