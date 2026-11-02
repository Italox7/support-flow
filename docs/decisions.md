# Decisões técnicas

Registro curto das decisões que não são óbvias pelo código. A mais recente fica no topo.

## 2026-11-01 — Atribuição (Fase 4)

Desenho revisado pelo Archie antes do código.

- **Um lock global de atribuição** (`pg_advisory_xact_lock`, chave fixa no
  `AssignmentService`). É sempre a primeira instrução da transação, que só o `inLock` abre,
  com `maxWait`/`timeout` explícitos. Os métodos que escolhem agente exigem um `LockedTx`:
  passar uma transação sem o lock não compila. Lock de transação funciona no pooler do
  Supabase em modo transação; um lock de sessão não funcionaria. Lock por linha
  (`FOR UPDATE` nos agentes) arriscaria deadlock sem ganho nesta escala.
- **Pegam o lock**: criação de ticket, mudança de disponibilidade e `PATCH /tickets/:id`.
  Transições não pegam: um ticket resolvido ou reaberto ao mesmo tempo deixa a carga lida
  defasada em 1 (escolha um pouco pior), nunca dois tickets vendo a mesma carga.
- **"Em aberto" tem uma definição só**: `OPEN_STATUSES` em `packages/shared` (OPEN,
  IN_PROGRESS, WAITING_CUSTOMER). WAITING_CUSTOMER conta como carga.
- **Ficar indisponível não redistribui**: o agente mantém os tickets e só sai da fila.
  Ficar disponível distribui os órfãos abertos na mesma transação, os de prazo mais curto
  primeiro, até 100 por vez; o resto espera o job diário (Fase 7). Se só um agente voltar,
  ele recebe o lote inteiro: é o que a regra de menor carga manda.
- **Reatribuir é só do admin**, pelo mesmo `PATCH /tickets/:id` da prioridade. Se o agente
  mandar `assigneeId`, a requisição inteira recebe 403, nada é aplicado em parte. O admin
  pode escolher um agente indisponível. A reatribuição não muda o status nem o
  `lastAssignedAt` (cursor da fila automática). `null` não é aceito: desatribuir criaria um
  órfão que a varredura reatribuiria.
- **Primeiro 422 da API**: `assigneeId` válido no formato, mas que não é de um agente. O
  400 continua sendo do formato (ValidationPipe). Ordem: 400 → 404 → 403 → 409 → 422.
- **Fronteira**: `assignment/` não importa `tickets/` nem `users/` (regra
  `no-restricted-imports` no ESLint).
- **Fora desta fase**: criar agente (`POST /users/agents`, antes da Fase 6, com o Gard) e
  `POST /jobs/run` (Fase 7). Até lá, agentes vêm do seed ou do banco.

## 2026-11-01 — Tickets e comentários (Fase 3)

Contrato e schema revisados pelo Archie antes do código.

- **Ticket de outro cliente é 404, não 403**, em toda rota (inclusive comentários e
  transições). O `number` é sequencial: um 403 confirmaria que o ticket existe. A ordem dos
  erros é 404 (escopo) → 403 (papel) → 409 (estado).
- **Escopo numa função só** (`ticketScope`): toda consulta de ticket passa por ela. Notas
  internas saem na consulta (`isInternal: false` para o cliente), não no front.
- **Paginação por offset** (`page`, `pageSize` até 100, envelope `{items, page, pageSize,
total}`). Cursor não compensa nesta escala e complica a numeração de páginas na tela.
- **Transições por update condicional** (`where: {id, status: <lido>}`), sem lock: de duas
  mudanças simultâneas, uma passa e a outra recebe 409. Todo status muda por
  `TicketsService.applyTransition`, onde a Fase 5 encaixa a pausa do SLA.
- **Efeitos de comentário na mesma transação** e também condicionais: a 1ª resposta pública
  de qualquer agente/admin grava `firstResponseAt`; a do responsável tira o ticket de OPEN; a
  do cliente devolve WAITING_CUSTOMER para IN_PROGRESS. Se outra requisição já mudou o ticket,
  o efeito é descartado e o comentário fica. Comentar em RESOLVED não reabre.
- **O cliente pode marcar o próprio ticket como resolvido** (de IN_PROGRESS ou
  WAITING_CUSTOMER), além de reabrir em até 7 dias. Fechar é só do job.
- **Políticas de SLA padrão vêm de uma migration de dados**, não do seed: os prazos são
  calculados na criação e toda prioridade precisa de política em qualquer ambiente. Os E2E
  não apagam `sla_policies`.
- **Sem auto-atribuição nesta fase**: sem responsável, só o admin tira um ticket de OPEN. A
  atribuição veio na Fase 4.
- **Rate limit global** (120/min por rota e por IP), antes da autenticação; `/auth` mantém
  30/min e 5/min nas rotas que verificam senha. Vale também para `/api/health`: com
  `TRUST_PROXY` errado, todos dividem o IP do proxy e o health check do Render pode levar 429.
  Revisar com o Pipe na Fase 7 (`@SkipThrottle` ou limite próprio).
- **O front trata o 409 de concorrência** (Fase 6) pedindo para recarregar o ticket.
- **E2E rodam um arquivo por vez** (projeto `e2e` do Vitest): os arquivos dividem o banco.

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
