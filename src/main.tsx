import React from 'react';
import ReactDOM from 'react-dom/client';
import 'leaflet/dist/leaflet.css';
import './styles.css';
import App from './App';
import StaticAccessGate from './StaticAccessGate';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <StaticAccessGate>
      <App />
    </StaticAccessGate>
  </React.StrictMode>,
);
