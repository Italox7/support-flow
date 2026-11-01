# Decisões técnicas

Registro curto das decisões que não são óbvias pelo código. A mais recente fica no topo.

## 2026-10-29 — Autenticação (Fase 2)

- **Negado por padrão**: `JwtAuthGuard` e `RolesGuard` são globais; rota aberta precisa de
  `@Public()`. Esquecer o decorator gera 401, não um endpoint exposto.
- **Papel no access token**: rebaixar alguém só vale no próximo refresh (até 15 min). Aceito
  para não consultar o banco a cada requisição.
- **Reuso de refresh token revoga a família**, inclusive quando duas abas fazem refresh ao mesmo
  tempo com o mesmo cookie. O front (Fase 6) precisa serializar o refresh numa única requisição.
- **Expiração deslizante**: cada rotação dá mais 7 dias; sessão ativa não expira. Tokens
  expirados e revogados ficam no banco até um job de limpeza (Fase 7).
- **Cookie sempre `Secure`**, inclusive em dev (navegadores aceitam em `http://localhost`).
- **Cadastro revela se o e-mail existe** (409): troca consciente por uma mensagem útil num help
  desk. O login não revela (mesma resposta e mesmo custo de argon2 para e-mail inexistente).
- **argon2id com 19 MiB / t=2** (mínimo OWASP): o padrão da lib (64 MiB) pesa no Render gratuito.
- **Rate limit em memória** (5/min em login e cadastro, 30/min no resto de `/auth`), por IP. Atrás
  de Vercel + Render, `TRUST_PROXY` precisa do número certo de proxies (Fase 7); com 0, todos os
  usuários compartilham o IP do proxy e o limite.
- **Seed do admin não promove conta existente**: se o e-mail já pertence a um não-admin, o seed
  falha em vez de dar o papel a quem escolheu aquela senha.
- **E2E só rodam com `TEST_DATABASE_URL`**: eles apagam as tabelas, então nunca usam a
  `DATABASE_URL` do `.env` (Supabase). Se ela apontar para um host não local, a suíte falha
  antes de conectar.

## 2026-10-23 — RLS ligado em todas as tabelas (deny-all)

O Supabase expõe o schema `public` pela Data API (PostgREST) com a anon key, que é pública. Toda
tabela é criada com `ENABLE ROW LEVEL SECURITY` e sem policies, na própria migration. A API não é
afetada porque conecta como dona das tabelas. **Toda migration que cria tabela repete isso**: o
Prisma não modela RLS, então o diff do CI não pega a falta.

## 2026-10-23 — multer 2.4.0 (GHSA-q7qp-rjg7-q26m) aceito temporariamente

> **Resolvido em 2026-10-29:** NestJS 12.3.2 passou a depender de multer 2.5.0; atualizado sem
> `overrides`. `npm audit` limpo.

`@nestjs/platform-express` 12.2.0 fixa multer 2.4.0, vulnerável a DoS. A correção (2.5.0) saiu em
2026-10-22. Não há upload no MVP (nenhum `FileInterceptor`), então o caminho não é alcançável. Não
fizemos `overrides` para uma versão de um dia (risco de supply chain). **Reavaliar em 2026-10-30**
ou quando o Nest publicar patch. Se anexos entrarem no escopo, isso vira bloqueio.

## 2026-10-23 — Versões e ferramentas

- **ESM em todo o monorepo**: NestJS 12 é ESM-only.
- **Vitest em vez de Jest**: Jest com ESM ainda depende de flags experimentais; SWC (via
  `unplugin-swc`) emite os metadados de decorators que a DI do Nest exige.
- **TypeScript 6.0**: typescript-eslint, ts-jest e o Nest CLI ainda não suportam o TypeScript 7.
- **Prisma 7.10.1**: a tag `latest` do npm aponta para uma RC da 8.0.

## 2026-10-23 — Um projeto Supabase, dois schemas

`dev` para desenvolvimento local e `public` para a demo. Testes rodam num Postgres próprio do CI.
Risco aceito: uma `DATABASE_URL` errada com `migrate reset` apagaria a demo. A URL de `public` só
existe nas variáveis do Render, nunca no `.env` local.
