import React, { useState, useRef, useEffect, useCallback } from 'react';
import Markdown from 'react-markdown';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';

// Credential types
interface CredentialStatus {
  provider_id: string;
  has_key: boolean;
}

// Provider display info
const providerInfo: Record<string, { displayName: string; placeholder: string }> = {
  anthropic: {
    displayName: 'Anthropic',
    placeholder: 'sk-ant-...',
  },
  openai: {
    displayName: 'OpenAI',
    placeholder: 'sk-...',
  },
  google: {
    displayName: 'Google',
    placeholder: 'AIza...',
  },
};

type StatusUpdate = {
  type: 'idle' | 'busy' | 'tool' | 'tool-completed' | 'tool-error' | 'reasoning' | 'generating' | 'retry';
  message?: string; // Truncated message for the status bubble
  details?: {
    fullMessage?: string; // Full message for the execution log
    toolName?: string;
    timestamp: number;
    input?: Record<string, unknown>;
    output?: string;
    error?: string;
    duration?: number;
  };
};

interface ExecutionLogEntry {
  id: number;
  type: StatusUpdate['type'];
  message: string;
  timestamp: number;
  toolName?: string;
  duration?: number;
  output?: string;
  error?: string;
}

interface Message {
  id: number;
  text: string;
  sender: 'user' | 'bot';
  executionLog?: ExecutionLogEntry[];
}

type ModelOption = {
  providerID: string;
  modelID: string;
  displayName: string;
};

// Available models configuration
const availableModels: ModelOption[] = [
  // Anthropic models
  { providerID: 'anthropic', modelID: 'claude-opus-4-5-20251101', displayName: 'Claude Opus 4.5' },
  { providerID: 'anthropic', modelID: 'claude-sonnet-4-5-20250929', displayName: 'Claude Sonnet 4.5' },
  { providerID: 'anthropic', modelID: 'claude-haiku-4-5-20251017', displayName: 'Claude Haiku 4.5' },
  // OpenAI models
  { providerID: 'openai', modelID: 'o3', displayName: 'OpenAI o3' },
  { providerID: 'openai', modelID: 'o4-mini', displayName: 'OpenAI o4-mini' },
  { providerID: 'openai', modelID: 'gpt-4.1', displayName: 'GPT-4.1' },
  { providerID: 'openai', modelID: 'gpt-4.1-mini', displayName: 'GPT-4.1 Mini' },
  // Google models
  { providerID: 'google', modelID: 'gemini-3-pro', displayName: 'Gemini 3 Pro' },
  { providerID: 'google', modelID: 'gemini-3-flash', displayName: 'Gemini 3 Flash' },
];

// Default model
const defaultModel = availableModels[0];

// Monotonically increasing counter for unique IDs
let nextLogEntryId = 0;

// CredentialsPanel component for managing API keys
interface CredentialsPanelProps {
  onClose: () => void;
}

