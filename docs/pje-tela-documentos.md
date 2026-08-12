# PJe — listar documentos pela tela "Documentos"

> Engenharia reversa do PJe 1º grau. Testado no TJCE (`pje.tjce.jus.br/pje1grau`);
> como a base de código é a do CNJ, trocando o host tende a valer para os demais
> tribunais.
>
> **IMPLEMENTADO** em `PJE.listarPelaGrid` (`src/pje.js`), com uma diferença de
> arquitetura em relação ao proposto: **iframe oculto same-origin em vez de aba
> em segundo plano**, o que evita as permissões `tabs`+`scripting` — ver
> "Iframe em vez de aba", abaixo. O scroll continua como fallback.
>
> ⚠️ **LEIA ANTES DE USAR ESTA ROTA (12/08/2026).** Existe um caminho MELHOR e
> ele é a rota 1 desde a v0.38.0: `GET /{base}/seam/resource/rest/pje-legacy/
> processos/{idProcesso}/documentos` devolve a lista inteira em UMA requisição
> REST, com o **tipo oficial** de cada peça (campo `descricao`) e a data de
> juntada — **sem gastar nenhuma tela JSF**, enquanto a grid gasta ~10 num
> processo de 138 peças e é o que faz a aba do usuário morrer com "Sua página
> expirou" (ver a seção homônima no `CLAUDE.md`). A grid segue documentada e
> implementada porque é o fallback e porque é a única que traz **quem juntou** a
> peça e as colunas `extras` daquele tribunal.

## O problema com os Autos Digitais

A tela de Autos Digitais (`listAutosDigitais.seam`, ou
`ng2/dev.seam#/autos-digitais/{idProcesso}`) lista os documentos com **paginação
infinita** (`bindPaginacaoInfinita`, RichFaces/A4J). Só o que está visível existe
no DOM, então a única forma de raspar é rolar até a contagem de
`idProcessoDocumento` parar de crescer — que é o que
`PJE.carregarTimelineCompleta` faz hoje.

**Isso é um heurístico temporal, não uma garantia.** "Parou de crescer" ≠
"acabou": se o servidor demorar mais que a janela de espera, a leitura para cedo
e devolve lista parcial **sem erro nenhum**. A tela também não informa o *tipo* do
documento — hoje ele é adivinhado por palavra-chave no título (`CATEGORIAS` em
`panel.js`).

## A alternativa: a tela "Documentos"

No menu (☰) do processo existe o item **Documentos**, que abre uma grid tabular
paginada. Medido num processo de 40 documentos:

| Fato | Valor |
|------|-------|
| Gatilho | `<a id="navbar:linkAbaDocumentos" onclick="A4J.AJAX.Submit('navbar', …)">` |
| Transporte | `POST` na própria `listAutosDigitais.seam` → `text/xml` (partial response RichFaces), ~270 KB |
| Grid | `id="processoDocumentoGridList"` — **o id nem sempre está presente** |
| Colunas | Id · Id na origem · Número · Origem · **Juntado em** · **Juntado por** · Documento · **Tipo** · Guia de recolhimento · Motivo da isenção · Anexos |
| Paginação | slider RichFaces (`input.rich-inslider-field`); total em `.rich-inslider-right-num` |
| Cobertura | 16 + 16 + 8 = 40 — idêntica ao "40 de 40" dos Autos Digitais |
| `Id` | **é o `idProcessoDocumento`** — confirmado baixando pela rota de download (200 `application/pdf`) |

**Por que compensa:**

1. Traz o **tipo oficial** ("Petição", "Certidão", "Despacho", "Contestação",
   "Documento de Comprovação"…), a **data/hora da juntada** e **quem juntou, com o
   papel** (Advogado / Magistrado / Sistema). Nada disso existe nos Autos Digitais.
2. **O total de páginas é conhecido.** Dá para *afirmar* que leu tudo, em vez de
   inferir pelo fim do scroll. Se uma página falhar, dá para marcar o resultado
   como incompleto — em vez de entregar lista parcial como se fosse completa.

