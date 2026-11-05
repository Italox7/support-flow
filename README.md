# Support Flow

Help desk com papéis (cliente, agente e admin), ciclo de vida de tickets, SLA com pausa e atribuição
automática por menor carga.

**Stack:** React + TypeScript (Vite) · NestJS · Prisma · PostgreSQL (Supabase)

> Os links da demo pública entram aqui depois do deploy. Contas de demonstração:
> `admin@demo.example.com`, `agente@demo.example.com` e `cliente@demo.example.com`. A senha, pública,
> também entra aqui nesse momento.

**A demo é pública.** Não use dados nem senhas reais: o e-mail não é confirmado, então invente um.
Tudo é apagado e recriado uma vez por dia, e a numeração dos tickets não recomeça. Fora de uso, a demo pode ficar pausada: a API gratuita pode levar mais de
um minuto para acordar, e agendamentos parados precisam ser reativados
([runbook](docs/runbook-deploy.md)).

## Estrutura

```
apps/api         API NestJS + Prisma
apps/web         Front React + Vite
packages/shared  Enums e tipos compartilhados entre API e front
```

## Rodando localmente

Requisitos: Node 22.12+ (o projeto usa 24, veja `.nvmrc`) e um banco Postgres. O desenvolvimento usa o
schema `dev` do projeto Supabase; a demo pública usa o schema `public`.

```bash
npm install
cp apps/api/.env.example apps/api/.env   # preencha DATABASE_URL e DIRECT_URL
npm run db:deploy -w @support-flow/api   # aplica as migrations no schema dev

npm run dev:api   # http://localhost:3000/api/health
npm run dev:web   # http://localhost:5173
```

## Scripts

| Comando                                   | O que faz                                           |
| ----------------------------------------- | --------------------------------------------------- |
| `npm run lint`                            | ESLint em todo o monorepo                           |
| `npm run typecheck`                       | TypeScript em todos os workspaces                   |
| `npm test`                                | Vitest (API e front)                                |
| `npm run build`                           | Build de shared, API e front                        |
| `npm run db:migrate -w @support-flow/api` | Cria uma nova migration a partir do `schema.prisma` |
