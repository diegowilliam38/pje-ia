# DESIGN.md — sistema visual da extensão

> **Leia este arquivo antes de qualquer mudança de frontend.** Ele é a fonte de
> verdade do visual: cores, tipografia, espaçamento, raios, sombras e o
> comportamento dos componentes. Se uma mudança precisar de um valor que não
> está aqui, o certo é acrescentá-lo aqui primeiro — literais soltos no CSS são
> exatamente o que faz a interface "parecer poluída" mesmo com cada tela
> individualmente correta.

**Origem**: sistema desenhado no Claude Design (arquivo `Assistente dos Autos.dc.html`)
e implementado a partir do handoff. O protótipo é a referência visual; o código aqui
é a implementação real, não uma cópia da estrutura do protótipo.

A versão vigente é o **refinamento institucional** (v0.24): paleta petróleo
dessaturada, Newsreader + IBM Plex, ícones SVG e peso máximo 600. Ele **reverteu
duas decisões** do sistema anterior — o gradiente 96deg do cabeçalho (§2) e a
inversão de superfície entre lista e conversa (§2) —, ambas anotadas no ponto em
que aparecem. Ao encontrar código que ainda siga o desenho antigo, é código a
migrar, não um desvio a preservar.

---

## 1. Onde os tokens vivem

Não há build step: os tokens são **variáveis CSS declaradas em dois lugares**,
que precisam ficar espelhados.

| Arquivo | Seletor | Cobre |
|---|---|---|
| `src/panel.css` | `.wrap` | O painel dentro do PJe (Shadow DOM) |
| `src/ui.css` | `:root` | popup, options, help |
| `src/editor.css` | `:root` | editor de minutas (+ tokens próprios de folha A4) |
| `src/modelos-page.css` | `:root` | página de modelos |
| `src/mapa.css` | `:root` | mapa mental |

O painel **não** pode importar `ui.css`: ele vive em Shadow DOM e carrega o
próprio CSS via `web_accessible_resources`. Por isso a duplicação é deliberada —
mas os **valores** têm de bater. Ao mudar um token, mude nos dois.

---

## 2. Cor

### Marca / ação

| Token | Valor | Uso |
|---|---|---|
| `--pje` | `#14607e` | Primária: links, foco, badges, ícones de ação, dots ativos |
| `--pje-2` | `#0e4459` | Hover da primária, texto de link sobre branco |
| `--pje-3` | `#0e4e69` | Hover de link, estados pressionados |
| `--hd` | `#0e4459` | Fundo do cabeçalho — **chapado** |
| `--mark-de` / `--mark-para` | `#2e7e9c` → `#175d79` | Quadrado da marca, **180deg** |
| `--btn-de` / `--btn-para` | `#1c6c8b` → `#125a78` | Botão primário (Enviar, Salvar), **180deg** |
| `--btn-de-h` / `--btn-para-h` | `#22789a` → `#0e4e69` | Hover do botão primário |
| `--line-focus` | `#6fa5b9` | Borda do campo em foco |
| `--ring` | `0 0 0 3px rgba(46,126,156,.13)` | Halo de foco, sempre junto de `--line-focus` |

> **A assinatura migrou do fundo para a marca.** Até a v0.23 o cabeçalho usava um
> gradiente diagonal de 96deg, e este documento proibia trocá-lo por cor chapada. O
> refinamento institucional inverteu a decisão: o cabeçalho é `--hd` **chapado**, e
> quem capta luz é o quadrado de 32px da marca (`--mark-de` → `--mark-para` em
> 180deg, com `inset 0 1px 0 rgba(255,255,255,.22)`). O motivo é posicional, não
> estético — o painel abre logo abaixo da barra do próprio PJe, que também é um azul
> largo; dois gradientes da mesma família empilhados liam como uma faixa só. Um
> realce de 32px não tem esse problema, e o botão primário passa a herdar o mesmo
> gradiente vertical, dando coerência a um elemento que antes era chapado.

### Texto

| Token | Valor | Uso |
|---|---|---|
| `--ink` | `#0e323f` | Títulos serifados, nome de peça em destaque |
| `--text` | `#0e323f` | Corpo de texto |
| `--text-2` | `#3e5561` | Itens de lista, rótulo de botão secundário |
| `--text-3` | `#234e5e` | Chip de exemplo, texto sobre superfície tingida |
| `--muted` | `#6b7c85` | Texto de apoio, descrições |
| `--muted-2` | `#74858e` | Meta-informação, contadores |
| `--muted-3` | `#93a3ac` | Placeholders, ícones inativos |
| `--eyebrow` | `#a0aeb6` | Eyebrow mono uppercase (ver §3) |

### Superfícies

| Token | Valor | Uso |
|---|---|---|
| `--surface` | `#ffffff` | Painel, cartões, campos |
| `--surface-2` | `#fafcfc` | **Coluna de peças**, rodapé de entrada |
| `--surface-3` | `#ffffff` | **Área de conversa** |
| `--surface-card` | `#fcfdfd` | Cartão de passo, acordeão de chave |
| `--surface-list-ft` | `#f4f8f9` | Rodapé da lista de peças (`.docs-tip`) |
| `--hover` | `#eff4f6` | Hover de linha da lista |
| `--hover-2` | `#f5fafc` | Hover de chip/ação |
| `--accent-bg` | `#dfeaee` | Badge e pill de contagem |
| `--accent-bg-2` | `#e4edf0` | Número dos passos |
| `--canvas` | `#e9eef3` | Fundo atrás de páginas (editor, modelos) |

