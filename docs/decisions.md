# Decisões técnicas

Registro curto das decisões que não são óbvias pelo código. A mais recente fica no topo.

## 2026-11-09 — Limite de falhas de login por e-mail e fila do argon2

Pendências do Gard desde a Fase 2. Desenho revisado pelo Gard, pelo Archie e pela Pixie antes do
código; custo do argon2 medido pelo Perry.

- **10 falhas de login em 15 min por e-mail, depois 429** com `Retry-After` igual ao que resta
  da janela. Soma ao limite por IP, que um `X-Forwarded-For` forjado contorna. Fica no
  `AuthService.login`, não num guard: o guard roda antes do DTO e veria o e-mail sem
  normalizar. A chave é um HMAC do e-mail com segredo aleatório por processo: o e-mail em claro
  não fica na memória. Cada tentativa reserva a falha antes do banco e do argon2 (pedidos em
  paralelo não furam o limite), e a reserva volta no sucesso ou em qualquer erro que não seja
  senha errada. O 429 tem o mesmo corpo do 429 por IP e sai igual para e-mail existente e
  inexistente, sem banco nem argon2. Em memória: o cold start zera, e ao escalar os contadores
  vão para um armazenamento compartilhado, com a chave do HMAC virando segredo.
- **Sem limite global de login**: ele deixaria uma pessoa travar a demo inteira. O teto global
  é a fila do argon2, que degrada para um 503 passageiro.
- **Contas da demo isentas do limite por e-mail com `DEMO_RESET_ENABLED`** (lista fixa em
  `auth/demo-emails.ts`, nunca o papel lido no banco). A senha delas é pública, então o limite
  não protegeria nada e só deixaria alguém travar a demo para os visitantes.
- **Riscos aceitos**: alguém que conhece o e-mail de outra conta pode travá-la por 15 min
  (lockout dirigido). E quem usa os e-mails isentos da demo pode encher a fila do argon2: aí os
  logins de todos levam 503 enquanto durar o abuso, ainda contido pelo limite por IP.
  O teto de 10.000 e-mails conta só os que têm falha confirmada, e só eles são despejados, do
  mais antigo para o mais novo. Pedidos pendentes, que não pagam argon2, não tiram um alvo do
  Map. Zerar a contagem de um alvo exige 10.000 falhas confirmadas dentro da janela, todas
  passando pela fila do argon2. O log `login_attempts_evicted` sai amostrado. Oráculo fraco e
  aceito: levar 429 com menos de 10 falhas próprias mostra que outra pessoa errou a senha
  daquele e-mail nos últimos 15 min.
- **Fila do argon2 em `password.ts`**: no máximo 2 hashes ao mesmo tempo, 8 na fila e 3 s de
  espera. Cobre todos os chamadores (login, cadastro, criar agente, seed, demo-reset), e um teste
  garante que só `password.ts` importa o `argon2`. Números do Perry: ~35 ms de CPU e ~19 MiB
  nativos por hash, medidos local; no Render free, ~350 ms estimados, coerente com o M5 de
  2026-11-08 (5 logins simultâneos em 1,5 a 1,9 s). Medição pendente: M7 do runbook no próximo
  deploy, rodada pelo usuário; o Perry decide os números a partir dela, e o resultado fica no
  runbook. O demo-reset faz um hash só para as três contas e entra na frente da fila, sem teto
  nem timeout. Testes que fixam o comportamento: `password-gate.spec.ts`,
  `login-attempts.spec.ts` e `auth.service.spec.ts`.
- **`503` com `code: 'PASSWORD_HASH_BUSY'` e `Retry-After: 2`** quando a fila enche ou a espera
  estoura. Não é 429: o problema é capacidade do servidor, não excesso do cliente. Como o
  `ASSIGNMENT_BUSY`, garante que nada foi gravado, porque todo chamador faz o hash antes de
  escrever. Mesmo assim o front **não** repete o `PASSWORD_HASH_BUSY` em nenhuma tela: com a fila
  cheia, repetir só aumenta a carga, e o `Retry-After: 2` é só indicação. Decisão do usuário,
  contra a sugestão do Archie de repetir em criar agente. O `ASSIGNMENT_BUSY` segue como na
  entrada de 2026-11-04.
- **Correção da entrada de 2026-11-04**: a repetição automática do 503 só existe em `api()`.
  Login e cadastro saem pelo `fetch` da sessão (`session.ts`) e nunca repetiram nenhum 503.
