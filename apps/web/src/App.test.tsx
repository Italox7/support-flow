import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('App', () => {
  it('mostra a API no ar quando o health check responde 200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    render(<App />);
    expect(await screen.findByText('API e banco de dados no ar')).toBeInTheDocument();
  });

  it('mostra a API indisponível quando o health check falha', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 503 })));
    render(<App />);
    expect(await screen.findByText('API indisponível')).toBeInTheDocument();
  });
});
