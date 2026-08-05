// -----------------------------------------------------------------------------
// Tour de primeiro uso — onboarding visual dentro do próprio painel.
//
// POR QUE CASEIRO (Driver.js/Shepherd/Intro.js foram avaliados e descartados):
//   1. SHADOW DOM. Todos os alvos (.btn-plib, .tip-ia, .doclist, .sel-opts…)
//      vivem no shadowRoot de #pje-ia-host — `document.querySelector` deles
//      devolve null. As libs aceitam um Element pronto, mas aí já se escreveu a
//      resolução de alvo, que é metade do trabalho delas.
//   2. ISOLAMENTO. Elas injetam o popover em document.body, FORA do shadow, e o
//      balão volta a ficar exposto ao CSS do tribunal — o painel usa Shadow DOM
//      exatamente para não estar. Seria o único elemento sem isolamento.
//   3. O QUE ESTE TOUR ENSINA SÃO GESTOS (arrastar em faixa, Shift+clique,
//      botão direito), e nenhuma lib anima gesto: elas recortam um retângulo e
//      escrevem um balão. Balão dizendo "arraste para marcar" não ensina; mão
//      fantasma percorrendo quatro linhas que se marcam sozinhas ensina.
//   4. Ele PILOTA o painel (abrir, expandir, mostrar a lista) — funções internas
//      que só existem aqui.
//   O recorte, que é a parte que a lib resolveria, são cinco linhas de CSS
//   (box-shadow gigante num div fixed — é o que o Driver.js faz por dentro).
//
// INVARIANTE CENTRAL — O TOUR NUNCA TOCA NO ESTADO REAL. Os gestos são
// demonstrados num PALCO FALSO (lista fictícia dentro do balão), jamais nas rows
// verdadeiras. Marcar peça de verdade dispararia `selChangeCb` → estimativa de
// contexto → `baixarQuieto`/prefetch, isto é, um tour de boas-vindas iniciando
// downloads reais na fila serializada do PJe. O palco também é o que faz o tour
// funcionar com a timeline ainda vazia, que é justamente o primeiro uso.
//
// O painel trata este arquivo como OPCIONAL (`typeof PjeTour !== "undefined"`),
// como já faz com MLIB e DocxImport: sem ele, nada quebra e o convite some.
// -----------------------------------------------------------------------------
var PjeTour = (function () {
  "use strict";

  // Versionado: um roteiro novo (recursos novos) pode voltar a oferecer o tour
  // sem que quem já viu o antigo perca a marcação de "visto".
  const VERSAO = 1;
  const CHAVE = "tourVisto";

  // Ícones locais. O `SVG` do panel.js é const dentro do IIFE dele e não sai de
  // lá; são poucos e o DESIGN.md §5 proíbe emoji (não aceita currentColor e não
  // alinha na grade óptica). Stroke 1.9 — a espessura do rodapé/toolbar.
  const I = {
    seta:
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13M13 6l6 6-6 6"/></svg>',
    volta:
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H6M11 6l-6 6 6 6"/></svg>',
    x: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    faisca:
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/></svg>',
    // ponteiro do palco: seta de mouse cheia (precisa de fill para "pousar"
    // sobre a lista falsa com peso próprio, ao contrário dos ícones de traço)
    mao:
      '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M5.5 3.2l12 8.6-5.2.6 2.9 6.2-2.4 1.1-2.9-6.2-3.7 3.4z" fill="#0e323f" stroke="#fff" stroke-width="1.3" stroke-linejoin="round"/></svg>',
    check:
      '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5 5L20 6.5"/></svg>',
  };

  // ---------------------------------------------------------------------------
  // Roteiro. Cada passo: alvo (função → Element | Element[] | null), título,
  // corpo (HTML de texto NOSSO — nada vindo dos autos passa por aqui) e um
  // `palco` opcional, que é a demonstração animada.
  // `antes` roda antes de pintar o passo (para pilotar o painel).
  // ---------------------------------------------------------------------------
  function roteiro(ctrl) {
    const $ = (s) => ctrl.root.querySelector(s);
    // O capítulo vira eyebrow no card. Sete dos treze passos são sobre MARCAR
    // PEÇAS de propósito: é a tarefa que o usuário repete dezenas de vezes por
    // processo, a que mais custa tempo quando feita a dedo e a que concentra os
    // recursos que ninguém descobre sozinho. O resto da extensão se explica no
    // primeiro uso; a seleção, não.
    const SEL = "Marcar as peças";
    const FER = "Ferramentas";
    const CON = "Conferir";
    return [
      {
        id: "abertura",
        alvo: () => null,
        capa: true,
        titulo: "Bem-vindo ao assistente dos autos",
        corpo:
          "<p>Em pouco mais de um minuto você vê o que a maioria leva semanas para " +
          "descobrir sozinha — a começar pelo essencial: <b>marcar dezenas de peças " +
          "sem clicar uma a uma</b>.</p>" +
          "<p class='tour-p2'>Nada aqui altera o seu processo. É só uma visita guiada, " +
          "e você pode sair a qualquer momento.</p>",
      },
      {
        id: "lista",
        cap: SEL,
        alvo: () => $(".docs"),
        titulo: "Tudo começa nesta lista",
        corpo:
          "<p>São as peças da linha do tempo do processo. <b>Só o que estiver marcado " +
          "aqui é lido</b> — nada mais entra na análise.</p>" +
          "<p>A <b>cor</b> diz a espécie num relance (decisões, audiências, petições, " +
          "provas) e o número ao lado é o <b>id da peça</b>, que você usa para " +
          "reencontrá-la no PJe.</p>" +
          "<p class='tour-nota'>A seguir, as <b>seis maneiras</b> de marcar — da mais " +
          "rápida à mais precisa.</p>",
        palco: "lista",
      },
      {
        id: "degraus",
        cap: SEL,
        alvo: () => $(".sel-opts"),
        titulo: "1. Os três degraus",
        corpo:
          "<p><b>chave</b> marca a espinha dorsal: inicial, contestação, laudo, " +
          "sentença, recursos. Costumam ser <b>cerca de doze peças num processo de " +
          "duzentas</b> — e respondem a maior parte das perguntas.</p>" +
          "<p><b>principais</b> acrescenta o resto do conteúdo e deixa de fora o " +
          "expediente (certidões de intimação, guias, procurações). <b>todas</b> é a " +
          "lista inteira.</p>" +
          "<p class='tour-nota'>Os três <b>somam</b> à sua escolha: nenhum deles " +
          "desmarca o que você marcou à mão.</p>",
        palco: "degraus",
      },
      {
        id: "nome",
        cap: SEL,
        alvo: () => $(".docsearch"),
        titulo: "2. Pelo nome — na busca ou com “@”",
        corpo:
          "<p>A <b>busca</b> filtra por título <i>e pelo tipo oficial</i>, sem exigir " +
          "acento. E o filtro manda nos degraus: com “perícia” na busca, <b>todas</b> " +
          "marca só as peças de perícia.</p>" +
          "<p>Dentro da pergunta, um <b>@</b> abre a mesma lista sem tirar as mãos do " +
          "teclado — escolha e a peça é marcada.</p>",
        palco: "nome",
      },
      {
        id: "arrastar",
        cap: SEL,
        alvo: () => $(".doclist"),
        titulo: "3. Arraste para marcar em faixa",
        corpo:
          "<p>Quarenta petições em sequência não deveriam custar quarenta cliques. " +
          "<b>Pressione o botão do mouse numa peça e arraste</b>: todas por onde o " +
          "ponteiro passar são marcadas — inclusive a de origem.</p>",
        palco: "arrastar",
      },
      {
        id: "shift",
        cap: SEL,
        alvo: () => $(".doclist"),
        titulo: "4. Shift + clique marca até aqui",
        corpo:
          "<p>Clique na primeira peça, role até a última e dê <b>Shift + clique</b> " +
          "nela: o intervalo inteiro entra de uma vez.</p>" +
          "<p class='tour-nota'>Serve igualmente para <b>desmarcar</b> uma faixa.</p>",
        palco: "shift",
      },
      {
        id: "direito",
        cap: SEL,
        alvo: () => $(".doclist"),
        titulo: "5. Botão direito: daqui para baixo",
        corpo:
          "<p>Quando a outra ponta está fora da tela, arrastar exigiria rolar com o " +
          "botão pressionado. O <b>botão direito</b> sobre uma peça abre <b>marcar " +
          "daqui para baixo</b> (ou para cima) e resolve numa ação só.</p>" +
          "<p class='tour-nota'>É o gesto para “desta sentença em diante” ou “tudo até " +
          "a inicial”.</p>",
        palco: "direito",
      },
      {
        id: "ia",
        cap: SEL,
        alvo: () => $(".tip-ia"),
        titulo: "6. Ou deixe a IA escolher",
        corpo:
          "<p>Escreva a pergunta e clique em <b>Escolher com IA</b>. Ela recebe apenas " +
          "a <b>lista</b> — id, título, tipo, data, quem juntou — e <b>nenhum byte do " +
          "conteúdo</b> das peças; devolve as que interessam <i>àquela</i> pergunta. " +
          "Com o campo vazio, escolhe as que descrevem o processo.</p>" +
          "<p class='tour-nota'>As peças acendem enquanto ela ainda escreve. Custa " +
          "centavos, e o <b>motivo de cada escolha</b> fica na dica da peça — você " +
          "precisa poder discordar.</p>",
        palco: "ia",
      },
      {
        id: "prompts",
        cap: FER,
        alvo: () => $(".btn-plib"),
        titulo: "Seus prompts, a um “/” de distância",
        corpo:
          "<p>Aquela instrução que você reescreve toda semana vira um prompt salvo. " +
          "Depois, <b>digite “/” no começo do campo</b>: escolha, complete com a sua " +
          "pergunta e envie.</p>" +
          "<p class='tour-nota'>Sincronizam entre os navegadores logados na mesma " +
          "conta Google.</p>",
        palco: "prompts",
      },
      {
        id: "modelos",
        cap: FER,
        alvo: () => $(".btn-mlib"),
        titulo: "Suas peças-modelo",
        corpo:
          "<p>Cadastre suas sentenças, decisões e despachos — inclusive " +
          "<b>arrastando vários .docx de uma vez</b>. Ao gerar uma minuta, escolha a " +
          "categoria e o assistente segue a <b>estrutura e a linguagem</b> dos seus " +
          "modelos.</p>" +
          "<p class='tour-nota'>Os <b>fatos</b> continuam saindo só das peças deste " +
          "processo — nome, valor e data nunca vêm do modelo.</p>",
      },
      {
        id: "minuta",
        cap: FER,
        alvo: () => [$(".btn-minuta"), $(".btn-mapa")],
        titulo: "Minutar e mapa mental",
        corpo:
          "<p><b>Minutar</b> devolve a peça redigida num editor em nova aba, pronta " +
          "para revisar, copiar para o PJe ou baixar em Word.</p>" +
          "<p><b>Mapa mental</b> abre os autos como um diagrama navegável — partes, " +
          "linha do tempo, teses e provas, cada item com a peça e a folha de onde saiu.</p>",
      },
      {
        id: "confianca",
        cap: CON,
        alvo: () => $(".metarow"),
        titulo: "Confira sempre a origem",
        corpo:
          "<p>Cada afirmação vem com a <b>peça, o id e a folha</b>. Clicar na fonte " +
          "leva direto ao documento na linha do tempo — é o que separa uma resposta " +
          "conferível de um palpite.</p>" +
          "<p>Aqui embaixo ficam o <b>medidor de contexto</b> e o <b>custo</b>. Se o " +
          "medidor encher, <b>desmarcar peças libera espaço na hora</b>.</p>",
        palco: "citacao",
      },
      {
        id: "fim",
        alvo: () => null,
        capa: true,
        titulo: "É só isso. Bom trabalho.",
        corpo:
          "<p>Marque as peças, faça a pergunta, confira a origem. O guia completo — " +
          "com modelos, preços e limites — fica no botão <b>Guia completo</b>, ao pé " +
          "da conversa.</p>" +
          "<p class='tour-nota'>Para rever esta visita, o botão <b>Ver como funciona</b> " +
          "está no início de toda conversa nova.</p>",
      },
    ];
  }

  // ---------------------------------------------------------------------------
  // Palcos — a demonstração animada. Cada um devolve {html, tocar(el, reg)},
  // onde `reg` registra os timers para que a troca de passo cancele tudo.
  // ---------------------------------------------------------------------------
  const PECAS_FALSAS = [
    { t: "Petição Inicial", id: "184100621", c: "cat-peticao" },
    { t: "Procuração", id: "184100628", c: "" },
    { t: "Contestação", id: "184100639", c: "cat-peticao" },
    { t: "Laudo Pericial", id: "184100647", c: "cat-prova" },
    { t: "Sentença", id: "184100655", c: "cat-decisao" },
  ];

  function listaFalsaHtml(n) {
    return PECAS_FALSAS.slice(0, n || PECAS_FALSAS.length)
      .map(
        (p, i) =>
          '<div class="tp-row ' + p.c + '" data-i="' + i + '">' +
          '<i class="tp-chk">' + I.check + "</i>" +
          '<i class="tp-dot"></i>' +
          '<span class="tp-t">' + p.t + "</span>" +
          '<span class="tp-id">' + p.id + "</span>" +
          "</div>"
      )
      .join("");
  }
  // ---------------------------------------------------------------------------
  // Palcos — a demonstração animada. Cada um declara `html` e um `tocar(el,
  // ctx)` que devolve a função de PARADA. O `ctx.laco(quadros, periodo)` é o
  // runner (ver `laco` abaixo): o palco só descreve a timeline, o runner cuida
  // de limpar o ciclo anterior. `ctx.reduzido` respeita prefers-reduced-motion
  // — nesse caso o palco pinta o estado FINAL e não devolve parada nenhuma,
  // porque não há o que parar.
  // ---------------------------------------------------------------------------
  const PALCOS = {
    // Visão geral: as cores das categorias entram em cascata. Não é enfeite —
    // é a única cena em que a legenda de cor aparece demonstrada, e é por ela
    // que o usuário vai varrer a lista depois.
    lista: {
      html:
        '<div class="tour-palco"><div class="tp-list">' + listaFalsaHtml(5) + "</div></div>",
      tocar(el, ctx) {
        const rows = [...el.querySelectorAll(".tp-row")];
        if (ctx.reduzido) return;
        return ctx.laco(
          [{ ms: 0, fn: () => rows.forEach((r) => r.classList.remove("brilha")) }].concat(
            rows.map((r, i) => ({ ms: 260 + i * 190, fn: () => r.classList.add("brilha") }))
          ),
          4200
        );
      },
    },

    // Degraus: os três acendem em sequência e a contagem salta 12 → 78 → 200,
    // que é a proporção real de um processo de duzentas peças. Aqui o número
    // É o argumento — "doze de duzentas" é o que convence a usar "chave".
    degraus: {
      html:
        '<div class="tour-palco palco-deg">' +
        '<div class="tp-seg"><span class="tp-sg" data-n="12">chave</span>' +
        '<span class="tp-sg" data-n="78">principais</span>' +
        '<span class="tp-sg" data-n="200">todas</span></div>' +
        '<div class="tp-cont"><b>12</b> de 200 marcadas</div>' +
        '<div class="tp-barra"><i></i></div></div>',
      tocar(el, ctx) {
        const segs = [...el.querySelectorAll(".tp-sg")];
        const cont = el.querySelector(".tp-cont b");
        const barra = el.querySelector(".tp-barra i");
        const pintar = (i) => {
          segs.forEach((s, j) => s.classList.toggle("on", j === i));
          const n = +segs[i].dataset.n;
          cont.textContent = n;
          barra.style.width = Math.round((n / 200) * 100) + "%";
        };
        if (ctx.reduzido) return pintar(0);
        return ctx.laco(
          [0, 1, 2].map((i) => ({ ms: 400 + i * 1150, fn: () => pintar(i) })),
          4400
        );
      },
    },

    // Duas cenas alternadas, porque são DOIS caminhos para a mesma coisa e o
    // usuário precisa reconhecer os dois: a busca acima da lista e o "@"
    // dentro da própria pergunta.
    nome: {
      html:
        '<div class="tour-palco palco-nome">' +
        '<div class="tp-cena tp-cena-a on">' +
        '<div class="tp-busca"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>' +
        '<span class="tp-q"></span><i class="tp-car"></i></div>' +
        '<div class="tp-list">' + listaFalsaHtml(5) + "</div></div>" +
        '<div class="tp-cena tp-cena-b">' +
        '<div class="tp-pop"><div class="tp-pop-h">Adicionar peça ao contexto</div>' +
        '<div class="tp-pop-r on"><b>Laudo Pericial</b><span>id 184100647 · prova</span></div>' +
        '<div class="tp-pop-r"><b>Quesitos da perícia</b><span>id 184100644 · petição</span></div></div>' +
        '<div class="tp-campo"><span>a perícia confirmou o nexo? </span>' +
        '<span class="tp-slash">@</span><span class="tp-q2"></span><i class="tp-car"></i></div>' +
        "</div></div>",
      tocar(el, ctx) {
        const A = el.querySelector(".tp-cena-a");
        const B = el.querySelector(".tp-cena-b");
        const q = el.querySelector(".tp-q");
        const q2 = el.querySelector(".tp-q2");
        const rows = [...el.querySelectorAll(".tp-cena-a .tp-row")];
        const alvo = "peric";
        // "Laudo Pericial" é a única das cinco falsas que casa com "peric" — as
        // outras SOMEM (display:none), que é o que `filtrarDocs` faz de fato
        // com `row.hidden`; desbotar daria a ideia errada do filtro.
        const casa = (r) => /Pericial/.test(r.textContent);
        const filtrar = (on) =>
          rows.forEach((r) => r.classList.toggle("fora", on && !casa(r)));
        if (ctx.reduzido) {
          q.textContent = alvo;
          filtrar(true);
          return;
        }
        const quadros = [
          {
            ms: 0,
            fn: () => {
              A.classList.add("on");
              B.classList.remove("on");
              q.textContent = "";
              q2.textContent = "";
              filtrar(false);
              rows.forEach((r) => r.classList.remove("on"));
            },
          },
        ];
        // cena A: digita na busca; a partir da 3ª letra a lista filtra
        for (let i = 1; i <= alvo.length; i++) {
          quadros.push({
            ms: 420 + i * 200,
            fn: () => {
              q.textContent = alvo.slice(0, i);
              if (i >= 3) filtrar(true);
            },
          });
        }
        quadros.push({
          ms: 1860,
          fn: () => rows.forEach((r) => casa(r) && r.classList.add("on")),
        });
        // cena B: o mesmo alvo, agora pelo "@" dentro da pergunta
        quadros.push({
          ms: 3400,
          fn: () => {
            A.classList.remove("on");
            B.classList.add("on");
            q2.textContent = "";
          },
        });
        for (let i = 1; i <= alvo.length; i++) {
          quadros.push({ ms: 3700 + i * 200, fn: () => (q2.textContent = alvo.slice(0, i)) });
        }
        return ctx.laco(quadros, 6800);
      },
    },

    // Arrastar: a mão desce marcando linha a linha. A row de ORIGEM entra
    // junto — é o detalhe que o gesto real também acerta (`origemMarcada`) e
    // que o usuário precisa ver para confiar no gesto.
    arrastar: {
      html:
        '<div class="tour-palco"><div class="tp-list">' + listaFalsaHtml(5) +
        '</div><i class="tp-mao">' + I.mao + "</i></div>",
      tocar(el, ctx) {
        const rows = [...el.querySelectorAll(".tp-row")];
        const mao = el.querySelector(".tp-mao");
        const y = (i) => 10 + i * 30;
        if (ctx.reduzido) {
          rows.forEach((r) => r.classList.add("on"));
          mao.style.transform = "translate(74px," + y(4) + "px)";
          return;
        }
        const quadros = [
          {
            ms: 0,
            fn: () => {
              rows.forEach((r) => r.classList.remove("on"));
              mao.classList.remove("press");
              mao.style.transform = "translate(30px," + y(0) + "px)";
            },
          },
          {
            ms: 520,
            fn: () => {
              mao.classList.add("press");
              rows[0].classList.add("on");
            },
          },
        ];
        for (let i = 1; i < 5; i++) {
          quadros.push({
            ms: 780 + i * 300,
            fn: () => {
              mao.style.transform = "translate(" + (30 + i * 11) + "px," + y(i) + "px)";
              rows[i].classList.add("on");
            },
          });
        }
        quadros.push({ ms: 2280, fn: () => mao.classList.remove("press") });
        return ctx.laco(quadros, 4200);
      },
    },

    // Shift+clique: dois toques, a faixa entre eles acende de uma vez.
    shift: {
      html:
        '<div class="tour-palco"><div class="tp-list">' + listaFalsaHtml(5) +
        '</div><i class="tp-mao">' + I.mao + '</i><span class="tp-kbd">Shift</span></div>',
      tocar(el, ctx) {
        const rows = [...el.querySelectorAll(".tp-row")];
        const mao = el.querySelector(".tp-mao");
        const kbd = el.querySelector(".tp-kbd");
        const y = (i) => 10 + i * 30;
        if (ctx.reduzido) {
          rows.forEach((r) => r.classList.add("on"));
          kbd.classList.add("on");
          mao.style.transform = "translate(60px," + y(4) + "px)";
          return;
        }
        return ctx.laco(
          [
            {
              ms: 0,
              fn: () => {
                rows.forEach((r) => r.classList.remove("on"));
                kbd.classList.remove("on");
                mao.classList.remove("press");
                mao.style.transform = "translate(40px," + y(0) + "px)";
              },
            },
            {
              ms: 520,
              fn: () => {
                mao.classList.add("press");
                rows[0].classList.add("on");
              },
            },
            { ms: 760, fn: () => mao.classList.remove("press") },
            {
              ms: 1150,
              fn: () => {
                mao.style.transform = "translate(60px," + y(4) + "px)";
                kbd.classList.add("on");
              },
            },
            {
              ms: 1850,
              fn: () => {
                mao.classList.add("press");
                // a faixa INTEIRA de uma vez — é esse o ponto do gesto
                for (let i = 1; i <= 4; i++) rows[i].classList.add("on");
              },
            },
            { ms: 2100, fn: () => mao.classList.remove("press") },
          ],
          4200
        );
      },
    },

    // Botão direito: o menu real tem estas duas linhas; o palco as reproduz
    // para o usuário reconhecer o menu quando ele aparecer de verdade.
    direito: {
      html:
        '<div class="tour-palco"><div class="tp-list">' + listaFalsaHtml(5) +
        '</div><i class="tp-mao">' + I.mao + "</i>" +
        '<div class="tp-menu"><span class="tp-mi on">Marcar daqui para baixo</span>' +
        '<span class="tp-mi">Marcar daqui para cima</span></div></div>',
      tocar(el, ctx) {
        const rows = [...el.querySelectorAll(".tp-row")];
        const mao = el.querySelector(".tp-mao");
        const menu = el.querySelector(".tp-menu");
        const y = (i) => 10 + i * 30;
        if (ctx.reduzido) {
          for (let i = 2; i < 5; i++) rows[i].classList.add("on");
          menu.classList.add("on");
          mao.style.transform = "translate(52px," + y(2) + "px)";
          return;
        }
        return ctx.laco(
          [
            {
              ms: 0,
              fn: () => {
                rows.forEach((r) => r.classList.remove("on"));
                menu.classList.remove("on");
                mao.classList.remove("press2");
                mao.style.transform = "translate(52px," + y(2) + "px)";
              },
            },
            {
              ms: 620,
              fn: () => {
                mao.classList.add("press2"); // realce no lado DIREITO do ponteiro
                menu.classList.add("on");
              },
            },
            { ms: 900, fn: () => mao.classList.remove("press2") },
            {
              ms: 2100,
              fn: () => {
                for (let i = 2; i < 5; i++) rows[i].classList.add("on");
                menu.classList.remove("on");
              },
            },
          ],
          4400
        );
      },
    },

    // Escolha por IA: as peças acendem ENQUANTO o modelo ainda escreve (é o
    // que `idsParciais`/`marcarParcial` fazem de verdade) e a escolha
    // SUBSTITUI a seleção — a peça marcada antes SAI. Mostrar isso aqui evita
    // a surpresa depois, que é o contrato oposto ao dos três degraus.
    ia: {
      html:
        '<div class="tour-palco palco-ia">' +
        '<div class="tp-pensa"><i></i><i></i><i></i><span>escolhendo as peças…</span></div>' +
        '<div class="tp-list">' + listaFalsaHtml(5) + "</div></div>",
      tocar(el, ctx) {
        const rows = [...el.querySelectorAll(".tp-row")];
        const pensa = el.querySelector(".tp-pensa");
        // o que ela escolheria para "houve prescrição?": inicial, contestação
        // e sentença — procuração e laudo ficam de fora
        const escolhidas = [0, 2, 4];
        if (ctx.reduzido) {
          escolhidas.forEach((i) => rows[i].classList.add("on"));
          pensa.classList.add("fim");
          return;
        }
        return ctx.laco(
          [
            {
              ms: 0,
              fn: () => {
                rows.forEach((r) => r.classList.remove("on"));
                rows[1].classList.add("on"); // marcada à mão antes — vai SAIR
                pensa.classList.remove("fim");
              },
            },
            { ms: 900, fn: () => rows[1].classList.remove("on") },
          ]
            .concat(
              escolhidas.map((r, k) => ({
                ms: 1000 + k * 520,
                fn: () => rows[r].classList.add("on"),
              }))
            )
            .concat([{ ms: 2700, fn: () => pensa.classList.add("fim") }]),
          4800
        );
      },
    },

    // Popup "/" com prompts fictícios: mostrar o RESULTADO é mais didático que
    // abrir a biblioteca real, que na primeira vez está vazia — e não mexe no
    // estado de ninguém.
    prompts: {
      html:
        '<div class="tour-palco palco-slash">' +
        '<div class="tp-pop"><div class="tp-pop-h">Inserir prompt salvo</div>' +
        '<div class="tp-pop-r on"><b>Relatório para audiência</b><span>Resuma o processo em tópicos, com…</span></div>' +
        '<div class="tp-pop-r"><b>Checar prescrição</b><span>Verifique marcos interruptivos e…</span></div>' +
        '<div class="tp-pop-r"><b>Resumo para despacho</b><span>Aponte o que falta para decidir…</span></div>' +
        "</div>" +
        '<div class="tp-campo"><span class="tp-slash">/</span><span class="tp-q"></span><i class="tp-car"></i></div></div>',
      tocar(el, ctx) {
        const q = el.querySelector(".tp-q");
        const pop = el.querySelector(".tp-pop");
        const rows = [...el.querySelectorAll(".tp-pop-r")];
        const texto = "audi";
        if (ctx.reduzido) {
          q.textContent = texto;
          pop.classList.add("filtrado");
          return;
        }
        const quadros = [
          {
            ms: 0,
            fn: () => {
              q.textContent = "";
              pop.classList.remove("filtrado");
              rows.forEach((r, i) => r.classList.toggle("on", i === 0));
            },
          },
        ];
        for (let i = 1; i <= texto.length; i++) {
          quadros.push({
            ms: 700 + i * 190,
            fn: () => {
              q.textContent = texto.slice(0, i);
              if (i === texto.length) pop.classList.add("filtrado");
            },
          });
        }
        return ctx.laco(quadros, 4200);
      },
    },

    // Citação: uma frase de resposta com o sobrescrito e a linha de fonte — o
    // mesmo desenho do rodapé da bolha (`.cites`), para reconhecer depois.
    citacao: {
      html:
        '<div class="tour-palco palco-cit">' +
        '<div class="tp-bolha">…o laudo conclui pela incapacidade parcial e permanente' +
        '<sup class="tp-sup">1</sup>, o que a contestação não impugna<sup class="tp-sup">2</sup>.</div>' +
        '<div class="tp-cites"><span class="tp-cite"><b>1</b> Laudo Pericial · id 184100647 · fl. 12</span>' +
        '<span class="tp-cite"><b>2</b> Contestação · id 184100639 · fl. 4</span></div></div>',
      tocar(el, ctx) {
        const cites = [...el.querySelectorAll(".tp-cite")];
        const sups = [...el.querySelectorAll(".tp-sup")];
        if (ctx.reduzido) {
          cites.forEach((c) => c.classList.add("on"));
          sups.forEach((s) => s.classList.add("on"));
          return;
        }
        return ctx.laco(
          [
            {
              ms: 0,
              fn: () => {
                cites.forEach((c) => c.classList.remove("on"));
                sups.forEach((s) => s.classList.remove("on"));
              },
            },
          ].concat(
            [0, 1].map((i) => ({
              ms: 700 + i * 900,
              fn: () => {
                if (sups[i]) sups[i].classList.add("on");
                if (cites[i]) cites[i].classList.add("on");
              },
            }))
          ),
          4000
        );
      },
    },
  };

  // ---------------------------------------------------------------------------
  // Instância. `ctrl` é o controle remoto do painel — só o necessário para
  // pilotar a visita, nunca o painel inteiro.
  //   ctrl: { root, wrap, abrir(), modo(m), modoAtual(), mostrarPecas(),
  //           configurado(), configurar() }
  // ---------------------------------------------------------------------------
  function criar(ctrl) {
    let camada = null;
    let passos = [];
    let atual = 0;
    let timers = [];
    let intervalos = [];
    let pararPalco = null;
    let modoAnterior = null;
    let aoSair = null;
    const reduzido =
      typeof matchMedia === "function" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches;

    function reg(id, ehIntervalo) {
      (ehIntervalo ? intervalos : timers).push(id);
    }
    function limparTimers() {
      timers.forEach(clearTimeout);
      intervalos.forEach(clearInterval);
      timers = [];
      intervalos = [];
      if (pararPalco) {
        pararPalco();
        pararPalco = null;
      }
    }

    // Runner de animação dos palcos. O palco declara a timeline como uma lista
    // de {ms, fn} e o período do laço; ESTE runner limpa os timers do ciclo
    // anterior antes de agendar o seguinte, e devolve a função de parada.
    //
    // Existe por causa de um vazamento real: quando cada palco fazia o próprio
    // `setInterval(ciclo)` e o `ciclo` registrava seus `setTimeout` na lista
    // geral, essa lista só era esvaziada na TROCA DE PASSO — um passo deixado
    // aberto empilhava dezenas de entradas mortas por minuto. Passar o
    // agendamento para um só lugar resolve, e ainda encurta cada palco.
    function laco(quadros, periodo) {
      let ts = [];
      const limpar = () => {
        ts.forEach(clearTimeout);
        ts = [];
      };
      const rodar = () => {
        limpar();
        for (const q of quadros) ts.push(setTimeout(q.fn, q.ms));
      };
      rodar();
      const iv = setInterval(rodar, periodo);
      return () => {
        limpar();
        clearInterval(iv);
      };
    }

    // Retângulo do alvo. Aceita lista (união dos rects — o passo "Minutar e
    // mapa" aponta dois botões vizinhos) e devolve null para alvo ausente,
    // oculto ou de área zero: painel estreito, elemento `hidden` e lista ainda
    // não renderizada são estados NORMAIS no primeiro uso, e um recorte sobre
    // um retângulo vazio é pior que nenhum recorte.
    function rectDe(alvo) {
      const els = (Array.isArray(alvo) ? alvo : [alvo]).filter(Boolean);
      let r = null;
      for (const el of els) {
        const b = el.getBoundingClientRect();
        if (!b.width || !b.height) continue;
        r = r
          ? {
              top: Math.min(r.top, b.top),
              left: Math.min(r.left, b.left),
              right: Math.max(r.right, b.right),
              bottom: Math.max(r.bottom, b.bottom),
            }
          : { top: b.top, left: b.left, right: b.right, bottom: b.bottom };
      }
      if (!r) return null;
      // fora da viewport (lista rolada) — sem recorte, o balão vai ao centro
      if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth)
        return null;
      return r;
    }

    function pintar() {
      const p = passos[atual];
      limparTimers();
      if (p.antes) {
        try {
          p.antes();
        } catch {
          /* pilotagem é best-effort: um passo nunca derruba o tour */
        }
      }

      const rect = p.capa ? null : rectDe(p.alvo());
      const buraco = camada.querySelector(".tour-hole");
      const card = camada.querySelector(".tour-card");

      // --- recorte ---
      // Sem alvo o buraco COLAPSA no centro em vez de sumir: o escurecimento é
      // o box-shadow dele, e `hidden` levaria o fundo embora junto, deixando a
      // capa flutuando sobre a página do tribunal sem nenhuma separação.
      if (rect) {
        const pad = 6;
        buraco.classList.remove("sem-alvo");
        camada.classList.remove("sem-alvo");
        buraco.style.top = rect.top - pad + "px";
        buraco.style.left = rect.left - pad + "px";
        buraco.style.width = rect.right - rect.left + pad * 2 + "px";
        buraco.style.height = rect.bottom - rect.top + pad * 2 + "px";
      } else {
        // A classe vai nos DOIS: o buraco se apaga e quem escurece passa a ser
        // o fundo da camada. Ver a nota no panel.css — uma caixa de 0×0 não
        // pinta box-shadow no Chrome, então colapsar o buraco não bastava.
        buraco.classList.add("sem-alvo");
        camada.classList.add("sem-alvo");
        buraco.style.top = innerHeight / 2 + "px";
        buraco.style.left = innerWidth / 2 + "px";
        buraco.style.width = "0px";
        buraco.style.height = "0px";
      }

      // --- conteúdo ---
      const palco = p.palco && PALCOS[p.palco];
      card.className = "tour-card" + (p.capa ? " capa" : "");
      card.innerHTML =
        '<button type="button" class="tour-x" aria-label="Sair da visita guiada">' +
        I.x +
        "</button>" +
        (p.capa ? '<span class="tour-faisca">' + I.faisca + "</span>" : "") +
        // eyebrow de capítulo (DESIGN.md §3): diz em que parte da visita se
        // está. Sem ele, treze passos lêem como uma fila sem fim
        (p.cap ? '<span class="tour-cap">' + p.cap + "</span>" : "") +
        '<h2 class="tour-h">' +
        p.titulo +
        "</h2>" +
        '<div class="tour-b">' +
        p.corpo +
        "</div>" +
        (palco ? palco.html : "") +
        '<div class="tour-nav">' +
        '<span class="tour-prog"><span class="tour-bar"><i style="width:' +
        Math.round(((atual + 1) / passos.length) * 100) +
        '%"></i></span><span class="tour-n">' +
        (atual + 1) +
        " de " +
        passos.length +
        "</span></span>" +
        '<span class="tour-btns">' +
        (atual > 0
          ? '<button type="button" class="tour-prev">' + I.volta + " Voltar</button>"
          : '<button type="button" class="tour-skip">Agora não</button>') +
        '<button type="button" class="tour-next">' +
        (atual === passos.length - 1 ? "Começar a usar" : "Continuar") +
        I.seta +
        "</button></span></div>";

      // --- posição do balão ---
      posicionar(card, rect);

      // --- animação do palco ---
      // `tocar` devolve a função de PARADA (ou nada, com movimento reduzido);
      // guardá-la é o que faz `limparTimers` desligar o laço na troca de passo.
      if (palco) {
        const el = card.querySelector(".tour-palco");
        if (el) pararPalco = palco.tocar(el, { laco, reduzido }) || null;
      }

      card.querySelector(".tour-x").addEventListener("click", () => sair(false));
      const skip = card.querySelector(".tour-skip");
      if (skip) skip.addEventListener("click", () => sair(false));
      const prev = card.querySelector(".tour-prev");
      if (prev) prev.addEventListener("click", () => ir(-1));
      card.querySelector(".tour-next").addEventListener("click", () => ir(1));
      // foco no botão principal: quem navega por teclado continua no fluxo, e
      // o Enter avança sem precisar do mouse
      card.querySelector(".tour-next").focus({ preventScroll: true });
    }

    // Balão perto do alvo, sem cobri-lo. Sem alvo (ou sem espaço), vai ao
    // centro.
    //
    // A ORDEM dos lados não é arbitrária, e "abaixo primeiro" (o default óbvio)
    // estava errado aqui: os alvos da metade esquerda são todos da COLUNA DE
    // PEÇAS — os degraus, a busca, a lista, o "Escolher com IA" —, e um balão
    // abaixo deles cobre justamente a lista que o passo está explicando. Para
    // esses o lado certo é a DIREITA, onde sobra o chat inteiro. Os alvos da
    // direita (toolbar, medidor) vivem no rodapé, onde não há espaço abaixo, e
    // caem naturalmente em "acima".
    function posicionar(card, rect) {
      card.style.top = card.style.left = "";
      card.classList.remove("centro");
      if (!rect) {
        card.classList.add("centro");
        return;
      }
      const gap = 14;
      const w = card.offsetWidth || 360;
      const h = card.offsetHeight || 260;
      const cabeDir = rect.right + gap + w <= innerWidth - 8;
      const cabeEsq = rect.left - gap - w >= 8;
      const cabeBaixo = rect.bottom + gap + h <= innerHeight - 8;
      const cabeCima = rect.top - gap - h >= 8;
      const naEsquerda = rect.right < innerWidth / 2;
      const meioX = rect.left + (rect.right - rect.left) / 2 - w / 2;
      const meioY = rect.top + (rect.bottom - rect.top) / 2 - h / 2;
      let top, left;
      if (naEsquerda && cabeDir) {
        left = rect.right + gap;
        top = meioY;
      } else if (cabeBaixo) {
        top = rect.bottom + gap;
        left = meioX;
      } else if (cabeCima) {
        top = rect.top - gap - h;
        left = meioX;
      } else if (cabeDir) {
        left = rect.right + gap;
        top = meioY;
      } else if (cabeEsq) {
        left = rect.left - gap - w;
        top = meioY;
      } else {
        card.classList.add("centro");
        return;
      }
      // clamp à viewport — o balão sempre inteiro na tela
      top = Math.max(8, Math.min(top, innerHeight - h - 8));
      left = Math.max(8, Math.min(left, innerWidth - w - 8));
      card.style.top = top + "px";
      card.style.left = left + "px";
    }

    function ir(d) {
      const alvo = atual + d;
      if (alvo < 0) return;
      if (alvo >= passos.length) return sair(true);
      atual = alvo;
      pintar();
    }

    function sair(completou) {
      limparTimers();
      if (camada) {
        camada.remove();
        camada = null;
      }
      removeEventListener("keydown", onTecla, true);
      removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisivel);
      // Marca visto em QUALQUER saída, inclusive "Agora não": quem recusou uma
      // vez não quer ser abordado de novo a cada processo aberto. O convite
      // permanente no estado vazio é o caminho de volta.
      marcarVisto();
      if (aoSair) aoSair(completou);
    }

    // Esc precisa ser capturado ANTES do painel: a cascata de Esc dele
    // (/ → @ → modal → modo minuta) fecharia outra coisa junto.
    function onTecla(e) {
      if (!camada) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        sair(false);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        e.stopPropagation();
        ir(1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        e.stopPropagation();
        ir(-1);
      }
    }
    // O recorte é geometria de viewport: qualquer mudança de tamanho o
    // invalida. Repintar é barato e mantém o spotlight colado no alvo.
    let tResize = null;
    function onResize() {
      clearTimeout(tResize);
      tResize = setTimeout(() => camada && pintar(), 120);
    }

    function iniciar(opts) {
      if (camada) return;
      aoSair = (opts && opts.aoSair) || null;
      passos = roteiro(ctrl);
      atual = 0;

      // Pilotagem: abre o painel e leva ao modo expandido, que é onde a lista
      // de peças é uma coluna visível ao lado do chat — os passos de seleção
      // não fazem sentido com a lista recolhida numa gaveta.
      modoAnterior = ctrl.modoAtual ? ctrl.modoAtual() : null;
      try {
        ctrl.abrir();
        if (ctrl.mostrarPecas) ctrl.mostrarPecas();
        if (ctrl.modo && modoAnterior !== "cheia" && modoAnterior !== "livre")
          ctrl.modo("expandido");
      } catch {
        /* segue mesmo sem pilotar: o tour se explica sozinho */
      }

      camada = document.createElement("div");
      camada.className = "tour";
      camada.setAttribute("role", "dialog");
      camada.setAttribute("aria-modal", "true");
      camada.setAttribute("aria-label", "Visita guiada da extensão");
      camada.innerHTML =
        '<div class="tour-hole sem-alvo"></div><div class="tour-card"></div>';
      ctrl.wrap.appendChild(camada);

      addEventListener("keydown", onTecla, true);
      addEventListener("resize", onResize);
      document.addEventListener("visibilitychange", onVisivel);

      // NUNCA usar requestAnimationFrame para a PRIMEIRA pintura. O Chrome
      // congela o rAF em aba de segundo plano (o mesmo que já derrubou o
      // primeiro desenho do mapa mental, ver mapa.js), e abrir processos com
      // Ctrl+clique em várias abas é o padrão de trabalho no PJe: a visita
      // guiada auto-abre ~1s depois do boot e o usuário encontraria a tela
      // escurecida com um cartão VAZIO, sem nada que explicasse. Pinta-se
      // síncrono; o reposicionamento depois da transição de layout fica por
      // conta do setTimeout, que é apenas afunilado em segundo plano, não
      // suspenso.
      pintar();
      // DOIS repintes, e não um: o `.panel` tem `transition: all` e a troca
      // para o modo expandido move o painel inteiro. Medir o alvo no meio
      // dessa transição dá um rect que já mudou quando o recorte aparece — o
      // spotlight fica ao lado do botão em vez de sobre ele. Confirmado no
      // teste no Chrome, onde o `.panel` foi flagrado com o transform pela
      // metade (`translate(0,10px)` a caminho de `translate(-50%,-50%)`).
      reg(setTimeout(() => camada && pintar(), 320));
      reg(setTimeout(() => camada && pintar(), 700));
    }

    // Medidas tiradas com a aba oculta podem estar erradas (layout suspenso):
    // ao voltar, repinta e o recorte reencontra o alvo. Mesma razão do
    // `visibilitychange` do mapa.js.
    function onVisivel() {
      if (camada && document.visibilityState === "visible") pintar();
    }

    return { iniciar, sair, ativo: () => !!camada };
  }

  // ---------------------------------------------------------------------------
  // Persistência do "já viu". Best-effort em todo caminho: sem storage (harness
  // de teste, contexto de extensão invalidado) o tour simplesmente não é
  // oferecido — nunca quebra o boot do painel.
  // ---------------------------------------------------------------------------
  function precisa(cb) {
    try {
      chrome.storage.local.get([CHAVE], (v) => {
        cb(!v || !v[CHAVE] || v[CHAVE] < VERSAO);
      });
    } catch {
      cb(false);
    }
  }
  function marcarVisto() {
    try {
      chrome.storage.local.set({ [CHAVE]: VERSAO });
    } catch {
      /* segue sem persistir */
    }
  }

  return { criar, precisa, marcarVisto, VERSAO };
})();

if (typeof module !== "undefined" && module.exports) module.exports = PjeTour;
