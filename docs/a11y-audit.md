# Auditoria de acessibilidade do front (WCAG 2.2 AA)

Fecha o P3 "contraste/leitor de tela não verificados". Só tema claro (o app não tem escuro).
Marque cada item com ✅ (passa), ❌ (falha: descreva) ou — (não se aplica).

## 0. Preparação

1. `npm run dev:api` e `npm run dev:web`; abrir http://localhost:5173 no Chrome.
2. Contas do seed: cliente, agente e admin (`README.md`, linha 11).
3. Para ver os selos de SLA mudarem sem esperar horas: como admin, em **Prazos de SLA**,
   pôr a prioridade **Baixa** com 1ª resposta = 1 e resolução = 2 minutos; abrir um ticket
   novo como cliente. Ao fim, voltar os valores originais (anote-os antes).
4. Leitor de tela: NVDA (gratuito, nvaccess.org) com Chrome. Alternativa: Narrador
   (Ctrl+Win+Enter). Teclas usadas abaixo:

| Ação                            | NVDA              | Narrador                            |
| ------------------------------- | ----------------- | ----------------------------------- |
| Ler tudo a partir daqui         | Insert+↓          | Narrador+R                          |
| Próximo título / região         | H / D             | H / D                               |
| Próximo campo de formulário     | F                 | F                                   |
| Próxima tabela; navegar células | T; Ctrl+Alt+setas | T; Ctrl+Alt+setas                   |
| Lista de elementos              | Insert+F7         | Narrador+F7 (não equivalente exato) |
| Modo foco ↔ navegação           | Insert+Espaço     | Narrador+Espaço (modo de varredura) |

## 1. Contraste — já calculado

Feito por script (oklch do `tailwindcss/theme.css` → sRGB → razão WCAG). Pior caso por grupo:

| Grupo                                                         | Pior razão                     | Mínimo         | Resultado |
| ------------------------------------------------------------- | ------------------------------ | -------------- | --------- |
| Texto (inclui secundário, links, erros, selos de SLA, avisos) | 6,09:1 (link sobre `canvas`)   | 4,5:1          | ✅        |
| Bordas de campo e botão (1.4.11)                              | 4,39:1 (`line` sobre `canvas`) | 3:1            | ✅        |
| Anel de foco contra o fundo                                   | 6,09:1                         | 3:1            | ✅        |
| Botão desativado (`opacity-60`)                               | 2,0–2,4:1                      | isento (1.4.3) | —         |

A conferir na página real (passo 2): anel de foco do **botão azul** (o cálculo o compara com o
próprio botão, 1:1; o `outline-offset: 2px` deve pô-lo sobre o fundo) e estados de hover.

## 2. Varredura automática (axe DevTools ou Lighthouse)

Extensão "axe DevTools" (versão grátis) ou Chrome DevTools → Lighthouse → só "Acessibilidade".
Rodar em cada linha; anotar só violações (não "needs review").

| Tela / estado                                                 | Conta    | Resultado |
| ------------------------------------------------------------- | -------- | --------- |
| `/entrar` (e com erro "E-mail ou senha incorretos")           | —        |           |
| `/cadastro` (e com erros nos campos)                          | —        |           |
| `/meus-tickets` (com tickets e vazia)                         | cliente  |           |
| `/tickets/novo` (e com erros)                                 | cliente  |           |
| `/tickets/:id` visão do cliente                               | cliente  |           |
| `/tickets/:id` visão do agente (com nota interna)             | agente   |           |
| `/tickets/:id` visão do admin (campo Responsável)             | admin    |           |
| `/fila` (com filtros e com "Nenhum ticket com esses filtros") | agente   |           |
| `/admin/agentes`                                              | admin    |           |
| `/admin/sla`                                                  | admin    |           |
| `/qualquer-coisa` (Página não encontrada) e `/tickets/123`    | qualquer |           |
| `/admin/sla` como agente (Sem acesso)                         | agente   |           |
| API parada → "Tentar de novo"                                 | qualquer |           |

## 3. Teclado (só Tab, Shift+Tab, Enter, Espaço, setas, Esc)

