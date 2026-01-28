import React, { useState, useRef, useEffect, useCallback } from 'react';
import Markdown from 'react-markdown';

type StatusUpdate = {
  type: 'idle' | 'busy' | 'tool' | 'tool-completed' | 'tool-error' | 'reasoning' | 'generating' | 'retry';
  message?: string;
  details?: {
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

// Declare the electronAPI exposed by the preload script
declare global {
  interface Window {
    electronAPI: {
      sendMessage: (message: string, providerID: string, modelID: string) => Promise<string>;
      onStatusUpdate: (callback: (status: StatusUpdate) => void) => () => void;
    };
  }
}

// Monotonically increasing counter for unique IDs
let nextLogEntryId = 0;

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

  // Subscribe to status updates from the main process
  useEffect(() => {
    const cleanup = window.electronAPI.onStatusUpdate((status) => {
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
            message: status.message,
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
    return cleanup;
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

    // Send message to main process via IPC and get response
    try {
      const response = await window.electronAPI.sendMessage(inputValue, selectedModel.providerID, selectedModel.modelID);
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
        text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
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
      </div>
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
