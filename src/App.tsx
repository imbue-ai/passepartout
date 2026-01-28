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

type ModelConfig = {
  providerID: string;
  modelID: string;
};

type ModelOption = {
  providerID: string;
  modelID: string;
  displayName: string;
};

// Declare the electronAPI exposed by the preload script
declare global {
  interface Window {
    electronAPI: {
      sendMessage: (message: string) => Promise<string>;
      onStatusUpdate: (callback: (status: StatusUpdate) => void) => () => void;
      getAvailableModels: () => Promise<ModelOption[]>;
      setModel: (model: ModelConfig) => Promise<void>;
      getCurrentModel: () => Promise<ModelConfig>;
    };
  }
}

function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Load available models and current model on mount
  useEffect(() => {
    const loadModels = async () => {
      const models = await window.electronAPI.getAvailableModels();
      setAvailableModels(models);

      const currentModel = await window.electronAPI.getCurrentModel();
      // Create a unique key for the current model
      setSelectedModel(`${currentModel.providerID}:${currentModel.modelID}`);
    };
    loadModels();
  }, []);

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

  const handleModelChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value;
    setSelectedModel(value);

    const [providerID, modelID] = value.split(':');
    await window.electronAPI.setModel({ providerID, modelID });
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
        <select
          className="model-selector"
          value={selectedModel}
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