| #   | Verificação                                                                                                        | Critério      | Resultado |
| --- | ------------------------------------------------------------------------------------------------------------------ | ------------- | --------- |
| K1  | Logado, o 1º Tab mostra "Ir para o conteúdo"; Enter leva o foco ao conteúdo                                        | 2.4.1         |           |
| K2  | Todo elemento focado tem anel visível, inclusive o botão azul e a chave de disponibilidade                         | 2.4.7, 1.4.11 |           |
| K3  | Ordem do Tab segue a leitura em todas as telas (cabeçalho → conteúdo → paginação)                                  | 2.4.3         |           |
| K4  | Ao trocar de tela pelo menu, o foco vai ao título (h1) e a aba do navegador muda de nome                           | 2.4.2, 2.4.3  |           |
| K5  | Enviar formulário vazio leva o foco ao 1º campo com erro (entrar, cadastro, novo ticket, criar agente, SLA)        | 3.3.1         |           |
| K6  | **Login com senha errada:** depois de "E-mail ou senha incorretos", onde fica o foco? Dê Tab e anote para onde vai | 2.4.3 (H1)    |           |
| K7  | **Comentário com erro do servidor** (API parada após abrir o ticket): onde fica o foco depois do erro?             | 2.4.3 (H1)    |           |
| K8  | Fila: filtros mudam com setas no select sem perder o foco; "Próxima página" leva o foco ao início da lista         | 2.1.1, 2.4.3  |           |
| K9  | Ticket: botões de status funcionam com Enter/Espaço; depois, o foco vai a "Status: …"                              | 2.1.1         |           |
| K10 | Chave de disponibilidade alterna com Espaço e Enter                                                                | 2.1.1         |           |
| K11 | Nenhuma armadilha de foco (Tab sempre sai de qualquer campo)                                                       | 2.1.2         |           |

## 4. Zoom e espaçamento

| #   | Verificação                                                                                               | Critério | Resultado |
| --- | --------------------------------------------------------------------------------------------------------- | -------- | --------- |
| Z1  | Zoom 200%: nada cortado ou sobreposto em todas as telas                                                   | 1.4.4    |           |
| Z2  | Zoom 400% (≈ 320 px): sem rolagem horizontal da página; tabelas rolando dentro do próprio quadro é aceito | 1.4.10   |           |
| Z3  | Cabeçalho a 400%: menu, nome, chave e "Sair" quebram linha sem sumir                                      | 1.4.10   |           |
| Z4  | Espaçamento de texto aumentado (bookmarklet "Text Spacing" de Steve Faulkner): nada cortado               | 1.4.12   |           |
| Z5  | Alvos de toque: a caixa "Nota interna" (20 px) tem o rótulo clicável junto                                | 2.5.8    |           |

## 5. Leitor de tela (NVDA + Chrome)

Anote o que foi **dito** quando divergir do esperado.

| #   | Passo                                                                                                                                                                                                                                         | Esperado                                                                                                     | Resultado                                      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| S1  | Abrir `/entrar`                                                                                                                                                                                                                               | "Entrar                                                                                                      | Support Flow" (aba) e "Entrar, título nível 1" |     |
| S2  | Tab pelos campos                                                                                                                                                                                                                              | "E-mail, editar"; "Senha, editar protegido"; "Mostrar senha, botão"                                          |                                                |
| S3  | Enviar vazio                                                                                                                                                                                                                                  | Foco em "E-mail, editar, inválido, Informe seu e-mail."                                                      |                                                |
| S4  | Senha errada                                                                                                                                                                                                                                  | "E-mail ou senha incorretos." lido sem mover o foco à mão                                                    |                                                |
| S5  | Sessão expirada: logado, apagar o cookie da sessão em DevTools → Application → Cookies **sem recarregar**; esperar 15 min (validade do token de acesso) e trocar de tela. Recarregar a página não serve: volta como "não logado", sem o aviso | Ao chegar em `/entrar`, ouvir "Sua sessão expirou…" (H2)                                                     |                                                |
| S6  | Navegar pelo menu (cliente → Meus tickets)                                                                                                                                                                                                    | Título lido; região "Principal" encontrada com D                                                             |                                                |
| S7  | Lista: T para a tabela, Ctrl+Alt+→ pelas células                                                                                                                                                                                              | Cabeçalhos lidos com cada célula ("Status, Aberto")                                                          |                                                |
| S8  | Fila: trocar o filtro de Status                                                                                                                                                                                                               | "N tickets" anunciado sem mover o foco                                                                       |                                                |
| S9  | Fila: "Próxima página"                                                                                                                                                                                                                        | Anuncia o novo conteúdo; anote o que é lido (H3)                                                             |                                                |
| S10 | Fila: selo de SLA em uma linha                                                                                                                                                                                                                | Texto completo (ex.: "1ª resposta: Em risco, vence em …") sem os símbolos ●▲✕                                |                                                |
| S11 | Ticket (agente): selo passando para Violado com a tela aberta (prazo de 1 min do passo 0.3)                                                                                                                                                   | "Primeira resposta: o prazo foi violado." **uma vez**                                                        |                                                |
| S12 | Ticket: botão de transição                                                                                                                                                                                                                    | "Status alterado para …" anunciado; foco em "Status: …"                                                      |                                                |
| S13 | Ticket: enviar comentário                                                                                                                                                                                                                     | "Atualizando o ticket…" e depois "Seu comentário foi enviado."                                               |                                                |
| S14 | Ticket (agente): marcar "Nota interna"                                                                                                                                                                                                        | Caixa "Nota interna (o cliente não vê), caixa de seleção, marcada"; o campo passa a se chamar "Nota interna" |                                                |
| S15 | Lista de comentários                                                                                                                                                                                                                          | A nota interna é identificada em voz ("Nota interna"), não só pela borda                                     |                                                |
| S16 | Agente: chave de disponibilidade                                                                                                                                                                                                              | Nome, papel e estado; **anote o nome exato** (H4)                                                            |                                                |
| S17 | Agente indisponível                                                                                                                                                                                                                           | Faixa "Você está indisponível…" encontrada na leitura do conteúdo                                            |                                                |
| S18 | Admin: criar agente                                                                                                                                                                                                                           | "Agente X criado. Ele começa indisponível." anunciado                                                        |                                                |
| S19 | Admin SLA: Insert+F7 → campos                                                                                                                                                                                                                 | Anote se os 4 pares "1ª resposta (minutos)" são distinguíveis (H5)                                           |                                                |
| S20 | API parada → ação qualquer                                                                                                                                                                                                                    | "O sistema está ocupado. Tentando de novo…" anunciado uma vez                                                |                                                |

