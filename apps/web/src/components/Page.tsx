import { useEffect, useRef, type ReactNode } from 'react';
import { useLocation } from 'react-router';

interface PageProps {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}

/** Numa SPA o navegador não troca título nem foco: cada rota nova leva o foco ao <h1>. */
export function Page({ title, actions, children }: PageProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  const { pathname } = useLocation();

  useEffect(() => {
    heading.current?.focus();
  }, [pathname]);

  useEffect(() => {
    document.title = `${title} | Support Flow`;
    // Ao sair da tela, o título de um ticket não fica na aba durante a troca de sessão.
    return () => {
      document.title = 'Support Flow';
    };
  }, [title]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 ref={heading} tabIndex={-1} className="text-2xl font-bold outline-none">
          {title}
        </h1>
        {actions}
      </div>
      {children}
    </div>
  );
}
