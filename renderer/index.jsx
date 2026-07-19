import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import StandaloneApp from './StandaloneApp';
import ErrorBoundary from './ErrorBoundary';

window.addEventListener('error', (event) => {
  console.error('REACT CRASH:', event.message, event.error);
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('REACT PROMISE CRASH:', event.reason);
});

// Detect standalone app mode via URL query parameters
// e.g. ?app=sheets or ?app=notebook&file=C:\path\to\file.txt
const urlParams = new URLSearchParams(window.location.search);
const standaloneAppId = urlParams.get('app');
const standaloneFilePath = urlParams.get('file');

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      {standaloneAppId ? (
        <StandaloneApp appId={standaloneAppId} filePath={standaloneFilePath} />
      ) : (
        <App />
      )}
    </ErrorBoundary>
  </React.StrictMode>
);
