import React, { useState, useRef, useEffect } from 'react';
import Markdown from 'react-markdown';

interface Message {
  id: number;
  text: string;
  sender: 'user' | 'bot';
}

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

// Declare the electronAPI exposed by the preload script
declare global {
  interface Window {
    electronAPI: {
      sendMessage: (message: string) => Promise<string>;
      onStatusUpdate: (callback: (status: StatusUpdate) => void) => () => void;
    };
  }
}

function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [executionLog, setExecutionLog] = useState<ExecutionLogEntry[]>([]);
  const [isLogExpanded, setIsLogExpanded] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

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
            id: status.details.timestamp + Math.random(), // Ensure unique IDs
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
    setIsLogExpanded(false); // Collapse log by default

    // Send message to main process via IPC and get response
    try {
      const response = await window.electronAPI.sendMessage(inputValue);
      const botMessage: Message = {
        id: Date.now() + 1,
        text: response,
        sender: 'bot',
      };
      setMessages((prev) => [...prev, botMessage]);
    } catch (error) {
      const errorMessage: Message = {
        id: Date.now() + 1,
        text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        sender: 'bot',
      };
      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
      setStatusMessage('');
    }
  };

  return (
    <div className="chat-container">
      <div className="chat-header">
        <h1>Chat</h1>
      </div>
      <div className="messages-container">
        {messages.length === 0 && (
          <div className="empty-state">
            Start a conversation by typing a message below.
          </div>
        )}
        {messages.map((message) => (
          <div
            key={message.id}
            className={`message ${message.sender === 'user' ? 'user-message' : 'bot-message'}`}
          >
            {message.sender === 'bot' ? (
              <Markdown>{message.text}</Markdown>
            ) : (
              message.text
            )}
          </div>
        ))}
        {isLoading && (
          <div className="loading-container">
            <div className="loading-indicator">
              <div className="loading-spinner" />
              <span className="loading-text">{statusMessage}</span>
            </div>
            {executionLog.length > 0 && (
              <div className="execution-log">
                <button
                  className="execution-log-toggle"
                  onClick={() => setIsLogExpanded(!isLogExpanded)}
                  type="button"
                >
                  <span className="toggle-icon">{isLogExpanded ? '▼' : '▶'}</span>
                  <span className="toggle-text">
                    Execution log ({executionLog.length} {executionLog.length === 1 ? 'step' : 'steps'})
                  </span>
                </button>
                {isLogExpanded && (
                  <div className="execution-log-entries">
                    {executionLog.map((entry) => (
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
            )}
          </div>
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
