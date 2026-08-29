import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { WebSocketProvider } from './contexts/WebSocketContext';
import { ThemeProvider } from './contexts/ThemeContext';
import { LanguageProvider } from './contexts/LanguageContext';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <LanguageProvider>
      <ThemeProvider>
        <WebSocketProvider>
          <App />
        </WebSocketProvider>
      </ThemeProvider>
    </LanguageProvider>
  </React.StrictMode>
);
