# Decisões técnicas

Registro curto das decisões que não são óbvias pelo código. A mais recente fica no topo.

## 2026-10-23 — RLS ligado em todas as tabelas (deny-all)

O Supabase expõe o schema `public` pela Data API (PostgREST) com a anon key, que é pública. Toda
tabela é criada com `ENABLE ROW LEVEL SECURITY` e sem policies, na própria migration. A API não é
afetada porque conecta como dona das tabelas. **Toda migration que cria tabela repete isso**: o
Prisma não modela RLS, então o diff do CI não pega a falta.

## 2026-10-23 — multer 2.4.0 (GHSA-q7qp-rjg7-q26m) aceito temporariamente

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
