# PJe IA — Extensão Chrome

> **Mudança de frontend? Leia `DESIGN.md` (raiz do repo) ANTES.** Ele é a fonte
> de verdade do visual — cores, tipografia, escala, raios, sombras e o
> comportamento dos componentes —, derivado do sistema desenhado no Claude
> Design. Valor novo no CSS entra primeiro como token lá, depois no código.

Extensão Chrome (Manifest V3, JavaScript puro, **sem build step**) que adiciona um painel
de chat com IA à tela de autos digitais do PJe. O usuário seleciona peças do
processo e conversa sobre elas; os PDFs são enviados diretamente à API do provedor do
modelo escolhido — **Anthropic (Claude)**, **Google (Gemini)** ou **OpenAI (GPT)**, ver as
seções "Provedor Gemini" e "Provedor OpenAI".

## Arquitetura

**Multi-PJe (default-on)**: `content_scripts`, `host_permissions` e
`web_accessible_resources` cobrem `https://*.jus.br/*` — qualquer tribunal
funciona sem nenhuma ação do usuário (decisão de produto: zero fricção; o
aviso de permissão do Chrome fica mais amplo, aceito). Como o script roda em
TODA página jus.br (login SSO, portais…), o boot do painel em `content.js`
vive em `iniciar()`, chamada só quando `#divTimeLine` existe (ou surge — SPA
do PJe novo) — sem timeline, nada é injetado no DOM. O grau e o base path
variam por tribunal (`pje.tjce.jus.br/pje1grau`, `pje1g.trf5.jus.br/pje`…):
`pje.js` deriva o base path da URL (`getBase`). `DOMINIOS_JURIDICOS` ganha o
domínio-raiz do tribunal atual em runtime (busca de jurisprudência).

Content scripts injetados nesta ordem
(cada um é um IIFE que expõe um global — não há imports entre content scripts):

| Arquivo | Global | Papel |
|---|---|---|
| `src/pje.js` | `PJE` | Acesso ao PJe: lista peças da timeline (`#divTimeLine`), baixa cada uma pelo endpoint REST autenticado por cookie de sessão. |
| `src/caso.js` | `CASO` | Cliente RPC da memória de caso (o banco vive no worker, `casodb.js`). Toda função devolve valor NEUTRO em vez de lançar. Ver "Memória de caso". |
| `src/prompts.js` | `PLIB` | Biblioteca de prompts do usuário: CRUD sobre `chrome.storage.sync` (um item por prompt, `plib:<id>`) + `aoMudar` para propagação entre abas/dispositivos. |
| `src/docx-importar.js` | `DocxImport` | Leitor de `.docx` sem biblioteca (ZIP à mão + `DecompressionStream` + `DOMParser` sobre `word/document.xml`) e leitura em LOTE. Ver "Importar peças-modelo de .docx". |
| `src/panel.js` | `PjePanel` | Toda a UI (chat, seletor de peças, chips, popups `@` e `/`, card de progresso), isolada em **Shadow DOM**. CSS carregado de `src/panel.css` via `web_accessible_resources`. |
| `src/content.js` | — | Orquestração: downloads com concorrência 3, cache por peça, montagem dos blocos da API, conversa multi-turno, streaming via `Port`. |

O worker (`src/background.js` + `src/claude.js`, ES modules) guarda a chave da API e faz o
streaming SSE — **a chave nunca chega ao contexto da página**. Dois canais content↔worker:

- **Port** `chrome.runtime.connect({name:"claude"})` para os turnos (streaming). Tipos
  content→worker: só `chat`; worker→content: `delta`, `thinking`, `citation`,
  `tool`, `trunc`, `iter` (início de request físico — checkpoint da UI),
  `retry` (re-tentativa transitória — a UI reverte ao checkpoint para não duplicar
  texto/citações), `done {content, stopReason}`, `error`. **AUTO-RESUME**: se a porta
  cair SEM `done`/`error` (worker MV3 morto no meio do turno — acontece mesmo com
  keepalive), `stream()` em content.js reconecta e REENVIA o payload sozinho (até 2
  vezes; o turno é stateless e o prefixo está no cache de prompt). O handler
  `onReinicio` zera TODO o estado de UI do turno (o novo stream re-emite do zero).
  Não transformar esse reenvio em erro imediato (regra do turno longo em geral).
- **`chrome.runtime.sendMessage`** (request/response) para `caps` (capacidades do
  modelo — a resposta traz `{model, effort, caps}`; model+effort alimentam o SELO do
  modelo ativo `panel.setModelo` na barra de ferramentas, atualizado ao vivo pelo
  `storage.onChanged` inclusive na troca de `effort`), `upload` (Files API) e
  `countTokens` (pré-voo gratuito).

## Fluxo de um turno (protocolo v2)

`claude.js` acumula os **blocos completos** da resposta a partir do SSE (padrão dos SDKs:
`content_block_start/delta/stop`, incluindo `signature_delta` do thinking, `citations_delta`
e `input_json_delta`) e emite `{kind:"final", content, stopReason, containerId}`.
`background.js` resolve sozinho as continuações de **`pause_turn`** (reenvia
`messages + [{role:"assistant", content: parcial}]`; teto fixo `MAX_ITER` = 8) — o
content script enxerga um único turno lógico. **Erros transitórios re-tentam sozinhos**:
cada request físico ganha até 2 re-tentativas com backoff (429 espera 10 s) quando o
erro é 429/529/5xx ou queda de rede no meio do SSE (flag `retryable` posta pelo
`claude.js`). `max_tokens` é 32000 (OBRIGATÓRIO na Anthropic; 32K é o teto de saída
aceito por todos os modelos Claude).

`MODEL_CAPS` em `background.js` governa por modelo: `provider` (anthropic|gemini|openai),
`contextTokens`, `maxPages` (600 nos modelos de 1M; 100 no Haiku; 1000 no Gemini; 500 nos GPT),
versões de `web_search`/`web_fetch` (variantes `_20260209` no Sonnet 5/Opus 4.8;
básicas no Fable/Haiku), `thinking` (adaptive+summarized; omitido no Haiku) e `effort`
(não suportado no Haiku; no Gemini vira `thinking_level`). Entradas Gemini têm ainda
`citacoesNativas:false`, `tokensPagina:258` e `preco.cacheRead`.

## Provedor Gemini (Interactions API)

`src/gemini.js` é o irmão de `claude.js` (que fica INTOCADO): emite o MESMO vocabulário
de eventos (`{kind:"text"|"thinking"|"citation"|"tool"|"trunc"|"final"}`) a partir do SSE
da **Interactions API** (`POST /v1beta/interactions`, header `x-goog-api-key` +
`Api-Revision: 2026-05-20`; eventos `step.start`/`step.delta`/`interaction.completed`).
`background.js` despacha por `providerDe(model)` (prefixo `gemini-`); `content.js` e
`panel.js` só condicionam por **caps**, nunca por nome de modelo. Regras que NÃO podem
quebrar:

- **Modo stateless obrigatório** (`store:false`): o histórico interno continua nos
  blocos estilo Anthropic (com `__pecaId`) e `traduzirHistorico` em gemini.js converte
  NO REQUEST — o filtro de peças desmarcadas (`prepararEnvio`) funciona igual nos dois
  provedores. NUNCA enviar `temperature/top_p/top_k` nem terminar o `input` com turno
  do modelo (prefill → 400).
- **Wrapper `x-gemini-item`**: todo step do Gemini que não seja texto puro sem
  assinatura (thought assinado, `google_search_call/result`, texto com
  `thought_signature`) é gravado no histórico como `{type:"x-gemini-item", raw: step}`
  e devolvido VERBATIM no reenvio — thought signatures precisam voltar byte a byte
  (regra análoga ao thinking assinado da Anthropic). `sanearCitacoes`/`prepararEnvio`
  não tocam nesses blocos por construção.
- **Step de busca OCO nunca volta ao histórico, e os de busca são TUDO OU NADA**
  (`ehStepDeBuscaOco`/`stepsParaBlocos`): quando o `interaction.completed` não traz
  os steps, o fallback são os acumulados do `step.start`, que são ESQUELETOS
  (`{id, signature:"", type}` — os deltas preenchem texto e a assinatura do
  thought, nunca as `queries` nem os resultados). Reenviar essa casca é o que
  fazia o 2º turno devolver **400 de corpo vazio**, e como os steps ficam no
  histórico para sempre, desligar a Jurisprudência depois não adiantava — só
  "Nova conversa". Duas armadilhas na guarda: (a) as queries da chamada vivem em
  **`arguments.queries`** (é de lá que o `step.start` as lê para o status), então
  olhar só `s.queries` marcava uma chamada COMPLETA como oca e a jogava fora;
  (b) a decisão é por TURNO, não por step — um `google_search_result` sem o
  `call` que o produziu é um par quebrado, isto é, request malformado do mesmo
  jeito. Cobertos por teste com SSE simulado (fetch fake).
- **`model_output` só é achatado em bloco `text` se for REALMENTE puro**: sem
  `signature`, sem `thought_signature`, **sem `annotations`** (com
  `google_search` é nelas que vêm as `url_citation` da bolha) e com
  `content.length > 0` — `[].every()` é `true` por vacuidade, e um conteúdo
  vazio passava por "texto puro" e sumia do histórico.
- **NÃO logar o `body` do request no console** (gemini.js): durante o diagnóstico
  do 400 ele foi despejado inteiro para ser reproduzido byte a byte — certo ali,
  errado num pacote publicado (carrega trecho dos autos e o base64 das peças que
  não subiram à Files API, e fica retido enquanto o DevTools estiver aberto). O
  que ficou é a linha de FORMA (tipos dos itens + KB), e o corpo é serializado
  UMA vez e reusado no `fetch` — `JSON.stringify` duplicado custa caro de verdade
  no caminho de fallback base64.
- **Erro HTTP: ler o corpo como TEXTO uma vez e só depois `JSON.parse`**
  (`friendlyHttpErrorGemini`). O corpo de uma `Response` só pode ser consumido
  UMA vez: `resp.json()` com `resp.text()` no catch lança "body stream already
  read" e engole justamente o caso não-JSON que o fallback existia para cobrir.
  O Google devolve o erro em DUAS formas — `{error:{message}}` e o ARRAY
  `[{error:{message}}]`; sem tratar a segunda o usuário via só "Erro da API do
  Google (400)".
- **usage normalizado** para as 4 categorias da Anthropic em gemini.js
  (`input = total_input − total_cached`; `cache_read = total_cached`;
  `cache_creation = 0`; `output` inclui thoughts) — custo, tooltip e gauge funcionam
  sem mudança. `custoUsdDe` usa `preco.cacheRead` quando existe (senão 0,1× o input,
  regra Anthropic inalterada).
- **Uploads por provedor**: a File API do Google EXPIRA em 48 h — o cache de sessão usa
  namespace `gfile:` com `{uri, exp}` validado na leitura (vencido re-sobe), e cada peça
  em `docsCache` guarda `d.fileProvider`: um `file_id` da Anthropic nunca entra num
  request Gemini (e vice-versa; `montarBlocos`/`subirPecas` conferem). PDF Gemini:
  ≤ 50 MB/1000 págs., 258 tokens/pág. Upload é resumable + poll de `state:ACTIVE`.
- **Sem citações por página no Gemini** (`citacoesNativas:false`): o system prompt
  alternativo (`SYSTEM_PROMPT_CIT_TEXTUAL` em content.js) manda citar peça e folha no
  próprio texto; `panel.setModoCitacoes("textual")` mostra o `ⓘ` (`.cite-note`)
  ao lado do selo do modelo — a nota é sobre o modelo ativo, e como parágrafo
  fixo no rodapé ela custava duas linhas em toda conversa.
  Annotations `url_citation` da busca viram citações web normais
  (`web_search_result_location`).
- **Paridade de recursos com o Gemini**: minutar (editor) e o mapa mental são chats
  comuns — sem skill, sem code execution —, então funcionam nos DOIS provedores. A
  única capacidade condicionada por caps é a citação nativa por página
  (`citacoesNativas`); nenhum recurso da UI é gated por nome de modelo.
- **Busca**: toggle Jurisprudência no Gemini declara `[{type:"google_search"}]` — a tool
  não aceita parâmetro NENHUM (a doc da Interactions API não expõe `allowed_domains` nem
  filtro por site), então este é o ÚNICO dos três provedores em que a priorização de
  fontes .jus.br depende só de instrução no system prompt — garantia mole, que o modelo
  pode ignorar. Custo: nos modelos **Gemini 3.x a cobrança é POR QUERY EXECUTADA**, não
  por prompt (era por prompt no 2.5), e o modelo dispara várias buscas num mesmo turno —
  o custo de um turno com Jurisprudência ligada é múltiplo do preço unitário. Os valores
  antes anotados aqui (5.000 buscas/mês grátis, depois US$ 14/1.000) não constam da
  página de docs, que remete à tabela de preços: reconferir antes de usar em cálculo.
- **Troca de provedor no meio da conversa é BLOQUEADA** (`conversaProvider` em
  content.js): o histórico de um provedor não roda no outro (raciocínio assinado).
  `aplicarCapsNaUI` liga `ALERTA_TROCA_PROVEDOR` na troca do modelo e o envio tem
  guarda dura; "Nova conversa" (ou voltar ao modelo anterior) resolve.
- **Sem pause_turn no Gemini**: o loop de continuações de `executarTurno` sai na 1ª
  iteração; retry transitório (429/5xx, `err.retryable`) funciona igual. Stream que
  termina SEM `interaction.completed` (queda "limpa" de conexão) e status
  `failed/cancelled` LANÇAM erro retryable — resposta parcial nunca passa por
  completa.
- **Teto de saída no Gemini: `generation_config.max_output_tokens = 65536` SEMPRE
  explícito** (invariante testado) — o máximo dos dois modelos, para a resposta
  nunca ser cortada por um default menor. O campo não aparece nas páginas de docs,
  mas é o que o AI Studio gera nos exemplos oficiais da Interactions API (fonte da
  confirmação, 2026-07). NUNCA repassar o `req.max_tokens` de 32000 do caminho
  Anthropic — cortaria o teto pela metade. O `max_tokens` de 32000 continua correto
  na Anthropic (parâmetro OBRIGATÓRIO lá; 32K é o valor aceito por todos os
  modelos Claude). Cache: só
  implicit caching (automático) — `cache_control` não é gravado nos blocos quando o
  provedor é gemini (e gemini.js nem copiaria o campo).
- **Config**: chave em `chrome.storage.local.geminiApiKey` (a `apiKey` continua sendo a
  da Anthropic); `chaveDe(cfg, provider)` escolhe e dá erro claro. popup/options têm os
  DOIS campos e uma lista única de modelos com `<optgroup>`; o chip e o `refreshKey`
  olham a chave do provedor do modelo selecionado. `manifest.json` inclui
  `https://generativelanguage.googleapis.com/*`.
- countTokens Gemini: `POST /models/{model}:countTokens` com `contents` traduzidos
  (file_data/inline_data/texto; steps opacos viram texto) — aproximação aceitável, a
  guarda de 90% e o `usageReq` pós-turno corrigem.

## Provedor OpenAI (Responses API)

`src/openai.js` é o TERCEIRO irmão de `claude.js` (INTOCADO) e `gemini.js`: emite o MESMO
vocabulário de eventos (`{kind:"text"|"thinking"|"citation"|"tool"|"trunc"|"final"}`) a
partir do SSE da **Responses API** (`POST /v1/responses`, header `Authorization: Bearer`;
GA, **sem header beta** — a API antiga `/chat/completions` NÃO é usada). `background.js`
despacha por `providerDe(model)` (prefixo `gpt-`); `content.js` e `panel.js` só condicionam
por **caps**, nunca por nome de modelo. Modelos: `gpt-5.6-sol` (topo, alias "GPT-5.6"),
`gpt-5.6-terra` (equilibrado), `gpt-5.6-luna` (rápido/barato) — todos 1,05M de contexto.
Regras que NÃO podem quebrar:

- **Modo stateless obrigatório** (`store:false`): o histórico interno continua nos blocos
  estilo Anthropic (com `__pecaId`) e `traduzirHistorico` em openai.js converte NO REQUEST —
  o filtro de peças desmarcadas (`prepararEnvio`) funciona igual nos três provedores. O
  system prompt vai em `instructions` (nível superior), NÃO no `input`.
- **Itens de raciocínio criptografados**: cada item `{type:"reasoning", id, encrypted_content}`
  da resposta é gravado no histórico como `{type:"x-openai-item", raw: item}` e devolvido
  VERBATIM no reenvio — reasoning criptografado precisa voltar byte a byte (regra análoga ao
  thinking assinado da Anthropic e ao `thought_signature` do Gemini). O request declara
  `include:["reasoning.encrypted_content"]` (para o conteúdo voltar no stateless) e
  `reasoning:{effort, summary:"auto", context:"all_turns"}`. `sanearCitacoes`/`prepararEnvio`
  não tocam nesses blocos por construção. A ordem `[reasoning, message]` é preservada na
  tradução — a API exige que um item reasoning seja seguido pelo item que ele produziu.
- **effort** (o eixo que o usuário pediu para conferir): a escala da OpenAI é a MAIS RICA —
  `none|minimal|low|medium|high|xhigh|max` (+ um eixo separado `reasoning.mode`
  standard|pro|ultra). O suporte a `xhigh`/`max` é dependente da variante e não documentado
  por modelo (Luna/Terra podem rejeitar com 400). `EFFORT_PARA_OPENAI` em background.js mapeia
  os três níveis da extensão para o subconjunto COMUM `low/medium/high` (aceito por todos os
  provedores e todas as variantes 5.6); expor `xhigh`/`max` seria só aqui, provavelmente só no
  Sol. Anthropic/Gemini/OpenAI compartilham low/medium/high.
- **usage normalizado** para as 4 categorias da Anthropic em openai.js
  (`input = input_tokens − cached`; `cache_read = input_tokens_details.cached_tokens`;
  `cache_creation = 0`; `output = output_tokens`, que já inclui os tokens de raciocínio) —
  custo, tooltip e gauge funcionam sem mudança. `custoUsdDe` usa `preco.cacheRead` (10% do
  input; cache automático, sem cobrança de gravação).
- **Uploads por provedor**: a Files API da OpenAI (`POST /v1/files`, `purpose:"user_data"`)
  devolve um `file_id` que persiste na conta (não expira por padrão) — o cache de sessão usa
  namespace `ofile:` (sem validação de expiração, ao contrário do `gfile:` do Gemini), e cada
  peça em `docsCache` guarda `d.fileProvider`: um `file_id` da OpenAI nunca entra num request
  Anthropic/Gemini (e vice-versa; `montarBlocos`/`subirPecas` conferem). PDF: ≤ 50 MB/arquivo
  e ≤ 50 MB somados por request; fallback base64 com teto `MAX_TOTAL_B64_CHARS_OPENAI` (40 MB).
- **Sem citações por página na OpenAI** (`citacoesNativas:false`, igual ao Gemini): o system
  prompt alternativo (`SYSTEM_PROMPT_CIT_TEXTUAL`) manda citar peça e folha no próprio texto;
  `panel.setModoCitacoes("textual")` mostra o `ⓘ`. Annotations `url_citation` da busca viram
  citações web normais (`web_search_result_location`), ao vivo pelo evento
  `response.output_text.annotation.added`; `file_citation` é ignorada (sem página).
- **Busca**: toggle Jurisprudência na OpenAI declara `[{type:"web_search"}]` — a tool
  embutida da Responses API. Não voltar ao `web_search_preview`: é LEGADO e não aceita
  `filters` (nem `external_web_access`/`return_token_budget`). Aqui a restrição de
  domínios EXISTE, ao contrário do Gemini — e vai em **`filters.allowed_domains`**
  (aninhado), não no topo do objeto como na Anthropic. Trocar o lugar não dá erro
  amigável: ou 400 de campo extra, ou o filtro é ignorado em silêncio e a busca varre a
  web inteira, devolvendo blog no lugar de fonte oficial. Teto de 100 domínios e nomes
  **sem protocolo** (`stf.jus.br`, nunca `https://stf.jus.br/`).
- **Troca de provedor no meio da conversa é BLOQUEADA** (`conversaProvider`): o histórico de
  um provedor não roda no outro (raciocínio assinado/criptografado). `ALERTA_TROCA_PROVEDOR`
  cobre os três; "Nova conversa" resolve.
- **Sem pause_turn na OpenAI**: o loop de continuações de `executarTurno` sai na 1ª iteração;
  retry transitório (429/5xx, `err.retryable`) funciona igual. Stream que termina SEM
  `response.completed`/`response.incomplete`, ou eventos `response.failed`/`error`, LANÇAM erro
  retryable — resposta parcial nunca passa por completa. `response.incomplete` com
  `reason:max_output_tokens` vira `trunc` + stopReason `max_tokens`; recusa (`content_filter`
  ou content-part `refusal`) vira `refusal`.
