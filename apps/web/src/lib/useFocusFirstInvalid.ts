import { useEffect, type RefObject } from 'react';

/** Depois de um envio recusado, o foco vai para o primeiro campo com erro. */
export function useFocusFirstInvalid(
  form: RefObject<HTMLFormElement | null>,
  errors: object,
): void {
  useEffect(() => {
    if (Object.keys(errors).length === 0) return;
    form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [form, errors]);
}
