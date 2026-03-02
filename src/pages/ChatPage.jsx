import React from 'react';
import ChatInput from '../components/ChatInput';
import MessageList from '../components/MessageList';
import VoiceConnectionIndicator from '../components/VoiceConnectionIndicator';
import styles from './ChatPage.module.css';

const ChatPage = () => {
  return (
    <div className={styles.container}>
      <VoiceConnectionIndicator />
      <div className={styles.chatArea}>
        <MessageList />
        <ChatInput />
      </div>
    </div>
  );
};

export default ChatPage;