- **Teto de saída na OpenAI: `max_output_tokens = 65536` SEMPRE explícito** — generoso (folga
  enorme para minuta + resumo de raciocínio; o máximo dos 5.6 é 128.000) e limitado para custo
  previsível. NUNCA repassar o `req.max_tokens` de 32000 do caminho Anthropic. Cache: só
  automático (implicit) — `cache_control` não é gravado nos blocos quando o provedor não é
  anthropic (`montarBlocos` só marca o breakpoint no Anthropic).
- **Config**: chave em `chrome.storage.local.openaiApiKey` (Anthropic = `apiKey`, Gemini =
  `geminiApiKey`); `chaveDe(cfg, provider)` escolhe e dá erro claro. popup/options têm os TRÊS
  campos e uma lista única de modelos com `<optgroup>`; o chip e o `refreshKey` olham a chave do
  provedor do modelo selecionado. `manifest.json` inclui `https://api.openai.com/*`.
- countTokens OpenAI: `POST /v1/responses/input_tokens` (mesmo corpo do `/responses`) →
  `{input_tokens}` — endpoint dedicado e exato (conta arquivos/imagens/tools), análogo ao
  count_tokens da Anthropic. A guarda de 90% fica precisa.

## Prioridade das fontes na busca web (os três provedores)

As fontes da busca vivem em **três degraus** (`content.js`): `FONTES_SUPERIORES`
(STF, STJ) → `FONTES_TRIBUNAL` (o tribunal deste processo, derivado da URL) →
`FONTES_DEMAIS`. Num parecer "o STJ decidiu" e "um blog noticiou" não pesam igual,
e até a v0.23 as dez fontes eram tratadas como equivalentes.

- **A união dos degraus é o `allowed_domains`; a ORDEM é o `PROMPT_BUSCA`.**
  `allowed_domains` é binário (dentro/fora) e nenhuma das três APIs tem parâmetro
  de ranking — só o prompt expressa prioridade. Por isso `PROMPT_BUSCA` é um
  trecho próprio, concatenado nos **DOIS** system prompts: antes disso a instrução
  de busca existia só no `SYSTEM_PROMPT_CIT_TEXTUAL` e o caminho **Anthropic não
  tinha instrução nenhuma** sobre fontes.
- **`TRIBUNAL_DO_PROCESSO` é derivado no TOPO do IIFE**, não junto da lista de
  domínios: o `PROMPT_BUSCA` o consome ~150 linhas antes, e declará-lo depois
  lançaria `Cannot access before initialization` na montagem (a zona morta
  temporal descrita em "Desenvolvimento e teste").
- **`tjce.jus.br` deixou de ser hardcoded**: entra pelo 2º degrau quando o processo
  é do TJCE. Num processo do TRF5, jurisprudência do TJCE é ruído.
- **A garantia é desigual por provedor, e isso é estrutural**: Anthropic e OpenAI
  aplicam a allowlist no servidor (garantia dura); o Gemini não tem o recurso e
  depende só da instrução (garantia mole). Medido em smoke test real: com o
  `PROMPT_BUSCA` em degraus o Gemini passou a emitir queries com `site stj jus br`,
  mas ainda citou `tjro.jus.br` num processo do TJCE. **Não tentar "consertar" isso
  na API** — não há como; o que existe é tornar o vazamento VISÍVEL na bolha.
- **O host da fonte nem sempre sai da URL** (`hostDaFonte`): o Gemini devolve um
  redirecionador opaco (`vertexaisearch.cloud.google.com/grounding-api-redirect/…`)
  e põe o domínio verdadeiro no `title`. Sem essa resolução o rodapé anunciaria
  "google.com" numa resposta cuja fonte é o STJ, e todo nível cairia em "outra". O
  `title` só vira host quando ELE é um domínio — na Anthropic e na OpenAI o title é
  a manchete da página, e usá-lo ali seria inventar origem.
- **Peça dos autos e fonte da web são grupos SEPARADOS no rodapé da bolha**
  (`updateAssistant`): uma é prova no processo, a outra é página da internet, e
  misturá-las apagava a fronteira que mais importa juridicamente. O número do
  rodapé é o MESMO do sobrescrito no texto (placeholder PUA → `<sup>`), então o
  agrupamento **não reordena nada** — mexer na ordem quebraria a correspondência
  entre a marca na frase e a linha da fonte.

## Invariantes importantes

