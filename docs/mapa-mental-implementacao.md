# Mapa mental de processo judicial com markmap — guia completo de implementação

> Documento de transferência técnica. Descreve, com todos os detalhes de desenvolvimento,
> como o recurso **“🧠 Mapa mental”** foi implementado na extensão *TecJustiça PJe*
> (`src/mapa.html` + `src/mapa.js` + `src/mapa.css` + o prompt em `src/content.js`),
> para que a mesma solução seja portada para outro sistema.
>
> Versão do documento: 2026-07-27 · Baseado na v0.14.0 da extensão.

---

## Sumário

1. [O que o recurso faz](#1-o-que-o-recurso-faz)
2. [Links oficiais — documentação e bibliotecas](#2-links-oficiais--documentação-e-bibliotecas)
3. [Downloads: arquivos, versões, URLs, hashes e licenças](#3-downloads-arquivos-versões-urls-hashes-e-licenças)
4. [Arquitetura em 5 etapas](#4-arquitetura-em-5-etapas)
5. [Etapa 1 — O prompt (a metade invisível do recurso)](#5-etapa-1--o-prompt-a-metade-invisível-do-recurso)
6. [Etapa 2 — Limpeza e transporte do Markdown](#6-etapa-2--limpeza-e-transporte-do-markdown)
7. [Etapa 3 — Parser Markdown → árvore do markmap](#7-etapa-3--parser-markdown--árvore-do-markmap)
8. [Etapa 4 — Enriquecimento visual do nó](#8-etapa-4--enriquecimento-visual-do-nó)
9. [Etapa 5 — Render com markmap-view](#9-etapa-5--render-com-markmap-view)
10. [CSS: o que realmente importa](#10-css-o-que-realmente-importa)
11. [Segurança: escape-first é inegociável](#11-segurança-escape-first-é-inegociável)
12. [Portando para um sistema web comum (sem extensão)](#12-portando-para-um-sistema-web-comum-sem-extensão)
13. [Armadilhas conhecidas (bugs que já custaram caro)](#13-armadilhas-conhecidas-bugs-que-já-custaram-caro)
14. [Testes fora do navegador](#14-testes-fora-do-navegador)
15. [Checklist de implementação](#15-checklist-de-implementação)
16. [Anexo A — `mapa.js` comentado, na íntegra funcional](#anexo-a--mapajs-comentado-na-íntegra-funcional)

---

## 1. O que o recurso faz

O usuário marca peças de um processo, clica em **🧠 Mapa mental**, edita (ou aceita) a
instrução padrão e clica em **Gerar mapa**. O modelo de IA lê os PDFs das peças e devolve
**Markdown hierárquico**. O sistema converte esse Markdown numa **árvore de nós** e a desenha
como **mapa mental interativo em SVG**, numa página própria, com:

- **eixos da análise processual** (Partes, Fatos, Pedidos, Teses, Provas, Audiências,
  Decisões, Recursos, Prazos, Situação atual), cada um com **ícone e cor próprios**;
- a cor do eixo **descendo para todo o ramo**;
- **pílulas coloridas** para o vocabulário processual: `fl. 61`, `id 123461`, `12/03/2025`,
  `R$ 15.000,00`, `art. 5º`;
- **etiqueta de origem** em linha própria (`Contestação · id 123461 · fl. 61`) — toda
  afirmação aponta a peça, o id e a folha;
- **tabelas** dentro de um nó (partes, linha do tempo, valores);
- controles de **nível de detalhe (1 / 2 / 3 / Tudo)**, zoom, ajustar, imprimir/PDF,
  tema escuro e **download do `.md`**;
- subtítulo com auditoria: `5 eixos · 34 tópicos · 31/34 com peça e folha`.

Demonstração visual do resultado: `docs/mapa-mental.gif` (neste repositório).

**Decisão de produto que sustenta tudo:** o mapa é um **chat comum** — sem *tools*, sem
*skills*, sem execução de código no servidor do provedor. Por isso funciona igual em
**Claude** e em **Gemini**, e funcionaria em qualquer LLM que devolva texto.

---

## 2. Links oficiais — documentação e bibliotecas

### markmap (a biblioteca de renderização)

| Recurso | Link |
|---|---|
| **Site oficial / documentação** | https://markmap.js.org/ |
| Documentação — “Getting started” | https://markmap.js.org/docs/markmap |
| Documentação — **markmap-view** (o pacote que usamos) | https://markmap.js.org/docs/packages--markmap-view |
| Documentação — JSON options (todas as opções de layout) | https://markmap.js.org/docs/json-options |
| **API reference** (TypeDoc: `Markmap`, `IMarkmapOptions`, `IPureNode`) | https://markmap.js.org/api/ |
| Repositório (monorepo) | https://github.com/markmap/markmap |
| Playground / REPL — testar o Markdown antes de codar (SPA: o conteúdo só aparece no navegador) | https://markmap.js.org/repl |
| npm — `markmap-view` | https://www.npmjs.com/package/markmap-view |
| npm — `markmap-lib` (**não usamos** — ver §3.4) | https://www.npmjs.com/package/markmap-lib |
| Extensão VS Code (referência de UX) | https://marketplace.visualstudio.com/items?itemName=gera2ld.markmap-vscode |

### d3 (dependência obrigatória do markmap-view)

| Recurso | Link |
|---|---|
| **Site oficial / documentação** | https://d3js.org/ |
| Repositório | https://github.com/d3/d3 |
| npm | https://www.npmjs.com/package/d3 |

### Tipos que você vai encontrar na API

- **`IPureNode`** — o formato de árvore que o markmap consome:
  `{ content: string /* HTML */, children: IPureNode[], payload?: object }`.
  É **isto** que nosso parser produz. Não é preciso `markmap-lib` para produzi-lo.
- **`IMarkmapOptions`** — as opções “de verdade” (funções). Não escreva à mão: use
  `markmap.deriveOptions({...})` sobre as *JSON options* documentadas em
  https://markmap.js.org/docs/json-options.
- **`Markmap`** — a classe: `new markmap.Markmap(svgEl, options)` ou
  `markmap.Markmap.create(selectorOuSvg, options, root)`.

---

## 3. Downloads: arquivos, versões, URLs, hashes e licenças

### 3.1 O que baixar (as duas únicas dependências do recurso)

| Arquivo local | Pacote | Versão usada | URL exata de download | Tamanho | Licença |
|---|---|---|---|---|---|
| `vendor/d3.min.js` | `d3` | **7.9.0** | `https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js` | 279.706 B (~273 KB) | **ISC** — © Mike Bostock |
| `vendor/markmap-view.js` | `markmap-view` | **0.18.12** | `https://cdn.jsdelivr.net/npm/markmap-view@0.18.12/dist/browser/index.js` | 50.156 B (~49 KB) | **MIT** — © Gerald Liu |

**Total: ~322 KB** de terceiros (não minificado no caso do markmap-view; o d3 já vem
minificado). Nenhum outro pacote é necessário.

> Verificado em 27/07/2026 no registry do npm: `d3@latest` = **7.9.0** (ISC) e
> `markmap-view@latest` = **0.18.12** (MIT). As versões vendorizadas estão **em dia**.

### 3.2 Hashes SHA-256 dos arquivos vendorizados neste repositório

Confira depois de baixar — se bater, o arquivo é byte a byte o mesmo que roda em produção aqui:

```
d3.min.js         F2094BBF6141B359722C4FE454EB6C4B0F0E42CC10CC7AF921FC158FCEB86539
markmap-view.js   861EB6D20AF18AAA300878D46D695722A73625C58B40F49236AF027F18B74E07
```

### 3.3 Comandos de download

**PowerShell (Windows)** — o que foi usado aqui:

```powershell
New-Item -ItemType Directory -Force vendor | Out-Null

Invoke-WebRequest -Uri "https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js" `
  -OutFile "vendor/d3.min.js"

Invoke-WebRequest -Uri "https://cdn.jsdelivr.net/npm/markmap-view@0.18.12/dist/browser/index.js" `
  -OutFile "vendor/markmap-view.js"

# conferência
Get-FileHash vendor/d3.min.js, vendor/markmap-view.js -Algorithm SHA256 | Format-List Hash,Path
```

**bash / curl:**

```bash
mkdir -p vendor
curl -fsSL https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js \
  -o vendor/d3.min.js
curl -fsSL https://cdn.jsdelivr.net/npm/markmap-view@0.18.12/dist/browser/index.js \
  -o vendor/markmap-view.js
sha256sum vendor/*.js
```

**npm (se o seu sistema tem build step):**

```bash
npm i d3@7.9.0 markmap-view@0.18.12
```

```js
// com bundler (Vite/webpack/esbuild) você NÃO precisa do bundle IIFE:
import * as d3 from "d3";
import { Markmap, deriveOptions } from "markmap-view";
// atenção: neste caminho o markmap importa o d3 por ESM sozinho —
// a regra da ordem dos <script> (§3.5) só vale para o bundle IIFE.
```

**CDN direto (sem vendorizar)** — aceitável em app web comum, proibido em extensão
(a CSP `script-src 'self'` bloqueia):

```html
<script src="https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/markmap-view@0.18.12/dist/browser/index.js"></script>
```

Espelhos equivalentes: `https://unpkg.com/d3@7.9.0/dist/d3.min.js` e
`https://unpkg.com/markmap-view@0.18.12/dist/browser/index.js`.

### 3.4 O que **NÃO** baixar: `markmap-lib`

`markmap-lib` é o transformador oficial de Markdown → árvore. **Não o use aqui.** Motivos,
medidos:

- arrasta **katex + highlight.js + prismjs + markdown-it** — cerca de **311 KB** adicionais;
- tenta **buscar assets em CDN em tempo de execução** (KaTeX fonts, temas de highlight),
  o que a CSP de uma página de extensão (`script-src 'self'`) bloqueia — e que, num app
  corporativo com CSP estrita, também bloqueia;
- entrega um HTML de nó que **não conhece o vocabulário jurídico**: não haveria pílula de
  `fl.`, nem etiqueta de origem, nem ícone por eixo. Você acabaria pós-processando o HTML
  dele — mais frágil do que gerar o HTML do zero.

O substituto é a função `mdParaArvore()` (§7): **~70 linhas**, sem dependências, que entende
exatamente o subconjunto de Markdown que o prompt manda o modelo produzir. Essa é a troca
central do projeto: **prompt prescritivo + parser pequeno** no lugar de **parser genérico
pesado**.

### 3.5 Regra da ordem dos `<script>` (bundle IIFE)

`markmap-view.js` (`dist/browser/index.js`) publica `window.markmap` e **consome `d3`
global** — ele *não* embute o d3, apesar de declará-lo como `dependency` no `package.json`.
Portanto:

```html
<!-- ORDEM OBRIGATÓRIA -->
<script src="../vendor/d3.min.js"></script>       <!-- 1º: define window.d3 -->
<script src="../vendor/markmap-view.js"></script> <!-- 2º: usa window.d3    -->
<script src="mapa.js"></script>                   <!-- 3º: seu código       -->
```

Inverter a ordem falha com um `d3 is not defined` **no primeiro render**, não no carregamento
— erro fácil de atribuir ao lugar errado.

### 3.6 Licenças — obrigação de atribuição

Ambas as licenças (MIT e ISC) exigem que o texto da licença e o aviso de copyright sejam
distribuídos junto. Neste repositório isso vive em [`vendor/LICENSES.md`](../vendor/LICENSES.md),
com tabela de arquivo → pacote → versão → origem → licença. **Replique esse arquivo** no
sistema de destino (e mantenha a coluna “Origem” com a URL exata: é o que torna a
atualização auditável).

Regra operacional adotada: `vendor/` é **intocado** — nada de patch local. Para atualizar,
baixe a mesma URL com a versão nova, rode `node --check`, rode os testes do parser e
atualize a tabela.

---

## 4. Arquitetura em 5 etapas

```
┌──────────────┐  1. prompt prescritivo          ┌──────────────┐
│  UI: botão   │ ──────────────────────────────► │   LLM        │
│  "Mapa       │    (peças em PDF + instrução     │  (Claude ou  │
│   mental"    │     + SUFIXO_MAPA + lista de ids)│   Gemini)    │
└──────────────┘                                  └──────┬───────┘
                                                         │ 2. Markdown puro (stream)
                                                         ▼
                              ┌───────────────────────────────────────┐
                              │ limparMarkdownMapa()  (tira cerca ```  │
                              │ e preâmbulo) → guarda o MD e devolve   │
                              │ um id  →  card no chat com "Abrir mapa"│
                              └──────────────────┬────────────────────┘
                                                 │ 3. window.open("mapa.html?id=…")
                                                 ▼
                        ┌────────────────────────────────────────────────┐
                        │ Página do mapa (contexto próprio, CSP própria) │
                        │  a) lê o MD pelo id                            │
                        │  b) mdParaArvore(md) → IPureNode               │
                        │     · escape → realces → inlineMd              │
                        │     · origemNoRodape, tabelas                  │
                        │     · decorarEixos (ícone + cor + payload)     │
                        │  c) new markmap.Markmap(svg, opções)           │
                        │  d) setData(clone) → fit()                     │
                        └────────────────────────────────────────────────┘
```

Pontos de contrato entre as etapas (mantenha-os ao portar):

| Fronteira | Contrato |
|---|---|
| UI → LLM | um único turno `user`, **isolado**: não entra no histórico da conversa |
| LLM → armazenamento | **Markdown cru**, nunca HTML |
| Armazenamento → página | `{ md, titulo, processo }` recuperável por um `id` opaco |
| Página → markmap | `IPureNode` com `content` **em HTML já escapado** e `payload.cor` |

---

## 5. Etapa 1 — O prompt (a metade invisível do recurso)

Sem este prompt, o parser não tem o que parsear. Ele é **prescritivo de propósito**: modelos
menores e mais baratos (Haiku, Flash-Lite) seguem instrução ao pé da letra, e o parser só
entende títulos, listas e tabelas simples — um preâmbulo (“Claro! Aqui está…”) ou uma cerca
` ``` ` estragaria o mapa.

### 5.1 Instrução padrão (editável pelo usuário no campo de texto)

```js
const INSTRUCAO_MAPA_PADRAO =
  "Mapeie o processo: partes e representantes, síntese dos fatos, pedidos, teses de cada " +
  "parte, provas produzidas, decisões proferidas e situação atual do feito.";
```

### 5.2 Sufixo fixo — o contrato de formato (copiar literalmente)

```js
const SUFIXO_MAPA =
  " Responda APENAS com o mapa em Markdown, sem nenhum texto antes ou depois e sem blocos" +
  " de código." +
  " ESTRUTURA: uma única linha começando com # (o processo e seu número); em seguida as" +
  " seções com ##, sempre NESTA ORDEM da análise processual, incluindo só as que os autos" +
  " permitirem: Partes e representação; Fatos (cronológicos); Pedidos; Teses e defesa;" +
  " Provas; Audiências; Decisões (cronológicas); Recursos; Prazos; Situação atual. Dentro de" +
  " cada seção, itens com \"-\", aninhados por indentação de dois espaços e no máximo três" +
  " níveis. Cada item é um rótulo curto (até cerca de 12 palavras), não uma frase completa." +
  " ORIGEM OBRIGATÓRIA: todo item que afirme algo dos autos TERMINA com a referência entre" +
  " parênteses, no formato (Título da peça, id 123456, fl. 7) — o id é o número que abre o" +
  " título de cada peça na lista abaixo e a folha é a do PDF daquela peça. Sem folha" +
  " identificável, use (Título da peça, id 123456). NUNCA invente id, folha, data ou valor." +
  " RECURSOS: use **negrito** no rótulo do item e ==destaque== no que for decisivo; quando a" +
  " informação for tabular (partes, linha do tempo, valores, prazos), use UMA tabela Markdown" +
  " na seção correspondente, com no máximo 3 colunas e células curtas. NÃO use emojis," +
  " imagens, HTML, fórmulas nem numeração de tópicos.";
```

### 5.3 Racional cláusula a cláusula (não “enxugue” sem entender o custo)

| Cláusula | Por que existe |
|---|---|
| “APENAS o mapa … sem blocos de código” | preâmbulo e cerca ` ``` ` quebram o parser; há limpeza defensiva depois, mas o prompt é a primeira linha de defesa |
| “uma única linha começando com `#`” | o parser promove esse `#` único a **raiz** do mapa; sem ele o mapa nasce com raiz genérica |
| lista fixa de seções, **nesta ordem** | é o que permite classificar cada `##` num **eixo** conhecido (ícone + cor). Se o modelo inventar seções, elas caem em “Outros” — funciona, mas perde a cor |
| “no máximo três níveis” | além disso o mapa vira ilegível na tela; e a legibilidade é o produto |
| “rótulo curto, até ~12 palavras” | nó de mapa mental é **rótulo**, não frase. `maxWidth: 380` corta o resto visualmente |
| **origem obrigatória** `(Título da peça, id 123456, fl. 7)` | é *o* requisito do domínio: o **id** é o número que abre o título da peça na timeline — é assim que o usuário reencontra o documento. Citar só o nome não serve |
| “NUNCA invente id, folha, data ou valor” | âncora de não-invenção; o subtítulo da página (`31/34 com peça e folha`) expõe quando o modelo não cumpriu |
| `**negrito**` e `==destaque==` | os dois únicos enfeites que o `inlineMd` entende |
| “UMA tabela … no máximo 3 colunas” | tabela dentro de um nó é ótima; tabela larga estoura o `maxWidth` |
| “NÃO use emojis, imagens, HTML, fórmulas” | HTML do modelo seria escapado (§11) e apareceria cru; fórmulas exigiriam KaTeX (que não temos) |

### 5.4 Montagem do turno (isolado do chat)

```js
const messages = prepararEnvio([{
  role: "user",
  content: [
    ...blocos,                       // os PDFs das peças (file_id / inline)
    { type: "text",
      text: instrucao + SUFIXO_MAPA +
            " Peças anexadas, use exatamente estes ids: " +
            selectedIds.map((id) => metaDe(id).titulo).join("; ") + "." }
  ]
}], null);
```

Duas decisões dentro dessas 8 linhas:

1. **Request isolado.** O turno do mapa **não entra no histórico** da conversa. Gerar um mapa
   não deve alterar a conversa em andamento (nem o cache de prefixo, nem a contagem de
   contexto). Ao portar: se seu sistema tem chat, mantenha essa separação.
2. **A lista de peças vai explícita no texto**, além do `title` de cada bloco `document`.
   Sem essa lista literal, o modelo **inventa os ids** — foi observado em teste. O `title` do
   bloco é lido pelo modelo, mas repetir a lista no texto é o que garante o uso exato.

### 5.5 Streaming e reinício

A resposta é acumulada por *delta* e mostrada no chat enquanto chega. Dois cuidados
transportáveis para qualquer front:

- **checkpoint por request físico** (`onIter` → `ckptMapa = acc`) e **rollback em retry**
  (`onRetry` → `acc = ckptMapa`): sem isso um 429 re-tentado duplica o texto na tela;
- **reinício total** (`onReinicio` → `acc = ""`): se o backend refizer o turno do zero, a UI
  precisa zerar, não concatenar.

---

## 6. Etapa 2 — Limpeza e transporte do Markdown

### 6.1 Limpeza defensiva

Mesmo instruídos, modelos às vezes cercam a resposta ou escrevem um preâmbulo:

```js
function limparMarkdownMapa(txt) {
  let t = String(txt || "").trim();
  const cerca = t.match(/^```[a-z]*\s*\n([\s\S]*?)\n?```$/i);
  if (cerca) t = cerca[1].trim();
  const i = t.search(/^#{1,2}\s+/m);   // corta tudo antes do 1º título
  if (i > 0) t = t.slice(i);
  return t.trim();
}
```

### 6.2 Resumo barato para o card do chat

```js
function resumoDoMapa(md) {
  const linhas = md.split(/\r?\n/);
  const eixos = linhas.filter((l) => /^##\s+/.test(l)).length;
  const itens = linhas.filter((l) => /^\s*(?:[-*+]|\d+[.)])\s+/.test(l)).length;
  return eixos + " eixo(s) · " + itens + " tópico(s)";   // "5 eixo(s) · 34 tópico(s)"
}
```

Contagem por regex de propósito: o parser de verdade só roda na página do mapa.

### 6.3 Transporte: guardar o **Markdown**, nunca o HTML

Na extensão, o worker grava em `chrome.storage.session` e devolve um `id`:

```js
// worker (background.js)
if (msg.type === "guardarMapa") {
  const id = String(Date.now()) + "-" + Math.random().toString(36).slice(2, 8);
  await sessSet("mapa:" + id, {
    md: msg.payload.md, titulo: msg.payload.titulo,
    processo: msg.payload.processo, ts: Date.now(),
  });
  await podarMapas();          // mantém no máximo MAX_MAPAS = 5
  sendResponse({ id });
}
```

Regras de projeto embutidas aí:

- **`session`, não `local`**: o mapa contém trechos dos autos. Sumir ao fechar o navegador é
  o comportamento **desejado** (é o oposto da minuta, que precisa sobreviver e por isso vai
  para `local`, com poda dupla e aviso de privacidade).
- **Poda em 5**: cada mapa é o Markdown inteiro de um processo; sem poda, uma tarde de uso
  enche a cota.
- **Markdown cru, não HTML**: o HTML é derivado; guardar o MD permite trocar a
  renderização, reprocessar com regras novas e oferecer “baixar `.md`” de graça.

### 6.4 A aba abre **no clique**, nunca sozinha

```js
panel.mostrarCardMapa(assistantEl, {
  md, resumo: resumoDoMapa(md),
  onAbrir: () => window.open(url, "_blank", "noopener"),
  onBaixar: () => baixarTexto(nomeMd, md, "text/markdown;charset=utf-8"),
});
```

A geração leva de dezenas de segundos a minutos; o *user gesture* do clique em “Gerar” já
expirou quando a resposta chega. `window.open` nesse momento cai no **bloqueador de
pop-ups**. Por isso a resposta vira um **card com botão** — o clique no botão é o gesto novo.
Vale para qualquer app web: **não abra abas em callback de promessa longa**.

---

## 7. Etapa 3 — Parser Markdown → árvore do markmap

Alvo: `IPureNode` = `{ content: string /* HTML */, children: [] , payload?: {} }`.

### 7.1 A ideia central: **duas pilhas**

- `pilhaH` — pilha de **títulos** (`#`, `##`, `###`) por profundidade;
- `pilhaL` — pilha de **itens de lista** por **coluna de indentação**.

Um título **fecha** a lista corrente (`pilhaL = []`). Um item de lista se pendura no último
item de lista com indentação menor; se não houver, no título corrente. É isso que dá
**aninhamento real** por indentação, que um `split("\n")` ingênuo não dá.

```js
function mdParaArvore(md, tituloPadrao) {
  const raiz = { content: conteudoNo(tituloPadrao || "Mapa"), children: [] };
  const pilhaH = [{ nivel: 0, no: raiz }];
  let pilhaL = [];
  let fence = false;

  const linhas = String(md || "").split(/\r?\n/);
  for (let i = 0; i < linhas.length; i++) {
    const linha = linhas[i];

    if (/^\s*(```|~~~)/.test(linha)) { fence = !fence; continue; }  // ignora blocos de código
    if (fence || !linha.trim()) continue;

    // ---- título: #, ##, ### …
    const h = linha.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const nivel = h[1].length;
      while (pilhaH.length > 1 && pilhaH[pilhaH.length - 1].nivel >= nivel) pilhaH.pop();
      const pai = pilhaH[pilhaH.length - 1].no;
      const no = { content: conteudoNo(h[2]), children: [], __titulo: h[2] };
      pai.children.push(no);
      pilhaH.push({ nivel, no });
      pilhaL = [];                       // um título fecha a lista anterior
      continue;
    }

    // ---- tabela: linha com | seguida de |---|
    if (linha.includes("|") && ehSeparadorTabela(linhas[i + 1] || "")) {
      const bloco = [];
      while (i < linhas.length && linhas[i].includes("|")) bloco.push(linhas[i++]);
      i--;                               // o for avança
      const pai = pilhaL.length ? pilhaL[pilhaL.length - 1].no
                                : pilhaH[pilhaH.length - 1].no;
      pai.children.push(novoNo(tabelaHtml(bloco)));
      continue;
    }

    // ---- item de lista (-, *, +, 1., 1))
    const li = linha.match(/^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      const col = li[1].replace(/\t/g, "    ").length;   // tab = 4 espaços
      while (pilhaL.length && pilhaL[pilhaL.length - 1].col >= col) pilhaL.pop();
      const pai = pilhaL.length ? pilhaL[pilhaL.length - 1].no
                                : pilhaH[pilhaH.length - 1].no;
      const no = novoNo(conteudoNo(li[2]));
      pai.children.push(no);
      pilhaL.push({ col, no });
      continue;
    }

    // ---- parágrafo solto: vira filho do título corrente (não quebra a árvore)
    const texto = linha.replace(/^\s*>\s?/, "").trim();
    if (texto) {
      pilhaH[pilhaH.length - 1].no.children.push(novoNo(conteudoNo(texto)));
      pilhaL = [];
    }
  }

  // um único "# título" no topo é a raiz natural do mapa
  const final = raiz.children.length === 1 && raiz.children[0].children.length
    ? raiz.children[0]
    : raiz;
  return decorarEixos(final);
}
```

### 7.2 Detalhes que parecem miudezas e não são

- **`fence`**: o modelo pode escapar e mandar um bloco de código. Ignorar o conteúdo entre
  cercas evita que ele vire dezenas de nós de lixo.
- **Parágrafo solto vira nó** em vez de ser descartado: um modelo desobediente ainda produz
  um mapa útil. **Degradação graciosa** em vez de tela vazia.
- **Promoção da raiz**: com `# Processo 0800…` no topo, esse nó vira a raiz e os `##` viram
  os eixos. Sem ele, os `#` é que são os eixos. As duas formas funcionam.
- **`__titulo`**: guarda o texto **cru** do título para a classificação por eixo (§8.3), já
  que `content` a essa altura é HTML. É removido no fim por `limparInternos()` — não deixe
  campos internos vazarem para a lib.
- **Tabelas**: detecção pelo par “linha com `|`” + “separador `|---|`”. O bloco inteiro vira
  **um único nó** cujo `content` é um `<table>`.

```js
function ehSeparadorTabela(l) { return /^\s*\|?\s*:?-{2,}[\s:|-]*$/.test(l) && l.includes("-"); }
function celulas(l) {
  let s = l.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}
function tabelaHtml(linhas) {
  const cab = celulas(linhas[0]);
  const corpo = linhas.slice(2).map(celulas);
  let h = '<table class="mm-tab"><thead><tr>';
  for (const c of cab) h += "<th>" + conteudoNo(c) + "</th>";
  h += "</tr></thead><tbody>";
  for (const linha of corpo) {
    h += "<tr>";
    for (let i = 0; i < cab.length; i++) h += "<td>" + conteudoNo(linha[i] || "") + "</td>";
    h += "</tr>";
  }
  return h + "</tbody></table>";
}
```

---

## 8. Etapa 4 — Enriquecimento visual do nó

O `content` de um nó do markmap é **HTML renderizado dentro de um `<foreignObject>`**. É essa
propriedade que sustenta ícones, pílulas, etiquetas e tabelas. Todo o enriquecimento acontece
antes de entregar a árvore.

### 8.1 O pipeline de um nó: `conteudoNo()`

Ordem **obrigatória**: `escape` → `realces` → `inlineMd`.

```js
// ATENÇÃO: os delimitadores são caracteres da Área de Uso Privado (U+E010 / U+E011)
// e devem ser escritos SEMPRE como escapes ASCII, nunca crus no arquivo.
const RE_COD_PLACEHOLDER = new RegExp("\uE010(\\d+)\uE011", "g");

function conteudoNo(txt) {
  const esc = escapeHtml(String(txt || "").trim());

  // trechos entre crases saem de cena por placeholders na Área de Uso Privado
  const codigos = [];
  const semCodigo = esc.replace(/`[^`]+`/g, (m) => {
    codigos.push(m);
    return "\uE010" + (codigos.length - 1) + "\uE011";
  });

  const comRealces = realces(semCodigo)
    .replace(RE_COD_PLACEHOLDER, (m, i) => codigos[Number(i)]);

  return inlineMd(origemNoRodape(comRealces));
}
```

Por que os placeholders **PUA** (`\uE010` / `\uE011`, Private Use Area): sem eles, um
`` `art. 5º` `` escrito como código viraria pílula **dentro** do `<code>`. Os placeholders
tiram o trecho de cena enquanto os realces rodam e o devolvem depois. (Mesma técnica usada
no painel para os marcadores de citação.) **Sempre escreva-os como escapes ASCII no código**,
nunca o caractere cru — ele é invisível no editor e some em copy/paste.

E por que os realces rodam **entre** o escape e o `inlineMd`: nesse ponto o texto **ainda não
tem tags**, então nenhum atributo HTML pode ser corrompido por uma substituição.

### 8.2 Realces do vocabulário processual

```js
function realces(s) {
  let h = s;
  // id do documento no PJe: "id 123456789"
  h = h.replace(/\bid\.?:?\s*(\d{5,})/gi, '<span class="mm-b mm-id">id $1</span>');
  // folhas: fl. 12 · fls. 18-40 · fls. 18/22
  h = h.replace(/\bfls?\.?\s*(\d+(?:\s*[-–\/aà]\s*\d+)?)/gi,
    (m, n) => '<span class="mm-b mm-fl">fl. ' + n.replace(/\s+/g, "") + "</span>");
  h = h.replace(/\b(\d{2}\/\d{2}\/\d{2,4})\b/g, '<span class="mm-b mm-dt">$1</span>');
  h = h.replace(/R\$\s?\d[\d.]*(?:,\d{2})?/g, (m) => '<span class="mm-b mm-vl">' + m + "</span>");
  h = h.replace(
    /\b(?:arts?\.\s*\d+[\wº°.\-\s§]{0,12}|s[úu]mula\s+(?:vinculante\s+)?\d+(?:\/[A-Z]{2,4})?)/gi,
    (m) => '<span class="mm-b mm-lei">' + m.trim() + "</span>");
  return h;
}
```

Adapte as regex ao vocabulário do **seu** domínio — é o ponto de customização mais barato e
de maior retorno visual.

### 8.3 Etiqueta de origem no rodapé do nó

A referência final (`(Contestação, id 123461, fl. 61)`) sai do meio da frase e vira linha
própria: o tópico fica legível e a procedência continua à vista.

```js
function origemNoRodape(h) {
  return h.replace(/\s*\(([^()]*(?:mm-id|mm-fl)[^()]*)\)\s*$/, (m, dentro) => {
    const partes = dentro
      .replace(/^\s*[,;·]?\s*/, "")
      .replace(/\s*,\s*/g, " · ")
      .trim();
    return '<span class="mm-src">' + partes + "</span>";
  });
}
```

Repare que o gatilho é a **presença das classes** `mm-id`/`mm-fl` — ou seja, roda **depois**
dos realces. Parênteses que não contenham origem ficam intactos.

### 8.4 Eixos: ícone, cor e propagação pelo ramo

```js
const EIXOS = [
  { k: "partes",     rot: "Partes",         cor: "#2f5583", re: /\b(parte|partes|polo|autor|autora|reu|re|requerente|requerido|exequente|executado|litisconsorte|representa|procurador|advogad|denunciad|acusad|vitima|ofendid|ministerio publico)/ },
  { k: "fatos",      rot: "Fatos",          cor: "#0e7490", re: /\b(fato|fatos|sintese|historico|contexto|narrativa|cronologia|linha do tempo|ocorrenci)/ },
  { k: "pedidos",    rot: "Pedidos",        cor: "#8a5a2b", re: /\b(pedido|pedidos|requerimento|postula|tutela|liminar|causa de pedir|objeto|denuncia|imputa)/ },
  { k: "teses",      rot: "Teses",          cor: "#7a5c94", re: /\b(tese|teses|argument|defesa|contestac|preliminar|merito|fundament|alegac|razoes|impugnac)/ },
  { k: "provas",     rot: "Provas",         cor: "#2e7d4f", re: /\b(prova|provas|pericia|laudo|documental|testemunh|depoiment|exame|indicio)/ },
  { k: "audiencias", rot: "Audiências",     cor: "#3f7f66", re: /\b(audienci|instruc|interrogatori|oitiva|sessao|julgamento em plenario)/ },
  { k: "decisoes",   rot: "Decisões",       cor: "#a8752f", re: /\b(decis|sentenc|despacho|acordao|liminar deferid|juizo|magistrad|pronuncia|absolvic|condenac)/ },
  { k: "recursos",   rot: "Recursos",       cor: "#4a5d78", re: /\b(recurs|apelac|agravo|embargos|contrarrazoes|habeas|instancia superior)/ },
  { k: "prazos",     rot: "Prazos",         cor: "#b04a3f", re: /\b(prazo|prescri|decadenci|intimac|citac|suspens|tempestiv)/ },
  { k: "situacao",   rot: "Situação atual", cor: "#0078aa", re: /\b(situac|andamento|atual|conclus|proximos passos|pendenci|status|providencia)/ },
];
const COR_PADRAO = "#0078aa";

function norm(s) {                       // sem acentos, minúsculo
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}
function classificarEixo(titulo) {
  const t = norm(titulo);
  for (const e of EIXOS) if (e.re.test(t)) return e;   // primeira regra que casa vence
  return { k: "outro", rot: "Outros", cor: COR_PADRAO };
}
```

Três decisões:

1. **Regex sobre texto normalizado sem acentos** — o modelo escreve “Decisões”, “DECISOES”,
   “Decisao”; a normalização NFD resolve os três de uma vez.
2. **Primeira regra que casa vence** — ordem importa; teste sobreposições com títulos reais.
   ⚠️ **Alternativas curtas precisam de `\b` no FIM.** As alternativas longas ficam sem
   fronteira final de propósito (`autor` precisa casar “autora”, “autores”), mas as curtas
   viram armadilha: `re` (de “ré”) sem `\b` casa o **prefixo** de *Recursos*, *Réplica*,
   *Relatório* e *Reconvenção* — e, como a primeira regra vence, esses eixos **nunca**
   chegam à regra correta e saem com ícone e cor de “Partes”. Escreva `reu\b|re\b` e
   cubra o caso no teste de classificação.
3. **Classificação por título, não por posição** — o modelo pode omitir seções; o mapa não
   pode depender de “a terceira seção é sempre Pedidos”.

A decoração roda **depois** de montar a árvore, e a cor **desce para os descendentes**:

```js
function decorarEixos(raiz) {
  for (const eixoNo of raiz.children) {
    const eixo = classificarEixo(eixoNo.__titulo || textoDe(eixoNo.content));
    eixoNo.content = icone(eixo) + eixoNo.content;      // SVG inline, monocromático
    eixoNo.payload = { cor: eixo.cor, eixo: eixo.k, rot: eixo.rot };
    pintar(eixoNo, eixo.cor);
  }
  limparInternos(raiz);
  return raiz;
}
function pintar(no, cor) {
  for (const f of no.children || []) {
    f.payload = { ...(f.payload || {}), cor };
    pintar(f, cor);
  }
}
```

> **Por que “depois”, e não durante a leitura:** durante a leitura ainda não se sabe **quem
> ficou como raiz**. Decorando na hora, o *título do processo* ganhava ícone de eixo. Bug
> real, corrigido movendo a decoração para o fim.

O ícone é SVG inline, colorido por `style="color: …"` e `fill="currentColor"` implícito:

```js
function icone(eixo) {
  const d = SVGP[eixo.k] || SVGP.outro;
  return '<svg class="mm-ic" viewBox="0 0 24 24" aria-hidden="true" style="color:' +
         eixo.cor + '"><path d="' + d + '"/></svg>';
}
```

(Os `path` completos estão em `src/mapa.js`, objeto `SVGP` — 11 ícones de 24×24, ~1 KB no
total. São ícones próprios; troque pelos do seu design system se preferir.)

### 8.5 Como a cor chega ao markmap

O markmap chama a função `options.color(node)` para colorir **linha e círculo** de cada nó.
Como ela recebe o nó inteiro, o `payload` é o canal:

```js
o.color = (n) => (n.payload && n.payload.cor) || COR_PADRAO;
```

> Isso **substitui** a opção `colorFreezeLevel`. Com `colorFreezeLevel: 2` a lib congela a
> cor no nível 2, mas pela **paleta dela**, e você perde o controle por eixo. Ao adotar
> `payload.cor` + `o.color`, **remova o `colorFreezeLevel`** — os dois brigam.

### 8.6 Auditoria: quantos tópicos citam a origem

```js
function contarComOrigem(no, r) {
  r = r || { folhas: 0, total: 0 };
  for (const f of no.children || []) {
    if (!f.children.length) {                     // só folhas da árvore
      r.total++;
      if (/mm-fl|mm-id/.test(f.content)) r.folhas++;
    }
    contarComOrigem(f, r);
  }
  return r;
}
```

Vira `31/34 com peça e folha` no subtítulo. **Métrica de qualidade visível ao usuário**:
expõe quando o modelo deixou tópicos sem lastro, em vez de esconder a falha.

---

## 9. Etapa 5 — Render com markmap-view

### 9.1 Opções

```js
const DURACAO = 300;

function opcoes(nivel) {
  const o = markmap.deriveOptions({
    initialExpandLevel: nivel > 0 ? nivel : -1,   // -1 = tudo aberto
    maxWidth: 380,
    spacingVertical: 12,
    spacingHorizontal: 96,
    duration: DURACAO,
    lineWidth: 2.5,
  });
  o.color = (n) => (n.payload && n.payload.cor) || COR_PADRAO;   // por cima
  return o;
}
```

`deriveOptions` traduz as *JSON options* (números, strings) para as funções que o construtor
espera. A `color` é atribuída **depois**, porque ela não é derivável de JSON.

Nossos valores contra os padrões da lib (padrões conferidos em
https://markmap.js.org/docs/json-options):

| Opção | Padrão do markmap | Usado aqui | Por quê |
|---|---|---|---|
| `initialExpandLevel` | `-1` (abre tudo) | `2` (raiz + eixos) | um processo inteiro aberto de uma vez é ilegível; o mapa **nasce recolhido** |
| `maxWidth` | `0` (sem limite) | `380` | rótulo longo esticaria o nó por toda a tela |
| `spacingVertical` | `5` | `12` | os nós têm duas linhas (rótulo + etiqueta de origem) |
| `spacingHorizontal` | `80` | `96` | folga para o ícone do eixo à esquerda do rótulo |
| `duration` | `500` | `300` (e `0` no 1º render) | 500 ms parece lento ao abrir vários ramos; ver §9.2 |
| `lineWidth` | — (disponível desde a v0.18.8) | `2.5` | linha fina some no fundo claro impresso |
| `colorFreezeLevel` | `0` | **não usado** | substituído por `payload.cor` + `o.color` (§8.5) |

### 9.2 Primeiro desenho: `duration: 0` — não é frescura

```js
mm = new markmap.Markmap(svgEl, { ...opcoes(nivelAtual), duration: 0 });

mm.setData(clonarArvore(arvore)).then(() => {
  mm.fit();
  mm.setOptions({ duration: DURACAO });   // a animação volta depois do 1º fit
});
```

**Bug real:** as transições do d3 rodam em `requestAnimationFrame`, que o Chrome **congela em
aba de segundo plano**. Abrindo o mapa em nova aba sem foco (Ctrl+clique, ou aba aberta atrás
por bloqueador de pop-ups), os nós ficavam **presos no estado inicial — invisíveis**. O
primeiro render sem animação resolve; a animação volta logo após o `fit()`.

A mesma regra se aplica a qualquer mudança de nível:

```js
function duracaoSegura() {
  return document.visibilityState === "visible" ? DURACAO : 0;
}
```

E ao voltar para a aba, redesenhe e reenquadre (em background o layout pode ter sido medido
com dimensões zeradas):

```js
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !mm) return;
  mm.setOptions({ duration: 0 });
  mm.renderData().then(() => { mm.fit(); mm.setOptions({ duration: DURACAO }); });
});
```

### 9.3 Trocar de nível de detalhe exige **clonar a árvore**

```js
function clonarArvore(no) {
  const c = { content: no.content, children: (no.children || []).map(clonarArvore) };
  if (no.payload) c.payload = { ...no.payload };
  return c;
}

async function aplicarNivel(nivel) {
  nivelAtual = nivel;
  mm.setOptions({ ...opcoes(nivel), duration: duracaoSegura() });
  await mm.setData(clonarArvore(arvore));   // árvore LIMPA
  await mm.fit();
  mm.setOptions({ duration: DURACAO });
}
```

**Por quê:** no primeiro render o markmap **anota a própria árvore** com `state` (id, depth,
`fold`…). Reentregar a mesma árvore faz o `initialExpandLevel` ser ignorado — os nós mantêm o
`fold` anterior. Entregando um clone limpo, o nível é reaplicado.

### 9.4 Abrir um ramo sem perder o ramo de vista

O markmap **não reenquadra sozinho** ao expandir: um ramo grande empurra o conteúdo para fora
da viewport. A correção é envolver o `toggleNode`:

```js
const alternar = mm.toggleNode.bind(mm);
mm.toggleNode = async (dados, recursivo) => {
  await alternar(dados, recursivo);
  await mm.ensureVisible(dados, { left: 24, right: 24, top: 24, bottom: 24 });
};
```

### 9.5 Demais controles

```js
$("#mais").addEventListener("click", () => mm && mm.rescale(1.25));
$("#menos").addEventListener("click", () => mm && mm.rescale(0.8));
$("#ajustar").addEventListener("click", () => mm && mm.fit());
window.addEventListener("resize", () => mm && mm.fit());

// imprimir: o mapa é um SVG com zoom/pan, não uma página que rola —
// o que estiver fora do enquadramento sairia CORTADO
window.addEventListener("beforeprint", () => mm && mm.fit());
$("#imprimir").addEventListener("click", () => window.print());

// tema escuro: a classe markmap-dark é do próprio markmap (ele troca as variáveis do texto)
$("#tema").addEventListener("click", () => {
  const escuro = document.documentElement.classList.toggle("markmap-dark");
  $("#tema").textContent = escuro ? "☀" : "🌙";
});
```

Métodos usados da API (`https://markmap.js.org/api/`): `new Markmap(svg, opts)`,
`setData`, `setOptions`, `fit`, `rescale`, `renderData`, `ensureVisible`, `toggleNode`.

### 9.6 Não há exportação de SVG — e é intencional

O `<foreignObject>` (que é o que dá pílulas, ícones e tabelas) **não sobrevive fora do
navegador**: um `.svg` salvo abre sem nada disso na maioria dos visualizadores. A saída
visual oficial é **imprimir / salvar em PDF** (com `beforeprint → fit()`), e a saída de dados
é o **`.md`**. Se o seu sistema precisar de PNG, renderize no servidor com um navegador
headless (Playwright/Puppeteer) — não tente serializar o SVG.

---

## 10. CSS: o que realmente importa

### 10.1 Variáveis do markmap (o padrão é fino demais para texto denso)

```css
#mapa {
  display: block; width: 100%; height: 100%;
  /* o markmap monta o texto dos nós a partir destas variáveis;
     o padrão dele é peso 300, fino demais para vocabulário jurídico */
  --markmap-font: 400 15px/1.35 system-ui, "Segoe UI", Arial, sans-serif;
  --markmap-a-color: #005f88;
  --markmap-code-bg: #eaf2f7;
  --markmap-code-color: #22303f;
}
```

O markmap **embute o CSS global dele dentro do próprio `<svg>`** (`embedGlobalCSS`); suas
regras só afinam o resultado.

### 10.2 A regra que evita a tela branca

```css
[hidden] { display: none !important; }
```

O atributo `hidden` do HTML **perde** para qualquer `display` definido por regra de autor —
e o elemento `.aviso` usa `display: flex`. Sem essa regra, o aviso “escondido” **cobre o mapa
inteiro**. (O mesmo bug já havia acontecido no painel; é o tipo de coisa que se paga duas
vezes se não estiver escrita.)

### 10.3 Layout da página

```css
html, body { height: 100%; overflow: hidden; }  /* quem rola/zooma é o mapa */
.tela { position: relative; height: calc(100% - 50px); }
```

### 10.4 Estilos do conteúdo do nó

```css
#mapa .mm-ic { width: 1.05em; height: 1.05em; vertical-align: -0.16em; margin-right: 5px; }

#mapa .mm-b {            /* pílulas */
  display: inline-block; padding: 0 6px; border-radius: 999px;
  font-size: 0.78em; font-weight: 600; line-height: 1.5;
  white-space: nowrap; vertical-align: 0.05em;
}
#mapa .mm-fl  { background:#e2eef5; color:#17536e; }
#mapa .mm-id  { background:#eae4f2; color:#55407a; font-variant-numeric: tabular-nums; }
#mapa .mm-dt  { background:#e6f1e9; color:#235c3c; font-variant-numeric: tabular-nums; }
#mapa .mm-vl  { background:#f6ecd9; color:#7a5115; font-variant-numeric: tabular-nums; }
#mapa .mm-lei { background:#f2e6e4; color:#8a3a30; }

#mapa .mm-src {          /* etiqueta de origem, em linha própria */
  display: block; margin-top: 2px; font-size: 0.78em; line-height: 1.5; color: #5d6b7a;
}

#mapa .mm-tab {          /* tabela dentro do nó */
  width: 100%; border-collapse: collapse; font-size: 12.5px; line-height: 1.3;
  table-layout: fixed; word-break: break-word; background: rgba(255,255,255,.75);
}
```

`table-layout: fixed` + `word-break: break-word` é o que impede uma célula longa de estourar
o `maxWidth: 380` do nó.

### 10.5 Impressão

```css
@media print {
  .topo, .dica { display: none; }
  .rodape { position: static; }
  .tela { height: 100%; background: #fff; }
}
```

---

## 11. Segurança: escape-first é inegociável

O texto vem **dos autos** — petições podem conter qualquer coisa, inclusive HTML colado por
uma parte. E o `content` do nó é **injetado como HTML** dentro do `<foreignObject>`. Portanto:

```js
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
```

E a ordem **escape → formata** vale em todo o pipeline (`conteudoNo`, `tabelaHtml`, legenda).
Sem isso, um `<img onerror="…">` dentro de uma petição **executa** ao abrir o mapa.

Três consequências práticas:

1. `inlineMd` roda **depois** do escape — ele só reintroduz tags que **você** escreveu
   (`<strong>`, `<em>`, `<code>`, `<mark>`, `<a>`);
2. links: só `https?://`, sempre com `target="_blank" rel="noopener"`;
3. o prompt proíbe HTML na resposta — mas a defesa **não é o prompt**, é o escape. Trate o
   prompt como cortesia e o escape como muro.

```js
function inlineMd(s) {
  let h = s;
  h = h.replace(/`([^`]+)`/g, "<code>$1</code>");
  h = h.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  h = h.replace(/==([^=]+)==/g, "<mark>$1</mark>");
  h = h.replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");
  h = h.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    (m, t, u) => '<a href="' + u + '" target="_blank" rel="noopener">' + t + "</a>");
  return h;
}
```

---

## 12. Portando para um sistema web comum (sem extensão)

O que é **específico de extensão Chrome** e o que é **do recurso**:

| Peça | Na extensão | Num app web |
|---|---|---|
| Página do mapa | `src/mapa.html` em `web_accessible_resources`, aberta por `chrome.runtime.getURL` | rota comum, ex. `/mapa/:id` |
| Transporte do MD | `chrome.storage.session` gravado pelo worker | ver §12.1 |
| Carregar d3/markmap | `<script src="../vendor/…">` (CSP `script-src 'self'`) | `<script>` local, CDN ou `import` com bundler |
| Abrir a aba | `window.open(chrome.runtime.getURL(...))` no clique | `window.open('/mapa/'+id)` no clique — **mesma regra do gesto** |
| Isolamento de CSP | página `chrome-extension://` tem CSP própria | sua app já tem a própria |

Tudo o mais — prompt, limpeza, parser, realces, eixos, opções do markmap, `duration: 0`,
clone da árvore, `ensureVisible`, CSS — **porta sem alteração**.

### 12.1 Escolha do transporte do Markdown

| Opção | Quando usar | Cuidados |
|---|---|---|
| **Backend + id opaco** (recomendado) | há servidor e sessão de usuário | ACL por usuário; TTL curto (o conteúdo é sigiloso); nunca id sequencial |
| `sessionStorage` + id | SPA, mapa aberto na mesma aba | não sobrevive a nova aba (`window.open` cria contexto novo) |
| `IndexedDB` + id | SPA e quer nova aba, sem backend | mesma origem; implemente a poda (equivalente ao `MAX_MAPAS = 5`) |
| `postMessage` para a aba aberta | quer evitar persistência | precisa da referência da janela e de *handshake*; frágil |
| **MD no fragmento da URL** (`#…`) | protótipo | ⚠️ estoura o limite de URL e vaza conteúdo no histórico. **Não use com dados sigilosos** |

Qualquer que seja: **guarde o Markdown, não o HTML**, e implemente **poda/TTL** desde o
primeiro dia — cada mapa é o texto inteiro de um processo.

### 12.2 SPA (React/Vue/Svelte)

- monte o markmap num `useEffect`/`onMounted` com a **ref do `<svg>`**, não com seletor;
- guarde a instância (`mm`) numa ref e chame `mm.destroy?.()` no unmount;
- o `content` do nó é HTML gerado por você — **não** passe pelo `dangerouslySetInnerHTML` do
  framework; quem renderiza é o markmap, dentro do SVG;
- se usar bundler, `import { Markmap, deriveOptions } from "markmap-view"` e `import * as d3`
  — o `window.d3` só é exigido pelo bundle IIFE.

### 12.3 Server-side / PDF

Para gerar imagem no servidor, abra a mesma página com Playwright, espere o `fit()` e use
`page.pdf()` ou `page.screenshot()`. Não serialize o SVG (§9.6).

---

## 13. Armadilhas conhecidas (bugs que já custaram caro)

| # | Sintoma | Causa | Correção |
|---|---|---|---|
| 1 | `d3 is not defined` no primeiro render | ordem dos `<script>` invertida | d3 **antes** de markmap-view (§3.5) |
| 2 | Mapa abre **em branco** em aba de segundo plano | transições do d3 usam `requestAnimationFrame`, congelado pelo Chrome | 1º render com `duration: 0`; `duracaoSegura()`; `visibilitychange` → `renderData()` + `fit()` (§9.2) |
| 3 | Botões de nível (1/2/3/Tudo) “param de funcionar” a partir do 2º clique | a árvore ganha `state.fold` no 1º render | `setData(clonarArvore(arvore))` (§9.3) |
| 4 | Título do processo aparece com ícone de eixo | decoração feita durante a leitura, antes de saber quem virou raiz | `decorarEixos()` **depois** de montar a árvore (§8.4) |
| 5 | Cor do eixo ignorada | `colorFreezeLevel` brigando com `options.color` | remova `colorFreezeLevel`; use `payload.cor` + `o.color` (§8.5) |
| 6 | Aviso “escondido” cobre o mapa | `hidden` perde para `display: flex` do autor | `[hidden] { display: none !important }` (§10.2) |
| 7 | Impressão sai cortada | o mapa é SVG com pan/zoom | `beforeprint` → `mm.fit()` (§9.5) |
| 8 | Ramo expandido some da tela | markmap não reenquadra ao expandir | envolver `toggleNode` com `ensureVisible` (§9.4) |
| 9 | Pílula colorida **dentro** de `<code>` | realces rodando sobre trecho entre crases | placeholders PUA `\uE010…\uE011` (§8.1) |
| 10 | Ids inventados pelo modelo | lista de peças só no `title` dos blocos | repetir a lista **no texto** do prompt (§5.4) |
| 11 | Mapa vazio / “sem estrutura de tópicos” | modelo devolveu preâmbulo ou cerca ` ``` ` | `limparMarkdownMapa()` + prompt prescritivo (§6.1) |
| 12 | Pop-up bloqueado ao terminar a geração | `window.open` fora de gesto do usuário | card com botão “Abrir mapa” (§6.4) |
| 13 | XSS a partir de uma petição | HTML dos autos injetado no `foreignObject` | escape-first em todo o pipeline (§11) |
| 14 | Cota de storage cheia depois de uma tarde de uso | mapas acumulando | poda em N mais recentes (§6.3) |
| 15 | Um eixo sai com ícone/cor de outro (ex.: “Recursos” pintado como “Partes”) | alternativa curta sem `\b` final na regex do eixo (`re` casa o prefixo de *Recursos*) | `reu\b|re\b`; teste todos os títulos do prompt contra `classificarEixo` (§8.4) |

---

## 14. Testes fora do navegador

O parser é a parte que mais quebra em silêncio — e é 100% testável sem navegador. Estratégia
usada aqui (Node, sem framework):

```js
// carrega mapa.js num contexto com stubs mínimos de document/chrome
const vm = require("vm");
const fs = require("fs");

const ctx = {
  window: {}, console,
  document: {
    querySelector: () => ({ addEventListener() {}, querySelectorAll: () => [] }),
    querySelectorAll: () => [],
    addEventListener() {},
    documentElement: { classList: { toggle: () => false } },
  },
  chrome: { storage: { session: { get: (k, cb) => cb({}) } } },
  location: { search: "" },
  URLSearchParams: URLSearchParams,
};
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync("src/mapa.js", "utf8"), ctx);

