# Decisões técnicas

Registro curto das decisões que não são óbvias pelo código. A mais recente fica no topo.

## 2026-11-02 — SLA (Fase 5)

Desenho revisado pelo Archie antes do código.

- **Onde o relógio corre**: `SLA_CLOCK` em `apps/api/src/sla` (regra do servidor, não
  de `packages/shared`), um `Record` exaustivo por status: corre em OPEN e IN_PROGRESS,
  pausa em WAITING_CUSTOMER e RESOLVED, para em CLOSED. Não é o `OPEN_STATUSES` da
  atribuição.
- **Prazos e "em risco" materializados**: além dos `*DueAt`, o ticket grava `*RiskAt`
  (80% do prazo, em ms inteiros) para o filtro da fila ser um `where` do Prisma, sem SQL
  cru. O 0,8 fica congelado nos dados: mudar a fração pede migration que recalcule.
- **Estado calculado na leitura** por `computeSla(ticket, now)`, só com os campos do
  ticket, sem a política: editar a política não muda o estado de tickets existentes.
  Relógio parado vale onde parou (`slaPausedAt`), inclusive em RESOLVED vindo de
  WAITING_CUSTOMER. Precedência: MET > BREACHED > PAUSED/NOT_APPLICABLE > AT_RISK > OK.
  O filtro `?sla=` (`sla-filters.ts`) espelha a mesma regra; um E2E com a matriz status ×
  1ª resposta × posição do relógio exige que os dois concordem ticket a ticket.
- **Pausa e retomada em `applyTransition`**: ao pausar grava `slaPausedAt`; ao retomar
  soma o tempo parado (segundos inteiros, o mesmo Δ em tudo) a `pausedSeconds` e aos
  prazos. Invariante: enquanto não há 1ª resposta, prazos gravados =
  `computeDeadlines(createdAt, política, pausedSeconds)`. Um CHECK no banco garante
  `slaPausedAt` presente se e só se o relógio não corre (fica fora do `schema.prisma`).
- **A 1ª resposta congela o prazo dela**: retomada e troca de prioridade não mexem mais
  nele, senão uma pausa posterior viraria um BREACHED antigo em MET. Se a resposta chega
  com o ticket pausado, o prazo recebe a parte da pausa já decorrida: o "cumpriu?" é
  medido onde o relógio parou.
- **Sem resposta e resolvido antes do prazo**: a 1ª resposta fica `NOT_APPLICABLE` em
  RESOLVED e CLOSED (decisão do usuário). Reabrindo, o relógio volta a correr.
- **Escritas concorrentes sem lock comum**: o PATCH (sob o lock da atribuição) só grava
  se status, `pausedSeconds` e, ao recalcular a 1ª resposta, `firstResponseAt: null`
  ainda forem os lidos. A retomada regrava prazos como valores absolutos, então só vale se
  os `*DueAt` lidos não mudaram; a 1ª resposta, se a pausa e o prazo não mudaram. Para o
  usuário, a perda é 409; um efeito de comentário relê e tenta de novo uma vez. E2E (a)–(e)
  em `sla.e2e-spec.ts` prendem a linha do ticket para forçar cada intercalação.
- **Troca de prioridade em RESOLVED é 409**, como em CLOSED: o veredito de um ticket
  resolvido não muda depois (decisão do usuário). Reabrindo, pode trocar.
- **O cliente não vê o SLA**: a chave `sla` nem existe na resposta dele, e `?sla=` vindo
  dele é 403 (ignorar fingiria um filtro; aplicar revelaria o estado).
- **Políticas**: `GET /sla-policies` (equipe) e `PUT /sla-policies/:priority` (admin),
  inteiros de 1 min a 30 dias, 1ª resposta menor que a resolução. Vale para tickets novos
  e trocas de prioridade, sem recalcular os existentes.
- **Migration** (`20261102000000_sla_risk_and_pause`): preenche os `*RiskAt` com a mesma
  conta do código e grava a pausa que a Fase 3 não gravava: `resolvedAt` em RESOLVED e
  CLOSED, `updatedAt` em WAITING_CUSTOMER. Esta é aproximada (um PATCH também mexe em
  `updatedAt`): risco aceito, os dados atuais são de teste.
- **Sem índice novo**: os filtros são OR entre dois relógios; medir com EXPLAIN num seed
  grande antes de criar (`[status, resolutionRiskAt]` é o candidato).
- **Fora desta fase**: horário comercial, alertas e jobs de estouro, métricas de SLA,
  histórico de política, recálculo ao editar a política, SLA visível ao cliente.

## 2026-11-01 — Atribuição (Fase 4)

Desenho revisado pelo Archie antes do código.

- **Um lock global de atribuição** (`pg_advisory_xact_lock`, chave fixa no
  `AssignmentService`). É sempre a primeira instrução da transação, que só o `inLock` abre,
  com `maxWait`/`timeout` explícitos. Os métodos que escolhem agente exigem um `LockedTx`:
  passar uma transação sem o lock não compila. Lock de transação funciona no pooler do
  Supabase em modo transação; um lock de sessão não funcionaria. Lock por linha
  (`FOR UPDATE` nos agentes) arriscaria deadlock sem ganho nesta escala.
- **Pegam o lock**: criação de ticket, mudança de disponibilidade e `PATCH /tickets/:id`
  (mesmo só de prioridade: um caminho só vale mais que os milissegundos de fila).
  Transições não pegam: um ticket resolvido ou reaberto ao mesmo tempo deixa a carga lida
  defasada em 1 (escolha um pouco pior), nunca dois tickets vendo a mesma carga.
- **Espera pelo lock de no máximo 2 s** (`lock_timeout` local da transação), depois 503. Quem
  espera ocupa uma conexão do pool: sem o limite, ~10 criações simultâneas esgotariam o pool
  e parariam a API inteira, `/api/health` incluído. O PATCH de disponibilidade tem 10/min,
  porque ficar disponível varre órfãos segurando o lock.
- **O PATCH do ticket é otimista**: só grava se `status` e `pausedSeconds` ainda forem os
  lidos, senão 409. Pré-condição da Fase 5, em que a pausa e a retomada do SLA mudam esses
  campos sem o lock.
- **"Em aberto" tem uma definição só**: `OPEN_STATUSES` em `packages/shared` (OPEN,
  IN_PROGRESS, WAITING_CUSTOMER). WAITING_CUSTOMER conta como carga. Não é o conjunto em
  que o SLA corre (lá ele está pausado): a Fase 5 define o seu.
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
- **Pendências registradas pelo Gard**:
  - limite por usuário no `POST /tickets` **bloqueia o deploy** (P1 a partir dele: o
    cadastro é aberto e cada criação entra na fila do lock). O PATCH do ticket já checa
    escopo e papel antes da fila: cliente e agente sem permissão não a ocupam;
  - o 503 do lock não manda `Retry-After`: o front (Fase 6) tenta de novo com espera;
  - esperar mais que o `maxWait` por uma conexão do pool vira 500, não 503;
  - rebaixar um agente (quando houver troca de papel) tem de reatribuir os tickets dele e
    revogar os refresh tokens;
  - `isAvailable` nasce `true` em todo usuário; o filtro `role: AGENT` está em toda consulta
    da atribuição. Default `false` ou um CHECK no banco pedem migration.
  - `lock_timeout` e tamanho do pool: medir com o Pipe no staging (Fase 7).

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