- **Assistant no histórico é SEMPRE array de blocos** (`response.content` completo), nunca
  string: a API exige thinking assinado intacto e os blocos de ferramenta/citações nos
  turnos seguintes. Em fallback (sem blocos), texto puro com os placeholders de citação
  removidos. **Citações NUNCA voltam à API**: a resposta traz campos que o request
  rejeita (`file_id` em `page_location` → 400 "Extra inputs are not permitted") e,
  pior, a API revalida os `document_index` contra o layout do request atual — com o
  anexo incremental essa revalidação falha (400 "Invalid citation indices: Document
  not found for placeholder citation", sempre na 2ª mensagem). Por isso o campo
  `citations` é REMOVIDO dos blocos de texto do assistant antes de qualquer reenvio:
  `sanearCitacoes` (content.js) ao gravar no histórico e `stripCitacoes`
  (background.js) nas continuações `pause_turn`. A UI mantém as citações
  renderizadas do turno; o modelo segue vendo o texto integral.
- **Um só tipo de request** (não há mais o caminho de skill/`.docx`): *chat/busca* —
  documentos + citações + web tools quando o toggle "Jurisprudência" está ligado. Uma
  vez usadas na conversa, as web tools seguem declaradas nos turnos seguintes mesmo com
  o toggle desligado (`buscaNaConversa`): trocar o conjunto de tools invalidaria o cache
  de prefixo e arriscaria rejeição do histórico com blocos de ferramenta. Minuta e mapa
  são o MESMO tipo de request de chat, apenas isolados (não entram em `conversation`).
  As versões `_20260209` dos web tools já embutem execução de código — **nunca** declare
  `code_execution` junto delas.
- **Peças vão por `file_id` (Files API)**: upload único pelo worker com cache em
  `chrome.storage.session` (chave `idProcesso:idPeca:tamanho`); beta
  `files-api-2025-04-14` em todos os requests de chat. Base64 inline é só fallback de
  upload (aí vale o teto `MAX_TOTAL_B64_CHARS` de 24 MB).
- **O upload é PIPELINADO ao download** (bomba dentro de `baixarSelecionadas`): cada
  peça começa a subir assim que ELA baixa, em vez de esperar a fila inteira — o turno
  passa de `Σdownload + Σupload` para `Σdownload + o upload da última`. A bomba mora
  ali, e não no handler de envio, porque existem TRÊS pares baixar→subir idênticos
  (chat, minuta e mapa): assim os três ganham o pipeline sem mudar os call sites.
  Invariantes que não podem cair:
  - **UM LOTE POR VEZ** (flag `bombeando`). O cache de upload do worker é
    read-then-write: duas chamadas simultâneas com a mesma `cacheKey` erram o cache
    as duas e sobem o arquivo duas vezes.
  - **`try/catch` em volta de cada lote.** Uma rejeição não tratada se propagaria
    pelo `await cadeiaUpload` e derrubaria o turno inteiro por causa de um upload — o
    oposto do design, em que falha de upload só devolve a peça ao fallback base64.
  - **`await cadeiaUpload` antes de devolver** `{ok, falhas}`. Sem isso o chamador
    seguiria para o seu próprio `subirPecas` com uploads em voo, e voltaria a corrida.
  - Os `await subirPecas(...)` que ficaram nos call sites viram no-ops para quem
    subiu e uma SEGUNDA tentativa para quem falhou — intencional (429 por rate limit
    costuma passar em segundos); no máximo duas tentativas por peça e por turno.
  - `guardaPaginas` passa a rodar DEPOIS dos uploads. Aceito: os `fileId` ficam em
    `chrome.storage.session` e viram prefetch, `refinarContexto` já subia sem guarda
    de páginas, e `paginasDe` depende do `d.pages` que só existe após o download.
  - `baixarQuieto` (medição de fundo) fica FORA do pipeline: é cancelável por
    `estSeq`/`busy` entre awaits, e uploads em voo depois do cancelamento
    reintroduziriam a corrida sem ninguém para aguardá-los.
- **Pré-voo (`count_tokens`) CONDICIONAL** (`podePularPreVoo`): num turno sem peça
  nova ele é o ÚNICO bloqueio antes do stream, isto é, 100% do tempo percebido entre
  o Enter e o primeiro token. Ele existe para barrar acima de 90% da janela — quando
  o turno anterior deixou uma medição EXATA (`ultimoTotalExato`, o usage do último
  request físico, que vem de graça) e o maior entre ela e a estimativa local fica
  abaixo de `LIMIAR_PULAR_PREVOO` (60% da janela), não há o que barrar. Guardas: sem
  medição exata anterior (1º turno) mede; peça selecionada FORA do cache mede (o que
  não é medido não pode ser dispensado da medição). A guarda de 90% e o tratamento de
  `model_context_window_exceeded` seguem como rede.
- **Guardas de processo grande**: contagem de páginas por heurística no binário do PDF
  (`pje.js`) bloqueia acima de `MODEL_CAPS.maxPages` ANTES do envio; `count_tokens`
  (gratuito) estima o contexto e bloqueia acima de 90% da janela — e recebe as
  MESMAS tools/betas do turno (histórico com blocos de ferramenta exige as tools
  declaradas também no count_tokens, senão o pré-voo falha mudo e o medidor some).
  Tratar também `stop_reason: model_context_window_exceeded`.
- **Citações**: `citations:{enabled:true}` em TODOS os blocos document (regra da API:
  tudo-ou-nada); peças HTML viram document com source text (citáveis por
  `char_location`). No stream, `citations_delta` gera marcadores por **placeholder PUA**
  (`\uE000<n>\uE001` — sempre como escapes ASCII no código, nunca o caractere cru) que
  atravessam o escape-first do `renderMd` e viram `<sup>` só DEPOIS do escape. PDFs
  escaneados sem camada de texto não são citáveis (degradação graciosa).
  `infoCitacao` devolve `{label, id?, url?, trecho?}`: o **id sai como campo
  próprio**, nunca colado no rótulo — é ele que o painel usa para transformar a
  linha do rodapé num botão `.cite-go`, que reusa `onVerNaTimeline` →
  `PJE.scrollAte(id)` (mesmo caminho do botão "ver na timeline" das peças, via
  `irParaPeca`). O handler é DELEGADO no container de mensagens: as bolhas são
  re-renderizadas a cada delta do stream e um listener por linha morreria no
  primeiro token seguinte. O `id` só entra no DOM se casar `^\d+$` (vem do título
  da peça, que é conteúdo dos autos). `char_location` (peças HTML) não tem página:
  a citação leva `trecho` (o `cited_text`) como única âncora. `chaveCitacao` NÃO
  usa o id — a dedup por `document_index` é por turno e está correta.

- **Fonte de verdade da seleção de peças**: os checkboxes de `.doclist` em `panel.js`.
  Chips da barra de contexto, contador `x/y no contexto` (pill no cabeçalho da lista,
  em duas linhas: título+pill+«, depois a busca + o segmented control
  `chave|principais|todas`), popup `@` e mensagens são
  *projeções* desse estado — nunca guarde seleção em outro lugar.
- **DUAS rotas de download, nesta ordem** (`urlsDownload` em pje.js):
  1. **COMPLETA** — `.../download/{TRIBUNAL}/{grau}/{idProcesso}/{idDocumento}`, com a
     sigla derivada do host (o rótulo antes de `jus.br`: `pje.tjce.jus.br` → `TJCE`).
     Serve os **dois tipos** de peça.
  2. **CURTA** — `.../download/{idDocumento}`: existe por retrocompatibilidade e **só
     funciona para PDF**. Em peça HTML o servidor devolve **200 com casca vazia** —
     sem o contexto do processo ele não sabe montar o documento. Era daí que vinha boa
     parte das "peças vazias" que só a ativação resolvia.

  `baixar()` aceita a primeira rota que devolva **corpo ÚTIL** — não basta HTTP 200,
  justamente por causa da casca. Hosts sem sigla clara (`*.cloud.pje.jus.br`) usam só a
  curta.
- **Download do PJe é stateful**: o endpoint REST só libera peças já "abertas" na sessão
  JSF. Quando nenhuma rota devolve corpo útil, `pje.js` simula o clique na timeline (A4J)
  e faz poll com HEAD até liberar, e tenta as rotas de novo. As ativações são
  **serializadas** (`activationChain`) — o JSF não tolera dois submits simultâneos na
  mesma view.
  **O poll sonda a MESMA rota que o download vai usar** — `urlsDownload(id)[0]`, a
  completa. Sondar a curta era um defeito silencioso e caro: ela responde 200 com
  casca vazia em toda peça HTML (decisões, despachos, petições do editor), então
  `probe.ok` ficava verdadeiro no primeiro poll e a ativação DESISTIA em 700 ms em vez
  de esperar os ~5,6 s — e o erro final era "a peça retornou vazia", exatamente a
  falha que a ativação existe para resolver, justamente nas peças que mais importam.
  Com `HEAD` não dá para distinguir casca de conteúdo (não há corpo), então a
  correção é a ROTA, não o critério. A ativação depende de a peça estar NA TIMELINE, o que pode não valer para
  peças que só a grid conhece; a falha dela não interrompe o fluxo. Cada download loga
  `[PJe IA] peça …` no console da página (F12) para diagnóstico.
- **TRÊS formatos de peça** (`lerCorpo`): **PDF** (digitalizados e anexos), **HTML**
  (editor atual) e **RTF** (editor antigo, comum em processos migrados). O tipo é
  decidido pelo content-type E pela **assinatura no binário** (`%PDF-` ou `{\rtf`),
  porque o PJe legado serve os dois como `octet-stream` — confiar só no header mandaria
  RTF/PDF para o ramo de texto. O RTF passa por `rtfParaTexto`, um extrator próprio (sem
  biblioteca): poda os grupos que não são conteúdo (`\fonttbl`, `\colortbl`, `\info`,
  destinos `\*`), resolve `\'XX` pela CP1252 (onde vivem os acentos e o travessão),
  `\uN` com o fallback pulado, e converte `\par`/`\tab`. Sem isso a peça chegava ao
  modelo como `{\rtf1\ansi\deff0{\fonttbl…` — milhares de tokens de marcação e nenhum
  texto legível.
- **O que NÃO é um dos três formatos NUNCA é "lido como texto"** (`IMAGENS`/
  `ASSINATURAS`/`tipoImagem`/`tipoBinario`/`pareceBinario` em `pje.js`): o PJe aceita
  anexo de qualquer tipo — foto de celular, print, .docx, áudio da audiência — e
  `blob.text()` decodifica QUALQUER byte sem reclamar. Sem essa barreira, um JPEG
  anexado chegava ao modelo como `���JFIF…`: milhares de tokens de lixo binário
  no lugar do conteúdo, com o selo da lista dizendo **TEXTO** (caso real: peças
  184100639/184100640). É o mesmo defeito que a assinatura do `%PDF-` já evitava, nos
  formatos que faltavam. Duas camadas de detecção: tabela de assinaturas e, para o
  binário sem assinatura catalogada, densidade de caracteres de **controle C0** > 2%.
  O critério é o controle, e **não** o `U+FFFD`: HTML servido em ISO-8859-1 sem charset
  no header chega com um replacement POR ACENTO (petição → peti�ão) e é texto legítimo
  — barrá-lo derrubaria peças que sempre funcionaram (caso coberto no teste do
  scratchpad). Duas saídas, e a diferença é o que dá para fazer com o arquivo:
  - **IMAGEM (JPEG/PNG/GIF/WebP) vira `{kind:"img"}` e VAI para o modelo como
    imagem** — ver a seção "Anexos em imagem" abaixo. Só os quatro formatos que os
    três provedores aceitam em comum entram aqui; **BMP e TIFF** (que aparecem em
    scanner de cartório) nenhum deles lê, então ficam na lista de recusa — mandar e
    tomar 400 seria pior que dizer o motivo.
  - **O resto é RECUSADO com o motivo** (.docx/.zip, OLE2, áudio/vídeo, formato de
    scanner exótico). `lerCorpo` **lança** em vez de devolver `null`: `null` significa
    "esta rota não serviu" e faria `baixar` gastar a ativação JSF (~5,6 s, serializada)
    para terminar dizendo "a peça retornou vazia", que é falso — ela veio inteira. O
    erro sobe para o relatório de peças que não entraram, no chat.
- **Anexos em imagem vão para o modelo COMO IMAGEM** (`kind:"img"` em `lerCorpo`,
  ramo próprio em `montarBlocos`): o BO fotografado, o print de conversa e o
  comprovante são PROVA, e são o anexo mais comum depois do PDF. Regras:
  - **DOIS blocos por peça, e o de texto não é enfeite**: a Citations API não cita
    imagem (não há página nem trecho), então o rótulo `[Peça anexada como imagem:
    <título>]` é o ÚNICO canal pelo qual o **id** chega ao modelo — a regra
    peça·id·folha vale aqui como nas outras saídas. Os dois blocos levam `__pecaId`:
    desmarcar a peça tem de remover o par inteiro, senão sobra um rótulo anunciando
    um anexo que não foi.
  - **Redimensionada no navegador antes de sair** (`normalizarImagem`, `createImageBitmap`
    + `OffscreenCanvas`, sem biblioteca): teto de 1568px no lado maior (acima disso a
    API reduz do lado dela antes de tokenizar, então mandar maior só gasta payload) e
    ~3,5 MB. Foto de celular tem 4–12 MP: reduzir é o que separa "a peça entra na
    análise" de um 400. Falha na redução **não é fatal** — devolve o blob original e
    quem decide é o teto. As dimensões voltam junto porque é delas que sai a estimativa
    de tokens (`tokensImagem`, largura × altura / 750).
  - **Base64 inline nos três provedores, sem Files API**: imagens são pequenas perto de
    um PDF de autos, e o upload multiplicaria a superfície de erro por três. Cada
    cliente traduz do bloco Anthropic (`{type:"image", source:{type:"base64"}}`) para o
    seu: Gemini → content part `{type:"image", data, mime_type}` (irmão do `document`,
    não uma variante dele); OpenAI → `{type:"input_image", image_url:"data:…;base64,…"}`.
    `claude.js` segue INTOCADO — o bloco já é o formato nativo dele.
  - **Imagem não entra na guarda de `maxPages`**: aquele teto é de páginas de PDF por
    request, não de anexos (a Anthropic aceita até 100 imagens). Somá-la ali faria um
    processo com 30 fotos e 2 PDFs bater num limite que ele não bateu.
  - No `.zip` sai como `.jpeg`/`.png` — o `fmt` guarda o formato de ORIGEM mesmo quando
    a redução converte para JPEG, e a tabela `EXTENSAO` do `exportar.js` PRECISA ter
    esses formatos: sem eles o `|| ".txt"` do fim fazia a foto sair do pacote como um
    `.txt` de lixo binário. No preview aparece por `data:` URI — **não `blob:`**, que a
    CSP de alguns tribunais barra.
- **Peças de encaminhamento são normais no PJe**: petições cujo conteúdo integral é algo
  como `<p>Em Anexo</p>` (o teor real está nos anexos "Documento de Comprovação"
  protocolados junto). Não é falha de download — o system prompt instrui o modelo a
  explicar isso e sugerir marcar os anexos.
- **Anexo incremental de peças** (`pecasNaConversa`): cada peça entra no histórico UMA
  única vez; a cada turno só o DELTA (peças ainda não enviadas) é anexado. Reanexar
  tudo a cada mudança de seleção duplicava páginas/tokens no request (os blocos já
  enviados fazem parte do prefixo cacheado) e estourava os limites já no segundo envio.
- **Desmarcar peça LIBERA contexto** (`prepararEnvio` em content.js): a API é
  stateless — o histórico inteiro é remontado a cada request —, então cada bloco
  `document` carrega o campo interno `__pecaId` e, no envio, `prepararEnvio(msgs,
  ativos)` filtra os blocos das peças desmarcadas e remove `__pecaId` (a API rejeita
  campos extras; o teste do scratchpad confirma que ele nunca vaza). Blocos do
  assistant (thinking assinado, ferramentas) NUNCA são tocados. `conversation` guarda
  o turno CRU (com `__pecaId`); re-marcar a peça faz os blocos voltarem sem reanexar
  (ela segue em `pecasNaConversa`). Custo aceito: mudar a seleção invalida o cache de
  prefixo daquele ponto em diante. As guardas de páginas/tokens contam o request que
  VAI de fato (só peças ativas + histórico filtrado).
- **Feedback de contexto em três camadas** (o usuário precisa saber quando encheu):
  (1) medidor `panel.setContexto` (tokens/páginas vs. limites), atualizado no envio e
  DINAMICAMENTE ao marcar/desmarcar peças — inclusive ANTES do primeiro envio, em
  DUAS sub-camadas, porque o clique não pode esperar download nem rede:
  (1a) estimativa LOCAL instantânea (0 ms, `estimativaLocalTokens`): PDF ≈ páginas ×
  2000 tokens, texto ≈ chars/3,5 sobre o que já está em `docsCache` (o tipo vem de
  `lerCorpo` em `pje.js`: content-type + assinatura `%PDF-` nos primeiros 1024
  bytes — PDF servido como octet-stream não pode cair no ramo de texto, que
  desperdiçaria ~17 mil tokens de lixo binário; HTML honra o charset do header
  ao decodificar); peças ainda sem download aparecem como
  "N peça(s) sem medir" (`pendentes` no gauge) — nunca fingir precisão;
  (1b) refinamento em segundo plano (debounce 900 ms): `baixarQuieto` (concorrência
  3, progresso peça a peça re-alimentando a estimativa local) → `subirPecas`
  (upload à Files API já na medição: count_tokens referencia por file_id, payload
  mínimo, e o envio reaproveia — prefetch completo) → count_tokens corrige o número.
  GUARDA de escala: acima de `LIMIAR_PREFETCH` (12) peças sem cache (ex.: "todas"
  marcadas), a medição completa não roda — a ativação JSF do PJe é serializada e
  levaria minutos. Em vez de parar por completo, entra o **prefetch progressivo**
  (`prefetchProgressivo`): baixa em lotes de `LOTE_PREFETCH` (4), **em ordem de
  relevância** (essencial → relevante → neutro → ruído), cedendo a `busy`, `estSeq` e
  `exportando` ANTES de cada lote. Motivo: o usuário leva de meio a um minuto
  escrevendo a pergunta, e esse tempo era desperdiçado — o envio pagava a fila inteira
  do zero. Ordenar por relevância importa porque, se ele interromper, o que já baixou
  é justamente o que o envio vai pedir primeiro. Ceder é obrigatório: o prefetch
  competiria com o turno pela sessão JSF, que é serializada. Ao terminar, chama
  `refinarContexto` de volta — sem laço, porque ali `faltam` já está vazio e o
  caminho normal assume. Nunca deixa o estado pior que o de antes: o que não baixar,
  o envio busca com o card de progresso visível.
  `estSeq` descarta respostas atrasadas e `ultimaChaveEst`
  (ids ordenados + tamanho da conversa) evita re-medir nos refreshs da timeline —
  a chave é limpa sempre que o alerta liga, para a próxima mudança re-medir.
  Durante um turno (`busy`) o handler de seleção retorna cedo: refreshs da
  timeline do PJe disparam `syncSelection` sem mudança real e sobrescreveriam
  a medição oficial do envio. Se o count_tokens do envio falhar (ex.: 429 —
  o motivo agora vai ao console), o fallback re-pinta a estimativa local com
  o cache já cheio (sem isso o medidor congelava no retrato do clique, "N
  peça(s) sem medir"). Após o turno, `atualizarGaugePosTurno` usa o
  `usageReq` (usage do ÚLTIMO request físico — a soma das iterações
  `pause_turn` serve para custo, mas duplicaria o tamanho do contexto) como
  medição EXATA, de graça, e memoriza `ultimaChaveEst`;
  (2) bloqueio a >90% da janela em `estimarContexto` (erro com flag `ctxCheio`);
  (3) barra de alerta persistente `panel.setAlerta` (`.alertbar`, `role="alert"`, com
  botão ⟲) ligada quando o envio é bloqueado ou em `model_context_window_exceeded` —
  diferente do `.status` (transitório), só some quando a conversa volta a caber
  (desmarcar peças re-estima e limpa sozinha) ou em "Nova conversa". Compaction
  server-side foi avaliada e descartada: resumiria as próprias peças, matando as
  citações por página — a saída certa aqui é tirar/incluir peças do request.
- **Custo por resposta** (`registrarCusto` em content.js + `.custo` no painel): a
  API não devolve valor monetário — só o `usage` (tokens por categoria). O
  acumulador SSE de `claude.js` captura o usage (entrada no `message_start`,
  saída no `message_delta`); `executarTurno` (background.js) SOMA o usage de
  todas as iterações `pause_turn` (um turno lógico = vários requests físicos) e
  calcula `custoUsd` pela tabela `MODEL_CAPS[model].preco` (US$/1M tokens; cache
  write 1,25× o input, cache read 0,1×; Sonnet 5 usa preço de tabela, não o
  promocional). **Preço em DEGRAU**: quando a entrada da tabela traz
  `limiarLongo` + `longo` (hoje só os GPT-5.6: acima de **272 mil tokens de
  input** a OpenAI cobra 2× input e 1,5× output pelo request INTEIRO, não só
  pelo excedente), `custoUsdDe` troca de tarifa. Como o limiar é POR REQUEST
  FÍSICO, `executarTurno` soma **custos**, não tokens: calcular no fim sobre o
  `usoTotal` faria duas iterações de 200k cruzarem um limiar que nenhuma delas
  cruzou. Modelos sem `longo` seguem lineares — Anthropic e Gemini inalterados.
  Este degrau importa muito aqui: mandar os autos completos passa de 272k com
  facilidade (é o motivo de existir o modelo de 1M), e sem ele o rodapé mostraria
  metade do custo real justamente nos processos volumosos. O `done` leva
  `usage`+`custoUsd`; o content acumula
  `custoConversaUsd` (zera em "Nova conversa") e `panel.setCusto` mostra no
  rodapé ("nesta resposta • na conversa", tooltip com o detalhamento).
- **Prompt caching**: `montarBlocos()` marca o último bloco com
  `cache_control: {type: "ephemeral"}` e `stripOldCacheControl()` remove breakpoints
  antigos do histórico (a API aceita no máx. 4).
- **Limite de payload**: 24 MB de base64 (`MAX_TOTAL_B64_CHARS`) com folga sob o limite de
  32 MB da API. `montarBlocos()` lança erro amigável se exceder — por isso
  `panel.endPrep()` (confirmação "peças anexadas") só é chamado **depois** de montar os
  blocos.
- **Turnos desfeitos em erro**: em falha ou resposta vazia, `content.js` faz `pop()` do
  turno do usuário e remove as peças do turno de `pecasNaConversa`, para permitir nova
  tentativa limpa. `panel.setPecasEnviadas([...pecasNaConversa])` é chamado no
  **`finally`** do turno: são QUATRO caminhos que mexem em `pecasNaConversa` (sucesso,
  resposta vazia, erro e turno desfeito) e espalhar a chamada garantiria esquecer um.
- **Peça de texto (HTML/RTF) é cortada em `MAX_CHARS_TEXTO` (60.000), e o corte NÃO
  pode ser silencioso**: são ~30 páginas, e sentença com transcrição de depoimentos ou
  RTF de processo migrado passam disso. O texto cortado leva `MARCA_TRUNCADO` — um
  aviso explícito para o modelo não concluir que algo "não consta" do que ele não
  leu — e a peça entra em `pecasTruncadas`, reportada ao usuário pelo canal do
  `mostrarFalhasPecas` com rótulos próprios (`avisoTrunc`): ali as peças ENTRARAM,
  pela metade, que é uma perda de outra natureza que a do download. `mostrarFalhasPecas`
  ganhou `opts {titulo, dica}` para isso; sem opts o texto é byte a byte o de antes.
  A mesma constante alimenta `estimativaLocalTokens`, para as duas leituras nunca
  divergirem.
- **Keepalive do service worker (MV3)**: o Chrome mata o worker após ~30 s sem eventos
  de extensão — fatal em turnos longos que ficam muito tempo sem emitir SSE (raciocínio
  extenso, busca na web) com
  longos silêncios no SSE (sintoma: "conexão com o serviço interrompida"). Durante um
  turno, `background.js` chama `chrome.runtime.getPlatformInfo` a cada 20 s
  (`manterVivo`) e `content.js` manda `{type:"ping"}` pela porta; o handler do Port
  ignora tipos desconhecidos. Não remova nenhum dos dois lados.
- **Markdown seguro**: `renderMd()` em `panel.js` **escapa primeiro, formata depois**.
  Qualquer mudança ali precisa preservar essa ordem (a resposta do modelo pode conter
  conteúdo dos autos).
- **Blocos `document` levam `title`** (título da peça, no formato `"123456 - Nome"`)
  — exigência do system prompt, e o único canal pelo qual o **id** da peça viaja:
  a Citations API devolve esse mesmo texto em `document_title`, de onde
  `infoCitacao` (content.js) o extrai de volta. Nunca enviar o título "limpo".
- **Rastreabilidade peça · id · folha é a mesma nas QUATRO saídas** (chat Anthropic,
  chat Gemini, minuta/editor, mapa mental): o id é o número que abre o título da peça e é
  por ele que o usuário a reencontra na timeline do PJe — citar só o nome não serve.
  `PROMPT_INICIO` (compartilhado pelos dois provedores) exige nome + id; o
  `SYSTEM_PROMPT_CIT_TEXTUAL`, o `SUFIXO_MINUTA` e o `SUFIXO_MAPA` usam o mesmo
  formato literal `(Peça, id 123456, fl. 7)`. Ao editar um deles, editar os quatro.
- **Contexto do caso no system** (`contextoDoProcesso` em content.js): número CNJ
  (`PJE.getNumeroProcesso`), **ficha do processo** e data de hoje. Sem o CNJ o mapa
  mental titulava com número inventado; sem a data, prazos e "situação atual" saíam
  calculados contra o conhecimento congelado do modelo. Todos entram por
  `systemPromptAtual()` — o mesmo ponto único do `customPrompt` —, então alcançam
  chat, minuta, mapa e count_tokens nos três provedores de uma vez. A data muda o
  system uma vez por dia, o que é inofensivo: o cache é ephemeral de 5 min e a virada
  nunca cai numa janela viva.
  A **ficha** (`resumoFicha`) sai de `PJE.lerCabecalhoProcesso()`, que já existia e
  até então só a exportação `.zip` usava: classe, assunto, órgão julgador e os
  titulares de cada polo (representantes NÃO entram — dobrariam o tamanho sem ajudar
  a entender o caso). São ~80 tokens que o modelo não deduz com segurança dos PDFs
  (nem sempre a peça marcada é a inicial), e sem eles ele troca os polos e erra o
  rito. Lida UMA vez por sessão (`fichaCache`): `systemPromptAtual()` roda duas vezes
  por turno e raspar o DOM de novo seria desperdício. Best-effort: ficha nula ⇒ o
  system fica byte a byte o de antes.
- **Avisos em bloco na resposta** (`PROMPT_DESTAQUES` em content.js +
  `lerCallout`/`CALLOUTS` em panel.js): a observação que MUDA a leitura do
  processo — "esta peça é só encaminhamento, a defesa está na 205649798", "a
  peça decisiva não foi anexada", "não deu para confirmar este valor" — chegava
  como mais um parágrafo no meio de uma resposta longa. Quem lê autos lê por
  VARREDURA: ressalva sem peso visual é ressalva não lida, e aqui o custo disso
  é decidir com base errada.
  - A sintaxe é a dos **"alerts" do GitHub** (`> [!ALERTA]`) por ADERÊNCIA, não
    por gosto: os modelos a conhecem do treino, e marcação inventada seria
    obedecida pela metade. Como é uma citação markdown legítima, o provedor que
    ignore a instrução degrada para blockquote em vez de vazar sintaxe crua.
  - **Três níveis, e as tabelas dos dois lados precisam bater**: `[!ALERTA]`
    (`--alerta-*`, o que pode levar a erro de decisão), `[!ATENÇÃO]`
    (`--warn-*`, ressalva sobre a BASE da resposta) e `[!NOTA]` (azul da marca).
    `CALLOUTS` aceita também os rótulos canônicos em inglês (WARNING, NOTE,
    CAUTION…): o modelo escorrega para eles mesmo instruído em português, e um
    rótulo não reconhecido apareceria como `[!WARNING]` cru na tela.
  - Vai nos DOIS system prompts de chat e **é proibido na minuta e no mapa**
    (regra explícita no `SUFIXO_MINUTA`/`SUFIXO_MAPA`): um `[!ALERTA]` no meio
    de uma sentença que vai ao PJe é defeito, não destaque — ali o canal do que
    falta continua sendo o `[COMPLETAR: …]`.
  - Teto de três avisos por resposta, dito no prompt: destaque que aparece em
    tudo deixa de destacar.
- **Inventário das peças NÃO anexadas** (`inventarioNaoMarcadas` + `comInventario`):
  ao fim do turno do usuário vai a lista de `id - título` das peças que estão na
  timeline mas ficaram de fora. É o que fecha o ciclo entre a IA e a seleção — sem
  ele, perguntar "qual foi o valor da perícia?" com o laudo desmarcado devolve um
  "não consta" seco, e o usuário não descobre que a peça está a um clique.
  - Vai no **texto do turno**, nunca no system: a lista muda a cada refresh da
    timeline (MutationObserver, debounce de 400 ms) e no system invalidaria o cache
    de prefixo o tempo todo.
  - E é anexado só na **cópia** que vai à API (`prepararEnvio` já devolve uma), nunca
    em `conversation`: no histórico ele se acumularia turno a turno — dez turnos com
    200 peças seriam ~20 mil tokens de listas repetidas e desatualizadas. Teste
    cobre: no 2º turno tem de haver exatamente UM inventário.
  - Entra ANTES do `estimarContexto`, para o pré-voo medir o request que vai de fato.
  - Teto `INVENTARIO_MAX` (80): acima disso, só as peças de relevância
    `essencial`/`relevante` (mesmo critério do "principais"), e o corte vai DITO no
    texto — sem cap silencioso.
  - `PROMPT_FIM` traz a regra correspondente: **nunca afirmar conteúdo de peça não
    anexada**, e distinguir "não consta das peças anexadas" de "não existe no
    processo". Sem ela o modelo trataria a lista como conteúdo disponível.

## Memória de caso (`casodb.js` no worker + `caso.js` + `content.js`)

Reabrir um processo já analisado retoma a conversa e **não re-baixa as peças**.
Antes disso, fechar a aba matava `conversation`, `pecasNaConversa` e — o mais
caro — o `docsCache`, que custou até `200 × 5,6 s ≈ 18 min` da fila serializada
do PJe. O `fileId` sobrevivia em `storage.session` mas era lido de DENTRO do
`docsCache`: na prática o cache de sessão poupava o upload e nunca o download.

- **O banco NÃO PODE viver no content script.** Content scripts rodam na origem
  da PÁGINA: um `indexedDB.open()` em `content.js` abriria o banco de
  `pje.tjce.jus.br` — os autos ficariam legíveis por qualquer script do tribunal
  e sumiriam quando o usuário limpasse os dados do site. Por isso `casodb.js` é
  um ES module do worker e `caso.js` é só o cliente RPC.
  IndexedDB e não `storage.local` por três razões: **cota** (o `local` tem teto
  de 10 MB e já hospeda config + `minuta:*` + `modelo:*`; estourá-lo faz o `set`
  de uma minuta FALHAR — o IndexedDB segue a cota por origem do navegador);
  **structured clone**, que preserva o `{type:"x-gemini-item", raw}` que precisa
  voltar byte a byte; e **escrita granular** por peça.
  Nota de fato conferida na doc oficial (2026-08): `unlimitedStorage` **NÃO
  gera aviso de permissão** — só `bookmarks`, `history`, `tabs` e afins geram.
  Não a declaramos porque não é necessária (o teto de 20 casos de texto fica em
  poucos MB); o que ela daria de útil é isenção de *eviction* sob pressão de
  disco. Não repetir a afirmação de que ela "mexeria no aviso de instalação":
  isso é falso e levaria a decisões erradas.
- **O b64 dos PDFs e das imagens NUNCA vai ao disco.** O que dispensa o download
  é o `fileId` da Files API — `montarBlocos` o prefere e nem toca no base64
  (content.js:1330). `salvarPecas` apaga `b64`/`semBytes` como última barreira.
  Peça de TEXTO guarda o texto: ali ele É o conteúdo e dispensa o download por
  completo.
- **QUATRO predicados são a fonte única da regra** (irmãos de `precisaUpload`):
  `fileIdValido` (provedor bate · `fileExp` com 60 s de folga · `chaveHash`),
  `podeAnexar` (ramos EXPLÍCITOS por `kind` — imagem vai **sempre** inline em
  base64 nos três provedores, então um `fileId` não a dispensa de nada),
  `precisaBaixar` e `temBytes`. Todo `!docsCache.has(id)` de decisão de download
  virou `precisaBaixar`; `garantirBaixada` é o funil ÚNICO e **mescla**
  (`Object.assign`) em vez de substituir — um `set` cru apagaria o `fileId` e a
  peça subiria de novo a cada sessão, anulando metade da economia.
- **`precisaBaixar` e `temBytes` respondem perguntas DIFERENTES, e confundi-las
  já custou dois bugs de uma vez.** O primeiro é "preciso baixar para
  **ENVIAR**?", e a resposta é **não** quando há `fileId` válido — o modelo
  recebe a peça por referência da Files API. Mas há dois consumidores que não
  mandam a peça a lugar nenhum e para os quais o `fileId` não vale nada: o
  **preview**, que desenha pixels, e a **exportação `.zip`**, que grava o arquivo
  original. Os dois chamavam `garantirBaixada(id)` e, numa peça vinda da memória
  de caso (`fileId` + zero bytes — o caminho COMUM ao reabrir um processo), o
  download era pulado. Sintomas distintos e ambos silenciosos: no preview o botão
  "Abrir documento" não fazia nada (baixava zero e o popover re-renderizava o
  mesmo aviso); no `.zip` a peça saía **vazia**, num arquivo que só se abre
  depois. Os dois passaram a pedir `garantirBaixada(id, {bytes:true})`. A
  medição de contexto (`baixarQuieto`) segue com `precisaBaixar`, porque lá o
  `fileId` de fato basta — o `count_tokens` referencia por ele.
  - Corolário na UI: o botão do preview confere se o que voltou tem **conteúdo**
    (`b64`, ou `text` quando é peça de texto), não se voltou algo. Retorno sem
    bytes cai no mesmo ramo no re-render, e o clique parece não ter feito nada —
    era metade do sintoma. Os DOIS ramos de `preview-miss` fazem essa checagem.
  - Coberto por teste que extrai os quatro predicados do `content.js` real (por
    varredura de chaves no fonte, não cópia) e roda em `vm` com um `docsCache`
    falso.
- **Armadilhas que já custaram bug nesta rodada:**
  - **Gravar antes de hidratar apaga o caso.** O `refresh()` do boot roda
    `setDocs` → `syncSelection` → `selChangeCb` SÍNCRONO, com a lista vazia. Sem
    a trava `casoCarregado`, a primeira gravação salva `selecao: []` por cima da
    memória. A ordem `hidratar → casoCarregado = true` é a correção inteira.
  - **`fileIdValido` lê `modelCaps`**, que no boot é `null` e cai no default
    "anthropic": hidratar antes do `await garantirCaps()` descartaria em silêncio
    todo `fileId` do Gemini, que é o provedor PADRÃO. O recurso pareceria não
    existir.
  - **`subirPecas` sem guarda de `b64`** subiria arquivo VAZIO, receberia um
    fileId válido e contaminaria o cache de sessão E o banco — o modelo
    responderia "não consta" sobre peças que recebeu em branco.
  - **`montarBlocos` fazia `d.b64.length`** no fallback: uma peça hidratada sem
    bytes derrubava o turno inteiro com TypeError. Agora sai por `podeAnexar` e
    entra em `semConteudo`, reportado no chat.
  - **O debounce precisa de TETO** (`TETO_ADIAR`): cada peça que baixa pede uma
    gravação e reagenda o timer — num prefetch de 200 peças a gravação seria
    adiada até o fim, e fechar a aba perderia exatamente o download que a
    memória existe para preservar.
  - **A poda NÃO pode rodar a cada gravação.** `podarCasos` percorre todos os
    casos; com `getAll()` ela desserializava as CONVERSAS INTEIRAS de 20
    processos a cada 1,2 s de debounce, dentro do worker — o processo que o
    Chrome mata primeiro. Agora usa `openKeyCursor` no índice `porAtualizacao`
    (só timestamps, o valor nunca é lido) e só roda quando um caso NOVO nasce —
    a criação é o único momento em que o teto de quantidade pode ser cruzado.
  - **`metaDe` tem fallback (`"Peça 123"`) e ele NÃO pode ir ao disco.** A
    timeline é lazy, então uma peça do histórico pode não estar no `docsIndex`;
    gravar o fallback trocaria "184100639 - Contestação" por "Peça 184100639"
    PARA SEMPRE, porque a mesclagem do banco aceita o campo. `pecaParaBanco` lê
    `docsIndex.get(id)` direto e OMITE o título quando não há — omitir preserva
    o que está gravado.
- **`selecaoEfetiva()` = checkboxes + `selPendente`, e ela é a fonte de verdade
  do TURNO** (não `getSelected()` puro). A timeline do PJe é lazy: ao reabrir um
  processo, boa parte das rows não existe no DOM e os checkboxes correspondentes
  não podem estar marcados. Três coisas quebravam por isso, e as três em
  silêncio: (1) o `if (selectedIds.length === 0)` do `onSend` recusava o envio
  com "marque ao menos uma peça" numa conversa que o usuário acabara de ver
  retomada; (2) `prepararEnvio` filtrava TODOS os blocos `document` do histórico
  — a IA responderia sobre um processo vazio; (3) a gravação salvaria a seleção
  encolhida, e ela sumiria um pouco a cada sessão. A guarda de peça marcada
  passou a valer só quando **não há** peça no histórico (`pecasNaConversa`).
  Vale para chat, minuta e mapa.
- **O `fileId` também vive DENTRO do histórico**, e é o modo de falha mais
  provável do recurso: `conversation` guarda `{source:{type:"file", file_id}}`
  dos turnos anteriores, e re-baixar a peça NÃO conserta o bloco antigo — o
  usuário levaria um 400 críptico na primeira mensagem de toda conversa
  retomada. `revalidarPecasDoHistorico` (chamada em `onSend` após
  `garantirCaps`) re-sobe o que venceu e **reescreve os `file_id` in-place**
  (legítimo: o bloco `document` não carrega assinatura, ao contrário do
  thinking). Peça que não voltou sai do histórico e é reportada. No caminho
  normal custa uma varredura e mais nada. **Minuta e mapa NÃO chamam essa
  função**: são requests isolados, montam blocos do zero e não reenviam
  `conversation`.
- **`chaveHash`** (SHA-256 da chave truncado em 8 hex, calculado no worker —
  a chave nunca sai de lá) invalida os uploads quando o usuário troca de conta.
  Viaja no `upload` e no **`caps`**, que já roda no boot e no `storage.onChanged`
  de chave/modelo: a invalidação acontece sozinha, sem caminho novo. A resposta
  de `upload` passou a levar `exp` também — antes a expiração do Gemini existia
  só dentro do worker, o que bastava enquanto o cache morria com a aba.
- **O que decide se há conversa a gravar é `temProduto`, e ele tem DUAS metades**
  — cada uma corrigindo um erro oposto:
  - `conversation` sozinho não serve: minuta, mapa mental e "escolher com IA"
    são requests ISOLADOS e não entram nele **por decisão de projeto**. Enquanto
    `gravarCasoEConversa` media por ele (`if (!conversation.length) return`),
    uma sessão inteira de minutas e mapas NUNCA virava conversa no disco: a tela
    com meia dúzia de cards e o banco vazio; fechar a aba apagava tudo sem
    aviso. Foi o bug que abriu a rodada.
  - O transcript INTEIRO também não serve: num turno que falha o histórico é
    desfeito (`conversation.pop()`) e a bolha do assistente é removida, mas a
    pergunta do usuário fica na tela — gravar ali encheria a lista de conversas
    com perguntas nunca respondidas.
  - Sobra o certo: **houve resposta** (uma entrada `assistant` no transcript, que
    é o que o card da minuta e o do mapa deixam) **ou** já há histórico de API.
    `onReset` usa a MESMA função para decidir se anuncia "conversa anterior
    guardada" — anunciar num caso em que nada foi gravado seria mentir sobre
    memória, que é pior do que o silêncio.

  Consequências que andam juntas e não podem se separar:
  - `retomarConversa` aceita conversa **sem** `conversation` (basta transcript),
    e `aplicarConversa` faz `caso.conversation || []` — `undefined` ali derruba
    o próximo `.length`, lido em quase todo caminho do envio.
  - **Minuta, mapa e triagem gravam no `finally`** (`salvarCasoAgora()`), como o
    chat e a exportação. Sem isso o registro só chegava ao disco se algum outro
    evento disparasse gravação depois — e o download das peças daquele turno
    junto. Na triagem vale o mesmo por outro motivo: ela reescreve a SELEÇÃO, e
    o `selChangeCb` que ela dispara cai na guarda de `busy` do `agendarSalvar`.
- **A identidade da conversa (`convAtual`) só é assumida quando
  `aplicarConversa` devolve `true`** — ela devolve `false` ao recusar histórico
  de outro provedor. Assumir antes era destrutivo nos DOIS caminhos (boot e
  troca pela lista): a tela fica vazia, `convAtual` segue apontando para o
  registro cheio, e a primeira gravação escreve o vazio por cima. O usuário
  perdia a conversa por ter clicado nela. E o `return true` no fim da função é
  parte da correção: sem ele a conversa aparece na tela, ninguém assume a
  identidade, e a gravação seguinte cria uma DUPLICATA.
- **"Nova conversa" apaga a CONVERSA, preserva as PEÇAS.** O botão promete zerar
  o chat, não esquecer o processo; apagar as peças faria o usuário pagar o
  download inteiro por ter trocado de assunto.
- **Duas abas no mesmo processo**: `salvarCaso` recebe o `base` (o
  `atualizadoEm` que aquela aba leu ao hidratar). Se o registro mudou desde
  então, os `CAMPOS_DE_SESSAO` (conversa, transcript, seleção, custo) são
  descartados e só o aditivo (peças, ficha) passa. **Não existe merge de
  conversas** — são duas sequências de raciocínio assinado, e intercalá-las
  produziria um histórico que nenhuma API aceita.
- **Retomada da UI**: `restaurarConversa` é REPLAY de `addMessage`/
  `updateAssistant` (o `transcript` interno volta correto sozinho e o ⬇ segue
  funcionando). Card de minuta/mapa retomado vira UMA LINHA — o `__entry.text`
  deles guarda o markdown inteiro, que como bolha despejaria 30 KB na conversa.
  `restaurarSelecao` guarda `selPendente` e o `setDocs` aplica cada id UMA vez:
  cobre a timeline lazy sem ressuscitar peça que o usuário desmarcou.
  **Troca de provedor desde a última sessão retoma só as PEÇAS** — o histórico
  de um provedor não roda no outro, e retomá-lo entregaria um estado que o envio
  bloquearia de todo jeito.
- **Privacidade**: default ligado, `chrome.storage.local.memoriaCaso` (desligar
  **apaga tudo na hora** — um interruptor que só impede gravações futuras
  deixaria no disco o que o usuário acabou de recusar); poda de 14 dias/20 casos
  de carona em cada gravação e no `onInstalled`; a faixa `.retomada` ANUNCIA a
  memória e hospeda o botão de apagar (dois cliques, nunca `confirm()`).
  Documentado em `PRIVACY.md`, `help.html#memoria` e `README.md`.

## Tour de primeiro uso (`tour.js` + `panel.js`)

Visita guiada de 13 passos que se desenha SOBRE o painel real. Existe porque os
gestos de seleção em faixa (arrastar, Shift+clique, botão direito) estavam na
extensão desde a v0.23 e quase ninguém os descobria: gesto não se anuncia
sozinho, e o guia do estado vazio é texto — ninguém abre um acordeão para achar
o que não sabe que existe. **Sete dos treze passos são sobre marcar peças**, que
é a tarefa repetida dezenas de vezes por processo.

- **Por que NÃO uma biblioteca** (Driver.js/Shepherd/Intro.js, todas avaliadas):
  (1) os alvos vivem no **Shadow DOM** e `document.querySelector` deles devolve
  `null`; (2) elas injetam o popover em `document.body`, FORA do shadow, e o
  balão volta a ficar exposto ao CSS do tribunal — o painel usa Shadow DOM
  exatamente para não estar; (3) o que este tour ensina são **gestos**, e
  nenhuma delas anima gesto; (4) ele **pilota** o painel (`open`, `aplicarModo`,
  `setDocsOcultas`), que é código só daqui. O recorte — a parte que a lib
  resolveria — são cinco linhas de CSS. Mesmo argumento que manteve o JSZip
  fora do projeto.
- **INVARIANTE: o tour NUNCA toca no estado real.** Os gestos são demonstrados
  num **palco falso** (lista fictícia dentro do balão). Animar sobre as rows
  verdadeiras marcaria peças de verdade → `selChangeCb` → estimativa de contexto
  → `baixarQuieto`/prefetch, isto é, uma visita de boas-vindas **iniciando
  downloads na fila serializada do PJe**. O palco também é o que faz os passos
  funcionarem com a timeline ainda vazia, que é justamente o primeiro uso.
  Coberto por teste (nenhum disparo de `onSelectionChange` na visita inteira).
- **O `ctrl` é a fronteira, e é deliberadamente mínimo**: `{root, wrap, abrir,
  modo, modoAtual, mostrarPecas}`. Nenhum método que altere seleção, conversa ou
  envio atravessa — é o que garante o invariante acima por construção, não por
  disciplina.
- **Uma caixa de 0×0 não pinta `box-shadow` no Chrome** — nem com spread de
  9999px. O recorte é `box-shadow: 0 0 0 9999px` num `div` posicionado sobre o
  alvo; nas telas SEM alvo (capa e encerramento) o buraco colapsaria em 0×0 e o
  escurecimento sumia inteiro, deixando a capa boiando sobre a página do
  tribunal. Por isso `sem-alvo` vai nos DOIS elementos: o buraco se apaga
  (`opacity`, nunca `[hidden]`, para o fade de volta) e quem escurece passa a ser
  o **fundo da camada**. `getComputedStyle` mostra a sombra viva e correta nesse
  estado — a falha é invisível fora de um teste de pixel.
- **NUNCA `requestAnimationFrame` na primeira pintura.** O Chrome congela o rAF
  em aba de segundo plano (o mesmo que já derrubou o primeiro desenho do mapa
  mental), e abrir processos com Ctrl+clique em várias abas é o padrão de
  trabalho no PJe: a visita auto-abre ~1 s após o boot e o usuário encontraria a
  tela escurecida com um cartão **vazio**. Pinta-se síncrono, com **dois**
  repintes (320 ms e 700 ms) porque o `.panel` tem `transition: all` e medir o
  alvo no meio dela põe o spotlight ao lado do botão.
- **Ordem dos lados do balão: direita ANTES de abaixo** quando o alvo está na
  metade esquerda. "Abaixo primeiro" é o default óbvio e estava errado aqui — os
  alvos da esquerda são todos da coluna de peças, e um balão abaixo deles cobre
  justamente a lista que o passo explica.
- **Os palcos declaram uma timeline; quem agenda é o `laco`.** Quando cada palco
  fazia o próprio `setInterval` e registrava os `setTimeout` na lista geral (só
  esvaziada na troca de passo), um passo deixado aberto empilhava dezenas de
  entradas mortas por minuto. `tocar` devolve a função de PARADA e
  `limparTimers` a chama. Teste cobre: nunca mais de um laço vivo, zero ao fim.
- **Esc é capturado em `capture:true` no window**, senão a cascata de Esc do
  painel (`/` → `@` → modal → modo minuta) fecharia outra coisa junto.
- **Abre sozinho UMA vez** (`chrome.storage.local.tourVisto`, versionado), e só
  com a conversa vazia — cobrir uma conversa restaurada da memória de caso seria
  o pior momento possível. A primeira tela é uma **capa que pergunta** antes de
  percorrer; recusar ali marca o "visto", porque quem recusou não quer ser
  abordado a cada processo. O caminho de volta é o botão `.hint-tour` no estado
  vazio, que some com a primeira mensagem como o resto do bloco.
- `panel.js` trata `PjeTour` como **opcional** (`typeof PjeTour !== "undefined"`,
  como `MLIB` e `DocxImport`): sem o arquivo, o convite some e nada quebra. E a
  **instância nasce depois** de `open`/`aplicarModo`/`setDocsOcultas` existirem —
  só o flag `temTour` mora no topo, porque `showEmptyHint()` roda antes (a
  armadilha da zona morta temporal, aqui no `panel.js`).

## Busca de peças e orientações (panel.js)

- **"Carregar todas as peças" tenta DUAS rotas, nesta ordem** (detalhes e
  armadilhas em `docs/pje-tela-documentos.md`):
  1. **`PJE.listarPelaGrid`** — a tela "Documentos" do PJe, uma grid tabular
     paginada, lida num **iframe oculto same-origin** (nunca uma aba: isso
     custaria as permissões `tabs`+`scripting`, que mudam o aviso de instalação
     da Web Store). Dentro do iframe clicamos no link real e deixamos o próprio
     `A4J.AJAX.Submit` do PJe montar o POST. Ela traz o **tipo oficial** da peça,
     data e autor da juntada e — o ponto principal — o **total de páginas**, que
     é o oráculo de completude: `incompleto = paginasLidas < paginas`. Tudo é
     best-effort e devolve `null` em qualquer falha, inclusive
     `X-Frame-Options`. A grid é mesclada à timeline por `mesclarDocs`
     (content.js): a timeline manda na ORDEM, a grid acrescenta o que faltou e o
     `tipo`. `categoriaDe` (panel.js) classifica pelo **`tipo` antes do título**.
  2. **`PJE.carregarTimelineCompleta`** (fallback) — a rota por scroll descrita
     abaixo. Ela continua indispensável: é a única quando a grid não existe ou
     mudou de layout no tribunal X. Mas note que o "parou de crescer" dela é um
     heurístico TEMPORAL — lista parcial passa por completa sem erro.
- **A rota por scroll** (`PJE.carregarTimelineCompleta`): a timeline do PJe
  carrega as peças sob demanda (scroll infinito) — em processos maiores, só o
  trecho já rolado existe no DOM e, portanto, na lista do painel. O botão rola o container da
  timeline programaticamente até o fim. Scroller por heurística em 3 níveis:
  (1) primeiro DESCENDENTE rolável da timeline que contenha links — o caso
  real do TJCE (`div.eventos-timeline.scroll-y`; o `#divTimeLine` e TODOS os
  ancestrais têm overflow visible, e o `#pageBody`, único ancestral com
  overflow:auto, fica com scrollHeight == clientHeight — armadilha que
  derrubou a v1, que só olhava ancestrais); (2) ancestral rolável; (3) a
  janela. Timeline e scroller são RE-LOCALIZADOS a cada rodada — o re-render
  A4J que anexa as peças substitui os nós, e referência guardada viraria
  no-op. Aguarda cada leva do servidor até a lista parar de crescer por 2
  rodadas (teto 90 s);
  o MutationObserver da timeline repovoa a lista ao vivo e, ao final, a
  rolagem volta para onde estava. NÃO clica em nada (zero efeito A4J/JSF,
  não toca na `activationChain` — por isso também não precisa de guarda de
  `busy`); a rolagem programática dispara o evento scroll nativo que o lazy
  load escuta. Feedback pela própria dica (`panel.setTimelineTip({texto,
  carregando})`); reentrada bloqueada em content.js (`carregandoTimeline`).
  A mensagem de falha do "ver na timeline" aponta para este botão.
- **Busca na lista de peças** (`.docsearch`/`filtrarDocs`): filtra por título **e pelo
  tipo oficial** sem acentos (`row.dataset.busca = textoBusca(d)`), só esconde/mostra
  linhas (`row.hidden` — depende da regra global `[hidden]{display:none !important}` do
  panel.css); os checkboxes seguem sendo a fonte de verdade (peça marcada e filtrada
  continua marcada). Indexar o `tipo` importa porque o título costuma ser o nome do
  arquivo ("Documentos diversos") e o tipo é o vocabulário controlado do PJe
  ("Despacho de Mero Expediente"): sem ele, buscar "despacho" não achava a peça que
  já aparecia dourada na lista. `textoBusca` é usada pela lista **e** pelo popup `@`,
  para os dois nunca divergirem. Esc limpa; `setDocs` re-aplica o filtro após
  re-renderizar a lista.
- **TRÊS degraus de seleção — `chave | principais | todas`** (`DEGRAUS` +
  `aplicarDegrau` em panel.js), sobre o eixo `data-rel` da row (ver "Relevância"
  abaixo), **nunca** sobre a classe de categoria:
  - `chave` (`[data-rel="essencial"]`) — a espinha dorsal: ~12 peças num processo de
    200. É o degrau que resolve o problema real; "principais" marcava ~78 de 200
    porque a regra de `cat-peticao` casa quase toda juntada das partes.
  - `principais` (`:not([data-rel="neutro"]):not([data-rel="ruido"])`) — as peças de
    conteúdo, sem o expediente.
  - `todas` — a lista inteira.

  Contrato dos três: **ADITIVO** (marcar nunca desmarca o que o usuário escolheu à
  mão — os conjuntos são encaixados, então os segmentos acendem em faixa) e
  **respeitam o filtro ativo** (agem só nas rows visíveis). O recálculo em
  `syncAtalhos` usa o MESMO conjunto (`rowsVisiveis()`) — quando ele varria a lista
  inteira, o checkbox se desmarcava sozinho logo após o clique sempre que havia busca.
  `syncAtalhos` é separado de `syncSelection` porque `filtrarDocs` precisa recalcular
  **sem** disparar `selChangeCb` (digitar na busca não muda a seleção, e avisar o
  content script a cada tecla o faria re-estimar o contexto à toa).

  **Modo de falha a não reintroduzir**: degrau com conjunto VAZIO (comum em `chave`
  antes de a grid ser lida) fazia o clique não fazer nada, em silêncio. A `.sel-nota`
  diz o motivo — tokens de aviso SUAVE (`--warn-*`), nunca a `.alertbar`. Sem o tipo
  oficial a classificação sai só do título e `chave` seleciona de menos: a nota
  aponta o `⟳ Carregar tudo`, que é o botão que resolve.
- **Relevância — segundo eixo, ortogonal à categoria** (`classificarPeca` em
  panel.js, logo depois de `CATEGORIAS`): a categoria responde "que tipo de peça é
  esta?" e vira COR; a relevância responde "esta peça vai para a IA?" e vira
  `row.dataset.rel` (dataset, **não** classe — as classes `cat-*` são semânticas pelo
  DESIGN.md §2 e uma `.rel-*` convidaria a pendurar cor nela). Quatro níveis:
  `essencial` (`RE_CHAVE`), `relevante` (derivado: tem categoria destacada),
  `neutro`, `ruido` (`RE_RUIDO`). Só os dois extremos têm tabela.
  - `classificarPeca` normaliza **uma vez por alvo** e devolve `{cat, rel}`;
    `categoriaDe` virou um wrapper (`.cat`). O custo real nunca foram as regex, é o
    `norm()` — e `setDocs` re-renderiza a lista a cada mutação da timeline.
  - Laço EXTERNO por alvo (`d.tipo` antes de `d.titulo`), interno na ordem
    ruído → chave → categorias: um tipo oficial "Certidão de Intimação" precisa
    vencer um título que contenha "sentença".
  - **Ruído força `cat-outro`**: "Certidão de Intimação da Sentença" pintada de
    dourado atrai o olho para o que não importa.
  - `RE_RUIDO` é CONSERVADORA e sempre ANCORADA. Nunca usar `certidao` sozinho
    (trânsito em julgado é ato relevante), `comprovante` sozinho (é prova em
    consumidor), `carta` sozinho (precatória não é ruído), `juntada de documentos`
    (é onde vive a prova) nem `mandado` (mandado de segurança).
  - **Armadilha da construção**: o grupo inteiro vai entre `\b…\b`, então toda
    alternativa precisa terminar em palavra COMPLETA — `saneador` não pega "Decisão
    Saneadora" e `acordo homologad` não pega "homologado". Flexões explícitas, nunca
    `\w*` solto (faria "inicial" casar "inicialmente"). Valem também o lookbehind de
    `(?<!cumprimento de )sentenca` e a separação `acordao` ≠ `acordo`.
- **Refino ESTRUTURAL da relevância** (`refinarRelevancia` em panel.js): dois
  sinais fortes não cabem em `classificarPeca` porque **não são propriedades da
  peça**. Ele roda em `setDocs`, sobre a lista já classificada, e devolve
  `Map id -> {rel, motivo}`; `classificarPeca`/`categoriaDe` ficam INTOCADAS —
  elas seguem sendo chamadas com peça avulsa pelos chips, pelo popup `@`, pelo
  preview e pelo content.js, e nenhum desses tem lista para oferecer. **UMA
  classificação por peça** é calculada em `setDocs` e reaproveitada pelos dois
  (classificar duas vezes dobraria o `norm()`, que é a parte cara).
  - **(1) A petição inicial, por POSIÇÃO.** É o sinal de maior retorno: o
    título costuma ser o nome do arquivo ("Petição", "Documentos diversos"),
    aí `RE_CHAVE` não casa nada e a peça mais importante do processo fica fora
    do degrau `chave`, em silêncio. Procura a primeira **petição**
    (`cat-peticao`) nas **5 primeiras** peças em ordem cronológica
    (`window.PjeExport.ordenarCronologico` — a MESMA premissa da exportação em
    `.zip`; duplicá-la aqui faria as duas divergirem sem ninguém ver).
  - **A guarda de `temTipoOficial` é o que impede o falso positivo caro**, e
    ela não é sobre o tipo: a timeline do PJe é LAZY, e numa lista parcial a
    peça mais antiga CARREGADA não é a mais antiga do PROCESSO. O tipo oficial
    só existe depois que a grid foi lida, e a grid é a rota que traz a lista
    inteira — é a proxy de completude disponível no painel.
  - **"Parar na primeira peça que não for ruído" está ERRADO** (foi a primeira
    versão, e o teste pegou): `RE_RUIDO` nunca usa `certidao` sozinho, então
    "Certidão de Distribuição" — que abre um número enorme de processos — não é
    ruído. O laço parava nela e a promovia a "provável inicial". Peça que não é
    petição não bloqueia a busca; a **janela** é que impede o laço de varrer os
    autos e rotular de inicial uma petição do meio.
  - **(2) Autor institucional, só para PROMOVER** (`RE_AUTOR_CONTEUDO` sobre
    `d.juntadoPor`): MP, promotoria, procuradoria e defensoria promovem a
    `relevante` o que o título e o tipo NÃO classificaram (`rel === "neutro"`).
    Quem juntou é **desempate**, nunca veredito — sobrepor um `RE_CHAVE` que
    casou faria uma sentença virar outra coisa por causa de quem a protocolou.
  - **Rebaixar por quem juntou foi avaliado e DESCARTADO**, por duas razões que
    se somam. Estrutural: nenhum degrau distingue `neutro` de `ruido`
    (`principais` exclui os dois), então rebaixar não mudaria seleção nenhuma —
    só criaria mais uma forma de a peça sumir sem ninguém ver. De domínio: o
    caso que parece render, "Petição juntada pela secretaria", é justamente
    onde a secretaria protocola petição de parte que chegou em papel.
  - **O motivo NÃO é enfeite**: peça que entra num degrau por um sinal que não
    está escrito no nome dela precisa poder ser contestada. Vai para o `title`
    da row, junto de quem juntou — o mesmo lugar onde o "Escolher com IA" já
    grava o motivo dele. O refino **nunca mexe na COR**: categoria e relevância
    são eixos ortogonais (DESIGN.md §2), e repintar a peça promovida afirmaria
    uma categoria que a classificação não reconheceu.
  - **Nº de páginas do PDF NÃO está disponível aqui** (e a tentação é real): o
    `paginas` que a grid devolve é a paginação da TABELA. O número de páginas
    da peça só existe no `docsCache`, depois do download, e o `docsCache` é do
    content.js — é por isso que ele aparece na lista do "Escolher com IA" e não
    nos degraus.
  - Testado fora do navegador (19 casos) carregando `exportar.js` + `panel.js`
    reais em `vm`, via `_refinarRelevancia`/`_classificarPeca`. O acesso a
    `PjeExport` é `window.PjeExport.…` explícito, e não o global nu: o IIFE de
    `exportar.js` publica a API só como propriedade de `window`, e o acesso nu
    só funciona pelo global-object-is-window do navegador.
- **Orientações no estado vazio** (`showEmptyHint`) — **progressive disclosure em
  quatro camadas**, nesta ordem: (1) três passos (`.passos`: marcar → pedir →
  conferir a origem), em coluna única e em 3 colunas SÓ no `.expanded` (na janela
  livre larga sobram ~420px de chat, e três cartões ali ficam com duas palavras
  por linha); (2) chips de exemplo (`EXEMPLOS`) que **preenchem** o campo — nunca
  enviam: sem peça marcada o envio falharia e a primeira experiência do usuário
  seria um erro; (3) `<details class="guia">` FECHADO por padrão (estado em
  `chrome.storage.local.guiaAberta`, restaurado depois de `showEmptyHint` existir
  — mesma armadilha do `docsOcultas`) com quatro parágrafos: não é agente
  autônomo, a lista pode vir incompleta, o contexto é limitado e **a conexão
  manda no tempo de espera** (cabo » Wi-Fi). O `<summary>` **nomeia a
  velocidade** ("…e o que deixa mais rápido") de propósito: o parágrafo de rede
  é o mais acionável do guia e ficava atrás de um rótulo — "limites e
  alternativas" — que não prometia falar disso, e ninguém abre um acordeão para
  descobrir o que não sabe que está lá dentro. A mesma frase agora abre também a
  caixa `.privacy` do popup/opções, que é onde ela alcança quem ainda não usou a
  extensão. **Mas ele não pode COMEÇAR por "Como funciona"** (é "Limites,
  privacidade e o que deixa mais rápido"): o convite ao tour, logo acima, chama-se
  "Ver como funciona" e também abre com um triângulo — dois controles empilhados,
  com o mesmo ícone e a mesma primeira palavra, liam-se como um só, e o que se
  perdia era justamente a visita guiada. A separação dos dois é feita em TRÊS
  eixos, e nenhum sozinho basta: espaço (`margin-bottom` no `.hint-tour` — ele é
  `inline-flex` e o `<details>` não tem `margin-top`, então o padrão eram 0px),
  peso (`--fs-ui`/600 contra o `--fs-micro` cinza do summary) e o selo de duração
  `.ht-dur` ("1 min"), que responde à pergunta que decide se alguém aceita um
  tour; (4) botão "Guia completo,
  modelos e preços →" abrindo `src/help.html` (por isso ele está em
  `web_accessible_resources`). **A referência que envelhece — tabela de modelos,
  preços, fluxo recomendado, dicas de cache — vive SÓ no `help.html`**: o painel
  aponta, não recita. Era duplicata integral e a origem da parede de ~380
  palavras. Manter os DOIS links (TecJustiça MCP https://mcp.tecjustica.com/ e a
  demonstração PJe-CE https://pjece.tecjustica.com/) dentro do `<details>`.
- **Aviso da timeline incompleta**: em repouso é só o ícone `⚠️` (`.tip-i`) —
  o aviso de duas linhas era permanente e competia com a própria lista. O
  `.tip-txt` **continua sempre no DOM com o texto padrão** (é ele que o
  hover/`:focus` no ícone revela, via `:has()`): esvaziá-lo faria o hover
  mostrar nada. O ícone é `role="note" tabindex="0"` com `aria-label` — sem
  isso o aviso sumiria para quem navega por teclado, já que conteúdo em
  `display:none` não é anunciado. `setTimelineTip` liga `.carregando` quando há
  progresso e, na mensagem FINAL (que chega com `carregando:false` e nunca mais
  é reescrita pelo content.js), agenda a volta ao repouso em 12 s — sem esse
  prazo o resultado ficaria fixo pelo resto da sessão, devolvendo à coluna as
  duas linhas que esta rodada tirou.

## Modos de layout, preview no hover e "ver na timeline" (panel.js/pje.js)

- **O launcher ("Analisar com IA") chama atenção em DOIS regimes**, e a
  diferença é ter usado o painel alguma vez:
  - `.wrap.pulse` — três halos no boot, e silêncio. É o de sempre, e vale para
    quem já usou: localiza o botão para quem sabe que ele existe.
  - `.wrap.chamando` — pulso CONTÍNUO (ciclo de 1,9 s: anel de ~1,4 s e 0,45 s
    de repouso) para quem **nunca abriu o painel**. Os três halos já existiam e
    mesmo assim havia quem não achasse o botão, e o motivo é QUANDO eles
    acontecem: rodam no boot da página, exatamente quando o usuário espera o PJe
    carregar e está olhando para outro lugar — cinco segundos depois não há mais
    nada na tela a que voltar. Duas diferenças: o pulso REPETE até o primeiro
    clique, e o botão ganha **escala** (movimento de forma é o que a visão
    periférica capta; o halo sozinho é mudança de cor num canto que o olho não
    está varrendo).
  - **O repouso é curto de propósito.** A primeira versão deixava 3 s de
    silêncio entre as rajadas, para não hipnotizar, e o efeito foi o oposto:
    quem olha para o botão vê um halo, espera, não vê mais nada e conclui que
    ele piscou uma vez e parou. Um chamado que exige paciência para ser
    percebido não é um chamado.
  - **O repouso do keyframe tem spread ZERO**, não só opacidade zero: é o que
    faz o anel sumir em vez de encolher de volta ao botão, e o que torna o salto
    para a rajada seguinte invisível.
  - **O estado mora nas CLASSES do wrap, não numa variável espelho.** Uma
    variável "já usou" inicializada de forma pessimista fazia o `open()` que
    acontece ANTES da resposta do storage (o content.js abre o painel em alguns
    caminhos) sair pela guarda sem gravar nada — e o chamado voltava na carga
    seguinte para quem já tinha usado. Painel já aberto quando a resposta chega
    conta como uso: grava e **nunca** liga o chamado, senão ele ficaria armado
    para quando o usuário fechasse o painel que acabou de usar.
  - `chrome.storage.local.launcherUsado`; o `get` vem DEPOIS de
    `open`/`marcarLauncherUsado` existirem (o stub de teste chama o callback de
    forma síncrona — a mesma armadilha do `docsOcultas` e do `guiaAberta`).
  - Em `prefers-reduced-motion` o chamado **não some**: perde a escala e o halo
    e vira uma respiração de brilho. Quem pediu menos animação é justamente quem
    mais precisa que o botão se anuncie por outro canal.
- **Modos de layout** (classes no `.wrap`): flutuante → `expanded` (modal central com
  backdrop) → `expanded full` (tela cheia), o modo `lateral` (sidebar colada à
  direita, página do PJe visível e CLICÁVEL ao lado — sem backdrop; `lateral` e
  `expanded` são mutuamente exclusivas) e o modo `livre` (janela solta: arrasta pelo
  cabeçalho, redimensiona pela alça nativa `resize:both` do canto — sem backdrop;
  com ≥740px de largura DO PAINEL ganha `.livre-wide` — alternada por
  `atualizarLivreLargo` no ResizeObserver e na entrada do modo, pois media query
  mede a viewport, não o painel — e a lista de peças vira coluna lateral como no
  expandido, com legenda).
  Transições centralizadas em `aplicarModo()`
  (não voltar aos handlers inline); a preferência persiste em
  `chrome.storage.local.layoutModo` (tela cheia é transitória: persiste "expandido")
  e é restaurada no `mount()`. Botões no header: `.side` entre `.expand` e `.free`;
  `.free` antes de `.fs`.
- **Modo livre — invariante da geometria**: left/top/width/height vivem em INLINE
  styles no `.panel` (inline vence classe) e são LIMPOS em toda saída do modo
  (`limparGeoLivre` em `aplicarModo` e no fechar) — sem isso deformariam o
  expandido/lateral/flutuante. A captura (`salvarGeoLivre`) acontece ANTES de
  remover a classe `.livre` (sem ela o `.panel` volta a `position:absolute` e o
  rect muda) e em três gatilhos: pointerup do arrasto, ResizeObserver (não dispara
  em janela ocluída — mesmo motivo do setTimeout do "ver na timeline") e
  saída do modo/fechar (cinto-e-suspensório do resize). Persistência em
  `chrome.storage.local.livreGeo` (debounce 400 ms); restauração no `mount` com
  clamp à viewport (o cabeçalho fica sempre alcançável). Os helpers são definidos
  ANTES do restore do layout (stub de teste chama o callback do storage
  sincronamente — mesma armadilha do `docsOcultas`). O arrasto ignora
  `closest("button")` (os botões do header continuam clicáveis) e o
  `setPointerCapture` fica em try/catch.
- **Ocultar a lista de peças** — disponível em TODOS os modos, com TRÊS
  affordances sincronizadas por `setDocsOcultas` — o botão do header
  sozinho passava despercebido (ícone parecido com o do modo lateral):
  (a) botão `.docsvis` no header, cujo ícone TROCA com o estado (chevron ←
  dentro do retângulo = recolher; → = exibir; `SVG.docshide`/`SVG.docsshow`);
  (b) botão `.docs-fold` («) no cabeçalho da própria coluna de peças;
  (c) `.docs-rail` ("Peças do processo" + badge `x/y`, alimentada
  em `syncSelection`) que fica NO LUGAR da lista recolhida e a reabre — a
  lista nunca some sem deixar rastro. Alterna `docs-collapsed` no `.wrap` →
  `.wrap.docs-collapsed .docs {display:none}` — mais espaço para o chat. A rail
  é **horizontal** (faixa no topo) onde a lista era faixa (flutuante, lateral,
  livre estreito) e **vertical** onde era coluna (`.expanded`, `.livre-wide`):
  duas regras no CSS sobre o MESMO elemento. É no flutuante que recolher mais
  rende — ~180px devolvidos ao chat.
  É puramente VISUAL: os checkboxes seguem no DOM (fonte de verdade da seleção),
  então chips, popup `@`, contador e envio funcionam com a lista oculta. Persiste
  em `chrome.storage.local.docsOcultas`, restaurada num `get` próprio DEPOIS de
  `setDocsOcultas` existir (stub de teste pode chamar o callback sincronamente);
  alternar fecha o preview (a âncora do popover some da tela).
- **"Ver na timeline"** (botão `.d-ver` em cada docrow, aparece no hover):
  `PJE.scrollAte(id)` rola a `#divTimeLine` até a peça com flash de ~2s — o estilo
  do flash é injetado no DOM da PÁGINA (`#pje-ia-flash-style`), pois o alvo vive
  fora do Shadow DOM. `scrollAte` NÃO clica no link (zero efeito A4J/JSF, não toca
  na `activationChain`) e retorna `false` quando a peça não está na timeline (o
  content mostra orientação no `.status`). No modal (expandido/cheia) o clique troca
  para o lateral ANTES de rolar — a página estava coberta. O handler é DELEGADO no
  `.doclist` e usa `preventDefault`+`stopPropagation`: a row é um `<label>`; sem
  isso o clique alternaria o checkbox (fonte de verdade da seleção) e dispararia o
  `change`. Callback: `panel.onVerNaTimeline(cb)`.
- **Preview de peça no hover** (só nos modos expandido/cheia/lateral/livre): popover ÚNICO
  `.preview` no Shadow DOM, debounce de intenção de 400 ms, posicionado pela
  `getBoundingClientRect` da row (direita quando cabe; senão esquerda — caso do
  lateral). O conteúdo vem SEMPRE do `docsCache` via `panel.onPreview(cb)` (callback
  SÍNCRONO) — **o hover NUNCA baixa nada**: o download do PJe é serializado na
  sessão JSF (~5,6 s/peça + clique na timeline como efeito colateral) e passadas de
  mouse travariam a extensão. Cache-miss mostra aviso + botão "Abrir documento"
  (rótulo de ABRIR, não "baixar" — decisão de UX; internamente segue sendo download)
  (`panel.onPreviewBaixar` → `PJE.baixar`, bloqueado durante `busy`; alimenta o
  MESMO `docsCache` que o envio reaproveita — prefetch de graça). O popover é
  REDIMENSIONÁVEL (`resize: both`; o tamanho persiste na sessão via inline
  width/height — a altura é zerada nos conteúdos compactos por `modoCompact`, e
  `posicionarPreview` usa a largura REAL quando há tamanho manual) e o embed de
  PDF usa a toolbar NATIVA do viewer do Chrome (zoom −/+, páginas; sem
  `#toolbar=0`) — Ctrl+scroll também faz zoom. O fechamento por mouseleave é
  SUSPENSO enquanto houver botão do mouse pressionado dentro do popover
  (`previewInteragindo`): no arrasto da alça de resize o ponteiro escapa do
  popover e o timer de 250 ms o fecharia na mão do usuário. PDF: no máximo UM
  blob URL vivo, revogado em todo fechamento/re-render; acima de 15 MB não
  decodifica no hover (o `atob` travaria a UI) — só metadados + "Abrir em nova aba"
  (posse do URL transferida, revogação com 30 s de folga). Texto: `textContent`,
  nunca innerHTML (conteúdo dos autos). CSP hostil da página (embed de `blob:`
  barrado) é detectada pelo evento `securitypolicyviolation` no `document` → flag de
  sessão + fallback com metadados ("Abrir em nova aba" escapa: navegação de topo não
  é governada pela CSP da página). TODOS os listeners são delegados no `.doclist`
  (as rows são recriadas a cada `setDocs`, que chama `hidePreview()`; `filtrarDocs`,
  `aplicarModo`, scroll da lista e Esc também fecham — o Esc do preview faz
  `stopPropagation` para não cancelar o modo minuta junto).

## Exportação das peças em `.zip` (zip.js + exportar.js + content.js)

Botão **⬇ Baixar .zip** na faixa `.docs-tip`, irmão de "⟳ Carregar todas as peças"
(as duas são ações sobre a lista INTEIRA; a `.toolbar` já estava apertada com cinco
botões em 484px). Existe para trabalhar os autos **fora** da extensão — no Claude
Code, num script, num arquivo de caso. Regras que não podem quebrar:

- **Sem a permissão `downloads`**, pela MESMA razão que fez a grid virar iframe: ela
  muda o aviso de instalação da Web Store numa extensão já publicada. Blob + âncora
  `download` (`baixarBlob` em content.js, o caminho que o mapa e a minuta já usavam)
  resolve, e como o resultado é **um** arquivo não há a enxurrada de downloads que a
  API `chrome.downloads` evitaria. A revogação do object URL tem 120 s de folga — o
  Chrome lê o blob DEPOIS do clique e um zip de centenas de MB demora a gravar.
- **`src/zip.js` (`ZipW`) é um escritor de ZIP próprio**, ~200 linhas: cabeçalho
  local + diretório central + EOCD, CRC-32 tabelado e deflate pela
  `CompressionStream("deflate-raw")` nativa. Vendorizar (JSZip/fflate) traria
  30–100 KB e um terceiro para auditar, para resolver a parte fácil. Sem Zip64
  (tetos de 4 GB e 65.535 entradas, com erro claro). **Cada entrada vira um Blob
  assim que é produzida** e o arquivo final é `new Blob(partes)`: concatenar num
  Uint8Array mataria a aba num processo grande. Deflate só no que ENCOLHE — PDF já
  é contêiner deflacionado, e `montarZip` passa `comprimir:false` nele.
- **`src/exportar.js` (`PjeExport`) é PURO**: não conhece `docsCache`, `PJE` nem o
  painel — recebe `docs`, a `ficha` e um `obter(id)`. É o que permite testá-lo fora
  do navegador (o ZIP gerado é validado pelo `zipfile` do Python, um leitor
  independente — escritor conferido pelo próprio leitor não prova nada).
- **`NNN_Titulo-limpo_ID.ext`**: o `NNN` é a posição CRONOLÓGICA no processo (não o
  índice do laço), para a ordenação alfabética da pasta coincidir com a ordem dos
  autos; o `ID` fica no nome porque **o nome do arquivo é o único metadado que
  sobrevive a sair da ferramenta**. O prefixo `123456 - ` do título é removido
  (`\d{6,}`, mesmo limiar do regex da timeline) para o id não aparecer duas vezes.
  **Peça que falha CONSOME o seu número** e a pasta fica com um salto (…002,
  004…). O salto é mantido de propósito — renumerar desalinharia a ordem —, mas
  não pode ficar mudo: a falha é gravada COM a `ordem`, e o `indice.txt` e o
  `LEIA-ME.md` dizem que o salto é a peça que faltou, não erro de contagem.
- **`ehBin` (PDF ou imagem) ≠ "tem páginas"**: os dois viajam em base64 e não
  passam pelo deflate, mas só o PDF tem contagem de páginas para declarar no
  índice — `paginas` sai de `c.kind === "pdf"`, nunca de `ehBin`. Ler `ehPdf`
  ali depois da renomeação foi o que derrubou a exportação inteira (ver a nota
  do `no-undef` em "Desenvolvimento e teste").
- **A ordem cronológica tem duas fontes e o critério vai ESCRITO no índice**: a data
  de juntada (só existe quando a grid foi lida) é dado; a inversa da ordem da tela é
  PREMISSA (o PJe lista do mais recente para o mais antigo). Peça sem data mantém a
  posição relativa — mover para um extremo seria inventar cronologia.
- **Três arquivos de metadados**, e o ZIP se explica sozinho no destino:
  `LEIA-ME.md` (convenção de nomes, formato de citação `(Título, id 123456, fl. 7)`,
  limites conhecidos), `indice.txt` (ficha do processo + **uma linha por peça**,
  campos separados por `" | "`, SEM truncar — uma tabela alinhada com dez campos só
  caberia cortando o nome de quem juntou a peça, que é justamente o que se pergunta
  a um índice) e `indice.json`. O formato de citação aqui é a **QUINTA** saída da
  regra peça·id·folha — ao editar `PROMPT_INICIO`/`SYSTEM_PROMPT_CIT_TEXTUAL`/
  `SUFIXO_MINUTA`/`SUFIXO_MAPA`, editar este também.
- **Ficha do processo** (`PJE.lerCabecalhoProcesso`): raspa `#maisDetalhes`
  (`dl.dl-horizontal` em blocos IRMÃOS — órgão julgador, cargo e competência vivem
  em `<dl>` próprios, por isso varre TODOS) e `#poloAtivo`/`#poloPassivo`. O titular
  sai do `<td>` com as `<ul>` REMOVIDAS de um clone; sem isso o nome do advogado
  colaria no da parte. `parsePessoa` corta o nome no primeiro `" - CPF|CNPJ|OAB"`,
  nunca no primeiro hífen (quebraria "BANCO ITAU CONSIGNADO S.A." e sobrenomes
  compostos). Tudo best-effort: falha vira `null` e a exportação segue sem a ficha.
- **`lerLinhas` guarda as colunas desconhecidas em `extras`**: a grid varia por
  tribunal (sigilo, matéria, órgão…) e um parser que só lê as cinco colunas
  conhecidas joga fora exatamente o que aquele tribunal tem de particular.
  `mesclarDocs` (content.js) **precisa repassar `extras`** junto de
  `tipo`/`juntadoEm`/`juntadoPor`: a peça que está nas DUAS fontes é o caso
  comum, e deixar o campo de fora ali fazia ele sobreviver só nas peças que a
  timeline não alcançou — o inverso do que ele existe para resolver.
- **Segredo de justiça vira banner no topo** do `LEIA-ME.md` e do `indice.txt`, e
  `segredoDeJustica` no JSON — muda como o pacote deve ser tratado, então não pode
  ser mais uma linha no meio da ficha.
- **Concorrência**: a exportação e qualquer turno disputariam a MESMA sessão JSF
  (o download do PJe é serializado). `exportando` bloqueia envio/minuta/mapa
  (`bloqueadoPelaExportacao`), o download do preview e — o caso não óbvio — a
  **camada 2 da estimativa dinâmica**: as ativações da exportação mexem na timeline,
  o que dispara `syncSelection` o tempo todo, e o refinamento sairia baixando peças
  em paralelo. A camada 1 (estimativa local) continua, que é de graça. A guarda é
  **recíproca com "⟳ Carregar todas as peças"**: a rota 1 (grid) faz submits A4J
  dentro do iframe, então ela recusa enquanto `exportando` e a exportação recusa
  enquanto `carregandoTimeline` — é o único outro caminho que mexe no JSF sem
  passar por `bloqueadoPelaExportacao`.
- **Cancelável**: `startPrep(items, {titulo, fim, onCancelar})` ganha um botão
  Cancelar quando há `onCancelar` (300 peças a ~5,6 s são ~28 min). O
  `sinal.cancelado` é conferido no topo de cada peça **e uma vez depois do
  laço**: cancelar durante a ÚLTIMA peça escaparia da guarda do topo e entregaria
  o download assim mesmo. No
  `setPrepState`, o estado **`erro` também adianta o contador** — sem isso a barra
  de uma exportação com falhas nunca chegaria ao fim. Sem `opts`, o card é byte a
  byte o do preparo de envio.

  **Estados de uma peça no card**: `wait` → `loading` (baixando) → `upload` (subindo
  à Files API, só nos PDFs) → `done`; ou → `erro`, quando o **download** falha. Três
  regras que não podem cair:
  - **`prepDone` é IDEMPOTENTE**: conta peças PRONTAS, não transições. Com mais de
    uma fase, um `done` repetido levaria o contador além de N/N e a barra além de
    100%. Protege também a exportação, que usa os mesmos estados.
  - **Nem toda peça sobe** (`precisaUpload`, extraída para ser a fonte ÚNICA da
    regra e usada pelos dois lados): HTML, RTF e imagem vão inline e ficariam presas
    em `upload` para sempre.
  - **Falha de UPLOAD não é `erro`**: a peça cai no fallback base64 e ENTRA no
    request; marcar erro sugeriria que ela ficou de fora. Falha de upload → `done`;
    `falhas` (download) continua sendo a única lista de peças ausentes.

  Antes disso o contador batia N/N no fim do download e o card ficava congelado em
  100% durante todo o upload, parecendo travado. `endPrep` continua onde está — é
  invariante: só depois de `montarBlocos`, que é onde o teto de base64 pode estourar.
- **Teto de 600 MB** (`TETO_BYTES`): o conteúdo vive em `docsCache` como base64
  (~1,33× os bytes) e é materializado em Uint8Array ao zipar. Estourar mata a aba
  sem dizer por quê; a mensagem manda exportar em levas marcando parte das peças.

## Seleção assistida por IA (`✨ Escolher com IA`)

Camada 2 da seleção; a camada 1 (`classificarPeca`, por regex) continua sendo o
padrão instantâneo e é a única que funciona sem chave, offline e em 0 ms. O botão
vive na `.docs-tip` (escopo "lista toda", regra do DESIGN.md §5), ao lado de
`⟳ Carregar tudo` e `⬇ Baixar .zip`.

- **Só a LISTA sai no request** — `#nº | id | título | tipo | data | quem juntou |
  etiqueta da triagem local | páginas`, nenhum byte de conteúdo de peça. É um chat
  comum e ISOLADO (sem tools, sem blocos `document`, fora de
  `conversation`/`pecasNaConversa`), como a minuta e o mapa: por isso funciona nos três
  provedores. ~28 tokens por peça (200 peças ≈ 5,7 mil tokens).
- **A lista vai em ordem CRONOLÓGICA, e isso é correção de um defeito**
  (`listaParaIA` reusa `PjeExport.ordenarCronologico`, a mesma da exportação em
  `.zip`): a lista da tela vem do mais RECENTE para o mais antigo, e o prompt
  antigo dizia "a primeira 'Petição' costuma ser a inicial" — apontando o modelo
  para a petição mais recente, o oposto do que se queria, justamente na peça mais
  importante do processo. As linhas são numeradas e o critério da ordenação (dado
  ou premissa) vai DITO no texto.
- **Os SINAIS valem mais que o raciocínio** — é a aposta desta camada. Cada linha
  leva também **quem juntou** (distingue a petição do autor da do réu), o **tipo
  oficial** (só quando difere do título — senão é token puro), a **etiqueta da
  triagem local** (`classificarPeca`, apresentada como palpite, não veredito) e o
  **nº de páginas** quando a peça já foi baixada (uma "Petição" de 2 páginas é
  encaminhamento; de 40, é a inicial). `docsCache` é um **Map**: acesso por
  colchetes devolveria `undefined` sempre, e a falha seria muda.
- **`effort` BAIXO, qualquer que seja a preferência salva** (`EFFORT_TRIAGEM`, via
  `payload.effort` → override em `executarTurno`): a triagem é classificação sobre
  metadados, e com raciocínio alto o usuário esperava dezenas de segundos por uma
  lista de ids — a queixa que originou a rodada. O override é por turno e não toca
  na configuração, que segue valendo para o chat.
- **System PRÓPRIO e enxuto** (`systemTriagem`): o system do chat traz regras de
  citação por página, de não-invenção, de busca web e do inventário — nada disso se
  aplica a quem não lê peça nenhuma, e ainda são ~900 tokens a conciliar. O que
  importa dali é a FICHA do processo (classe, assunto, partes), que `contextoDoProcesso`
  já monta e diz o que é relevante NESTE caso.
- **Marcação AO VIVO** (`idsParciais` + `marcarParcial`): os `ids` são o primeiro
  campo do JSON, então as peças acendem na lista enquanto o modelo ainda escreve os
  motivos — a espera vira progresso visível. Só id fechado entre aspas conta (um id
  pela metade marcaria a peça errada). Como isso mexe na seleção antes de o turno
  terminar, o painel manda a seleção anterior no callback (`iaCb(docs, texto,
  getSelected())`) e **erro ou resultado vazio restauram o estado do usuário**.
- **Acima de `MAX_LINHAS_IA` (400) o corte é pelo MEIO**, não pelas pontas: a
  inicial está no começo e a sentença no fim; o miolo é onde vive o expediente
  repetitivo. A omissão vai dita numa linha própria — sem cap silencioso.
- **Sob demanda, nunca automático**: nada acontece sem o usuário pedir — zero custo
  surpresa, zero latência não solicitada, e o resultado é sempre atribuível a uma ação
  dele (coerente com o guia do painel afirmar que a extensão não é agente autônomo).
- **O texto do campo vira o OBJETIVO** e NÃO é consumido: "houve prescrição?" traz
  peças diferentes de "qual o valor da causa?"; vazio, o objetivo é descrever o
  processo. A pergunta continua no campo, pronta para enviar com as peças certas.
- **A escolha SUBSTITUI a seleção** — contrato oposto ao dos três degraus, que somam.
  Uma escolha que só acrescenta não é uma escolha: se a IA concluiu que a peça é
  irrelevante e ela segue marcada, o pedido não foi atendido.
- **O parser assume que o modelo vai desobedecer** (`lerJsonEscolha`): corta do
  primeiro `{` ao último `}` (sobrevive a cerca ```` ``` ```` e preâmbulo), descarta id
  que não está na lista, deduplica repetidos e, se nada sobrar, **não desmarca nada**
  e diz o que fazer. Cada uma dessas defesas tem teste.
- **Auditável**: o motivo de cada peça vai no `title` da row e o critério na
  `.sel-nota` — o usuário precisa poder discordar.

## Tolerância a falha de download (invariante do envio)

Peça que falha ao baixar **não interrompe o turno**. O PJe devolve 404 em peças que
existem na lista mas não têm download servível (atos ordinatórios de sistema anterior,
por exemplo), e uma única dessas abortava a análise inteira: o usuário desmarcava,
reenviava, e caía na seguinte.

`baixarSelecionadas` devolve `{ok, falhas}` em vez de lançar; o envio segue com `ok` e
**só as peças que realmente entraram** vão para `pecasNaConversa` (as que falharam
continuam elegíveis na próxima tentativa). `montarBlocos` pula id sem cache por
construção — um `TypeError` ali derrubaria o turno por causa de uma peça. Minuta e mapa
seguem a mesma regra. Só quando **nenhuma** peça baixa é que o turno falha.

O relatório vai para o CHAT (`panel.mostrarFalhasPecas`), não para o `.status`
(transitório) nem para a `.alertbar` (que é para o que impede de continuar): a análise
seguiu, e o usuário precisa poder ler com calma o que faltou e por quê.

## Seleção em faixa na lista de peças (panel.js)

Marcar 40 petições em sequência não pode custar 40 cliques. Três gestos, todos sobre os
MESMOS checkboxes (fonte de verdade) e todos respeitando o **filtro ativo** (só rows
visíveis, como o "todas" e o "principais"):

- **arrastar** — marca/desmarca a faixa por onde o ponteiro passa. Exigiu
  `user-select: none` na `.docrow`: sem isso o gesto pintava a lista de azul de
  seleção de TEXTO e não marcava nada. Exceção: `.d-id` continua `user-select: text`
  (o número da peça se copia para procurar no PJe) — **e a exceção reintroduziu o
  bug**: o ponteiro cruzando os ids começava a selecionar texto e o arrasto morria.
  A classe `.arrastando` no `.doclist` (posta no pointerdown, tirada no pointerup)
  suspende o `user-select` de TODOS os descendentes durante o gesto; parado, o id
  volta a ser copiável. A row de ORIGEM é marcada no primeiro `pointerover` de
  outra row (`origemMarcada`): o `<label>` só a alterna quando o gesto vira clique,
  então arrastar da peça 1 até a 5 marcava 2,3,4,5 e deixava de fora justamente
  aquela onde o dedo começou.
- **Shift+clique** — do último item tocado até este. `preventDefault` no
  `pointerdown`, senão o `<label>` alternaria só a row clicada.
- **botão direito** — menu com "daqui para baixo/cima", que resolve quando o outro
  extremo está fora da tela.

`ancoraSel` é zerada em `setDocs` e em `filtrarDocs`: os índices são posicionais e
deixam de valer quando a lista muda. **`.selmenu` e `.confirmbox` são
`position: fixed`** — o `.wrap` é um container de tamanho ZERO (quem tem dimensão é o
`.panel`), então posicionar por dentro dele joga o elemento para fora da tela.

## Popup de menção `@` (panel.js)

Detecção por regex do token `@busca` antes do caret (`findMentionToken`); busca ignora
acentos via `norm()` (NFD + remoção de diacríticos). Ao selecionar, o token é removido do
texto e o checkbox correspondente é alternado. Detalhes fáceis de quebrar:

- As linhas do popup usam `mousedown` + `preventDefault()` (não `click`) para agir antes
  do `blur` do textarea.
- `Enter`/`Tab` com popup aberto selecionam; só com popup fechado o `Enter` envia.
- `updateMention()` é chamado em `input`, `click`, `keyup` (setas/Home/End) e em
  `setDocs()` — todos os caminhos que movem o caret ou mudam a lista.
- Cap de `MENTION_MAX` itens com linha "… e mais N peças" quando excede.
- **Busca visível** (`.mention-q`): um campo de busca FALSO (lupa + texto +
  cursor piscando + contador "N peças") entre o cabeçalho e a lista espelha
  a query digitada após o `@` — a digitação continua no textarea (não é um
  input; `aria-hidden`, atualizado em `renderMention` via `mention.query`/
  `mention.total`). Sem ele ninguém descobria que dava para filtrar.
- **Busca sem resultado NÃO fecha o popup** (até 20 chars de query): mostra o
  estado vazio ("nenhuma peça…") — o campo de busca sumir no meio da digitação
  parecia travamento. ACIMA de 20 chars sem resultado o popup FECHA: o usuário
  está escrevendo a frase (um "@" que não é peça), não buscando — sem isso o
  popup ficava aberto re-renderizando a cada tecla até o fim da mensagem.
  Com a lista vazia o teclado é liberado (só Esc é capturado): Enter ENVIA a
  mensagem normalmente — capturá-lo bloquearia mensagens com "@algo" que não
  é peça — e as setas movem o caret.
- **Cursor falso do campo de busca**: reiniciado a cada `renderMention`
  (`style.animation = "none"` + reflow + limpa) — fica SÓLIDO enquanto se
  digita e pisca só parado, como um cursor real; `.mq-t` usa `white-space:
  pre` e a query CRUA (sem trim) para o espaço final mover o cursor; no
  vazio o `order` põe o cursor ANTES do placeholder.

## Biblioteca de prompts — popup `/` e chip (prompts.js + panel.js)

Prompts reutilizáveis do usuário (título + texto): digitar `/` no campo abre um popup
com os prompts salvos; selecionar liga um CHIP na `.promptbar` (faixa fundida ao topo
da `.inrow`) e o texto do prompt PRECEDE a mensagem **no envio**. CRUD num modal
(`.plib`) dentro do Shadow DOM, aberto pelo botão `✦ Prompts` da barra de ferramentas
ou pelas linhas de ação do próprio popup. Regras que não podem quebrar:

- **Gatilho só no INÍCIO da mensagem** (`findSlashToken`, regex `^\s*\/([^/@\n]*)$`
  sobre o texto antes do caret): a barra é onipresente em texto jurídico
  (`01/02/2026`, `art. 5º/CF`, `e/ou`) — a regra do `@` (dispara após espaço) geraria
  falso positivo a cada frase. Um segundo `/` ou um `@` na query fecham o popup por
  construção. Ambos os popups nunca abrem juntos: os tokens são disjuntos.
- **A concatenação acontece no PAINEL** (`montarTextoEnvio`, `prompt + "\n\n" + texto`;
  campo vazio envia o prompt sozinho): `sendCb`/`minutaCb`/`mapaCb` seguem recebendo
  `(texto, ids)` e **content.js/protocolo/histórico não mudam em nada**. A bolha do
  usuário mostra o texto combinado de propósito — é o que foi à API.
- **Um prompt por mensagem**: `promptAtivo` é objeto único; escolher outro substitui o
  chip; o envio o consome (`setPromptAtivo(null)`), e "Nova conversa" também o solta.
- **`storage.sync`, um item por prompt** (`plib:<id>`): a cota é de 8.192 B POR ITEM —
  `PLIB.tamanhoOk` valida os bytes REAIS com `TextEncoder` (não `.length`: texto
  jurídico é acentuado, multibyte) e o `set` sempre confere `chrome.runtime.lastError`
  (cota total/rate-limit). `AREA` em prompts.js é o único ponto de troca sync↔local —
  trocar não migra os dados. O `aoMudar` filtra a área `sync` + prefixo, sem colidir
  com o `storage.onChanged` de `"local"` do content.js.
- **Espelho do popup `@`**: rows usam `mousedown`+`preventDefault` (o blur do textarea
  fecha em 120 ms), `updateSlash` roda nos MESMOS 4 gatilhos (`input`, `click`, `keyup`
  de setas, `blur`) e o bloco do `/` no `keydown` vem ANTES do `@` e do Enter genérico.
  Sem resultado na busca o teclado é liberado (Enter envia a mensagem que começa com
  "/" literal); as ações fixas seguem clicáveis pelo mouse.
- **Esc em cascata**: `/` → `@` → modal (o keydown do `.plib-card` faz
  `stopPropagation`, senão cancelaria o modo minuta junto) → modo minuta.
- **Exclusão em dois cliques** ("excluir" → "excluir?"), nunca `confirm()` nativo: o
  dialog da página vive fora do Shadow DOM e congela a extensão.
- **minuta + prompt convivem**: com chip ativo e campo vazio, o botão `.btn-minuta` NÃO
  injeta a `INSTRUCAO_MINUTA_PADRAO` (o prompt já é a instrução da minuta).
- `PLIB` ausente (harness sem o content script) esconde o botão e desliga a feature
  em silêncio — nada quebra.

## Minuta e editor de texto — página `src/editor.html`

Substitui o antigo `.docx` por skill da Anthropic (removido: era a maior fonte de
complexidade — code execution, `container`, três betas, keepalive dedicado — e só rodava
no Claude). Agora o modelo devolve **markdown** e a extensão o abre num **editor WYSIWYG**
(Jodit) numa aba própria; o `.docx` é gerado **no cliente**, igual nos dois provedores.

Botão "✍️ Minutar" liga o **modo minuta** (`setMinutaMode` em `panel.js`), clone exato do
contrato do modo mapa: instrução padrão editável no campo, faixa `.minutabar`, Enviar vira
"✍️ Gerar minuta", ✕/Esc/segundo clique cancelam. Mutuamente exclusivo com o mapa; "Nova
conversa" desliga ambos. O turno (`panel.onMinuta` → handler em `content.js`) é um **chat
comum** (sem tools/skills/`container`) — por isso funciona nos dois provedores. Regras:

- **Request isolado, como o mapa**: `prepararEnvio([{role:"user", content:[...blocos,
  instrucao + SUFIXO_MINUTA + lista de ids]}], null)`. Não entra em `conversation` nem em
  `pecasNaConversa` — gerar uma minuta não altera a conversa em andamento.
- **`SUFIXO_MINUTA` é prescritivo de propósito** (mesma razão do `SUFIXO_MAPA`): só
  Markdown, sem preâmbulo nem cerca ```` ``` ````, um `#` (nome do ato) e `##` nas seções;
  prosa em parágrafos, não bullets; **origem obrigatória** `(Título da peça, id 123456,
  fl. 7)` — o documento circula FORA da extensão, sem citação nativa nem timeline para
  conferir; nada inventado (o que falta vira `[COMPLETAR: …]`); sem assinatura/cabeçalho de
  tribunal (o PJe já põe). A lista explícita de ids vai no texto (sem ela o modelo inventa
  o id). `limparMarkdownMinuta` tira cerca e preâmbulo que escapem.
- **Canal de dados = `chrome.storage.local`** (não `session` como o mapa): a minuta precisa
  sobreviver ao fechar o navegador, e o content script acessa `local` direto — **sem RPC
  nova no worker**. `guardarMinuta` grava `minuta:<id>` com `{md, titulo, processo,
  criadoEm, atualizadoEm}` — **o Markdown CRU, não HTML** —, poda para os 10 mais recentes e
  descarta acima de 7 dias, e devolve a URL `src/editor.html?id=…`. ISTO GRAVA TRECHO DOS
  AUTOS NO DISCO (a única persistência do gênero na extensão): daí a poda dupla, o botão
  "Descartar", a lista de recuperação e as notas no `PRIVACY.md`/`help.html`.
- **Conversão Markdown→HTML é do `MinutaMd` (`src/minuta-md.js`), NÃO do `renderMd` do
  chat**: o renderMd do painel é o renderizador de BALÃO — achata listas aninhadas e junta
  parágrafos com `<br>`, inaceitável num documento. O `MinutaMd` (parser dedicado, testado)
  faz **listas aninhadas reais** (pilha por indentação), tabelas com alinhamento, parágrafos
  de verdade, títulos no nível certo (# → h1) e o mesmo *escape-first* de segurança (o texto
  vem dos autos). A conversão roda na PÁGINA do editor (script normal, sem a limitação de
  content script) na 1ª abertura; o HTML editado é gravado de volta e reusado depois.
- **Recuperação de rascunhos** (`listarRascunhos` em editor.js): sem uma lista, o rascunho
  ficaria órfão no disco. O botão "🗂 Rascunhos" abre um dropdown com os `minuta:*` (mais
  recente primeiro); `editor.html` SEM `?id` vira a própria lista (modo-lista); o popup e
  **Configurações → Suas bibliotecas** têm a porta de entrada "📝 Minhas minutas".
  No modo-lista some a barra de ferramentas E o próprio botão "🗂 Rascunhos"
  (`.modo-lista .acoes .grupo`): a página inteira já É a lista, e o dropdown repetia o
  mesmo conteúdo por cima dela. O `.drop` é ancorado à **direita** (`right: 0`) porque o
  `.drop-wrap` fica no canto direito do cabeçalho — com `left: 0` os 280px de largura
  saíam da janela e o painel aparecia cortado. O estado vazio da PÁGINA é próprio
  (`vazioPaginaHtml`, com orientação e links), diferente do compacto do dropdown, e o
  texto do rodapé é reescrito: o padrão fala de "Descartar" e de conferir citações,
  instruções do editor que não existem numa tela que só lista.
- **Card no chat, aba no clique** (`panel.mostrarCardMinuta`, clone do `mostrarCardMapa`): a
  bolha vira card "Minuta gerada" com "Abrir no editor" (`window.open` no clique — a resposta
  demora e o gesto do "Gerar" já expirou; navegação de topo é imune à CSP do tribunal) e
  "Baixar .md". Depois de `mostrarCardMinuta` NÃO se chama `updateAssistant` nesse elemento.
- **Oferta em respostas de chat comuns** (`panel.adicionarAcaoEditor`): ao fim de um turno
  normal, uma ação "Abrir no editor" abaixo da bolha (irmã do `.body`, sobrevive a
  `updateAssistant`). Vira botão em DESTAQUE quando `pareceMinuta(text)` (a **primeira
  heurística de intenção** do projeto: VERBO de redação + ESPÉCIE de peça, com VETO para
  pedidos de leitura) reconhece um pedido de peça redigida — a heurística NÃO toca no
  request nem no system prompt, só a proeminência do botão.

### A página do editor (`src/editor.html`/`.js`/`.css` + `src/editor-docx.js`)

- **Jodit** (`vendor/jodit.min.js`, global `Jodit`, MIT) monta a barra FORA da folha (config
  `toolbar: "#barra"`): a largura da folha é A4 e a barra na folha quebraria em duas filas.
  A largura A4 vive no `.folha-wrap`, não no `.jodit-container` — o Jodit escreve
  `max-width:100%;width:auto` no style inline do container, e inline vence classe.
  Tipografia forense (Times 12, 1,5, justificado, recuo 1,25 cm) no `.jodit-wysiwyg`, e
  `@media print` esconde topo/barra e imprime só a folha.
- **`.docx` no cliente** (`vendor/docx.iife.js`, global `docx`, MIT): `EditorDocx.gerarBlob`
  em `editor-docx.js` percorre o DOM do conteúdo (via `DOMParser`, que não executa scripts —
  o HTML teve origem no modelo) e monta `Paragraph`/`TextRun`/`Table` com page setup A4 +
  margens 3/2 cm, numeração declarada e estilos de título; `docx.Packer.toBlob()` → Blob +
  `<a download>` (sem permissão `downloads`). **Editar `editor.css` e `editor-docx.js`
  juntos**: as medidas forenses estão nos dois e precisam bater (o que se vê é o que se
  imprime/exporta).
- **Copiar formatado**: `navigator.clipboard.write` com `ClipboardItem text/html+text/plain`
  (exige `"clipboardWrite"` no manifest), com fallback de `execCommand("copy")` sobre uma
  seleção na própria página. **Descartar** é exclusão em dois cliques (nunca `confirm()`
  nativo, que congela a página).
- **CSP da extensão veta scripts externos** (`script-src 'self'`): o Jodit em config PADRÃO
  puxa o `ace` (modo código) e o `js-beautify` de cdnjs — ambos bloqueados. Por isso o
  `montarEditor` fixa `beautifyHTML:false`, `sourceEditor:"area"` e **remove o botão
  `source`**: o editor de minutas é WYSIWYG puro, sem visão de HTML cru (que também não
  faria sentido para o usuário). Não reintroduzir o botão `source`.
- `vendor/` é **intocado**; nenhum bundle entra em página de tribunal. `src/editor.html`
  está em `web_accessible_resources` (aberto de `*.jus.br`); os subrecursos não precisam.

## Biblioteca de modelos de peças (`modelos.js` + `panel.js` + `content.js`)

Peças-modelo do usuário (sentenças, decisões, despachos, ofícios, atas, mandados) para
o assistente **imitar a forma** ao gerar minutas. `src/modelos.js` expõe o global `MLIB`,
irmão do `PLIB`, com diferenças de propósito:

- **`chrome.storage.local`, um item por modelo** (`modelo:<id>`), NÃO `sync`: uma
  peça-modelo (mesmo real) passa dos 8.192 B/item do sync. `AREA` é o único ponto de
  troca; o `aoMudar` filtra área `local` + prefixo `modelo:` para não colidir com o
  `onChanged` de config do content.js nem com o do `PLIB` (área `sync`). Cada item tem
  **categoria** (a espécie) e descrição além de título + texto. Teto por item
  `TETO_BYTES` = 60000 (barreira de sanidade, não da API — local não tem cota por item).
- **Gated a modelos de 1M tokens** (`setModelosHabilitado` no painel, chamado por
  `aplicarCapsNaUI` com `caps.contextTokens >= 1000000`): a minuta manda os autos
  inteiros + vários modelos, o que só cabe nas janelas de 1M — no Haiku (200k) o botão
  **📚 Modelos** e o seletor da minuta somem (a minuta comum segue funcionando). Ao vivo
  na troca de modelo; fecha o modal se ele estiver aberto quando desabilita.
- **Seleção por CATEGORIA, não por modelo** (decisão de produto): o seletor da
  `.minutabar` escolhe uma espécie e `modelosMinutaSelecionados()` reúne TODOS os modelos
  daquela categoria (ordenados por recência) até dois tetos — `MODELOS_MAX_ENVIO` (12) e
  `MODELOS_TETO_CHARS` (180000, ~45k tokens; o 1º sempre entra). Corte avisado no console
  (sem cap silencioso). A categoria é pré-selecionada por `detectarCategoria` (espelha o
  agrupamento de `MINUTA_ESPECIE`); o usuário pode trocar. Passa via `minutaCb(t, sel,
  modelos)` — a assinatura ganhou o 3º arg, e sem modelos o comportamento é byte a byte
  o de antes.
- **A linha de modelos da `.minutabar` NUNCA some por biblioteca vazia**
  (`atualizarSeletorMinuta`): sem nada cadastrado ela mostra "nenhuma peça-modelo
  cadastrada" + o botão **Cadastrar modelo** (abre o `.mlib` já no formulário).
  Esconder era o defeito relatado: quem nunca cadastrou ligava o modo minuta,
  não via vestígio da feature e concluía — com razão — que ela não existia. É a
  mesma regra da `.sel-nota` nos degraus de seleção: **conjunto vazio se
  explica, não desaparece**. Só o gate de janela (< 1M) e a ausência do `MLIB`
  escondem a linha inteira; ali o botão da barra de ferramentas, DESABILITADO
  com tooltip, já é a explicação. `modelosMinutaSelecionados` ganhou a guarda
  `minutaModeloSel.hidden` — com o wrap visível, "não há o que enviar" deixou de
  depender de o `<select>` estar sem opções.
- **O caminho do CHAT comum também precisa apontar para os modelos**
  (`adicionarAcaoEditor`): pedir a peça no chat e clicar em "Abrir no editor" é
  um turno de chat, que nunca passa pela `.minutabar` — a biblioteca ficava
  invisível justamente para quem acabou de pedir uma peça redigida. Quando a
  heurística `pareceMinuta` acende o destaque E há modelos cadastrados, entra ao
  lado uma ação secundária "Refazer seguindo seus modelos", que só clica no
  `.btn-minuta` (reusa validação de peças marcadas e exclusividade com o mapa).
  Ela devolve o **pedido original** ao campo antes disso (`info.pedido`, posto
  pelo content.js com o `text` do turno): sem isso o `.btn-minuta` veria o campo
  vazio e injetaria a `INSTRUCAO_MINUTA_PADRAO` — genérica —, trocando "sentença
  de improcedência pela prescrição" por "redija a peça adequada", num clique
  cujo nome promete REFAZER o mesmo pedido. Campo já preenchido nunca é
  sobrescrito. Ela precisa de CSS próprio porque
  `.editor-act.destaque button` pinta TODO botão do bloco com o gradiente da
  ação principal — dois destaques disputariam o mesmo clique.
- **Testar a UI da biblioteca em jsdom exige `<script>` de verdade, nunca
  `w.eval()`**: `modelos.js` e `prompts.js` declaram `const MLIB`/`const PLIB`
  no topo, e uma declaração léxica dentro de um `eval` morre com ele — entre
  scripts clássicos do mesmo realm ela é compartilhada, que é como o Chrome
  executa content scripts. Com `eval`, `typeof MLIB` dá `"undefined"` dentro do
  panel.js e a feature inteira some: um falso positivo de bug convincente.
- **Moldura anti-contaminação** (`molduraModelos` em content.js): o(s) modelo(s) entram
  como **um bloco de texto** (nunca `document`/`file_id` — não é peça dos autos, não é
  citável) e é o **PRIMEIRO** do content da minuta (antes das peças, no prefixo
  cacheado). Vai em **XML** (`<modelos_de_referencia>` com `<modelo n="i">`), não
  Markdown, porque o conteúdo interno é Markdown e a tag é a única fronteira que o modelo
  não confunde com a resposta. A instrução manda **analisar, escolher a base mais
  adequada e reaproveitar estrutura e LINGUAGEM** das outras, mas **nenhum FATO** (nomes,
  valores, datas, dispositivos) — esses saem só das peças do processo em tela; o que
  faltar vira `[COMPLETAR: …]`. Tags `<modelo…>` acidentais no texto do usuário são
  removidas (regex `limpar`) para não quebrar a moldura — o `<` comum do texto jurídico é
  preservado.
- **Página própria `src/modelos.html`** (+ `modelos-page.js`/`.css`), alcançável por
  **Configurações → Suas bibliotecas**, pelo rodapé do popup e pelo estado vazio de
  `editor.html`: cadastrar modelos é tarefa de PREPARAÇÃO e não deveria exigir uma aba
  de autos aberta só para chegar ao modal do painel. A camada de dados é a MESMA
  (`MLIB`), então o que se cadastra ali aparece no painel na hora (`aoMudar`), e não há
  esquema novo. A página **não** precisa entrar em `web_accessible_resources`: só é
  aberta de contextos de extensão (options/popup/editor), nunca de uma página `jus.br`.
  A lista é **agrupada por categoria** (a etiqueta repetida em cada linha competia com
  o título, e a categoria é o eixo em que se pensa aqui — é por ela que a minuta
  seleciona); a linha inteira abre a edição; excluir segue em dois cliques.
- **Funciona nos DOIS provedores** (a minuta é chat comum, sem gating por nome de
  modelo) e grava **trecho de outros processos no disco** (como os rascunhos de minuta):
  daí a nota no `PRIVACY.md`/`help.html` e a exclusão fácil na biblioteca (dois cliques,
  nunca `confirm()` nativo). O modal `.mlib` reaproveita todo o visual do `.plib`
  **carregando as duas classes** (`class="mlib plib"`, `mlib-card plib-card`…) — por
  isso o bloco `.mlib` tem de continuar DEPOIS do `.plib` no template: os seletores do
  PLIB são `$(".plib")`/`$(".plib-card")`/`$(".plib-cnt")` sem escopo, devolvem o
  PRIMEIRO match e passariam a apontar para o modal errado se a ordem invertesse. Os
  handlers de lista dos dois são delegados e escopados no próprio `.*-list`, então só a
  ordem no DOM segura essa fronteira.

## Importar peças-modelo de `.docx` (docx-importar.js + modelos.js + as duas cascas)

Cadastrar dez modelos não pode custar dez formulários. O usuário solta 5–10 `.docx`
de uma vez, cada arquivo vira uma **ficha** já preenchida e um clique cadastra todas.
Existe nos DOIS lugares — modal `.mlib` do painel e página `src/modelos.html` —, com
a lógica compartilhada e só a casca escrita duas vezes.

- **`src/docx-importar.js` já existia** (leitor de um arquivo, usado só na página) e
  **não estava no `manifest.json`** — por isso o modal do painel não tinha importação
  nenhuma. Ele entra nos content_scripts **entre `modelos.js` e `panel.js`**. O IIFE
  não toca em nada de ambiente na definição (`DecompressionStream` é checado dentro do
  `lerArquivo`, `DOMParser` só dentro do `textoDoXml`), então acrescentá-lo não pode
  quebrar o boot. `panel.js` o trata como **opcional** (`typeof DocxImport !==
  "undefined"`, igual ao `MLIB`): sem ele o botão Importar some e o resto funciona —
  é o que mantém o harness de boot verde sem stub novo.
- **Nenhum global novo.** `lerLote` mora no `DocxImport` (dono do formato);
  `adivinharCategoria`, `chaveTitulo`, `fichaImportada`, `medirFicha`,
  `marcarDuplicados` e `salvarLote` moram no `MLIB` (dono do esquema e do storage).
  Um `modelos-importar.js` dependeria dos DOIS — seria o primeiro content script com
  duas dependências entre globais. Efeito colateral: `categoriaValida`, que era código
  morto, virou a guarda do que a adivinhação devolve.
- **`adivinharCategoria` tem TRÊS sinais, e a precedência é nome → cabeçalho →
  dispositivo.** (1) O **nome do arquivo** vence quando existe (foi decisão do
  usuário) e, dentro dele, vence o casamento **mais à esquerda** — nome é "Espécie —
  assunto", a posição carrega informação; sem isso "Despacho designando audiência de
  instrução.docx" cairia em `ata`. (2) O **cabeçalho** (12 primeiras linhas úteis) é
  **ancorado em `^`**: `textoDoXml` entrega um parágrafo por linha, e sem a âncora
  "…conforme a sentença de fls. 30" passaria por cabeçalho. (3) O **dispositivo** (18
  últimas) é o sinal mais discriminante, e ali a ORDEM da tabela é tudo — `sentenca`
  vem ANTES de `mandado` ("Publique-se… Expeça-se mandado" é sentença) e `despacho`
  vem POR ÚLTIMO (`cite-se`/`cumpra-se` estão em quase todo dispositivo). Valem as
  armadilhas de sempre: `norm()` antes de tudo, `(?<!(cumprimento|execucao|
  liquidacao|carta) de )sentenca` (sem `carta`, "Carta de sentença" viraria sentença),
  `mandado\b(?! de seguranca)`, `ata(?!\s*notarial)`, `acordao` ≠ `acordo`, e — na
  construção `\b(…)\b` — toda alternativa começando E terminando em caractere de
  palavra (`p\.r\.i`, nunca `p\.r\.i\.`, cujo ponto quebraria o `\b` de fechamento).
  Devolve `{categoria, confianca, sinal}`: o `sinal` vira o `title` do selo, porque o
  usuário precisa poder discordar sabendo de onde veio o palpite.
- **O selo "sugerida" some no PRIMEIRO `change` do seletor** (`catTocada`): ele afirma
  "isto é um palpite", e depois do toque deixaria de ser verdade. Com
  `confianca:"nenhuma"` o rótulo troca para "confira" em tom de aviso suave.
- **O teto de 60.000 é do ITEM SERIALIZADO, não do texto**: o envelope (UUID, chaves
  do JSON, dois timestamps) custa ~201 bytes, então `medirFicha` roda também a cada
  edição do TÍTULO — uma ficha cruza o teto por causa dele. Ficha acima do teto entra
  **desmarcada**, com aviso suave, e **não bloqueia o lote**; a saída para encurtar
  aparece no RESULTADO, depois de gravar os outros (`mlibAposForm`/`aposForm` levam o
  rascunho ao formulário normal com `{novo:true}` e devolvem ao resultado). Pular para
  o formulário no meio da conferência exigiria carregar N fichas por uma troca de
  tela, e perder o lote seria o pior desfecho.
- **ARMADILHA CRÍTICA — soltar arquivo FORA da zona.** Por padrão o Chrome NAVEGA para
  o `file://`, o que na página de autos mata a sessão JSF e o trabalho junto. A guarda
  precisa dos **DOIS** eventos com `preventDefault` (é o `dragover` que declara a área
  como alvo válido e cancela a navegação; só o `drop` não basta — modo de falha
  silencioso), em **`window` com `capture:true`** (eventos de arrasto são *composed*:
  atravessam o Shadow DOM e chegam ao window retargetados, então um par de listeners
  cobre o shadow tree E a página do tribunal), com funções **nomeadas** (arrow inline
  não sai no `removeEventListener`), ligada/desligada com a tela e **idempotente**. A
  guarda NUNCA chama `stopPropagation` — quem consome o evento é a zona. `dragleave`
  é por **CONTADOR** (`dragenter`++/`dragleave`--), nunca por `relatedTarget`, que vem
  retargetado para o host. Custo aceito e comentado no código: com o importador aberto
  um arquivo solto sobre a página do PJe é engolido. `impDesligar()` é chamado por
  TODOS os caminhos de saída, inclusive o gate de 1M (`setModelosHabilitado(false)` →
  `fecharMlib()`).
- **Três telas no card, um ponto único** (`mlibTela` no painel, `mostrarTela` na
  página): lista, formulário e importação são exclusivos, e "Novo"/"Importar" somem
  fora da lista (clicá-los com um lote em conferência descartaria o trabalho).
  `fecharMlibForm` PRECISA voltar para `"lista"` — ela é chamada por `fecharMlib` e
  por `abrirMlib`, e sem isso fechar com a importação aberta deixaria duas telas
  visíveis na abertura seguinte.
- **A ficha é construída com `createElement` + `.value`/`.textContent`, nunca
  `innerHTML`**: título e texto vêm de arquivo externo e o `escapeHtml` do painel não
  escapa aspa simples. Os handlers são delegados no container, com `data-i` INTEIRO
  como chave (não o nome do arquivo — evita `CSS.escape` e nomes hostis em seletor). E
  editar o título **não re-renderiza a ficha** (`pintarFicha` atualiza só o que muda):
  re-render a cada tecla arrancaria o foco do campo.
- **Nada silencioso**: erro de leitura de um arquivo não derruba o lote (vira ficha de
  erro com a mensagem do `DocxImport` verbatim, e as falhas aparecem ANTES das fichas
  — é o que explica o botão dizer "Cadastrar 7" quando foram soltos 8); cancelar a
  leitura NÃO descarta o que já foi lido; `salvarLote` serializa e AGREGA os erros em
  vez de parar no primeiro; e o resultado nomeia, um a um, tudo o que ficou de fora.
- **Descarte do lote em dois cliques** (backdrop, ✕ e Esc armam o botão Cancelar),
  nunca `confirm()` nativo. O Esc do `.mlib-card` mantém o `stopPropagation`.
- Fixtures de teste: `.docx` fabricados com o **`ZipW` do próprio repo** (escritor e
  leitor conferem campo a campo — método 8/0, CRC no cabeçalho local, EOCD).
  Armadilha do fixture: o estilo tem de ser `w:val` com o prefixo ligado ao namespace,
  senão `getAttributeNS(W,"val")` devolve `null` e a regra de heading nunca dispara.

## Mapa mental (markmap) — página `src/mapa.html`

Botão "🧠 Mapa mental" na barra de ferramentas liga o **modo mapa** (`setMapaMode` em
`panel.js`), clone exato do contrato do modo minuta: instrução padrão editável no
campo, faixa `.mapabar`, Enviar vira "🧠 Gerar mapa", ✕/Esc/segundo clique cancelam.
Os dois modos são **mutuamente exclusivos** (ligar um desliga o outro) e "Nova conversa"
desliga ambos. O turno (`panel.onMapa` → handler em `content.js`) é um **chat comum**:
sem tools, sem skills, sem `container` — por isso funciona nos dois provedores. Regras
que não podem quebrar:

- **Request isolado, como a minuta**: `prepararEnvio([{role:"user", content:[...blocos,
  instrucao + SUFIXO_MAPA]}], null)`. Não entra em `conversation` nem em
  `pecasNaConversa` — gerar um mapa não altera a conversa em andamento.
- **`SUFIXO_MAPA` é prescritivo de propósito** (mesma razão do `SUFIXO_MINUTA`): só
  Markdown, sem preâmbulo nem cerca ```, um único `#`, `##` nos eixos, listas `-` com
  até 3 níveis, itens curtos com peça/folha entre parênteses, nada de tabela/HTML.
  `limparMarkdownMapa` ainda tira cerca e preâmbulo que escapem.
- **Nova aba, não overlay**: `markmap-view` exige `d3` GLOBAL (~340 KB), content
  scripts do manifest não podem ser ES modules e `import()` dinâmico no content script
  fica exposto à CSP do tribunal (a mesma que barra o embed `blob:` do preview). A
  página `src/mapa.html` é `chrome-extension://`, carrega `vendor/d3.min.js` +
  `vendor/markmap-view.js` por `<script>` e não pesa nada nas páginas do PJe. Ela está
  em `web_accessible_resources` porque o `window.open` parte do content script.
- **A aba NÃO abre sozinha**: o card no chat (`panel.mostrarCardMapa`) tem o botão
  "Abrir mapa" — a resposta demora minutos e o gesto do "Gerar" já expirou; abrir
  direto cairia no bloqueador de pop-ups.
- **Canal de dados**: o content manda `{type:"guardarMapa"}` ao worker, que grava em
  `chrome.storage.session` (`mapa:<id>`, poda nos 5 mais recentes) e devolve o `id`; a
  página lê direto (contexto confiável). Some ao fechar o navegador — é o esperado.
- **`vendor/` é intocado** (d3 7.9.0 ISC + markmap-view 0.18.12 MIT, com
  `LICENSES.md`). **Não** vendorizar `markmap-lib`: arrasta katex/highlight.js/prismjs
  (~311 KB) e busca assets em CDN. A árvore `IPureNode` (`{content, children}`) sai de
  `mdParaArvore()` em `mapa.js` — ~70 linhas que entendem títulos e listas.
- **`content` do nó é HTML**: `mapa.js` duplica `escapeHtml` + `inlineMd` do `panel.js`
  (não dá para importar um IIFE de content script) e mantém a ordem **escape → formata**.
  O texto vem dos autos; sem isso um `<img onerror>` numa petição executaria.
- **Primeiro desenho com `duration: 0`**: as transições do d3 rodam em
  `requestAnimationFrame`, que o Chrome CONGELA em aba de segundo plano — com animação,
  abrir o mapa numa aba sem foco deixava os nós presos, invisíveis. A animação volta
  logo após o `fit()`; `duracaoSegura()` repete a regra na troca de nível e o
  `visibilitychange` redesenha + reenquadra ao voltar para a aba.
- `[hidden] { display: none !important }` em `mapa.css` pelo MESMO motivo do
  `panel.css`: o `.aviso` usa `display:flex` e cobria o mapa inteiro.
- **Riqueza visual do nó** (o `content` do markmap é HTML, e é isso que sustenta
  tudo abaixo): cada eixo é classificado por `EIXOS` (regex sobre o título sem
  acento, mesma técnica das `CATEGORIAS` do painel) e ganha **ícone SVG + cor**;
  a cor DESCE para todos os descendentes via `payload.cor` (a função `color` do
  markmap lê o payload — foi por isso que `colorFreezeLevel` saiu). A decoração
  roda em `decorarEixos()` DEPOIS de montar a árvore: durante a leitura não se
  sabe ainda quem virou raiz, e o título do processo acabava com ícone de eixo.
- **Realces do vocabulário processual** (`realces`): `fl.`/`fls.`, `id <n>`, datas,
  `R$` e `art./súmula` viram pílulas coloridas. Rodam ENTRE o escape e o
  `inlineMd` — o texto ainda não tem tags nesse ponto, então nenhum atributo é
  corrompido; trechos entre crases saem de cena por placeholders PUA
  (`…`, sempre escapados no código) para um `art. 5º` escrito como
  código não virar pílula dentro do `<code>`.
- **Etiqueta de origem** (`origemNoRodape`): a referência final do item —
  `(Contestação, id 123461, fl. 61)` — sai do meio da frase e vira `.mm-src` em
  linha própria. Citar peça, **id** e **folha** é requisito do recurso (é assim
  que o usuário reencontra a peça na timeline), e o subtítulo da página mostra
  `N/M com peça e folha` para expor quando o modelo não cumpriu.
- **Tabelas**: bloco Markdown `|…|` + separador vira UM nó com `<table class="mm-tab">`
  (partes, linha do tempo, valores). Sem `markmap-lib` no meio: o parser detecta o
  bloco e monta o HTML.
- A lista de peças (id + título) vai EXPLÍCITA no texto do request, além do `title`
  de cada bloco `document` — sem ela o modelo inventa ou omite o id.
- Recolhimento inicial: `initialExpandLevel: 2` (raiz + eixos). Os botões de detalhe
  re-`setData` sobre um **clone** da árvore — depois do primeiro render ela carrega
  `state`/`fold` e o nível não seria reaplicado. `colorFreezeLevel: 2` dá uma cor por
  eixo, na paleta das categorias de peças. Não há exportação de SVG: o
  `foreignObject` (que é o que dá as pílulas e tabelas) não sobrevive fora do
  navegador — a saída visual é a impressão/PDF, com `beforeprint` → `mm.fit()`
  para nada sair cortado.

## Desenvolvimento e teste

- **ARMADILHA DA ZONA MORTA TEMPORAL no `content.js`** (já derrubou o painel
  inteiro uma vez): o arquivo é um IIFE gigante que REGISTRA callbacks no painel
  centenas de linhas antes de declarar o estado que eles leem, e chama
  `refresh()` no meio — que roda `panel.setDocs` de forma **síncrona**. Todo
  `const`/`let` do escopo do IIFE declarado DEPOIS de `refresh()` e lido por um
  desses callbacks lança `Cannot access before initialization` dentro do
  `setDocs`, que **aborta e leva junto o resto do content.js** — sumiu a seleção
  em faixa inteira, sem nenhum sintoma que apontasse para a causa. Estado lido
  por callback vive no TOPO, junto do `const panel`.
- Não há bundler. Valide sintaxe com `node --check src/*.js`.
- **`node --check` NÃO pega variável inexistente** — ele só valida sintaxe, e um
  `ReferenceError` de runtime derruba a função inteira. Foi assim que um
  `paginas: ehPdf ? …` sobrevivente de um `ehPdf` → `ehBin` quebrou a exportação
  em `.zip` por completo, com a mensagem "Não foi possível exportar: ehPdf is
  not defined". Depois de renomear variável ou remover recurso, rode um ESLint
  descartável com **só duas regras** (`no-undef` e `no-unused-vars`) sobre
  `src/*.js`: instale no scratchpad, declare os globais dos content scripts
  (`PJE`, `PjePanel`, `PLIB`, `MLIB`, `ZipW`, `PjeExport`, `DocxImport`,
  `chrome`…) e trate como falso positivo o `typeof module !== "undefined"` dos
  rodapés de teste e os IIFE `var X = (function(){…})()`, que são consumidos por
  outro arquivo. Não deixe o config no repo: o projeto não tem `package.json`.
- **Testar o BOOT do content.js sem PJe** (o único teste que pega erro de ordem
  de inicialização): DOM com `#divTimeLine`, stubs de `chrome`, `PJE`
  (a superfície real é `listarDocumentos`, não `listar`), `PLIB`,
  `MLIB` (**precisa de `CATEGORIAS`**, que o `mount` itera), `ZipW` e
  `PjeExport`; roda `panel.js` e depois `content.js` no mesmo contexto. Em
  `jsdom` (`npm i jsdom` no scratchpad) sai sem navegador — mas é preciso stubar
  `ResizeObserver`, `requestIdleCallback`, `matchMedia`, `CSS.escape`,
  `setPointerCapture` e o `fetch` do `panel.css`, e procurar o host do Shadow DOM
  em `document.documentElement` (é lá que o `mount` o anexa), não no `body`.
  Conferir por COMPORTAMENTO que os handlers do fim do arquivo subiram —
  arrastar marca a faixa, Shift+clique estende, botão direito abre o `.selmenu`
  —, porque um `content.js` abortado no meio ainda monta o painel e lista as
  peças. Testes de unidade fora do
  navegador no scratchpad da sessão: `renderMd` (escape-first + citações) roda com
  `eval` do `panel.js`; o acumulador SSE de `claude.js` roda com `fetch` fake devolvendo
  um `ReadableStream` de eventos simulados (chat com citação, `pause_turn`);
  `_findSlashToken`/`_montarTextoEnvio` (gatilho `/` e merge prompt+texto) também saem
  do `eval` do `panel.js`, e `PLIB` roda com um stub de `chrome.storage.sync`
  (get/set/remove + `onChanged` manual). `mdParaArvore` (mapa mental) roda em `vm` com
  stub de `document`/`chrome` — `mapa.js` expõe `window.__mapa` ANTES dos `return` de
  erro justamente para isso; o teste cobre aninhamento por indentação, fences, listas
  numeradas e o **escape de HTML vindo dos autos**.
- **Testar a página do mapa sem PJe**: HTML no scratchpad que stub
  `chrome.storage.session.get` devolvendo `{md, titulo, processo}`, carregue
  `vendor/d3.min.js` + `vendor/markmap-view.js` + `src/mapa.js` e abra com `?id=demo`
  por HTTP local. Atenção ao testar por automação: em aba de segundo plano o
  `visibilityState` fica `hidden` e as transições do d3 congelam — o que se vê na tela
  pode ser um estado intermediário, não um bug de layout.
- **Testar a UI sem PJe**: criar um HTML que stub `window.chrome`
  (`runtime.getURL`, `storage.local.get`, `storage.sync` completo — sem ele a
  biblioteca de prompts fica invisível —, `runtime.connect`) e carregue
  `src/prompts.js` + `src/panel.js`,
  servido por HTTP local (fetch do CSS falha em `file://`). **`mount()` DEVOLVE a
  API** — `const painel = PjePanel.mount()`, e é nele que vivem `setConfigured(true)`,
  `setDocs([...])`, `setTimelineTip({texto, carregando})`… Chamar `PjePanel.setDocs`
  direto lança `is not a function` e a lista fica vazia, sem nada na tela que
  explique. O painel abre pelo botão `.launcher` (não `.fab`) e o modo se troca
  pelos botões `.expand` / `.side` / `.free` do cabeçalho. As APIs `startPrep` /
  `setPrepState` / `endPrep` / `addMessage` permitem simular todo o fluxo visual.
  Duas armadilhas do harness por automação: `document.hasFocus()` é **false** com
  a janela em segundo plano, então `:focus` não casa e regras como
  `:has(.tip-i:focus)` parecem quebradas (o `activeElement` está correto); e o
  ponto de virada dos modos largos é a **coluna** de peças (328/372px), não a
  largura do painel — testar layout de lista só no flutuante não vê o pior caso.
- Para testar no PJe de verdade: recarregar a extensão em `chrome://extensions` e
  recarregar a aba do processo (o content script tem guard `window.__pjeIaLoaded`).

## Categorias de peças (destaque visual)

`CATEGORIAS` em `panel.js` classifica cada título por regex **sobre o texto normalizado
sem acentos** (`norm()`): decisões (dourado), audiências (verde), petições (azul),
provas (violeta), outros (neutro). Cobre o vocabulário criminal (IP, APF, flagrante,
corpo de delito, interrogatório, pronúncia, cota/promoção ministerial, mídia…) e cível
(reconvenção, exceção, acordo, quesitos, estudo psicossocial…). A primeira regra que
casar vence — cuidado com sobreposições, todas testadas no teste de categorias do
scratchpad (58 títulos reais):
- "ata notarial" é prova — lookahead negativo na regra de audiências;
- "cumprimento de sentença" é fase/petição das PARTES — lookbehind negativo em
  `sentenca` na regra de decisões (senão "Impugnação ao Cumprimento de Sentença"
  viraria decisão), e o termo aparece explícito na regra de petições;
- "acordo" (petição) NÃO casa dentro de "acordao" (decisão): o `\b` não existe entre
  "acordo" e o "a" seguinte — seguro manter os dois;
- "mídia" sozinha é prova, mas "mídia da audiência" cai em audiências (regra anterior);
- "manifestação sobre o laudo" é petição (regra de petições vem antes da de provas). As cores vivem em variáveis `--cat-*` no `panel.css` e aparecem na lista
lateral (dot + peso da fonte), nos chips e no popup `@`; a legenda só é exibida no modo
expandido.

## Convenções

- Comentários e strings de UI em português do Brasil (com acentuação correta).
- **Visual: `DESIGN.md` manda.** O parágrafo abaixo é histórico e os valores nele
  estão desatualizados (a paleta migrou para `#12729f`, petições virou roxo e
  provas magenta). Em qualquer conflito, vale o DESIGN.md — tokens, componentes,
  restrições da plataforma e o porquê de as fontes não virem de CDN.
- Identidade visual: paleta do próprio PJe — azul-petróleo `#0078aa` (`--pje`, cor
  da barra do PJe/TJCE), escurecido `#005f88` (`--pje-2`, gradientes/hover/balão do
  usuário — texto branco sobre `#0078aa` puro passa AA por pouco, por isso texto
  longo usa o tom escuro), azul claro `#62a9c7` (`--pje-soft`, medidores), fundos
  frios `#f6f9fb`, títulos em Georgia serif. Variáveis CSS no topo de `panel.css`
  (`.wrap`) e espelhadas em `ui.css` (`:root`, popup/opções/ajuda — HTMLs têm
  referências inline a `var(--pje-2)`). Cores semânticas preservadas: categorias
  `--cat-*`, verde de sucesso, laranja da `.alertbar`/gauge crítico.
- **Escala tipográfica em variáveis** (`--fs-nano|micro|meta|ui|body|lg|lead`, no
  mesmo bloco `.wrap`): sete degraus inteiros no lugar dos 13 tamanhos com
  meios-pixels que existiam antes — variação de tamanho sem intenção é o que faz
  a interface "parecer poluída" mesmo com cada elemento correto. `--fs-nano` (10px)
  é só para numerais e teclas (`.d-id`, `kbd`, sobrescrito da citação). Ritmo
  vertical em `--sp-1..4`. **Não reintroduzir literais de `font-size`** em px no
  painel; `em` relativos (markdown das mensagens) continuam corretos.
- **Rodapé em duas linhas** (`.toolbar` + `.metarow`): a faixa de ferramentas
  perdeu o rótulo `.ctxlab` (os botões se autodescrevem; em 484px ele custava
  ~22% da linha) e recebeu à direita a `.metarow` com medidor, custo, selo do
  modelo e o `ⓘ` — antes eram três blocos empilhados. `.tools` usa
  `flex: 0 1 auto`: com `flex:1;min-width:0` os botões encolhiam abaixo do
  conteúdo e viravam uma coluna de quatro linhas quando a `.metarow` disputava
  espaço. Medidor e custo escrevem **duas versões no DOM** (`.g-full`/`.g-short`,
  escolhidas pelo CSS conforme `.expanded`) — nenhum dado acionável vira só
  tooltip, e a linha não estoura no painel estreito. Os atalhos de teclado
  (`.hint-key`) aparecem com o campo em foco ou enquanto a conversa está vazia
  (classe `.novato` no `.ft`, posta por `showEmptyHint`), com revelação
  `grid-template-rows: 0fr→1fr` (anima sem reservar espaço morto).
- **Popup × página de opções** (`popup.html`, `options.html`, ambos servidos pelo
  MESMO `popup.js`): o popup é o console rápido (largura **460px** — o Chrome
  aceita até 800×600, e com 340 o nome do modelo era cortado no meio) e a página
  de opções é a versão com as explicações longas, aberta pelo link "Configuração
  completa" (`chrome.runtime.openOptionsPage`). Regras que não podem quebrar:
  - **Todo elemento que existe em só uma das páginas é opcional no `popup.js`**
    (`if (el)`): `boxA`/`boxG`/`firstRun`/`abrirOpcoes` são exclusivos do popup e
    quebrariam a página de opções se acessados direto. Os IDs compartilhados
    (`apiKey`, `geminiApiKey`, `model`, `effort`, `customPrompt`, `save`,
    `saveStatus`, `chip`, `chipText`, `togglePw`, `togglePwG`) precisam existir
    **nas duas**.
  - **Progressive disclosure por ESTADO, como no painel**: as chaves são
    `<details class="keybox">` — a que falta para o modelo ativo abre sozinha, a
    que já está salva vira uma linha de estado (cada campo aberto custa ~99px dos
    600px de altura que o popup do Chrome tem). Os passos "Como usar"
    (`#firstRun`) só aparecem enquanto NENHUMA chave foi salva, e o critério é o
    que está **salvo**, não o que está sendo digitado — sumir no meio da
    digitação seria um salto de layout no meio da tarefa.
  - **`.kstate` (ponto + "configurada") não pode ser escopado em `label.field`**:
    no popup o mesmo elemento vive dentro de um `<summary>`. O chip do topo fala
    só do provedor do modelo ativo; são os `.kstate` que dizem o estado das duas
    chaves de uma vez.
  - **O endereço do console do provedor é um LINK (`.pc-obter`), no `.pc-head`, e
    fica visível SEMPRE.** Enquanto ele era texto dentro da `.hint` ("Crie em
    console.anthropic.com"), a tela que pede uma chave não tinha como levar até
    ela: dava para selecionar e copiar, e só. Pior, `pintarMascara` esconde a
    `.hint` inteira quando há chave salva — exatamente quando se volta ao console
    para conferir saldo, limite ou chave revogada. Por isso ele mora ao lado do
    "Trocar" (`.pc-acts`), não na dica. URLs: `console.anthropic.com/settings/keys`,
    `aistudio.google.com/apikey`, `platform.openai.com/api-keys` — os mesmos do
    `help.html`, que continua sendo o passo a passo.
  - **A `.save-row` tem margem PRÓPRIA** (`--sp-5`). `.save-acts .btn` zera o
    `margin-top` que o `.btn` carregava de quando nascia sozinho na coluna, e sem
    a margem da linha "Testar chave"/"Salvar configuração" encostava nos chips de
    persona — some a fronteira entre "ainda estou preenchendo" e "agora eu ajo".
    Consequência no popup: o `.save-status` (overlay `position:absolute; inset:0`
    sobre o botão) **não pode repetir esses 14px** — repetindo, o "Salvo!" saía
    deslocado para baixo do botão que ele deveria cobrir.
- Modelos da API: manter os IDs do `popup.html`/`options.html` alinhados aos aliases
  atuais da Anthropic (`claude-haiku-4-5` — rápido e barato, mas com janela de 200 mil
  tokens/100 págs.; o Sonnet 5 de 1M é a opção para autos volumosos) e do Google
  (**`gemini-3.6-flash` é o DEFAULT em `background.js`** — 1M de tokens e 1000 págs.
  cobrem os autos inteiros sem a guarda de páginas estourar, que é o caso comum;
  `gemini-3.5-flash-lite` — GA na Interactions API). **Consequência do default ser
  Gemini, e ela é real**: `citacoesNativas:false`, então a experiência padrão usa
  citação TEXTUAL (o `ⓘ` ao lado do selo do modelo) em vez das citações `[n]`
  clicáveis por página; e a busca de jurisprudência roda sem `allowed_domains`
  (garantia mole por prompt — ver "Prioridade das fontes na busca web"). Quem quiser
  citação nativa por página troca para um modelo Anthropic. E a tabela
  `MODEL_CAPS` sincronizada com os docs (limites, versões de tools, thinking/effort).
- **O modelo padrão vive em DOIS lugares e eles precisam bater**: `getCfg` em
  `background.js` (ES module do worker) e `MODELO_PADRAO` em `popup.js` (script
  clássico, compartilhado por popup e options — não pode importar do worker).
  Quando o default virou Gemini, só o worker mudou: sem `model` no storage o
  `<select>` caía no PRIMEIRO `<option>` do HTML (o Haiku), então na **primeira
  instalação** — o público que chega pela Store — o popup pedia a chave da
  Anthropic para uma extensão que ia falar com o Google, e o selo do painel
  contradizia a tela de configuração. `select.value` com um id fora da lista
  (config de uma versão anterior) deixa o campo VAZIO: o popup cai no padrão em
  vez de gravar modelo vazio. Coberto por teste em jsdom que lê o default do
  próprio `background.js` — divergir de novo quebra o teste, não o usuário.
- **`capsDe` tem fallback POR PROVEDOR** (`FALLBACK_POR_PROVEDOR`): id
  desconhecido tem o provedor decidido por `providerDe` (prefixo, acerta
  sempre), então cair sempre nas caps do Haiku dava um par incoerente — request
  para o Google com janela de 200 mil tokens, guarda de 100 páginas e
  `citacoesNativas` ligada (o system pediria citação por página a um modelo que
  não as produz).
- **O selo do modelo (`setModelo` em panel.js) tem tabela de NOMES própria** e
  ela precisa acompanhar `MODEL_CAPS`: o fallback é o id cru, e um selo cujo
  trabalho é dizer qual modelo respondeu não pode mostrar `gpt-5.6-luna`.
- Config no `chrome.storage.local`: `apiKey` (Anthropic), `geminiApiKey` (Google),
  `openaiApiKey` (OpenAI),
  `model`, `effort` (baixo/médio/alto — `output_config.effort` na Anthropic, omitido
  nos modelos sem suporte; `generation_config.thinking_level` no Gemini) e
  `customPrompt` (instruções personalizadas do usuário — persona/preferências,
  textarea no popup/options, máx. 4000 chars).
- **Instruções personalizadas** (`customPrompt`): anexadas por `systemPromptAtual()`
  em content.js DEPOIS das regras-base, com rótulo "siga-as no que não conflitar
  com as regras acima" (a âncora de não-invenção permanece autoritativa). Ponto
  ÚNICO de injeção → alcança chat, minuta, mapa e count_tokens nos DOIS
  provedores (Anthropic `system` / Gemini `system_instruction`, repasse verbatim
  do worker). INVARIANTE: campo vazio ⇒ prompt byte a byte idêntico ao padrão
  *dado o mesmo processo e o mesmo dia* (o sufixo de `contextoDoProcesso` — CNJ +
  data — é anterior e independente do `customPrompt`). Editar no meio da conversa só invalida o
  cache de prefixo (sem guarda de "Nova conversa" — o system não faz parte do
  histórico); o `storage.onChanged` atualiza a variável e zera `ultimaChaveEst`,
  e `estimativaLocalTokens` soma o tamanho do texto ao chute do system.
- Alternar o toggle de busca ou trocar de modelo invalida o cache de prompt daquele ponto
  em diante (comportamento aceito). Arquivos enviados à Files API persistem na conta
  (100 GB por organização) — "limpar uploads" é melhoria futura registrada.
