import { useEffect, useState } from 'react';

const SLOW_MS = 3_000;

/** Fica verdadeiro depois de ~3 s de espera: a API hiberna e pode levar até um minuto. */
export function useSlow(waiting: boolean): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => setSlow(true), SLOW_MS);
    return () => {
      clearTimeout(timer);
      setSlow(false);
    };
  }, [waiting]);
  return slow;
}

export const WAKING_MESSAGE = 'Acordando o servidor… Isso pode levar até um minuto.';
