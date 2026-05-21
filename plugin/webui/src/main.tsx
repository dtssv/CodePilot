import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { initLocaleFromStorage } from './i18n';
import './styles/global.css';

initLocaleFromStorage();

ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <App />
    </React.StrictMode>,
);