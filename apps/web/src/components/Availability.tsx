import type { Availability } from '@support-flow/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import { describeError } from '../lib/errors';
import { keys } from '../lib/queries';
import { session } from '../lib/session';
import { useUser } from '../lib/useSession';

function useAvailability() {
  const user = useUser();
  return useQuery({
    queryKey: keys.availability(user),
    queryFn: () => api<Availability>('/users/me/availability'),
  });
}

/** A chave do agente: o estado só muda depois que a API confirma, e o erro não finge sucesso. */
export function AvailabilitySwitch() {
  const user = useUser();
  const client = useQueryClient();
  const query = useAvailability();
  const [notice, setNotice] = useState('');
  const mutation = useMutation({
    mutationFn: (isAvailable: boolean) =>
      api<Availability>('/users/me/availability', { method: 'PATCH', body: { isAvailable } }),
    onSuccess: (data) => {
      if (session.getUserId() !== user.id) return;
      client.setQueryData(keys.availability(user), data);
      setNotice(
        data.isAvailable
          ? 'Você está disponível. Tickets sem responsável podem ser atribuídos a você agora.'
          : 'Você está indisponível. Seus tickets atuais continuam com você.',
      );
    },
    onError: () => setNotice(''),
  });

  // Sem a resposta, não dá para afirmar um estado: clicar enviaria o inverso de um chute.
  if (query.isError && !query.data) {
    return (
      <div role="alert" className="flex items-center gap-2 text-sm text-danger">
        Não foi possível ver sua disponibilidade.
        <button type="button" className="btn" onClick={() => void query.refetch()}>
          Tentar de novo
        </button>
      </div>
    );
  }

  const isAvailable = query.data?.isAvailable ?? false;
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        role="switch"
        aria-checked={isAvailable}
        aria-label="Disponível para receber tickets"
        aria-busy={mutation.isPending}
        disabled={mutation.isPending || query.isPending}
        className={`btn ${isAvailable ? 'border-green-800 bg-green-100 text-green-950 hover:bg-green-200' : ''}`}
        onClick={() => mutation.mutate(!isAvailable)}
      >
        {/* Texto fixo: o nome falado contém o visível (WCAG 2.5.3); o estado está no ícone, na cor,
            no aria-checked e, desligada, na faixa "Você está indisponível". */}
        <span aria-hidden="true">{isAvailable ? '●' : '○'}</span>
        Disponível
      </button>
      <span className="sr-only" role="status">
        {notice}
      </span>
      {mutation.isError && (
        <span role="alert" className="text-sm text-danger">
          {describeError(mutation.error)}
        </span>
      )}
    </div>
  );
}

/** Agente recém-criado nasce indisponível: sem este aviso, a fila vazia pareceria normal. */
export function AvailabilityBanner() {
  const query = useAvailability();
  if (query.data?.isAvailable !== false) return null;
  return (
    <p className="rounded-md border border-amber-800 bg-amber-100 p-2 text-amber-950">
      Você está indisponível: mantém seus tickets atuais, mas não recebe novos. Use a chave no
      cabeçalho quando quiser receber tickets.
    </p>
  );
}
