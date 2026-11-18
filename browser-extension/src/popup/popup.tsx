import { createRoot } from 'react-dom/client';
import { PopupApp } from './PopupApp.tsx';

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(<PopupApp />);
}
