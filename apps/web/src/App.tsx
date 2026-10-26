import { useEffect, useState } from 'react';

type ApiStatus = 'checking' | 'up' | 'down';

const statusLabel: Record<ApiStatus, string> = {
  checking: 'Verificando a API…',
  up: 'API e banco de dados no ar',
  down: 'API indisponível',
};

// Tela provisória da Fase 1: confirma que front → proxy /api → API → banco funciona.
export function App() {
  const [status, setStatus] = useState<ApiStatus>('checking');

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/health', { signal: controller.signal })
      .then((res) => setStatus(res.ok ? 'up' : 'down'))
      .catch(() => {
        if (!controller.signal.aborted) setStatus('down');
      });
    return () => controller.abort();
  }, []);

  return (
    <main>
      <h1>Support Flow</h1>
      <p role="status">{statusLabel[status]}</p>
    </main>
  );
}