const { mdParaArvore, contarNos, escapeHtml, classificarEixo } = ctx.window.__mapa;
```

Para isso funcionar, `mapa.js` expõe o ponto de entrada **antes** dos `return` de erro:

```js
window.__mapa = { mdParaArvore, contarNos, escapeHtml, inlineMd, realces, classificarEixo };
```

Casos que o teste **precisa** cobrir (todos já pegaram bug real aqui):

1. aninhamento por indentação de 2 e 4 espaços, e com tab;
2. lista numerada (`1.`, `1)`) tratada como item;
3. bloco de código (` ``` `) integralmente ignorado;
4. `#` único no topo virando raiz; múltiplos `#` sem raiz única;
5. tabela `|…|` + separador virando **um** nó com `<table>`;
6. **escape de HTML vindo dos autos**: `- <img src=x onerror=alert(1)>` deve sair como
   `&lt;img …` no `content`;
7. `classificarEixo("DECISÕES")` e `classificarEixo("Decisoes")` → mesmo eixo;
8. realce não aplicado dentro de crases.

Validação de sintaxe (o projeto não tem bundler): `node --check src/mapa.js`.

Para testar a **página** sem o sistema real: um HTML no scratchpad que stub
`chrome.storage.session.get` devolvendo `{md, titulo, processo}`, carregue
`vendor/d3.min.js` + `vendor/markmap-view.js` + `src/mapa.js` e abra com `?id=demo` **por
HTTP local** (não `file://`). ⚠️ Ao testar por automação: em aba de segundo plano o
`visibilityState` fica `hidden` e as transições do d3 congelam — o que aparece na tela pode
ser um estado intermediário, não um bug de layout.

