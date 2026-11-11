import type { SlaClock, SlaState, TicketSla } from '@support-flow/shared';
import { useEffect, useState } from 'react';
import { SLA_LABELS } from '../lib/labels';
import {
  describeClock,
  describeSla,
  formatDuration,
  isCounting,
  liveSla,
  liveState,
  mostUrgent,
  secondsLeft,
} from '../lib/sla';

/** Forma e rótulo dizem o estado; a cor só reforça. */
const STYLES: Record<SlaState, { icon: string; className: string }> = {
  OK: { icon: '●', className: 'border-green-800 bg-green-100 text-green-950' },
  AT_RISK: { icon: '▲', className: 'border-amber-800 bg-amber-100 text-amber-950' },
  BREACHED: { icon: '✕', className: 'border-red-800 bg-red-100 text-red-950' },
  MET: { icon: '✓', className: 'border-teal-800 bg-teal-50 text-teal-950' },
  PAUSED: { icon: '❚❚', className: 'border-slate-700 bg-slate-100 text-slate-900' },
  NOT_APPLICABLE: {
    icon: '–',
    className: 'border-dashed border-slate-700 bg-white text-slate-900',
  },
};

/**
 * Um timer só, guiado pelo relógio que vence primeiro entre os que contam. Segundos só
 * no último minuto: antes disso, um timer a cada 30 s basta.
 */
function useNow(clocks: SlaClock[], receivedAt: number) {
  const [now, setNow] = useState(() => Date.now());
  const pending = clocks
    .filter((clock) => isCounting(clock.state))
    .map((clock) => secondsLeft(clock, receivedAt, now))
    .filter((left) => left >= 0);
  const left = pending.length > 0 ? Math.min(...pending) : -1;

  useEffect(() => {
    if (left < 0) return;
    const delay = left <= 60 ? 1_000 : Math.min(30_000, (left - 60) * 1_000);
    const timer = setTimeout(() => setNow(Date.now()), delay);
    return () => clearTimeout(timer);
  }, [left, now]);

  return now;
}

function useLiveClock(clock: SlaClock, receivedAt: number) {
  const now = useNow([clock], receivedAt);
  return { state: liveState(clock, receivedAt, now), left: secondsLeft(clock, receivedAt, now) };
}

function BadgeVisual({ state, left }: { state: SlaState; left: number }) {
  const { icon, className } = STYLES[state];
  return (
    <span
      aria-hidden="true"
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-sm font-medium whitespace-nowrap ${className}`}
    >
      <span>{icon}</span>
      <span>{SLA_LABELS[state]}</span>
      {isCounting(state) && <span className="tabular-nums">· {formatDuration(left)}</span>}
    </span>
  );
}

/** Na fila: o relógio mais urgente à vista, os dois no texto acessível, sem região viva. */
export function QueueSlaBadge({ sla, receivedAt }: { sla: TicketSla; receivedAt: number }) {
  // Os dois relógios contam: o escondido pode estourar antes do que está à vista.
  const now = useNow([sla.firstResponse, sla.resolution], receivedAt);
  const clock = mostUrgent(liveSla(sla, receivedAt, now));
  return (
    <>
      <BadgeVisual state={clock.state} left={secondsLeft(clock, receivedAt, now)} />
      <span className="sr-only">{describeSla(liveSla(sla, receivedAt, now))}</span>
    </>
  );
}

const HINTS: Partial<Record<SlaState, string>> = {
  PAUSED: 'Aguardando cliente',
  NOT_APPLICABLE: 'Resolvido antes do prazo de 1ª resposta',
};

function SlaRow({
  name,
  clock,
  receivedAt,
}: {
  name: string;
  clock: SlaClock;
  receivedAt: number;
}) {
  const { state, left } = useLiveClock(clock, receivedAt);
  const crossedZero = state === 'BREACHED' && clock.state !== 'BREACHED';
  const hint = HINTS[state];
  return (
    <div>
      <dt className="text-sm text-muted">{name}</dt>
      <dd className="flex flex-wrap items-center gap-2">
        <BadgeVisual state={state} left={left} />
        {hint && (
          <span aria-hidden="true" className="text-sm text-muted">
            {hint}
          </span>
        )}
        <span className="sr-only">
          {crossedZero ? `${name}: ${SLA_LABELS.BREACHED}.` : describeClock(name, clock)}
        </span>
        {/* Anuncia só a passagem para Violado, uma vez, e só aqui: nunca por linha da fila. */}
        <span role="status" className="sr-only">
          {crossedZero ? `${name}: o prazo foi violado.` : ''}
        </span>
      </dd>
    </div>
  );
}

export function SlaPanel({ sla, receivedAt }: { sla: TicketSla; receivedAt: number }) {
  return (
    <dl className="grid gap-3 sm:grid-cols-2">
      <SlaRow name="Primeira resposta" clock={sla.firstResponse} receivedAt={receivedAt} />
      <SlaRow name="Resolução" clock={sla.resolution} receivedAt={receivedAt} />
    </dl>
  );
}
