import type { SlaClock, SlaState } from '@support-flow/shared';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueueSlaBadge } from './SlaBadge';

const clock = (state: SlaState, remainingSeconds: number): SlaClock => ({
  state,
  remainingSeconds,
  dueAt: '2026-11-11T12:00:00.000Z',
});

/** Um segundo por vez: cada tique re-renderiza e agenda o próximo timer. */
function advanceSeconds(seconds: number) {
  for (let i = 0; i < seconds; i++) act(() => vi.advanceTimersByTime(1_000));
}

describe('QueueSlaBadge', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('o relógio escondido que estoura antes do refetch vira Violado na hora', () => {
    // Em risco ganha de No prazo, então a 1ª resposta aparece; a resolução vence antes.
    render(
      <QueueSlaBadge
        sla={{ firstResponse: clock('AT_RISK', 600), resolution: clock('OK', 30) }}
        receivedAt={Date.now()}
      />,
    );
    expect(screen.getByText('Em risco')).toBeInTheDocument();

    advanceSeconds(30);
    expect(screen.getByText('Em risco')).toBeInTheDocument();

    advanceSeconds(1);
    expect(screen.getByText('Violado')).toBeInTheDocument();
    expect(screen.queryByText('Em risco')).not.toBeInTheDocument();
  });

  it('a contagem do relógio à vista segue enquanto o outro ainda corre', () => {
    render(
      <QueueSlaBadge
        sla={{ firstResponse: clock('AT_RISK', 90), resolution: clock('OK', 600) }}
        receivedAt={Date.now()}
      />,
    );
    expect(screen.getByText('· 1 min')).toBeInTheDocument();

    advanceSeconds(35);
    expect(screen.getByText('· 55 s')).toBeInTheDocument();
  });

  it('o texto do leitor de tela diz Violado junto com o badge', () => {
    const { container } = render(
      <QueueSlaBadge
        sla={{ firstResponse: clock('AT_RISK', 600), resolution: clock('OK', 30) }}
        receivedAt={Date.now()}
      />,
    );
    const srText = () => container.querySelector('.sr-only')?.textContent;
    expect(srText()).toBe(
      'Primeira resposta: Em risco, vence em 10 min. Resolução: No prazo, vence em 30 s.',
    );

    advanceSeconds(31);
    expect(srText()).toBe('Primeira resposta: Em risco, vence em 10 min. Resolução: Violado.');
  });
});
