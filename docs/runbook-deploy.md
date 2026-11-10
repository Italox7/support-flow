# Runbook de deploy

Demo pública: API no Render, front na Vercel e banco no schema `public` do Supabase. Não há
staging: o primeiro deploy fica com o link não publicado até as medições passarem.

## Antes do primeiro deploy

Confira, nesta ordem:

1. A senha do banco foi trocada, e o schema `public` não tem tabelas.
2. O certificado confere com o pooler da região do projeto. No Git Bash, troque `<host>` pelo host
   do pooler (ele não é segredo) e espere `Verify return code: 0 (ok)`:

   ```bash
   openssl s_client -starttls postgres -connect <host>:6543 -servername <host> \
     -CAfile apps/api/certs/supabase-ca.crt -no-CApath -no-CAstore \
     -verify_return_error -verify_hostname <host> </dev/null 2>&1 | grep 'Verify return code'
   ```

## Variáveis do Render

Região: a mesma do Supabase. Health check path: `/api/health/live`. Sem PR previews.

| Variável             | Valor                                                                                                |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| `NODE_ENV`           | `production`                                                                                         |
| `DATABASE_URL`       | Transaction pooler (6543) com `?schema=public&sslmode=verify-full&sslrootcert=certs/supabase-ca.crt` |
| `DIRECT_URL`         | Session pooler (5432), mesmo host, com `?schema=public&sslmode=require`                              |
| `JWT_ACCESS_SECRET`  | Novo, exclusivo da demo (48 bytes aleatórios)                                                        |
| `JOBS_SECRET`        | Novo, de `openssl rand -hex 32`; o mesmo valor vai para os secrets do GitHub Actions                 |
| `TRUST_PROXY`        | `1` provisório; medido no passo 3 abaixo                                                             |
| `DEMO_RESET_ENABLED` | `true`                                                                                               |
| `DEMO_PASSWORD`      | Nova, 12 caracteres ou mais, exclusiva da demo: ela fica pública                                     |

Nunca use `uselibpqcompat`: ele muda o sentido de `sslmode`, e a guarda recusa a URL.

- **Build** (raiz do repositório):
  `npm ci --include=dev --ignore-scripts && npm run build -w @support-flow/shared && npm run build -w @support-flow/api && node apps/api/dist/check-deploy-env.js && npm run db:deploy -w @support-flow/api`
- **Start**: `npm start -w @support-flow/api`. O cwd fica em `apps/api`, de onde o caminho da CA é
  relativo. Confirme no primeiro deploy.

A guarda `check-deploy-env` lista só os nomes das variáveis inválidas, nunca os valores.

## Ordem do primeiro deploy

1. Criar o serviço no Render e esperar `/api/health/live` responder.
2. Em um PR curto, trocar o host `.invalid` de `apps/web/vercel.json` pela URL real do Render.
3. **Medir o `TRUST_PROXY`**: criar a Vercel com Root Directory `apps/web`, ligar
   `LOG_XFF_COUNT=true`, fazer uma requisição pelo domínio da Vercel e ler no log do Render
   `X-Forwarded-For com N entrada(s)`. Usar `TRUST_PROXY=N` e tirar `LOG_XFF_COUNT`. O Express conta
   da direita para a esquerda: um N menor faz todos dividirem o IP da Vercel.
4. Criar os secrets `API_URL` (URL do Render, sem barra no fim) e `JOBS_SECRET` no GitHub Actions.
5. Rodar o workflow **Jobs diários** por `workflow_dispatch` e conferir `restored: true`.
6. Fazer as medições abaixo e o ensaio de rollback.
7. Abrir o front no navegador e conferir que o console não mostra violação de CSP.
8. Só então publicar no README o link e a `DEMO_PASSWORD`.

## Medições, com o link ainda não publicado

| #   | Como                                                                                                                                       | Esperado                                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M1  | Pela Vercel, depois de 20 min parado, 3 vezes                                                                                              | JSON em até 100 s                                                                                                                                            |
| M2  | 6 logins errados de uma rede, 1 de outra, com `X-Forwarded-For` forjado                                                                    | O 6º da primeira rede leva 429; a outra não é afetada; o XFF forjado escapa (risco aceito)                                                                   |
| M3  | 30 `POST /api/tickets` simultâneos                                                                                                         | Só 201, 429 ou 503 com `code`; `live` abaixo de 5 s                                                                                                          |
| M4  | `curl -i` pela Vercel                                                                                                                      | `Retry-After`, corpo do 503 e `Set-Cookie` intactos; sem cache                                                                                               |
| M5  | 5 logins simultâneos                                                                                                                       | Abaixo de 512 MB, sem reinício                                                                                                                               |
| M6  | Cron com a API fria e com segredo errado                                                                                                   | O primeiro passa; o segundo falha e chega e-mail; o `dev` fica idêntico                                                                                      |
| M7  | 10 logins certos em sequência, 15 s entre eles (limite de 5/min por IP), com `curl -w '%{time_total}'` e um `live` antes (API já acordada) | Mediana anotada no resultado. O verify não tem log de duração: estimar por login menos `live`. Acima de 1 s, o Perry revê as vagas do argon2 (`password.ts`) |
| M8  | 11 logins errados com um e-mail que não é da demo, de uma rede só, 15 s entre eles (limite de 5/min por IP)                                | Do 1º ao 10º, 401; o 11º, 429 com `Retry-After` ≤ 900 (a janela conta desde a 1ª falha); conta da demo nunca leva 429                                        |