## Hipóteses levantadas pela leitura do código (confirmar acima)

- **H1 — foco perdido após erro do servidor.** Os botões de envio ficam `disabled` durante o
  envio; o Chrome tira o foco de um elemento que é desativado, e ele vai para o `<body>`. Em
  erro de servidor sem campo inválido (login 401, comentário, transição), nada devolve o foco.
  O aviso é lido (`role="alert"`), mas o próximo Tab recomeça do topo. (K6, K7)
- **H2 — aviso de sessão expirada pode não ser lido.** `FormAlert` nasce já com texto junto com
  a tela; leitores costumam ignorar `role="alert"` presente no carregamento. O foco no h1 e a
  leitura sequencial ainda o alcançam logo depois. (S5)
- **H3 — "Próxima página" foca uma `div` sem nome nem papel.** O NVDA pode ler a lista inteira ou
  nada. (S9)
- **H4 — nome da chave de disponibilidade (2.5.3).** `aria-label="Disponível para receber
tickets"` substitui o texto visível; quando a tela mostra "Indisponível", o nome não contém o
  texto visível (problema para quem usa comando de voz: "clicar Indisponível"). (S16)
- **H5 — campos do SLA repetidos.** Os 4 formulários têm os mesmos rótulos; na lista de campos
  do leitor não se sabe de qual prioridade é cada um (2.4.6). (S19)
- **H6 — `aria-current="page"` num `<span>` da paginação.** Inócuo, mas não tem efeito: só
  vale em item de um conjunto de links. Ajuste cosmético.

## Resultado

Teste manual em 2026-11-12, Chrome, versão resumida do roteiro (sem varredura axe/Lighthouse):

- Teclado: o foco visível acompanha o elemento em uso em login, ticket, status e comentário. ✅
- Leitor de tela (Narrador): descrições corretas no mesmo percurso. ✅
- Zoom 400%: nada cortado ou encoberto. ✅

| Achado                                              | Critério | Severidade                                                                                                                   | Decisão                                                                                 |
| --------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| H1 foco após erro do servidor                       | 2.4.3    | baixa: não reproduzido no login (Tab após o erro ficou no campo E-mail); comentário/transição com servidor fora não testados | aceito                                                                                  |
| H4 nome da chave sem o texto visível "Indisponível" | 2.5.3    | baixa (comando de voz)                                                                                                       | corrigido: texto fixo "Disponível"; estado no ícone, na cor, no aria-checked e na faixa |
| H5 rótulos repetidos nos 4 formulários de SLA       | 2.4.6    | baixa                                                                                                                        | corrigido: cada formulário nomeado pelo seu h2                                          |
| H6 `aria-current` sem efeito na paginação           | —        | cosmética                                                                                                                    | corrigido: removido                                                                     |