> **A conversa é branca e a lista é que fica tingida** — até a v0.23 era o inverso
> (`--surface-3` valia `#f5f9fc` e a lista era branca). Inverter põe o peso visual
> onde está o trabalho, que é o texto da resposta, e tira a coluna de navegação da
> disputa por atenção com a leitura. Como os dois tokens trocaram de papel e não só
> de valor, conferir cada uso de `--surface-2`/`--surface-3` ao migrar.

### Linhas

| Token | Valor | Uso |
|---|---|---|
| `--line` | `#e2eaee` | Divisórias, bordas de rodapé |
| `--line-2` | `#edf1f3` | Divisória suave dentro de blocos |
| `--line-card` | `#e4ebee` | Borda de cartão |
| `--line-input` | `#dae3e8` | Borda de campo |
| `--line-strong` | `#d8e2e6` | Borda de botão com contorno |
| `--line-check` | `#c3cfd5` | Checkbox |

### Categorias de peça

São **semânticas** — a cor identifica a espécie do documento na lista, nos chips,
no popup `@` e no mapa mental. Não reutilizar para outros fins.

| Token | Valor | Espécie |
|---|---|---|
| `--cat-decisao` | `#de8b2c` | Decisões, sentenças, despachos |
| `--cat-audiencia` | `#2f9268` | Atas e audiências |
| `--cat-peticao` | `#6a62c0` | Petições das partes |
| `--cat-prova` | `#c1508a` | Laudos, perícias, provas |
| `--cat-outro` | `#b7c4cb` | Demais documentos (neutro) |

> **Por que petições deixou de ser azul**: azul é a cor de *ação* do sistema
> (`--pje`). Uma categoria azul na lista competia com botões e links, e o usuário
> não conseguia dizer se o azul significava "petição" ou "clicável". Petições
> passou a roxo e provas a magenta, mantendo dourado/verde onde já estavam.

### Estados

| Token | Valor | Uso |
|---|---|---|
| `--ok` | `#2f9268` | Sucesso, salvo, chave configurada |
| `--ok-bg` | `#eaf4ef` | Fundo de confirmação suave (marca da peça em texto) |
| `--ok-line` | `#cbe3d8` | Borda do banner de estado "Pronto para usar" |
| `--ok-ink` | `#1e5c44` | Texto sobre confirmação suave |
| `--warn` | `#de8b2c` | Alerta, contexto quase cheio |
| `--warn-bg` | `#fbead2` | Fundo de aviso suave |
| `--warn-line` | `#eeddba` | Borda de aviso suave |
| `--warn-ink` | `#a96b14` | Texto sobre aviso suave |
| `--erro` | `#a5301f` | Erro, exclusão armada |
| `--erro-hd` | `#b4402f` | Hover do ✕ no cabeçalho |

> **Aviso suave × `.alertbar`.** O trio `--warn-*` veste o que **informa sem
> impedir de continuar**: o relatório de peças que não baixaram, a nota de
> download lento, o estado "voltar ao documento". A `.alertbar` é o contrário —
> ela aparece quando algo **bloqueia** o envio (contexto cheio, troca de
> provedor) e usa vermelho-tijolo, mais forte de propósito. Não trocar um pelo
> outro: se tudo alerta com a mesma intensidade, nada alerta.

---

## 3. Tipografia

```css
--ff-sans:  "IBM Plex Sans", "Segoe UI", system-ui, sans-serif;
--ff-serif: "Newsreader", Georgia, "Times New Roman", serif;
--ff-mono:  "IBM Plex Mono", "Cascadia Mono", Consolas, monospace;
```

- **Sans** para interface. Plex Sans e Plex Mono são a mesma superfamília, então
  rótulo e numeral compartilham construção e não brigam lado a lado.
- **Serif** para títulos — "Peças do processo", "Como posso ajudar?", nomes de
  página, chips de exemplo. É o que dá o tom forense sem recorrer a ornamento.
- **Mono** para **numerais que o usuário compara ou copia** (o id da peça) e para
  **eyebrows** uppercase. Tabular, alinha na vertical, não se confunde com o nome.

> **As fontes são vendorizadas, nunca carregadas de CDN.** Um `<link>` para
> `fonts.googleapis.com` seria barrado pela CSP de vários tribunais e, pior, faria
> uma requisição a servidor externo a partir da tela dos autos — vazamento que a
> extensão não pode causar. Os `.woff2` (todos SIL OFL) vivem em `vendor/fontes/`,
> declarados num arquivo único: **`src/fontes.css`**.
>
> **O painel não pode declarar `@font-face` no próprio CSS**, por duas razões
> independentes e ambas fatais em silêncio:
> 1. `@font-face` dentro de shadow tree é **ignorado** pela spec de CSS Scoping, e
>    o Chrome cumpre — a família nunca seria registrada e tudo cairia no fallback,
>    sem erro no console.
> 2. `panel.css` é injetado como TEXTO, então uma `url()` relativa resolveria
>    contra o host do tribunal e daria 404 mudo.
>
> Por isso `injetarFontes()` em `panel.js` faz fetch de `fontes.css`, troca o
> prefixo `../vendor/fontes/` por `chrome.runtime.getURL(...)` e injeta o
> resultado num `<style id="pje-ia-fontes">` **no `document.head` da página**.
> Injetar só `@font-face` ali é inócuo: registra nomes, não altera estilo algum da
> página. As páginas da extensão usam o mesmo arquivo por `<link>` simples, onde o
> caminho relativo já resolve certo.
>
> As fontes estão em `web_accessible_resources`. A stack de fallback continua
> declarada: se algum tribunal barrar `font-src chrome-extension:`, o painel
> degrada para Segoe UI/Georgia sem quebrar layout.

