import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '@dolphin-terminal/react/theme.css';
import '@dolphin-terminal/react/styles.css';
import './standalone.css';

import App from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
