import React from 'react';
import ReactDOM from 'react-dom/client';
import { NativePlayerHud } from './components/player/NativePlayerHud';
import './index.css';

document.documentElement.style.background = 'transparent';
document.body.style.background = 'transparent';
document.documentElement.classList.add('native-player-control');

const root = document.getElementById('root');
if (root) {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <NativePlayerHud />
    </React.StrictMode>,
  );
}