## Armadilhas (todas observadas na prática)

1. **Ids JSF são posicionais.** O input do slider tem id
   `j_id1822:j_id1823Input`, gerado pelo JSF pela *posição* do componente na
   árvore. Muda entre versões e customizações do tribunal. Localize pela
   **classe** (`input.rich-inslider-field`), nunca pelo id.
2. **O id `processoDocumentoGridList` some.** Dependendo de como o A4J
   re-renderizou, a mesma tabela aparece sem ele. Tenha um segundo critério: a
   **assinatura das colunas** — uma tabela com `Id` + `Juntado em` + `Tipo` só
   pode ser a de documentos. As tabelas do RichFaces são aninhadas e o ancestral
   aparece *antes* na ordem do documento; pegue a candidata mais **interna**,
   senão os `<th>` de tudo o que ela embrulha desalinham o mapeamento.
3. **Os `<th>` vêm com `<script>` CDATA embutido no texto.** Limpe antes de
   comparar: `.replace(/\/\/<!\[CDATA\[[\s\S]*?\/\/\]\]>/g, "").replace(/\s+/g, " ").trim()`.
4. **A paginação faz POST de página inteira.** A URL perde a query string e o
   documento é recriado — não dá para segurar estado em `window`. E, se isso for
   feito na aba do usuário, tira da tela o documento que ele estava lendo. Use
   uma **aba própria em segundo plano**.
5. **Não confie no valor do slider como sinal de troca de página** — quem
   escreveu o valor foi você, então o teste passa na página velha. Carimbe o
   documento atual (`document.documentElement.setAttribute("data-pje-stale","1")`)
   antes de submeter: o documento novo nasce sem o carimbo.
6. **O clique pode ser engolido em silêncio.** Em navegações por script o
   `A4J.AJAX.Submit` sai, o servidor devolve a mesma tela e nada muda — sem erro.
   Provável relação com a conversação Seam (`cid`) ainda se estabelecendo.
   **Re-tente o clique** (3×) antes de desistir.
7. **O renderer congela.** ~270 KB de HTML com `<script>` inline por linha: em
   processos grandes o Chrome fica sem resposta por dezenas de segundos. Use
   timeouts generosos (até 30 tentativas × 700 ms por página).

## Acionando a paginação

```js
var inp = document.querySelector("input.rich-inslider-field");
document.documentElement.setAttribute("data-pje-stale", "1"); // carimbo
inp.value = String(n);
["input", "change", "blur"].forEach(function (ev) {
  inp.dispatchEvent(new Event(ev, { bubbles: true }));
});
inp.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter", keyCode: 13 }));
```

Pronto quando: sem `data-pje-stale`, `readyState === "complete"`, a grid existe
(por id **ou** por assinatura de colunas) e algum `input.rich-inslider-field`
está com o valor esperado.

## Baixando cada documento

O `Id` da grid é o `idProcessoDocumento`. Rota de download:

```
GET /{contexto}/seam/resource/rest/pje-legacy/documento/download/{TRIBUNAL}/{grau}/{idProcesso}/{idDocumento}
```

Ex.: `.../documento/download/TJCE/1g/{idProcesso}/{idDocumento}`

