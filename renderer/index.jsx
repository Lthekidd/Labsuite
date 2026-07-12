import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import ErrorBoundary from './ErrorBoundary';

window.addEventListener('error', (event) => {
  console.error('REACT CRASH:', event.message, event.error);
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('REACT PROMISE CRASH:', event.reason);
});

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