### Peso

Três pesos, e **`700` não é um deles**. Até a v0.23 o painel usava 700 em 23
lugares; o sistema refinado distribui tudo entre 400/500/600. Peso é o eixo que
mais afeta a sensação de "densidade" da interface — 700 em rótulo de 12px lê como
ruído, não como ênfase.

| Peso | Uso |
|---|---|
| 400 | Corpo de texto, parágrafos, itens de lista não destacados |
| **500** | **O peso padrão dos controles**: rótulo de botão, segmented inativo, chip, meta, selo do modelo |
| 600 | Títulos serifados, nome de peça em destaque, rótulo de campo, segmented ativo, botão primário |
| ~~700~~ | **Não usar.** |

### Escala

Sete degraus inteiros. **Não introduzir literais de `font-size` em px** fora
desta escala (`em` relativos no markdown das mensagens seguem corretos).

| Token | px | Uso |
|---|---|---|
| `--fs-nano` | 10 | id da peça, `kbd`, sobrescrito de citação |
| `--fs-micro` | 11 | rótulos, legendas, meta |
| `--fs-meta` | 12 | chips, dicas, controles secundários |
| `--fs-ui` | 13 | lista de peças, formulários, botões |
| `--fs-body` | 14 | mensagens, campo de entrada |
| `--fs-lg` | 15 | título do painel, título da lista |
| `--fs-lead` | 17 | "Como posso ajudar?" no painel estreito |
| `--fs-hero` | 26 | "Como posso ajudar?" nos modos largos |

**Eyebrow**: rótulo acima de um título — `--fs-micro`, peso 600,
`letter-spacing: 1.4px`, `text-transform: uppercase`, cor `--muted-2`.

A escala vale nas **cinco** folhas, não só no painel: `ui.css`, `editor.css`,
`modelos-page.css`, `mapa.css` e o `<style>` inline do `help.html` também. Elas
ficaram para trás numa rodada e acumularam 71 literais — com 25 meios-pixels
(10,5 / 11,5 / 12,5 / 13,5 / 14,5) — que é exatamente a variação sem intenção
que a escala existe para impedir. Ao arredondar, o degrau é o **mais próximo** e
empate sobe (16 → `--fs-lead`).

> A tipografia forense da folha A4 (`.jodit-wysiwyg`: Times 12**pt**, 1,5,
> recuo 1,25cm) **não** é interface e fica fora da escala — ela precisa bater
> com `editor-docx.js`, que é o que se imprime.

---

## 4. Espaço, raio, sombra

```css
/* espaço — oito degraus. --sp-2b e --sp-3b entraram no refinamento: o sistema
   trabalha muito na faixa 6–12px, e saltar de 6 para 10 (+66%) se via. */
--sp-1: 4px;  --sp-2: 6px;  --sp-2b: 8px;  --sp-3: 10px;
--sp-3b: 12px;  --sp-4: 14px;  --sp-5: 20px;  --sp-6: 28px;

--r-xs: 4px;    /* checkbox */
--r-tight: 6px; /* botão de 24px, segmento dentro de segmented */
--r-sm: 7px;    /* botão do cabeçalho, cluster interno */
--r-md: 8px;    /* botão, item de lista, segmented externo */
--r-ctrl: 9px;  /* campo de busca, marca, cluster do cabeçalho, Enviar */
--r-box: 10px;  /* cartão de chave, botão de 44px, cartão de provedor */
--r-lg: 11px;   /* cartão de passo */
--r-xl: 12px;   /* caixa de entrada */
--r-2xl: 14px;  /* moldura externa do painel */
--r-pill: 20px; /* chip, badge, selo do modelo — NÃO 999px */

--sh-card:  0 1px 2px rgba(14, 50, 63, 0.04);
--sh-seg:   0 1px 2px rgba(14, 50, 63, 0.10);  /* pill ativo do segmented */
--sh-btn:   0 1px 2px rgba(14, 50, 63, 0.22), inset 0 1px 0 rgba(255,255,255,0.18);
--sh-pop:   0 1px 2px rgba(14, 50, 63, 0.10), 0 24px 60px -18px rgba(14, 50, 63, 0.34);
--sh-panel: 0 1px 2px rgba(14, 50, 63, 0.10), 0 24px 60px -18px rgba(14, 50, 63, 0.34);
```

**`--r-pill` é 20px, não `999px`.** Num chip de 26px de altura a diferença é
invisível; num selo de 30px o `999px` arredonda até virar cápsula, e a cápsula
destoa dos raios de 8–12px de tudo em volta. 20px mantém a família.

O `--sh-btn` do botão primário tem **duas camadas**: a sombra projetada e um
`inset` branco no topo. É o inset que faz o gradiente vertical parecer uma
superfície iluminada em vez de um degradê chapado — não removê-lo ao ajustar.

Transições: `140ms ease` para cor/borda/fundo; `120ms ease` para hover de lista.
Nunca animar `width`/`height` de container com conteúdo (reflow visível).

---

## 5. Componentes