---

## 15. Checklist de implementação

**Preparação**
- [ ] Baixar `d3@7.9.0` e `markmap-view@0.18.12` (§3.3) e conferir os SHA-256 (§3.2)
- [ ] Criar `vendor/LICENSES.md` com pacote, versão, URL de origem e licença (§3.6)
- [ ] Confirmar a ordem dos `<script>`: d3 → markmap-view → seu código (§3.5)

**Backend / geração**
- [ ] Adicionar `INSTRUCAO_MAPA_PADRAO` (editável pelo usuário) e `SUFIXO_MAPA` (fixo) (§5)
- [ ] Enviar a **lista explícita de ids/títulos** dos documentos no texto do prompt (§5.4)
- [ ] Manter o turno **isolado** do histórico do chat (§5.4)
- [ ] `limparMarkdownMapa()` na resposta (§6.1)
- [ ] Persistir **o Markdown** com id opaco + TTL/poda (§6.3, §12.1)

**Front — página do mapa**
- [ ] `mdParaArvore()` com as duas pilhas, fences, tabelas e parágrafo solto (§7)
- [ ] `escapeHtml` → `realces` (com placeholders PUA) → `inlineMd` (§8.1, §11)
- [ ] `origemNoRodape()` (§8.3)
- [ ] `EIXOS` + `classificarEixo()` + `decorarEixos()` + `pintar()` (§8.4)
- [ ] `o.color = n => n.payload?.cor` e **sem** `colorFreezeLevel` (§8.5)
- [ ] 1º render com `duration: 0`; `duracaoSegura()`; `visibilitychange` (§9.2)
- [ ] Níveis com `setData(clonarArvore(...))` (§9.3)
- [ ] `toggleNode` envolvido com `ensureVisible` (§9.4)
- [ ] `fit()` no `resize` e no `beforeprint` (§9.5)
- [ ] `[hidden] { display:none !important }` (§10.2)
- [ ] Subtítulo com `N/M com peça e folha` (§8.6)
- [ ] Botão “baixar `.md`” (§9.5 / `baixar()`)