- **Textos**: o 429 diz "Aguarde cerca de N minutos", calculado uma vez a partir do
  `Retry-After`, sem contagem regressiva nem o número exato do limite; no login, fala de
  "tentativas de entrada", sem sugerir que a conta existe ou foi bloqueada. O 503 do hash diz
  que nada foi salvo (no login, só pede para tentar de novo). Campos e senha ficam preenchidos,
  e o botão volta a ficar habilitado.
- **Revisitar quando**: a API passar de uma instância; `password_hash_busy` ou `login_locked`
  aparecerem no log de produção sem um teste nosso; ou o verify no Render (M7) passar de 1 s.

## 2026-11-08 — Limites de escrita depois da Fase 7

- **`no-store` em toda a API**: um middleware em `configureApp` põe `Cache-Control: no-store` em
  toda resposta, inclusive erros. Conferido pela Vercel depois do deploy: 401 e 404 chegam com
  `no-store`; a Vercel só aplica o padrão dela quando a origem não manda nenhum.
- **Fora do `UserRateLimitGuard`, por decisão**: `POST /tickets/:id/transitions` e
  `PUT /sla-policies/:priority` ficam só com o limite global de 120/min por IP. O
  `rate-limit.bindings.spec.ts` fixa as duas listas; uma escrita nova faz o teste falhar até
  alguém decidir se ela entra no limite.

## 2026-11-08 — Primeiro deploy medido (Fase 7)

