const FALLBACK = '/';
const BASE = 'http://interno.invalid';

/** Destino pós-login: só caminho interno, para a URL nunca levar a outro site. */
export function safeRedirect(target: unknown): string {
  if (typeof target !== 'string' || !target.startsWith('/') || target.startsWith('//')) {
    return FALLBACK;
  }
  // eslint-disable-next-line no-control-regex -- navegadores removem esses caracteres da URL
  if (/[\\\u0000-\u001f]/.test(target)) return FALLBACK;
  const url = new URL(target, BASE);
  // `/.//x` normaliza para `//x`, que o router leria como outro site.
  if (url.origin !== BASE || url.pathname.startsWith('//')) return FALLBACK;
  if (url.pathname === '/entrar' || url.pathname === '/cadastro') return FALLBACK;
  return `${url.pathname}${url.search}`;
}
