import React, { useState, useRef, useEffect } from 'react';
import Markdown from 'react-markdown';

interface Message {
  id: number;
  text: string;
  sender: 'user' | 'bot';
}

type StatusUpdate = {
  type: 'idle' | 'busy' | 'tool' | 'reasoning' | 'generating' | 'retry';
  message?: string;
};

type ModelOption = {
  providerID: string;
  modelID: string;
  displayName: string;
};

// Available models configuration
const availableModels: ModelOption[] = [
  // Anthropic models
  { providerID: 'anthropic', modelID: 'claude-sonnet-4-5-20250929', displayName: 'Claude Sonnet 4.5' },
  { providerID: 'anthropic', modelID: 'claude-opus-4-20250514', displayName: 'Claude Opus 4' },
  { providerID: 'anthropic', modelID: 'claude-3-5-haiku-20241022', displayName: 'Claude 3.5 Haiku' },
  // OpenAI models
  { providerID: 'openai', modelID: 'gpt-4o', displayName: 'GPT-4o' },
  { providerID: 'openai', modelID: 'gpt-4o-mini', displayName: 'GPT-4o Mini' },
  { providerID: 'openai', modelID: 'o1', displayName: 'OpenAI o1' },
  { providerID: 'openai', modelID: 'o3-mini', displayName: 'OpenAI o3-mini' },
  // Google models
  { providerID: 'google', modelID: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' },
  { providerID: 'google', modelID: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash' },
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

function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [selectedModel, setSelectedModel] = useState<ModelOption>(defaultModel);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
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

    // Send message to main process via IPC and get response
    try {
      const response = await window.electronAPI.sendMessage(inputValue, selectedModel.providerID, selectedModel.modelID);
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
          <div className="loading-indicator">
            <div className="loading-spinner" />
            <span className="loading-text">{statusMessage}</span>
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