**UX**
- [ ] Abrir a aba **no clique** de um card, nunca automaticamente (§6.4)
- [ ] Estado vazio com mensagem útil (“sem estrutura de tópicos… gere novamente”)
- [ ] Legenda só com os eixos presentes no mapa

**Testes**
- [ ] Suíte do parser com os 8 casos do §14, incluindo o de XSS

---

## Anexo A — `mapa.js` comentado, na íntegra funcional

O arquivo de referência completo está em **`src/mapa.js`** (≈530 linhas, sem dependências
além de d3 + markmap-view). A ordem interna dele é:

| Bloco | Linhas aprox. | Conteúdo |
|---|---|---|
| Cabeçalho | 1–12 | por que a página existe (CSP, d3 global, content script não pode ser ESM) |
| `escapeHtml` / `inlineMd` | 20–37 | markdown inline, escape-first |
| `realces` | 44–64 | pílulas do vocabulário processual |
| `origemNoRodape` | 70–78 | etiqueta de procedência |
| `conteudoNo` | 86–98 | pipeline do nó, com placeholders PUA |
| `SVGP` / `EIXOS` / `classificarEixo` / `icone` | 108–169 | eixos, ícones e cores |
| `ehSeparadorTabela` / `celulas` / `tabelaHtml` | 176–197 | tabelas dentro do nó |
| **`mdParaArvore`** | 207–275 | o parser (duas pilhas) |
| `decorarEixos` / `pintar` / `limparInternos` | 280–306 | decoração pós-montagem |
| `contarNos` / `contarComOrigem` / `clonarArvore` | 308–335 | métricas e clone |
| Página: `opcoes`, `duracaoSegura`, `aplicarNivel`, `baixar`, `ligarBotoes`, `montarLegenda`, `desenhar` | 340–507 | render e controles |
| `window.__mapa` + bootstrap por `?id` | 511–531 | testes e entrada |