### Cabeçalho do painel
Altura **60px** (64px nos modos largos), fundo `--hd` **chapado**, texto branco. À
esquerda: marca 32×32 com `--r-ctrl`, gradiente `--mark-de`→`--mark-para` (180deg) e
`inset 0 1px 0 rgba(255,255,255,0.22)`, seguida de **duas linhas** — nome do produto
em `--ff-serif` (`--fs-lead`, peso 500) e, abaixo, o **número CNJ** em `--ff-mono`,
`--fs-nano`, `letter-spacing: .03em`, cor `#93bacA`. Nos modos largos o CNJ ganha
uma segunda informação ao lado (classe e órgão julgador), separada por barra
vertical de 1px `rgba(255,255,255,0.22)`.

À direita, os botões vivem em **clusters** — não soltos: cada grupo é um
`background: rgba(255,255,255,0.07)`, `--r-ctrl`, `padding: 3px`, `gap: 2px`. São
três: `[baixar · nova conversa]`, `[modos de layout]` e `[✕]` isolado. Botões 30×30
(32 nos largos), `--r-sm`, transparentes, hover `rgba(255,255,255,0.16)`; o modo
ativo fica com esse mesmo fundo fixo. O ✕ tem hover `--erro-hd`.

> **O cluster substituiu o separador de 1px** que ficava antes do ✕. Sete botões
> lado a lado exigiam um separador justamente porque não se lia onde um grupo
> terminava; agrupando por função, o agrupamento faz esse trabalho e ainda diz
> *quais* botões são parentes entre si — que o separador não dizia.

> Mostrar o CNJ no cabeçalho não é decoração: o usuário costuma ter vários
> processos abertos em abas, e era impossível saber a qual deles o painel se
> referia sem olhar a página atrás.

### Lista de peças
Fundo `--surface-2`. Cabeçalho com título serifado + badge de contagem (pill
`--accent-bg`, alinhado por **baseline**) + botão recolher «. Busca com **lupa SVG**
posicionada em `left: 11px`, foco `--line-focus` + `--ring`. **Segmented control**
`chave | principais | todas`: três botões, o ativo com fundo `--surface` + `--sh-seg`
e texto `--ink`, o inativo transparente com `--muted-2` e peso 500; moldura
`--r-md` sobre `#ebf1f3`. **À direita do segmented, o contador "N marcadas"** em
`--ff-mono`/`--fs-micro`/`--muted-3` — a contagem do que está selecionado é a
resposta à pergunta que o degrau acabou de gerar, e ficava longe demais no rodapé.
Legenda de categorias com dots de **6px**. Itens: checkbox 15px (`--r-xs`) + dot
6px da categoria + nome (`--fs-ui`, peso 600 se destacado / 400 se não, truncado) +
**id em `--ff-mono`**, `--fs-nano`, cor `--muted-3`. Rodapé `--surface-list-ft`.

> **O `<input type=checkbox>` de cada segmento fica fora da tela**
> (`position:absolute; opacity:0`), nunca `display:none`: ele continua sendo a
> fonte de verdade do estado e o par `label`+`input` mantém a acessibilidade
> nativa (foco por teclado, espaço para alternar, leitor de tela). Isso exige
> `:has(input:focus-visible)` no `.all`, senão o anel de foco desaparece junto.
> Esconder o checkbox devolve ~18px por segmento — é o que faz os três caberem
> nos **292px** da coluna do modo expandido, que é o pior caso de largura, mais
> estreito que os 432px do modo flutuante.
>
> Os rótulos têm versão longa e curta (`.op-l`/`.op-s`), mesmo padrão do medidor
> (`.g-full`/`.g-short`), com a lógica invertida: encurtam nos modos LARGOS,
> porque lá a lista é uma coluna estreita, e não uma faixa larga.
>
> **`.sel-nota`** (linha própria abaixo do controle, ocupando 100% da largura):
> diz o que o clique fez e por que pode ter feito menos do que se esperava —
> nenhuma peça reconhecida no degrau, ou lista ainda sem o tipo oficial da grid.
> Usa o trio de aviso **suave** (`--warn-bg`/`--warn-line`/`--warn-ink`), nunca a
> `.alertbar`: informa sem impedir de continuar. Some no gesto seguinte.

A faixa abaixo da lista (`.docs-tip`) hospeda as ações que valem para a **lista
inteira** — hoje `⟳ Carregar tudo`, `✨ Escolher com IA` e `⬇ Baixar .zip`. As três
compartilham a MESMA regra de estilo (`.tip-load, .tip-zip, .tip-ia`) de propósito:
são irmãs, e regras separadas divergiriam com o tempo. Ação nova de escopo "lista
toda" entra aqui, não na `.toolbar` — aquela linha já vive no limite em 484px.

O `!` (`.tip-i`) **fecha a fileira à direita**, não a abre: ele é indicador de
ESTADO da lista, e ação vem antes de estado no eixo de leitura — a mesma anatomia
da `.metarow` do rodapé. Aberta pelo ícone, a faixa dava a primeira posição a um
aviso secundário.

