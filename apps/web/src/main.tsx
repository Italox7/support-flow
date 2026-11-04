import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App';
import './index.css';
import { connectSession } from './lib/connectSession';
import { session } from './lib/session';

// `retry: false`: quem repete é o cliente da API, e só nos casos em que repetir é seguro.
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});

connectSession(session, queryClient);

// Fora do React: o StrictMode monta duas vezes, e um refresh a mais seria desperdício.
void session.bootstrap();

const root = document.getElementById('root');
if (!root) throw new Error('Elemento #root não encontrado');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
