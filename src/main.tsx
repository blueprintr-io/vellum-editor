import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/globals.css';

// Test helpers are imported through the application graph and omitted from production.
if (import.meta.env.DEV && import.meta.env.MODE === 'e2e') {
  await import('./testing/e2e');
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