> **A faixa é de UMA fileira, sempre — e isso é incondicional.** Quem cede
> quando falta espaço é o rótulo de `Carregar tudo` (ellipsis), nunca a linha; a
> única quebra permitida é a do texto do aviso, que ocupa a fileira inteira
> abaixo. Incondicional porque `wrap` + `margin-left: auto` põe o `!` **sozinho**
> numa segunda fileira quando falta um punhado de pixels.
>
> **O que é condicional é o RÓTULO**, e o gatilho é a lista ser estreita — o que
> acontece por DUAS vias independentes: painel abaixo de 520px (`.estreito`) e a
> **coluna** de 328/372px dos modos largos (`.expanded`, `.livre-wide`). A regra
> nasceu só dentro do bloco `.estreito` e por isso o pior caso ficava sem defesa
> nenhuma: no expandido o painel tem 1180px — nada dispara `.estreito` —, mas a
> coluna tem 328px e os três botões com rótulo somam ~416px, então a fileira
> quebrava em duas com um buraco à direita da primeira. É a mesma lógica dos
> rótulos `.op-l`/`.op-s` do segmented: encurtar nos modos LARGOS, porque lá a
> lista vira coluna. Por ser regra do COMPONENTE, e não de um modo, ela vive
> junto da `.docs-tip`. Fora dessas classes sobra um caso só — a janela livre
> entre 520 e 740px, onde a lista é faixa de até 712px e os três rótulos cabem
> com folga; escondê-los ali seria perder informação sem motivo.
>
> Cuidado com o seletor que libera a quebra quando o aviso aparece: os gatilhos
> são `.carregando` e hover/foco no ícone, os MESMOS três que revelam o
> `.tip-txt`. Testar `:has(.tip-txt:not([hidden]))` **casa sempre** — o
> `.tip-txt` nunca recebe o atributo `hidden`, quem o esconde é `display:none` —
> e, com especificidade maior, devolvia `flex-wrap: wrap` em repouso: a fileira
> única existia no papel e não na tela.

### Aviso dentro do card de progresso (`.prep-nota`)
Nota em aviso suave abaixo da barra, usada quando o download passa de 12 s por
peça. Aparece **durante** a espera, que é quando a informação vale: o gargalo
real do produto é a entrega serializada do PJe, e sem isso a extensão parece
travada quando na verdade está esperando o tribunal. Ver `#rede` no `help.html`.

### Zona de arraste e ficha de importação (`.imp-drop`, `.imp-ficha`)

O único drag & drop do produto (importar `.docx` de peças-modelo). Vive nas duas
folhas com os **mesmos nomes de classe** e regras reescritas — `panel.css` está
num Shadow DOM e não pode importar `modelos-page.css`, e nomes iguais é o que faz
as duas se lerem lado a lado quando uma mudar. **Nenhum token novo.**

A **zona** é tracejada (`1.5px dashed --line-check`, `--r-box`, fundo `--paper`),
porque é um **alvo**, não um botão: contorno cheio a leria como controle
clicável e o gesto principal ali é soltar. No hover, no foco e durante o arrasto
ela vira `--pje` + `--hover-2`, com o ícone (24px, traço 1.4) acompanhando. Na
conferência ela fica **compacta** — uma faixa acima das fichas, com o rótulo
trocado para "adicionar mais" — e **não some**: sem alvo visível, arrastar mais
arquivos não teria onde cair.

A **ficha** é um cartão por arquivo (`--line`, `--r-box`) com checkbox real +
nome do arquivo em `--ff-mono`/`--fs-nano`, título e categoria editáveis, a
contagem em mono e a prévia do texto lido em **serifada** (é peça jurídica).
Desmarcada fica `opacity:.62` sobre `--paper` — **continua legível e editável**,
porque desmarcar não é apagar.

O selo **"sugerida"** (`--accent-bg`/`--pje-2`, `--fs-nano`, `--r-tight`) diz que
a categoria é palpite da máquina, e **desaparece no primeiro toque no seletor**:
depois disso ele estaria mentindo. Quando nada foi reconhecido, vira "confira"
nos tokens de aviso suave.

Tudo o que informa sem impedir — título duplicado, arquivo grande demais, arquivo
ilegível — usa o trio **`--warn-*`**, nunca a `.alertbar`: o lote continua, e o
que ficou de fora é nomeado no resultado. O único vermelho da tela é o botão
Cancelar **armado** (`--alerta`), porque descartar o lote é a ação destrutiva.

### Estado vazio da conversa
Eyebrow mono `ASSISTENTE DOS AUTOS` (só nos modos largos) + título serifado
centrado + subtítulo de uma linha em `--muted-2`. Grade de 3 cartões de passo
(`--surface-card`, borda `--line-card`, `--r-lg`) com o número em círculo de 19–21px
`--accent-bg-2`/`--pje` em `--ff-mono`. Eyebrow `COMECE POR AQUI` e chips que
**preenchem** o campo (nunca enviam) — os chips são **serifados** (`--ff-serif`,
`--r-pill`) e trazem a pergunta entre aspas tipográficas: é o que dá o tom forense
ao único lugar do painel onde o produto sugere palavras ao usuário.

Nos modos largos a linha final vira duas colunas (`Como funciona…` à esquerda como
botão de texto puro, `Guia completo →` à direita) separadas do resto por borda
superior. No estreito os três passos empilham e os chips viram botões de largura
total alinhados à esquerda.

### Faixa de retomada (`.retomada`)

Primeira linha da área de mensagens quando a conversa foi restaurada da memória
de caso: `Conversa retomada de 3 de agosto · 6 mensagens` + a nota de onde os
dados estão, e o botão de texto **Esquecer este processo** à direita.

