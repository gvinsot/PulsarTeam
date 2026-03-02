import React from 'react';
import { useVoiceConnection } from '../contexts/VoiceConnectionContext';
import styles from './VoiceConnectionIndicator.module.css';

const VoiceConnectionIndicator = () => {
  const { isConnected, isMuted } = useVoiceConnection();

  if (!isConnected) return null;

  return (
    <div className={styles.container}>
      <div className={styles.indicator}>
        <span className={styles.status}>
          {isMuted ? 'Microphone Muted' : 'Connected'}
        </span>
        <div className={styles.dot} />
      </div>
    </div>
  );
};

export default VoiceConnectionIndicator;