import React, { useEffect, useRef, useState } from 'react';
import MessageList from './MessageList';
import ChatInput from './ChatInput';
import '../styles/chat.css';

interface Message {
  id: string;
  role: 'user' | 'agent' | 'system';
  content: string;
  timestamp?: string;
}

interface ChatWindowProps {
  messages: Message[];
  onSendMessage: (message: string) => void;
  isLoading?: boolean;
}

const ChatWindow: React.FC<ChatWindowProps> = ({ messages, onSendMessage, isLoading = false }) => {
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const [autoScrollEnabled, setAutoScrollEnabled] = useState(true);

  useEffect(() => {
    if (!autoScrollEnabled) return;
    const container = messagesContainerRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
  }, [messages, autoScrollEnabled]);

  const toggleAutoScroll = () => {
    setAutoScrollEnabled((prev) => {
      const next = !prev;
      if (next && messagesContainerRef.current) {
        messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight;
      }
      return next;
    });
  };

  return (
    <div className="chat-window">
      <div className="chat-messages-container" ref={messagesContainerRef}>
        <MessageList messages={messages} isLoading={isLoading} />
      </div>

      <div className="chat-footer">
        <button
          type="button"
          className={`auto-scroll-toggle ${autoScrollEnabled ? 'on' : 'off'}`}
          onClick={toggleAutoScroll}
          aria-pressed={autoScrollEnabled}
          aria-label={`Auto-scroll is ${autoScrollEnabled ? 'on' : 'off'}. Click to turn ${autoScrollEnabled ? 'off' : 'on'}.`}
        >
          Auto-scroll: {autoScrollEnabled ? 'On' : 'Off'}
        </button>
        <ChatInput onSendMessage={onSendMessage} disabled={isLoading} />
      </div>
    </div>
  );
};

export default ChatWindow;