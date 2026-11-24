import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import './index.css';

declare global {
  interface Window {
    __CLIPGENIUS_MOUNTED__?: boolean;
  }
}

window.__CLIPGENIUS_MOUNTED__ = true;
try {
  window.sessionStorage.removeItem('clipgenius_boot_retry');
} catch {
  // ignore sessionStorage errors
}

// Auto-recover if Vite encounters a stale dynamic import / preload error after a server restart
window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault();
  try {
    const key = 'clipgenius_preload_reload';
    const last = Number(window.sessionStorage.getItem(key) || '0');
    if (Date.now() - last > 8000) {
      window.sessionStorage.setItem(key, String(Date.now()));
      window.location.reload();
    }
  } catch {
    window.location.reload();
  }
});

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