Resultados em [runbook-deploy.md](runbook-deploy.md#resultado-do-primeiro-deploy-2026-11-08).

- **`TRUST_PROXY=4`**: o pedido chega com 4 entradas no `X-Forwarded-For` (Vercel → Cloudflare →
  Render); os health checks internos chegam com 0.
- **XFF forjado escapa de forma intermitente** (3 de 6): o tamanho da cadeia parece variar na borda.
  Continua dentro do risco aceito; reavaliar só se houver abuso.
- **Cache-Control padrão da Vercel** (`public, max-age=0, must-revalidate`) nas respostas da API sem
  cabeçalho próprio. Nenhum HIT observado; `no-store` global em `/api` fica como melhoria (P3).
- **Memória do M5 estimada, não medida**: cerca de 95 MB de argon2 para 5 logins, mais o Node, contra
  512 MB.
- **Rollbacks não são neutros**: o do Render volta as variáveis e desliga o Auto-Deploy; o da Vercel,
  no Hobby, só alcança o deploy anterior.

## 2026-11-04 — Deploy da demo pública (Fase 7)

Desenho revisado por Pipe, Archie e Gard antes do código. Passo a passo em
[runbook-deploy.md](runbook-deploy.md).

- **Job único e diário**, `POST /api/jobs/run`, nesta ordem: restaurar a demo, fechar os tickets
  resolvidos há mais de 7 dias (`REOPEN_WINDOW_MS`) e atribuir órfãos. Sem snapshot: os dados da
  demo são descartáveis. Fechar fica fora do lock, como toda transição; só a restauração e a
  atribuição o usam. Corpo: `{restored, closed, assigned}`, também no log.
- **Três travas na restauração**: `DEMO_RESET_ENABLED`, `RENDER=true` e o schema `public` lido da
  URL crua, porque `parseDatabaseUrl` trata schema ausente como public e `RENDER=true` não prova
  que é a demo. Só usa a API de modelos, sem SQL cru, o que a prende ao schema do adapter.
- **TLS diferente nas duas URLs**: `DATABASE_URL` em `verify-full` com a CA pública versionada;
  `DIRECT_URL` em `require`, porque o schema engine do Prisma não suporta `verify-full`. A CLI
  autentica sem verificar o servidor; só roda no build do Render, que fica na região do banco. Em
  deploy, `env.ts` aceita só os parâmetros previstos, o que barra `uselibpqcompat` e `host`, e
  `check-deploy-env` valida antes do migrate.
- **Limites**: 10/min por usuário e por rota em `POST /tickets`, `POST` de comentários e nas rotas que
  entram no lock ou pagam argon2 (`PATCH /tickets/:id`, criar agente, disponibilidade); teto de
  30/min somando todas; teto de 30 cadastros por hora, independente de IP. A contagem fica em memória
  e zera no cold start: basta para uma instância.
- **X-Forwarded-For forjado aceito na demo**, sem segredo de origem (Gard), porque os limites acima
  não dependem de IP; o login ainda depende (pendência da Fase 2 sobre os hashes simultâneos). **Admin com senha pública é aceitável**: o dano se desfaz em até 24 h ou por
  `workflow_dispatch`. `DEMO_PASSWORD` e `JWT_ACCESS_SECRET` são exclusivos da demo.
- **`inLock` responde 503 só enquanto nada foi gravado**: sem conexão, antes do callback, ou ao
  tomar o lock. Depois de começar, o erro sobe como está. P2028 não serve de critério (Archie),
  porque também cobre a transação expirada ou já fechada, e essa pode ter gravado.
- **`/api/health/live` para o Render**, sem banco e sem rate limit; `/api/health` para o cron. Pool
  de 5 conexões, com 4 s de espera.
- **Riscos conhecidos**:
  - o access token de um usuário apagado pela restauração vale até 15 min, e `POST /tickets` com
    ele tende a 500 por chave estrangeira. As contas da demo têm IDs fixos e não passam por isso;
  - o advisory lock é por banco: os schemas `dev` e `public` dividem a mesma fila;
  - uma migration à frente do código pede expandir e contrair, e o runbook explica como;
  - **indisponibilidade por abuso (risco aceito)**: com as três contas públicas, uma pessoa sustenta
    o teto de escrita, e qualquer um esgota os cadastros da hora com pedidos inválidos, porque o teto
    conta antes da validação. Só as escritas e os cadastros param; as contas da demo continuam
    entrando. Reavaliar só se houver abuso real nos logs, começando por captcha no cadastro ou por
    teto por IP depois de medir o `TRUST_PROXY`.

## 2026-11-04 — Sessão no front e repetição automática (Fase 6)

Desenho revisado pelo Gard e pela Pixie antes do código.

- **`code: 'ASSIGNMENT_BUSY'` no corpo do 503 de `inLock`** (acréscimo ao contrato), usado na
  criação, no PATCH do ticket e na disponibilidade. O código significa "nada gravado", não só
  "lock ocupado": uma queda do banco ao tomar o lock sai com ele também. Só esse 503 garante isso. Um 503 de proxy pode vir depois de a API gravar e, como
  `POST /tickets` não tem chave de idempotência, repetir criaria um ticket duplicado. O front
  repete só com status 503, `Retry-After` inteiro de 1 a 5 e esse `code`, em até 3 tentativas
  no total. O 429 nunca repete. (Correção em 2026-11-09: a repetição só existe em `api()`; login
  e cadastro saem por `session.ts` e não repetem nenhum 503.)
- **Cada aba renova o próprio access token, em fila num Web Lock.** A rotação só revoga a
  família quando o token apresentado já foi revogado; em fila, cada aba manda o cookie que a
  anterior deixou. O BroadcastChannel leva só avisos, nunca o token, que fica só em memória.
- **Login, cadastro e logout usam o mesmo lock**, porque escrevem o mesmo cookie: sem isso, um
  refresh atrasado ressuscitaria a sessão depois do logout ou sobrescreveria o login de outra
  pessoa.
- **O fetch do refresh não é abortado cedo.** Abortar depois de o servidor rotacionar perde o
  token novo. O timeout curto (10 s) vale para a espera do lock; o do fetch é só um teto alto.
- **Só o 401 do refresh encerra a sessão.** 429, 5xx e erro de rede são transitórios: a sessão
  fica, e o usuário tenta de novo.
- **Troca entre o teto de 60 s e a sessão**: a leitura desiste em 60 s e mostra "Tentar de novo",
  mas login, cadastro e refresh têm teto de 120 s, para não perder um token já rotacionado. Com
  o servidor muito lento, a tela de abertura pode esperar mais que o minuto que o texto promete.
  A espera de 10 s pelo lock também é menor que o cold start: uma segunda aba pode mostrar erro
  com "Tentar de novo" enquanto a primeira acorda a API. Nos dois casos a sessão é preservada.
- **Riscos aceitos para a demo**: se a resposta de um refresh se perder depois da rotação, a
  renovação seguinte revoga a família e o usuário entra de novo (só uma janela de tolerância na
  API eliminaria isso). Sem Web Locks, a fila vale só dentro da aba, e abas renovando juntas
  têm a mesma consequência. Nos dois casos nada vaza.
- **Rascunho de comentário em `sessionStorage`**, com chave por usuário e ticket, para
  sobreviver à sessão expirada; o logout explícito apaga os rascunhos.

## 2026-11-03 — Criar agente e contrato para o front (antes da Fase 6)

Desenho revisado pelo Archie antes do código.

- **`POST /users/agents` (admin)**: o admin define a senha inicial, com o mesmo mínimo do
  cadastro (`CreateAgentDto` herda de `RegisterDto`, decisão do usuário). 10/min, porque
  cada criação calcula um argon2. E-mail repetido é 409, sem promover a conta existente.
- **O agente nasce indisponível**, contra o default do schema: não recebe tickets antes do
  primeiro login e a criação dispensa o lock. Ao ficar disponível, a varredura de órfãos é a
  de sempre.
- **Risco conhecido**: não há rota de troca de senha, então o admin continua sabendo a senha
  do agente, e uma conta comprometida só se resolve por SQL. O agente tem mínimo de 8
  caracteres; o admin do seed, de 12. Aceitável para a demo com dados fictícios (Gard, P2).
  **Antes de dar conta de agente a uma pessoa real ou atender dados reais**: rota de troca que
  exige a senha atual e revoga os refresh tokens, e limite por e-mail no login.
- **Pendências de auth que estavam fora deste registro** (Gard, Fase 2): limite por e-mail no
  login; limitar quantos hashes argon2 rodam ao mesmo tempo.
- **O limite de 10/min conta antes da autenticação** (rota + IP): um anônimo no mesmo IP gasta
  o limite do admin, sem pagar argon2. Impacto baixo; com `TRUST_PROXY` errado, todos dividem o
  IP. A exigência dele em produção é da Fase 7, e o `env.ts` ainda não a impõe.
- **`Retry-After: 1` só no 503 do lock**, por uma subclasse (`AssignmentBusyException`) e um
  filtro que escreve o cabeçalho e mantém o corpo. (Regra do front substituída pela entrada de
  2026-11-04, que exige também o `code`.) O front só repete sozinho com status 503
  **e** esse cabeçalho, com um número limitado de tentativas: o throttler também manda
  `Retry-After` no 429, e uma queda do banco cai no mesmo 503. É seguro porque o lock é a
  primeira instrução da transação. Falta conferir no staging se o rewrite da Vercel preserva o
  cabeçalho (Fase 7, com o Pipe); se não preservar, o front só deixa de repetir.
- **Os botões de transição vêm da API**: `allowedTransitions` em `TicketDetail`, calculado com
  o próprio `canTransition`, em vez de levar a tabela para `packages/shared`. A regra tem
  `SYSTEM`, contexto e a janela de 7 dias, que no front dependeria do relógio do navegador.
  O valor pode estar defasado: o front recarrega o ticket em 403 e 409 na transição (quem
  perdeu a atribuição em OPEN recebe 403).
- **Comentar pode mudar o status** e `POST /comments` devolve só o comentário: o front recarrega
  o ticket depois de comentar. O contrato não muda por isso.

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
  Uma migration que recrie a coluna `status` ou mude o enum precisa dropar e recriar o
  CHECK nela mesma. O CHECK e os `*RiskAt` NOT NULL quebram código antigo que grave
  tickets: aplicar com a API antiga parada (em produção, expand/contract se precisar).
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
- **Comentário em RESOLVED não vira 1ª resposta**: o veredito de um ticket resolvido
  não muda (a 1ª resposta continua NOT_APPLICABLE ou BREACHED). `?sla=` aceita no
  máximo um de cada valor (repetidos multiplicariam o OR da consulta).
- **Risco conhecido (Gard)**: a equipe consegue melhorar a própria métrica, baixando a
  prioridade de um ticket estourado (os prazos são recalculados desde a abertura) ou
  pausando em WAITING_CUSTOMER, sem histórico. Aceito para o MVP; se o SLA for usado
  para avaliar pessoas, pede auditoria de mudanças. A edição de política fica no log
  (`sla_policy_updated`, com o admin e os valores antes e depois).
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
- **Fora desta fase**: criar agente (`POST /users/agents`, feito antes da Fase 6, ver a
  entrada de 2026-11-03) e `POST /jobs/run` (Fase 7).
- **Pendências registradas pelo Gard**:
  - limite por usuário no `POST /tickets` **bloqueia o deploy** (P1 a partir dele: o
    cadastro é aberto e cada criação entra na fila do lock). O PATCH do ticket já checa
    escopo e papel antes da fila: cliente e agente sem permissão não a ocupam;
  - ~~esperar mais que o `maxWait` por uma conexão do pool vira 500, não 503~~ (resolvido na
    entrada de deploy: sem conexão antes da transação começar, `inLock` responde 503);
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