Usa o trio de **confirmação suave** (`--ok-bg` / `--ok-line` / `--ok-ink`), não o
de aviso: nada deu errado — o trabalho anterior voltou, que é uma boa notícia. O
`--warn-*` aqui leria como problema e o vermelho da `.alertbar` está reservado
para o que **bloqueia** o envio.

Duas regras de conteúdo, e as duas são de privacidade, não de estética:

- A faixa **diz onde os dados estão** ("o texto das peças deste processo está
  guardado neste computador"). Memória silenciosa que ninguém pediu é o tipo de
  coisa que se descobre pelo caminho errado; ela se anuncia no lugar onde o
  efeito aparece.
- O botão de apagar mora **aqui**, junto da frase que explica o que existe, e não
  no cabeçalho — ali já vivem `.dl` e `.reset`, e um terceiro ícone destrutivo
  entre eles seria acidente esperando. A exclusão é em **dois cliques**
  (`Esquecer` → `Esquecer?` em `--erro`), nunca `confirm()` nativo, que congela a
  página do tribunal.

Sem memória não há faixa: quando não há o que esquecer, não há o que dizer.

### Rodapé de citações da bolha (`.cites`)

Duas naturezas diferentes convivem ali: **peça dos autos** (prova no processo,
vira botão `.cite-go` que rola a timeline) e **fonte na web** (página da internet,
vira `<a target="_blank">`). Até a v0.23 saíam na mesma lista, com a mesma
aparência — numa resposta que mistura autos e jurisprudência, que é o caso de uso
principal, isso apagava a fronteira que mais importa juridicamente.

Agora vão em grupos com **eyebrow** (`.cites-h` — `--fs-micro`, peso 600,
`letter-spacing: 1.4px`, uppercase, `--muted-2`), e o grupo web traz a contagem:
`FONTES NA WEB (3)`. O rótulo de grupo **só aparece quando há fonte web**: com
peças apenas, "veio dos autos" é a expectativa padrão do usuário e o título seria
ruído — a mesma regra do `.tip-txt` da timeline, que em repouso é só o ícone.

Cada fonte web mostra o **domínio** ao lado do título (`.cite-host` — `--ff-mono`,
`--fs-nano`, `--muted-3`), que é o que responde "de onde veio isto?" antes do
clique. Mono porque é identificador, não frase. Quando o título JÁ É o domínio
(caso do Gemini, que não manda manchete) mostra-se um só, senão sairia
`stj.jus.br stj.jus.br`. O `title` do elemento diz o degrau da fonte (tribunal
superior / tribunal deste processo / outra) — ver `CLAUDE.md`, "Prioridade das
fontes".

> **Não reordenar as linhas.** O número do rodapé é o mesmo do sobrescrito no
> corpo do texto; agrupar preserva o índice original de cada citação, e ordenar
> por autoridade quebraria a correspondência entre a marca na frase e a fonte.

### Rodapé de entrada
Fundo `--surface-2`. Faixa de ações com **ícone SVG colorido por função** (não mais
emoji nem dot):

| Ação | Ícone | Cor |
|---|---|---|
| Jurisprudência | lupa | `--pje` |
| Minutar | caneta sobre linha | `--cat-peticao` |
| Mapa mental | nó central com ramos | `--cat-prova` |
| Prompts | faísca dupla | `--cat-decisao` |
| Modelos | dois livros | `--cat-audiencia` |

> Minutar e Prompts **trocaram de cor** no refinamento (eram `--cat-decisao` e
> `--cat-peticao`). A regra que passou a valer: a cor do ícone é a da categoria de
> peça que a ação *produz ou consome* — minuta é peça de parte (roxo), prompt é
> instrução do juízo sobre o trabalho (dourado).

À direita, o selo do modelo ativo como pill (`--r-pill`) com dot de estado e
chevron — o chevron sinaliza que o selo é clicável, o que já era o comportamento.
Ao lado, o `ⓘ` como botão redondo de 26px.

Caixa de entrada com `--r-xl`, borda `--line-input`, foco `--line-focus` + `--ring`.
Botão **Enviar com gradiente vertical** (`--btn-de`→`--btn-para`, `--sh-btn`) e seta
→ à direita do rótulo; no modo estreito vira quadrado de 38×38 só com a seta.
Abaixo, dicas de teclado em `--fs-micro`.

### Ícones
SVG stroke, `fill: none`, `stroke-linecap/linejoin: round`, `currentColor` sempre
que a cor vier do estado. **A espessura varia por contexto** — um valor único faz
o ícone de 13px parecer mais pesado que o de 18px:

| Stroke | Onde |
|---|---|
| 1.7 | Marca (18px) |
| 1.8 | Botões do cabeçalho, `ⓘ`, cadeado |
| 1.9 | Toolbar, rodapé da lista, ✕ do cabeçalho |
| 2 | Lupa, recarregar, check, recolher « |
| 2.2 | Chevron ⌄ |
| 3 | ✕ pequeno dentro de chip (9px) |

Nada de emoji na interface: renderiza diferente em cada sistema, não aceita
`currentColor` e não alinha na grade óptica dos demais ícones. Isto vale também
para os **glifos unicode** que passam por ícone (`⟳ ⟲ ⎘ ⬇ ✚ ⬆ ✕`) — são a mesma
falha com outra roupa, e escaparam da primeira varredura porque não estão nas
faixas de emoji.

**Ícone dentro de uma frase** (`.ic-in`): o `help.html` e o `changelog.html`
nomeiam botões do painel — "clique em ⟨ícone⟩ **Minutar**". Desde que os botões
deixaram de usar emoji, esse texto precisa mostrar o **mesmo desenho** da tela,
senão o guia manda procurar algo que não existe. Alinhado por
`vertical-align: -2px`, nunca por flex: o ícone vive no meio de um parágrafo, e
transformar o `<strong>` em flex quebraria a quebra de linha.

**Escrever rótulo em botão com ícone**: sempre no `<span>` interno, nunca no
botão. `btn.textContent = "…"` apaga o `<svg>` — e de forma permanente quando o
código restaura o valor "anterior", que já vem sem o ícone. Existem dois
helpers para isso: `rotulo()` em `panel.js` e `piscar()` em `editor.js`.

### Alinhamento
- **`align-items: baseline`** para título + badge de contagem e para rótulo +
  valor. Centralizar faz o badge "flutuar" ao lado de um título serifado, porque
  as duas caixas têm alturas de linha diferentes.
- `space-between` nas linhas de cabeçalho (título ↔ ação) e em
  segmented ↔ contador "N marcadas".
- Ícone dentro de campo: `position: absolute; left: 11px; pointer-events: none` —
  nunca `::before` com padding, que desalinha quando o texto quebra.

### Alturas de controle
| Altura | Componente |
|---|---|
| 26 / 28px | Botões do cabeçalho no estreito, `ⓘ`, ✕ de chip |
| **30px** | Botão do cabeçalho e da toolbar, rodapé da lista |
| **32px** | Idem nos modos largos; segmented de raciocínio |
| 34px | Marca e ✕ nos modos largos |
| 36 / 38px | Campo de busca (estreito / largo) |
| **38 / 40px** | Enviar (estreito / largo); 38×38 quadrado no lateral |
| **42px** | `<select>` do popup |
| **44px** | Salvar configuração / Testar chave |

### Larguras
| Modo | Painel | Coluna de peças | Cabeçalho | Corpo (max-width) |
|---|---|---|---|---|
| Lateral | **420px** | gaveta colapsável, não coluna | 2 linhas | — |
| Flutuante / modal | 1180px | **328px** | 60px | 660px |
| Tela cheia | viewport | **372px** | 64px | 740px |

As larguras de painel para modal e tela cheia são referência do protótipo; o que é
prescritivo são as **colunas de peças**, as **alturas de cabeçalho** e o **lateral
em 420px**.

O ponto de virada é a **largura do painel**, não a da viewport — media query mede
a janela e erra no modo livre. Use `ResizeObserver` (já existe:
`atualizarLargura`, que alterna as DUAS classes de largura).

### Painel estreito (`.estreito`) — abaixo de 520px

Classe posta por `atualizarLargura()` sempre que o painel mede menos de **520px**.
Não é uma classe do modo lateral: o flutuante também tem 420px, e a janela livre
pode ser arrastada até lá. Um modo largo nunca a recebe (expandido 1120px,
livre-wide ≥ 740px).

Em 420px cabem **uma** fileira de botões e **uma** coluna. Tudo que dobra de linha
vira bagunça, e foi o que aconteceu antes desta regra existir: o rodapé da lista
quebrava em duas fileiras, a toolbar em duas, e a lista de 33 peças mostrava
**uma**. As cinco regras:

1. **Cabeçalho em duas linhas.** Linha 1: marca + título + `[⬇ 💬]` + `✕`. Linha 2:
   o cluster de layout ocupando a largura toda, cada botão `flex: 1` — vira um
   segmented control de verdade. Só assim o título deixa de ser cortado
   ("Assist…") e o CNJ reaparece.
2. **Uma fileira no rodapé da lista.** Só `Carregar tudo` mantém o rótulo — é o
   botão que o texto do aviso nomeia, e um ícone ali faria o aviso mentir.
   `Escolher com IA` e `Baixar .zip` ficam só com o ícone (`title` + `aria-label`
   preservados). **A regra não é mais exclusiva deste modo**: ela vale igual na
   coluna estreita dos modos largos e por isso mora junto do componente
   `.docs-tip` (ver "Lista de peças"). Editá-la aqui não tem efeito.
3. **Uma fileira na toolbar.** `Jurisprudência` (tem ESTADO, e o estado é o
   rótulo) e `Minutar` (ação primária) mantêm o rótulo; mapa, prompts e modelos
   ficam só com o ícone. A `.metarow` desce ancorada à direita quando não couber —
   quebra deliberada, não vazamento.
4. **A lista é uma gaveta.** `max-height: 46%` (≈ 4 peças visíveis, contra uma),
   e o par `.docs-fold` / `.docs-rail` que já existe devolve a altura inteira ao
   chat com um clique. Marcar peças e ler a resposta são fases SEQUENCIAIS; não
   há por que reservar espaço para as duas ao mesmo tempo.
   **Porcentagem, não `vh`**: só no lateral a janela é o painel. O flutuante tem
   660px fixos, e `44vh` numa tela de 1080px reservaria 475 dos 660 para a lista,
   deixando uma tira para o chat. O `%` resolve contra o `.content`, que é quem
   de fato divide a altura.
5. **Enviar vira quadrado** 38×38 só com a seta, e os atalhos do rodapé caem para
   três (sai o `Shift+Enter`).

Textos que mudam de lugar mudam de palavra: no estreito a lista fica **acima** do
chat, não ao lado. O passo 1 do estado vazio troca "na lista ao lado" por "na
gaveta acima" pelo mesmo mecanismo dos rótulos longo/curto do segmented
(`.op-l`/`.op-s`) — dois `<span>`, escolha no CSS, zero JS.

### Popup e página de opções: a MESMA tela, em duas densidades

`popup.html` e `options.html` compartilham o `popup.js` — e agora também a
estrutura: chip de estado, três cartões de provedor, cartão do provedor ativo
(chave + modelo + segmented de raciocínio), instruções personalizadas com chips
de persona, a linha `Testar chave` + `Salvar` e a caixa `.privacy`. A página de
opções não é outra tela: é a mesma com respiro e com os textos longos que não
cabem nos 600px de altura do popup do Chrome.

**`.privacy` — uma caixa, três fatos.** Fecha o bloco de ação com o que o usuário
precisa saber antes de usar: a chave fica **neste navegador**, as peças marcadas
**vão à API** do provedor, e **conexão por cabo faz muita diferença**. Cartão
`--surface-card` / `--line-card` / `--r-box`, texto todo no mesmo eixo de leitura
à esquerda; o que distingue as linhas é a **cor do ícone** — `--pje` para a
garantia, `--warn` para a implicação —, não a moldura.

> Eram três coisas em três lugares, e o resultado somava mal. `.lock-note`
> (cadeado, centralizado, `--muted-3` — o único elemento fora do eixo de leitura
> da coluna) e `.note` (âmbar, à esquerda, barra de 3px) diziam a MESMA coisa em
> dois alinhamentos e duas cores, com os passos "Como usar" separando um do outro
> no popup. Três blocos de aviso empilhados alertam todos com a mesma
> intensidade, e aí nada alerta (§2).
>
> A terceira linha, a de rede, **não existia em tela nenhuma de configuração** — e
> é a mais acionável das três, porque o gargalo do produto é o PJe entregando as
> peças uma de cada vez. Ela estava dita em três lugares e todos exigem uma ação
> ou uma condição para aparecer: o guia do painel (acordeão fechado), a
> `.prep-nota` (só depois de 12 s por peça) e o `help.html#rede` (outra página).
> Sem ela, conexão ruim lê como extensão lenta. A divisória tracejada
> (`--line-2`) é que marca a mudança de assunto dentro da caixa — um segundo
> cartão recriaria o empilhamento que ela acabou de desfazer.
>
> **Cada linha é `display:flex`, então todo o texto vai num `<span>` único.** Sem
> ele, cada `<b>` e cada nó de texto vira um flex item próprio: a frase se parte
> em pedaços com o `gap` de 8px entre eles.

Enquanto ela teve layout próprio (acordeões `<details class="keybox">`), o
resultado era duas telas com aparências diferentes para a mesma tarefa — e um
caminho de `<select>` no `popup.js` que só ela exercitava. Os dois saíram.

**Rodapé de links**: separador é `gap`, nunca um `<span>·</span>`. Como item de
flex o ponto viaja na quebra de linha e fica pendurado no fim da fileira,
apontando para nada.

**Marca das páginas satélites** (`editor`, `modelos`, `mapa`): o mesmo quadrado
com gradiente vertical e inset branco do painel e do popup, com a imagem menor
que ele. Eram as únicas telas com o ícone chapado sobre o cabeçalho.

---

## 6. Restrições da plataforma

1. **`[hidden] { display: none !important }`** em todo CSS de página: qualquer
   regra de autor com `display` vence o atributo `hidden`, e o bloco "escondido"
   reaparece. Vale para `panel.css`, `ui.css`, `mapa.css`, `editor.css`,
   `modelos-page.css`.
2. **Nada de recurso externo** — sem CDN, sem Google Fonts, sem imagem remota. O
   painel roda na página do tribunal; as demais páginas têm CSP `script-src 'self'`.
   As fontes são servidas de `vendor/fontes/`; no painel, via `injetarFontes()`,
   que faz fetch de `src/fontes.css`, troca o prefixo `../vendor/fontes/` por
   `chrome.runtime.getURL(...)` e injeta num `<style id="pje-ia-fontes">` no
   `document.head` DA PÁGINA — não no shadow tree, onde `@font-face` é ignorado
   (ver §3).
3. **Conteúdo dos autos é hostil**: todo texto vindo de peça passa por
   `escapeHtml` antes de virar HTML. `renderMd` escapa **primeiro** e formata
   depois — essa ordem não pode inverter.
4. **Nunca `confirm()`/`alert()` nativos**: o diálogo vive fora do Shadow DOM e
   congela a extensão. Confirmação destrutiva é sempre em **dois cliques**.
5. **Nada de nome de arquivo ou pasta iniciado por `_`** na árvore da extensão: o
   prefixo é reservado (`_locales`, `_metadata`) e o Chrome recusa carregar tudo.

---

## 7. Checklist antes de mexer no frontend

- [ ] Li este arquivo e usei tokens, não literais.
- [ ] Se criei um token, adicionei-o à tabela acima **e** aos dois arquivos de
      variáveis (`panel.css` e o `:root` da página em questão).
- [ ] Não introduzi `font-size` fora da escala nem `font-weight: 700`.
- [ ] Usei ícone SVG, não emoji.
- [ ] Texto vindo dos autos está escapado.
- [ ] Testei o estado **vazio**, não só o preenchido.
- [ ] Testei no painel estreito (420px), não só no expandido.
- [ ] `[hidden]` continua funcionando nos blocos que criei.