### Resultado do primeiro deploy (2026-11-08)

| #        | Resultado                                                                                                                                 |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| M1       | 3 partidas a frio: 42,7 s, 42,6 s e 42,8 s, sempre JSON. O front mostra "Acordando o servidor…"                                           |
| M2       | 6º login errado = 429; outra rede (4G) não foi afetada, o que confirma `TRUST_PROXY=4`; o XFF forjado escapou em 3 de 6                   |
| M3       | 30 POST em 1,9 s: 10 × 201 e 20 × 429, todos com `Retry-After`; nenhum 500 ou 503; `live` no máximo em 1,35 s                             |
| M4       | Sem cache (`MISS`, sem `age`); login com `no-store` e cookie `HttpOnly; Secure; SameSite=Lax`; corpos 401/429 intactos. 503 não provocado |
| M5       | 5 logins simultâneos, todos 200 em 1,5 a 1,9 s, sem reinício. Memória **estimada** (o plano free não mostra)                              |
| M6       | Cron a frio verde e `dev` idêntico antes e depois (contagem e md5 de 5 tabelas); segredo errado = 401                                     |
| Rollback | Render ida e volta em 41 s cada; Vercel imediato; login e escrita funcionaram nos dois                                                    |
| CSP      | Console sem violação em login, lista, ticket, comentário e saída                                                                          |

### Resultado do segundo deploy (2026-11-10, limite de login e fila do argon2)

| #   | Resultado                                                                                                                                                                                                                                                                     |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M7  | 10 logins certos, 15 s entre eles, todos 200: mediana 0,709 s (0,659 a 0,913); `live` sem banco 0,691 s (1 amostra). Do Rio, o RTT até Virginia domina; o verify some no ruído (< ~0,25 s no pior caso). Vagas mantidas em 2, fila 8, espera 3 s (Perry)                      |
| M8  | 10 errados com e-mail inexistente = 401; o 11º = 429, `Retry-After` 719 (janela de 15 min já com ~3 min gastos), `x-ratelimit-remaining` 2 (limite por e-mail, não o do IP); `login_locked` 1 vez; 11 errados na conta da demo = todos 401; `password_hash_busy` não apareceu |

## Rollback

- **API**: Render → Events → **Rollback** no deploy desejado (cerca de 40 s). O rollback **volta
  também as variáveis de ambiente** daquele deploy (a caixa de confirmação lista a diferença; confira
  antes, porque ele pode desfazer a troca de um segredo) e **desliga o Auto-Deploy**. Para voltar,
  faça Rollback no deploy mais novo e religue Settings → Auto-Deploy → On Commit.
- **Front**: Vercel → Deployments → **Instant Rollback** (imediato, sem novo build). No plano Hobby
  só vai para o deploy de Production **imediatamente anterior**: não deixe um deploy quebrado nessa
  posição. Para voltar, use **Promote** no deploy mais novo, o que também devolve aos próximos merges
  a atribuição automática do domínio.
- **Dados da demo**: rodar **Jobs diários** por `workflow_dispatch`. Qualquer dano feito com a senha
  pública se desfaz assim, ou sozinho em até 24 h.
- **Migrations não voltam atrás**. Com a API antiga rodando, use expandir e depois contrair: primeiro
  uma migration compatível com as duas versões, e só no deploy seguinte a que remove o antigo. A
  migration de SLA é o contraexemplo: o CHECK e o NOT NULL exigem a API antiga parada.

## Rotina

- **Lembrete mensal**: o GitHub desliga agendamentos após 60 dias sem atividade no repositório, e o
  Supabase pausa projetos gratuitos parados. Confira se **Jobs diários** segue rodando e reative
  se for preciso. Nos logs do Render do mês, busque `password_hash_busy` e `login_locked`: são os
  gatilhos do "Revisitar quando" do limite de login em `docs/decisions.md`. `password_hash_busy` fora
  de rajada isolada pede nova medição (M7) com o Perry; `login_locked` frequente ou num mesmo e-mail
  pode ser tentativa de adivinhar senha, e vale avisar o Gard.
- **Falha do job**: o GitHub avisa por e-mail. 401 é `JOBS_SECRET` diferente nos dois lados; 503 é o
  lock ocupado ou o banco fora, e pode ser repetido (a restauração e o fechamento podem já ter rodado).
  `restored` falso também falha o job: confira `DEMO_RESET_ENABLED` e o `schema` da URL.
- **503 com `code: 'PASSWORD_HASH_BUSY'`**: a fila do hash de senha encheu (log `password_hash_busy`),
  e nada foi gravado. Passageiro numa rajada; se for frequente, medir de novo (M7) com o Perry antes
  de mexer nas vagas. **429 no login com `Retry-After` alto** é o limite de 10 falhas por e-mail em
  15 min (log `login_locked`): espera a janela, sem ação manual.
- **Trocar a senha pública**: alterar `DEMO_PASSWORD` no Render e rodar o workflow.
