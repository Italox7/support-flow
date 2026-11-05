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

| #   | Como                                                                    | Esperado                                                                                   |
| --- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| M1  | Pela Vercel, depois de 20 min parado, 3 vezes                           | JSON em até 100 s                                                                          |
| M2  | 6 logins errados de uma rede, 1 de outra, com `X-Forwarded-For` forjado | O 6º da primeira rede leva 429; a outra não é afetada; o XFF forjado escapa (risco aceito) |
| M3  | 30 `POST /api/tickets` simultâneos                                      | Só 201, 429 ou 503 com `code`; `live` abaixo de 5 s                                        |
| M4  | `curl -i` pela Vercel                                                   | `Retry-After`, corpo do 503 e `Set-Cookie` intactos; sem cache                             |
| M5  | 5 logins simultâneos                                                    | Abaixo de 512 MB, sem reinício                                                             |
| M6  | Cron com a API fria e com segredo errado                                | O primeiro passa; o segundo falha e chega e-mail; o `dev` fica idêntico                    |

## Rollback

- **API**: Render → Events → reverter para o deploy anterior.
- **Front**: Vercel → Deployments → promover o anterior.
- **Dados da demo**: rodar **Jobs diários** por `workflow_dispatch`. Qualquer dano feito com a senha
  pública se desfaz assim, ou sozinho em até 24 h.
- **Migrations não voltam atrás**. Com a API antiga rodando, use expandir e depois contrair: primeiro
  uma migration compatível com as duas versões, e só no deploy seguinte a que remove o antigo. A
  migration de SLA é o contraexemplo: o CHECK e o NOT NULL exigem a API antiga parada.

## Rotina

- **Lembrete mensal**: o GitHub desliga agendamentos após 60 dias sem atividade no repositório, e o
  Supabase pausa projetos gratuitos parados. Confira se **Jobs diários** segue rodando e reative
  se for preciso.
- **Falha do job**: o GitHub avisa por e-mail. 401 é `JOBS_SECRET` diferente nos dois lados; 503 é o
  lock ocupado ou o banco fora, e pode ser repetido (a restauração e o fechamento podem já ter rodado).
  `restored` falso também falha o job: confira `DEMO_RESET_ENABLED` e o `schema` da URL.
- **Trocar a senha pública**: alterar `DEMO_PASSWORD` no Render e rodar o workflow.