function CredentialsPanel({ onClose }: CredentialsPanelProps) {
  const [credentials, setCredentials] = useState<CredentialStatus[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // Load credentials on mount
  useEffect(() => {
    loadCredentials();
  }, []);

  // Handle escape key to close modal
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !editingProvider) {
        onClose();
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [onClose, editingProvider]);

  const loadCredentials = async () => {
    try {
      setIsLoading(true);
      setError(null);
      console.log('[Credentials] Loading credentials...');
      const result = await invoke<CredentialStatus[]>('list_credentials');
      console.log('[Credentials] Loaded:', result);
      setCredentials(result);
    } catch (err) {
      console.error('[Credentials] Failed to load:', err);
      setError(`Failed to load credentials: ${err}`);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSaveCredential = async (providerId: string) => {
    if (!apiKeyInput.trim()) {
      setError('API key cannot be empty');
      return;
    }

    try {
      setIsSaving(true);
      setError(null);
      console.log('[Credentials] Saving credential for:', providerId);
      await invoke('save_credential', {
        providerId,
        apiKey: apiKeyInput.trim(),
      });
      console.log('[Credentials] Save successful');
      setEditingProvider(null);
      setApiKeyInput('');
      await loadCredentials();
    } catch (err) {
      console.error('[Credentials] Failed to save:', err);
      setError(`Failed to save credential: ${err}`);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteCredential = async (providerId: string) => {
    try {
      setError(null);
      console.log('[Credentials] Deleting credential for:', providerId);
      await invoke('delete_credential', { providerId });
      console.log('[Credentials] Delete successful');
      await loadCredentials();
    } catch (err) {
      console.error('[Credentials] Failed to delete:', err);
      setError(`Failed to delete credential: ${err}`);
    }
  };

  const startEditing = (providerId: string) => {
    setEditingProvider(providerId);
    setApiKeyInput('');
    setError(null);
  };

  const cancelEditing = () => {
    setEditingProvider(null);
    setApiKeyInput('');
    setError(null);
  };

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <div className="modal-overlay" onClick={handleOverlayClick}>
      <div className="credentials-modal">
        <div className="credentials-header">
          <h2>API Keys</h2>
          <button className="close-button" onClick={onClose} type="button">
            &times;
          </button>
        </div>
        <p className="credentials-description">
          Configure your API keys for each LLM provider. Keys are stored securely in your system keychain.
        </p>
        {error && <div className="credentials-error">{error}</div>}
        {isLoading ? (
          <div className="credentials-loading">Loading...</div>
        ) : (
          <div className="credentials-list">
            {credentials.map((cred) => {
              const info = providerInfo[cred.provider_id] || {
                displayName: cred.provider_id,
                placeholder: 'Enter API key...',
              };
              const isEditing = editingProvider === cred.provider_id;

              return (
                <div key={cred.provider_id} className="credential-item">
                  <div className="credential-info">
                    <span className="credential-name">{info.displayName}</span>
                    <span className={`credential-status ${cred.has_key ? 'has-key' : 'no-key'}`}>
                      {cred.has_key ? 'Configured' : 'Not configured'}
                    </span>
                  </div>
                  {isEditing ? (
                    <div className="credential-edit">
                      <input
                        type="password"
                        value={apiKeyInput}
                        onChange={(e) => setApiKeyInput(e.target.value)}
                        placeholder={info.placeholder}
                        className="credential-input"
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleSaveCredential(cred.provider_id);
                          if (e.key === 'Escape') cancelEditing();
                        }}
                      />
                      <div className="credential-actions">
                        <button
                          className="save-button"
                          onClick={() => handleSaveCredential(cred.provider_id)}
                          disabled={isSaving}
                          type="button"
                        >
                          {isSaving ? 'Saving...' : 'Save'}
                        </button>
                        <button
                          className="cancel-button"
                          onClick={cancelEditing}
                          disabled={isSaving}
                          type="button"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="credential-actions">
                      <button
                        className="edit-button"
                        onClick={() => startEditing(cred.provider_id)}
                        type="button"
                      >
                        {cred.has_key ? 'Update' : 'Add'}
                      </button>
                      {cred.has_key && (
                        <button
                          className="delete-button"
                          onClick={() => handleDeleteCredential(cred.provider_id)}
                          type="button"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ExecutionLog component with smart auto-scroll
interface ExecutionLogProps {
  log: ExecutionLogEntry[];
  isExpanded: boolean;
  onToggle: () => void;
  formatTime: (timestamp: number) => string;
  formatDuration: (ms: number) => string;
  getLogIcon: (type: StatusUpdate['type']) => string;
}

function ExecutionLog({ log, isExpanded, onToggle, formatTime, formatDuration, getLogIcon }: ExecutionLogProps) {
  const entriesRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);

  // Check if scrolled to bottom (with small threshold for floating point)
  const checkIfAtBottom = useCallback(() => {
    const el = entriesRef.current;
    if (!el) return true;
    const threshold = 5;
    return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  }, []);

  // Handle scroll events to track if user is at bottom
  const handleScroll = useCallback(() => {
    isAtBottomRef.current = checkIfAtBottom();
  }, [checkIfAtBottom]);

  // Auto-scroll to bottom when new entries are added (only if already at bottom)
  useEffect(() => {
    const el = entriesRef.current;
    if (el && isAtBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [log.length]);

  return (
    <div className="execution-log">
      <button
        className="execution-log-toggle"
        onClick={onToggle}
        type="button"
      >
        <span className="toggle-icon">{isExpanded ? '▼' : '▶'}</span>
        <span className="toggle-text">
          Execution log ({log.length} {log.length === 1 ? 'step' : 'steps'})
        </span>
      </button>
      {isExpanded && (
        <div
          className="execution-log-entries"
          ref={entriesRef}
          onScroll={handleScroll}
        >
          {log.map((entry) => (
            <div key={entry.id} className={`log-entry log-entry-${entry.type}`}>
              <span className="log-icon">{getLogIcon(entry.type)}</span>
              <span className="log-time">{formatTime(entry.timestamp)}</span>
              <span className="log-message">
                {entry.message}
                {entry.duration !== undefined && (
                  <span className="log-duration"> ({formatDuration(entry.duration)})</span>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [executionLog, setExecutionLog] = useState<ExecutionLogEntry[]>([]);
  const [expandedLogs, setExpandedLogs] = useState<Set<number>>(new Set());
  const [selectedModel, setSelectedModel] = useState<ModelOption>(defaultModel);
  const [showCredentials, setShowCredentials] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const executionLogRef = useRef<ExecutionLogEntry[]>([]);

  // Keep ref in sync with state for use in async handlers
  useEffect(() => {
    executionLogRef.current = executionLog;
  }, [executionLog]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  // Format timestamp for execution log display
  const formatTime = (timestamp: number): string => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  // Get icon for execution log entry type
  const getLogIcon = (type: StatusUpdate['type']): string => {
    switch (type) {
      case 'busy': return '⏳';
      case 'tool': return '🔧';
      case 'tool-completed': return '✓';
      case 'tool-error': return '✗';
      case 'reasoning': return '💭';
      case 'generating': return '✍️';
      case 'retry': return '🔄';
      default: return '•';
    }
  };

  // Format duration for display
  const formatDuration = (ms: number): string => {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  // Toggle expansion state for a message's execution log
  const toggleLogExpanded = (messageId: number) => {
    setExpandedLogs((prev) => {
      const next = new Set(prev);
      if (next.has(messageId)) {
        next.delete(messageId);
      } else {
        next.add(messageId);
      }
      return next;
    });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Subscribe to status updates from the Tauri backend
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;

    const setupListener = async () => {
      unlisten = await listen<StatusUpdate>('chat:statusUpdate', (event) => {
        const status = event.payload;
        if (status.type === 'idle') {
          setIsLoading(false);
          setStatusMessage('');
        } else {
          setIsLoading(true);
          setStatusMessage(status.message || 'Working...');

          // Add entry to execution log (only for non-idle statuses)
          if (status.message && status.details?.timestamp) {
            const newEntry: ExecutionLogEntry = {
              id: nextLogEntryId++,
              type: status.type,
              // Use fullMessage for the log if available, otherwise fall back to message
              message: status.details.fullMessage || status.message,
              timestamp: status.details.timestamp,
              toolName: status.details.toolName,
              duration: status.details.duration,
              output: status.details.output,
              error: status.details.error,
            };
            setExecutionLog((prev) => [...prev, newEntry]);
          }
        }
      });
    };

    setupListener();

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, []);

  const handleModelChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value;
    const [providerID, modelID] = value.split(':');
    const model = availableModels.find(m => m.providerID === providerID && m.modelID === modelID);
    if (model) {
      setSelectedModel(model);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputValue.trim() || isLoading) return;

    const userMessage: Message = {
      id: Date.now(),
      text: inputValue,
      sender: 'user',
    };

    setMessages((prev) => [...prev, userMessage]);
    setInputValue('');
    setIsLoading(true);
    setStatusMessage('Thinking...');
    setExecutionLog([]); // Clear execution log for new request

    // Send message to Tauri backend via invoke and get response
    try {
      const response = await invoke<string>('send_message', {
        message: inputValue,
        providerId: selectedModel.providerID,
        modelId: selectedModel.modelID,
      });
      const botMessageId = Date.now() + 1;
      const botMessage: Message = {
        id: botMessageId,
        text: response,
        sender: 'bot',
        executionLog: executionLogRef.current.length > 0 ? [...executionLogRef.current] : undefined,
      };
      setMessages((prev) => [...prev, botMessage]);
      // Transfer expanded state from loading (-1) to the new message
      setExpandedLogs((prev) => {
        const next = new Set(prev);
        if (next.has(-1)) {
          next.delete(-1);
          next.add(botMessageId);
        }
        return next;
      });
    } catch (error) {
      const errorMessageId = Date.now() + 1;
      const errorMessage: Message = {
        id: errorMessageId,
        text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        sender: 'bot',
        executionLog: executionLogRef.current.length > 0 ? [...executionLogRef.current] : undefined,
      };
      setMessages((prev) => [...prev, errorMessage]);
      // Transfer expanded state from loading (-1) to the new message
      setExpandedLogs((prev) => {
        const next = new Set(prev);
        if (next.has(-1)) {
          next.delete(-1);
          next.add(errorMessageId);
        }
        return next;
      });
    } finally {
      setIsLoading(false);
      setStatusMessage('');
    }
  };

  // Render execution log component
  const renderExecutionLog = (log: ExecutionLogEntry[], messageId: number, isCurrentLoading: boolean) => {
    if (log.length === 0) return null;

    const isExpanded = isCurrentLoading ? expandedLogs.has(-1) : expandedLogs.has(messageId);
    const toggleId = isCurrentLoading ? -1 : messageId;

    return (
      <ExecutionLog
        log={log}
        isExpanded={isExpanded}
        onToggle={() => toggleLogExpanded(toggleId)}
        formatTime={formatTime}
        formatDuration={formatDuration}
        getLogIcon={getLogIcon}
      />
    );
  };

  return (
    <div className="chat-container">
      <div className="chat-header">
        <h1>Chat</h1>
        <div className="header-actions">
          <select
            className="model-selector"
            value={`${selectedModel.providerID}:${selectedModel.modelID}`}
            onChange={handleModelChange}
            disabled={isLoading}
          >
            {availableModels.map((model) => (
              <option
                key={`${model.providerID}:${model.modelID}`}
                value={`${model.providerID}:${model.modelID}`}
              >
                {model.displayName}
              </option>
            ))}
          </select>
          <button
            className="settings-button"
            onClick={() => setShowCredentials(true)}
            title="API Keys"
            type="button"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>
      </div>
      {showCredentials && (
        <CredentialsPanel onClose={() => setShowCredentials(false)} />
      )}
      <div className="messages-container">
        {messages.length === 0 && !isLoading && (
          <div className="empty-state">
            Start a conversation by typing a message below.
          </div>
        )}
        {messages.map((message) => (
          <React.Fragment key={message.id}>
            <div
              className={`message ${message.sender === 'user' ? 'user-message' : 'bot-message'}`}
            >
              {message.sender === 'bot' ? (
                <Markdown>{message.text}</Markdown>
              ) : (
                message.text
              )}
            </div>
            {message.sender === 'bot' && message.executionLog && (
              renderExecutionLog(message.executionLog, message.id, false)
            )}
          </React.Fragment>
        ))}
        {isLoading && (
          <>
            <div className="loading-indicator">
              <div className="loading-spinner" />
              <span className="loading-text">{statusMessage}</span>
            </div>
            {renderExecutionLog(executionLog, -1, true)}
          </>
        )}
        <div ref={messagesEndRef} />
      </div>
      <form className="input-container" onSubmit={handleSubmit}>
        <input
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          placeholder="Type a message..."
          className="message-input"
        />
        <button type="submit" className="send-button" disabled={isLoading}>
          Send
        </button>
      </form>
    </div>
  );
}

export default App;