Arquivos irmãos:

- **`src/mapa.html`** (~50 linhas) — cabeçalho com controles, `<svg id="mapa">`, rodapé com
  legenda e dica, e os três `<script>` na ordem certa;
- **`src/mapa.css`** (~290 linhas) — cromo da página, variáveis `--markmap-*`, estilos do
  conteúdo do nó, tema escuro e `@media print`;
- **`src/content.js`** — `INSTRUCAO_MAPA_PADRAO`, `SUFIXO_MAPA`, handler `onMapa`,
  `limparMarkdownMapa`, `resumoDoMapa`;
- **`src/background.js`** — `guardarMapa` e `podarMapas`;
- **`src/panel.js`** — `setMapaMode` (modo mapa na UI) e `mostrarCardMapa` (card com
  “Abrir mapa” / “Baixar .md”).

---

### Resumo em uma frase

O mapa mental não é “a biblioteca markmap”: é **um prompt prescritivo** que força o modelo a
produzir Markdown previsível, **um parser de 70 linhas** que o converte em `IPureNode` sem
arrastar 311 KB de dependências, **uma camada de HTML por nó** que carrega o vocabulário do
domínio (ícone do eixo, pílulas de `fl.`/`id`, etiqueta de origem, tabelas) e **meia dúzia de
correções de comportamento** do markmap (`duration: 0`, clone da árvore, `ensureVisible`,
`fit` na impressão). A lib entrega o desenho; o resto é o que faz o desenho ser útil.
