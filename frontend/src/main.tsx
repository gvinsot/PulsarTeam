import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { WebSocketProvider } from './contexts/WebSocketContext';
import { ThemeProvider } from './contexts/ThemeContext';
import { LanguageProvider } from './contexts/LanguageContext';
import './index.css';

// index.html always ships <div id="root">, so this is never null in practice.
// Throwing keeps the observable behaviour of the previous unguarded call —
// createRoot itself throws "Target container is not a DOM element" on null — so
// a missing mount point still fails loudly at boot instead of rendering nothing.
const rootContainer = document.getElementById('root');
if (!rootContainer) throw new Error('Root container #root not found');

ReactDOM.createRoot(rootContainer).render(
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