- Serve **os dois tipos**: nascidos digitais em **HTML** (decisões, despachos,
  petições do editor) e os com binário/**PDF** (anexos, digitalizados). O
  `Content-Type` da resposta diz qual é.
- A forma curta `.../documento/download/{idDocumento}` existe por
  retrocompatibilidade, mas **só funciona para os PDFs**. Para os HTML é preciso a
  forma completa com `{idProcesso}` — sem o contexto do processo o servidor
  devolve uma casca vazia.
- Autenticação: **cookie**, não `Authorization: Bearer`. Quem autentica a área
  legada/Seam é o `JSESSIONID` + o cookie sticky
  (`PJE-<TRIB>-<grau>-StickySessionRule`, usado pelo balanceador para mandar
  sempre ao nó que guarda a sessão). O JWT do Keycloak diz *quem* você é, mas não
  autoriza sozinho. De dentro do navegador logado, basta `credentials: "include"`.

## Arquitetura recomendada

Grid como rota principal, scroll como **fallback** — não apagar o scroll: ele
continua sendo a única rota quando a grid não existe ou mudou de layout no
tribunal X.

```
1. abre o processo numa aba própria em segundo plano
2. clica navbar:linkAbaDocumentos (re-tentando até 3x)
3. lê página 1: colunas + linhas + total de páginas
4. para n = 2..total: vira a página, espera ficar pronta, acumula as linhas
5. mapeia as colunas PELO CABEÇALHO (não por índice fixo) → id, título,
   tipo oficial, juntadoEm, juntadoPor
6. marca incompleto = (páginas lidas < total)   ← senão vira a mesma falha
                                                   silenciosa do scroll
7. fecha a aba (sempre, inclusive em erro)
```

O mapeamento pelo cabeçalho importa: se um tribunal reordenar ou acrescentar uma
coluna, o parser acompanha em vez de silenciosamente ler o campo errado.

## Iframe em vez de aba (o que foi implementado)

A proposta original era abrir uma aba em segundo plano e dirigi-la por
`chrome.scripting`. O motivo é correto — a armadilha 4 (POST de página inteira
que recria o documento) exige um documento descartável que não seja o do usuário.
Mas um **iframe oculto same-origin** satisfaz a mesma exigência sem custar
permissão alguma:

| | Aba + `chrome.scripting` | **Iframe oculto** |
|---|---|---|
| Permissões | `tabs` + `scripting` — **muda o aviso de instalação** e obriga nova revisão na Web Store | nenhuma: o content script já roda na origem |
| Documento destruído pelo POST | o da aba auxiliar | o do iframe |
| Onde vive o estado da paginação | no worker | no content script, fora do iframe |
| Quem monta o POST do RichFaces | o `A4J.AJAX.Submit` da aba | o `A4J.AJAX.Submit` do iframe — igual |
| Risco | — | `X-Frame-Options: DENY` no tribunal X; renderer compartilhado (armadilha 7) |

Os dois riscos do iframe são tratados: `contentDocument` inacessível devolve
`null` (e o chamador cai no scroll), o frame fica fora da tela e com
`visibility:hidden` para não pagar paint, e há teto global de 120 s.

Detalhe que importa: dentro do iframe **clicamos no link real**, deixando o
próprio A4J do PJe montar o POST. Replicar os parâmetros do RichFaces na mão
(`AJAXREQUEST`, `javax.faces.ViewState`, o id do componente) funcionaria, mas
seria mais uma superfície de quebra a cada versão do PJe.

## Como está integrado

`panel.onCarregarTimeline` (content.js) tenta a grid primeiro e cai no scroll se
ela devolver `null`. Quando a grid responde:

- as peças são **mescladas** com as da timeline (`mesclarDocs`): a timeline manda
  na ORDEM (é a cronologia que o usuário vê) e a grid acrescenta as que o scroll
  não alcançou, além do `tipo` oficial de cada uma;
- `categoriaDe` (panel.js) passou a aceitar o objeto da peça e classifica pelo
  **`tipo` antes do título** — "Despachos / 2" não diz nada, "Despacho de Mero
  Expediente" diz tudo;
- a dica da timeline informa **quantas páginas de quantas** foram lidas, e diz
  "leitura PARCIAL" quando `paginasLidas < paginas`. É este o ganho central: a
  rota por scroll entrega lista parcial com cara de completa.

## Testes

26 asserções em `teste-grid.mjs` (scratchpad), sobre um HTML que reproduz as
armadilhas: tabelas aninhadas do RichFaces (confere que pega a **interna**),
`<th>` com CDATA, ausência do id `processoDocumentoGridList`, colunas
**reordenadas**, linha de rodapé com `colspan` e tabela que não é a grid.
Falta o smoke test num processo real.
