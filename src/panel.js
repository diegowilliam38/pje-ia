// UI do painel lateral (chat + seletor de documentos), isolada em Shadow DOM.
var PjePanel = (function () {
  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
    );
  }

  // ---------------------------------------------------------------------------
  // Renderizador markdown seguro (escapa primeiro, depois formata).
  // Suporta: títulos, negrito/itálico, código inline, blocos ```, listas,
  // listas numeradas, tabelas, citações (>), linhas --- e links http(s).
  // ---------------------------------------------------------------------------
  function inlineMd(s) {
    let h = s;
    h = h.replace(/`([^`]+)`/g, "<code>$1</code>");
    h = h.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    h = h.replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");
    h = h.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (m, t, u) => {
      return '<a href="' + u + '" target="_blank" rel="noopener">' + t + "</a>";
    });
    return h;
  }

  function isTableSep(line) {
    return /^\s*\|?\s*:?-{2,}[\s:|-]*$/.test(line) && line.includes("-");
  }
  function splitRow(line) {
    let l = line.trim();
    if (l.startsWith("|")) l = l.slice(1);
    if (l.endsWith("|")) l = l.slice(0, -1);
    return l.split("|").map((c) => c.trim());
  }

  function renderMd(text, cites) {
    const src = escapeHtml(text);
    const lines = src.split(/\r?\n/);
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // bloco de código cercado
      if (/^```/.test(line)) {
        const buf = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
        i++; // pula o fecho
        out.push("<pre><code>" + buf.join("\n") + "</code></pre>");
        continue;
      }

      // tabela (linha com | seguida do separador |---|)
      if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        const head = splitRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
          rows.push(splitRow(lines[i++]));
        }
        let t = "<table><thead><tr>";
        for (const c of head) t += "<th>" + inlineMd(c) + "</th>";
        t += "</tr></thead><tbody>";
        for (const r of rows) {
          t += "<tr>";
          for (let k = 0; k < head.length; k++) t += "<td>" + inlineMd(r[k] || "") + "</td>";
          t += "</tr>";
        }
        t += "</tbody></table>";
        out.push(t);
        continue;
      }

      // título
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        const lvl = Math.min(h[1].length + 2, 6); // #→h3… (mantém hierarquia visual do chat)
        out.push("<h" + lvl + ">" + inlineMd(h[2]) + "</h" + lvl + ">");
        i++;
        continue;
      }

      // linha horizontal
      if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
        out.push("<hr>");
        i++;
        continue;
      }

      // citação
      if (/^\s*&gt;\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) {
          buf.push(lines[i].replace(/^\s*&gt;\s?/, ""));
          i++;
        }
        out.push("<blockquote>" + buf.map(inlineMd).join("<br>") + "</blockquote>");
        continue;
      }

      // lista com marcadores
      if (/^\s*[-*]\s+/.test(line)) {
        let ul = "<ul>";
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
          ul += "<li>" + inlineMd(lines[i].replace(/^\s*[-*]\s+/, "")) + "</li>";
          i++;
        }
        out.push(ul + "</ul>");
        continue;
      }

      // lista numerada
      if (/^\s*\d+[.)]\s+/.test(line)) {
        let ol = "<ol>";
        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
          ol += "<li>" + inlineMd(lines[i].replace(/^\s*\d+[.)]\s+/, "")) + "</li>";
          i++;
        }
        out.push(ol + "</ol>");
        continue;
      }

      // linha em branco
      if (line.trim() === "") {
        i++;
        continue;
      }

      // parágrafo (junta linhas consecutivas com <br>)
      const buf = [line];
      i++;
      while (
        i < lines.length &&
        lines[i].trim() !== "" &&
        !/^(#{1,6}\s|```|\s*[-*]\s|\s*\d+[.)]\s|\s*&gt;)/.test(lines[i]) &&
        !(lines[i].includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1]))
      ) {
        buf.push(lines[i]);
        i++;
      }
      out.push("<p>" + buf.map(inlineMd).join("<br>") + "</p>");
    }

    let html = out.join("");
    // Marcadores de citação: o content script injeta placeholders na área de
    // uso privado do Unicode (U+E000 n U+E001) — eles atravessam o escapeHtml
    // intactos e só aqui, DEPOIS do escape, viram sobrescritos [n].
    html = html.replace(new RegExp("\\uE000(\\d+)\\uE001", "g"), (m, n) => {
      const c = cites && cites[Number(n) - 1];
      return (
        '<sup class="cit"' +
        (c ? ' title="' + escapeHtml(c.label) + '"' : "") +
        ">" + n + "</sup>"
      );
    });
    return html;
  }

  // Ícones SVG (evita depender de glifos unicode que podem faltar na fonte).
  // Cada ação do cabeçalho tem um desenho DISTINTO: baixar (seta na bandeja),
  // nova conversa (balão com +), expandir (seta horizontal dupla), lateral
  // (retângulo com coluna à direita), janela livre (janela com barra de
  // título), tela cheia (setas diagonais para os cantos) e fechar (X).
  // ---------------------------------------------------------------------------
  // Ícones. Traçado em grade de 24, fill:none, currentColor — nada de emoji, que
  // renderiza diferente em cada sistema, não aceita currentColor e não alinha na
  // grade óptica dos demais. A ESPESSURA varia por contexto (DESIGN.md §5): um
  // valor único faz o ícone de 13px pesar mais que o de 18px.
  // ---------------------------------------------------------------------------
  const P = {
    download: '<path d="M12 4v11"/><path d="M7 11l5 5 5-5"/><path d="M5 20h14"/>',
    chat: '<path d="M20 15a3 3 0 0 1-3 3H9l-4 3v-4H7a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3z"/>',
    close: '<path d="M6 6l12 12"/><path d="M18 6L6 18"/>',
    x: '<path d="M6 6l12 12"/><path d="M18 6L6 18"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 5H6a2 2 0 0 0-2 2v9"/>',
    fold: '<path d="M13 7l-5 5 5 5"/><path d="M19 7l-5 5 5 5"/>',
    // modos de layout — o retângulo é o painel; a divisória diz onde ele encosta
    side: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M14 5v14"/>',
    sideL: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 5v14"/>',
    split: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18"/>',
    expand: '<path d="M8 8L4 12l4 4"/><path d="M16 8l4 4-4 4"/><path d="M4 12h16"/>',
    fs: '<path d="M14 4h6v6"/><path d="M10 20H4v-6"/><path d="M20 4l-7 7"/><path d="M4 20l7-7"/>',
    fsOff: '<path d="M9 4H4v5"/><path d="M15 20h5v-5"/><path d="M4 4l6 6"/><path d="M20 20l-6-6"/>',
    // a lista recolhe/expande: o chevron DENTRO do retângulo dá o sentido da
    // ação (← recolhe, → traz de volta). Sem ele o ícone ficava idêntico ao do
    // modo lateral e ninguém achava o botão.
    docshide: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M9 5v14"/><path d="M16 8.5L12.5 12l3.5 3.5"/>',
    docsshow: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M9 5v14"/><path d="M12.5 8.5L16 12l-3.5 3.5"/>',
    lupa: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/>',
    reload: '<path d="M20 12a8 8 0 1 1-2.5-5.8"/><path d="M20 4v4h-4"/>',
    check: '<path d="M20 6L9 17l-5-5"/>',
    chevron: '<path d="M7 10l5 5 5-5"/>',
    enviar: '<path d="M5 12h13"/><path d="M12 6l6 6-6 6"/>',
    mais: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
    lista: '<path d="M4 5h13"/><path d="M4 12h10"/><path d="M4 19h7"/>',
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
    doc: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
    ver: '<circle cx="12" cy="12" r="4.2"/><path d="M12 3.6v2.8"/><path d="M12 17.6v2.8"/><path d="M3.6 12h2.8"/><path d="M17.6 12h2.8"/>',
    // toolbar
    minuta: '<path d="M5 20h14"/><path d="M15 4l5 5-9 9H6v-5z"/>',
    mapa: '<circle cx="12" cy="12" r="3"/><path d="M12 9V5"/><path d="M14.5 13.5l3 2.5"/><path d="M9.5 13.5l-3 2.5"/>',
    prompts: '<path d="M12 4l1.8 4.2L18 10l-4.2 1.8L12 16l-1.8-4.2L6 10l4.2-1.8z"/><path d="M18 16l.9 2.1L21 19l-2.1.9L18 22l-.9-2.1L15 19l2.1-.9z"/>',
    modelos: '<path d="M4 6h7v14H4z"/><path d="M13 6h7v14h-7z"/>',
  };
  // px = lado do ícone; w = stroke-width (a escala do DESIGN.md §5).
  function ic(paths, px, w) {
    return (
      '<svg width="' + px + '" height="' + px + '" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="' + w + '" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' + paths + "</svg>"
    );
  }

  // Botões da toolbar são <svg> + <span class="lbl">: trocar o texto do botão
  // inteiro destruiria o ícone. Estes dois helpers mexem em um sem tocar no
  // outro; se o .lbl não existir (botão sem ícone), caem no próprio elemento.
  function rotulo(btn, txt) {
    if (!btn) return;
    const el = btn.querySelector(".lbl") || btn;
    el.textContent = txt;
  }
  function icone(btn, svg) {
    const el = btn && btn.querySelector("svg");
    if (el) el.outerHTML = svg;
  }

  const SVG = {
    free: ic(P.split, 15, 1.8),
    fs: ic(P.fs, 15, 1.8),
    fsOff: ic(P.fsOff, 15, 1.8),
    expand: ic(P.expand, 15, 1.8),
    side: ic(P.side, 15, 1.8),
    sideL: ic(P.sideL, 15, 1.8),
    docshide: ic(P.docshide, 15, 1.8),
    docsshow: ic(P.docsshow, 15, 1.8),
    fold: ic(P.fold, 13, 2),
    ver: ic(P.ver, 12, 1.8),
    close: ic(P.close, 15, 1.9),
    reset: ic(P.chat, 15, 1.8),
    download: ic(P.download, 15, 1.8),
    copy: ic(P.copy, 13, 1.8),
    doc: ic(P.doc, 11, 1.8),
    x: ic(P.x, 9, 3),
    check: ic(P.check, 10, 2),
    lupa: ic(P.lupa, 12, 2),
    // --- toolbar: a cor vem do CSS (currentColor), a espessura é 1.9 ---
    cancel: ic(P.close, 13, 1.9), // ✕ no tamanho da toolbar, não o de chip
    ia: ic(P.prompts, 13, 2),
    novo: ic('<path d="M12 5v14"/><path d="M5 12h14"/>', 13, 2),
    juris: ic(P.lupa, 13, 1.9),
    minuta: ic(P.minuta, 13, 1.9),
    mapa: ic(P.mapa, 13, 1.9),
    prompts: ic(P.prompts, 13, 1.9),
    modelos: ic(P.modelos, 13, 1.9),
    // --- demais ---
    info: ic(P.info, 15, 1.8),
    enviar: ic(P.enviar, 14, 2),
    chevron: ic(P.chevron, 11, 2.2),
    mais: ic(P.mais, 15, 1.8),
    lista: ic(P.lista, 15, 1.9),
    reload: ic(P.reload, 13, 2),
    zip: ic(P.download, 13, 2),
    play: '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5l10 7-10 7z"/></svg>',
  };

  // Título curto da peça (sem o prefixo numérico do id) para chips e menções.
  function tituloCurto(t) {
    return String(t).replace(/^\d{6,}\s*-\s*/, "");
  }
  // Separa "141516171 - Petição Inicial" em {id, nome} para exibição.
  function partesTitulo(t) {
    const m = String(t).match(/^(\d{6,})\s*-\s*(.+)$/);
    return m ? { id: m[1], nome: m[2] } : { id: "", nome: String(t) };
  }

  // ---------------------------------------------------------------------------
  // Categorias de peças (regex sobre o título sem acentos) para destaque visual.
  // A primeira que casar vence — mantenha as mais específicas primeiro.
  // ---------------------------------------------------------------------------
  const CATEGORIAS = [
    // atos do juízo — o lookbehind tira "cumprimento de sentença" daqui (é
    // fase/petição das partes, não ato decisório); "acordao" ≠ "acordo"
    // (o \b não casa dentro de "acordao", então "acordo" pode ir às petições)
    { cls: "cat-decisao", re: /\b((?<!cumprimento de )sentenca|decisao|despacho|acordao|liminar|tutela|julgamento|impronuncia|pronuncia|homologacao|medida protetiva|transito em julgado)\b/ },
    // atas, audiências e atos orais ("ata notarial" é prova — regra de provas)
    { cls: "cat-audiencia", re: /\b(ata(?!\s+notarial)|audiencia|assentada|depoimento|interrogatorio|oitiva|degravacao)\b/ },
    // peças das partes e do Ministério Público
    // "resposta a acusacao" é a defesa escrita do processo penal (art. 396-A do
    // CPP) e não casava nenhuma regra — ficava cinza como se fosse expediente.
    { cls: "cat-peticao", re: /\b(peticao|inicial|emenda|contestacao|reconvencao|replica|treplica|recurso|apelacao|embargos|agravo|impugnacao|excecao|alegacoes|manifestacao|defesa|resposta a acusacao|denuncia|queixa|memoriais|razoes|contrarrazoes|cumprimento de sentenca|habeas|cota|promocao|quesitos|rol de testemunhas|acordo)\b/ },
    // provas técnicas e atos de investigação (criminal: IP, APF, exames…)
    { cls: "cat-prova", re: /\b(laudo|pericia|parecer|ata notarial|auto de|flagrante|inquerito|boletim de ocorrencia|exame|corpo de delito|midia|interceptacao|relatorio|estudo social|estudo psicossocial|antecedentes)\b/ },
  ];
  // ---------------------------------------------------------------------------
  // RELEVÂNCIA — segundo eixo, ortogonal à categoria.
  //
  // A categoria acima responde "que tipo de peça é esta?" e vira COR. Ela não
  // serve para responder "quais peças eu mando para a IA?", que é outra
  // pergunta: num processo de 200 peças, tudo que não é `cat-outro` são ~120,
  // porque a regra de petição casa `peticao|manifestacao|cota|promocao` — ou
  // seja, praticamente toda juntada das partes. "Principais" acabava
  // significando "quase todas".
  //
  // Quatro níveis:
  //   essencial — a espinha dorsal do processo: as ~10 peças que respondem a
  //               maioria das perguntas (inicial, contestação, laudo, sentença…)
  //   relevante — derivado: tem categoria destacada mas não é da espinha
  //   neutro    — sem categoria e sem sinal de expediente
  //   ruido     — expediente puro: certidão de intimação, AR, guia, procuração
  //
  // `relevante` e `neutro` NÃO têm tabela própria — saem da categoria que já
  // existe. Só os dois extremos precisam de regra.
  // ---------------------------------------------------------------------------

  // A espinha dorsal, cível e criminal. Herda as armadilhas já anotadas nas
  // CATEGORIAS: o lookbehind de "cumprimento de sentença" (que é fase das
  // partes, não ato de mérito) e a separação entre `acordao` e `acordo` (o \b
  // não existe entre "acordo" e o "a" seguinte).
  //
  // ARMADILHA PRÓPRIA desta construção: o grupo inteiro vai entre \b…\b, então
  // toda alternativa precisa terminar em PALAVRA COMPLETA. Escrever "saneador"
  // não pega "Decisão Saneadora" e "acordo homologad" não pega "homologado" —
  // o \b final exige um limite e encontra uma letra. Por isso as flexões vão
  // explícitas, em vez de \w* solto (que faria "inicial" casar "inicialmente").
  const RE_CHAVE = new RegExp(
    "\\b(" +
      [
        // inicial
        "peticao inicial", "inicial", "denuncia", "queixa-crime",
        "reclamacao trabalhista",
        // resposta
        "contestacao", "defesa (previa|preliminar|escrita)",
        "resposta a acusacao", "reconvencao",
        // réplica
        "replica", "impugnacao a contestacao",
        // saneamento
        "saneador(a|es|as)?", "saneamento",
        // prova técnica
        "laudo(s)?", "pericia(s)?", "parecer tecnico",
        // instrução
        "ata(s)? de audiencia", "audiencia de instrucao", "termo de audiencia",
        // razões finais
        "alegacoes finais", "memoriais",
        // mérito
        "(?<!cumprimento de )sentenca", "acordao", "liminar(es)?",
        "tutela (de urgencia|antecipada)", "acordo homologad(o|a)",
        // recurso
        "apelacao", "contrarrazoes",
        "recurso (especial|extraordinario|ordinario)",
      ].join("|") +
      ")\\b"
  );

  // Expediente. CONSERVADORA de propósito e sempre ANCORADA — termo solto aqui
  // custa caro, porque tira a peça de "principais" e ela some do recorte sem o
  // usuário perceber. Nunca use: `certidao` sozinho (certidão de trânsito em
  // julgado é ato relevante), `comprovante` sozinho (é prova em consumidor),
  // `carta` sozinho (precatória não é ruído), `juntada de documentos` (é onde
  // vive a prova), `mandado` (mandado de segurança).
  const RE_RUIDO = new RegExp(
    "\\b(" +
      [
        "certidao de (intimacao|publicacao|decurso|prazo|citacao)",
        "termo de juntada", "ato ordinatorio", "aviso de recebimento",
        "carta de (citacao|intimacao)", "guia de (recolhimento|custas)",
        "procuracao", "substabelecimento", "comprovante de residencia",
        "publicacao.*(dje|diario)",
      ].join("|") +
      ")\\b"
  );

  // Classifica nos DOIS eixos de uma vez. Aceita string (título) ou o objeto da
  // peça, e devolve {cat, rel}.
  //
  // Quando a peça vem da tela "Documentos" do PJe ela traz o TIPO OFICIAL
  // ("Despacho de Mero Expediente", "Certidão de Intimação"), que é muito
  // melhor que o título para isto — o título costuma ser o nome do arquivo
  // ("Despachos / 2"), enquanto o tipo é o vocabulário controlado do sistema.
  // Por isso o laço EXTERNO é por alvo (tipo primeiro, título depois): um tipo
  // oficial "Certidão de Intimação" precisa vencer um título que por acaso
  // contenha "sentença", que é o falso positivo mais comum do título.
  //
  // Dentro de cada alvo a ordem é ruído → chave → categorias, e a normalização
  // acontece UMA vez por alvo: o custo real aqui não são as regex, é o norm()
  // (toLowerCase + NFD + replace), e `setDocs` re-renderiza a lista inteira a
  // cada mutação da timeline do PJe.
  function classificarPeca(docOuTitulo) {
    const d = docOuTitulo && typeof docOuTitulo === "object" ? docOuTitulo : null;
    const alvos = (d ? [d.tipo, d.titulo] : [docOuTitulo]).filter(Boolean);
    for (const alvo of alvos) {
      const t = norm(alvo);
      // Expediente é sempre NEUTRO na cor, mesmo quando o título menciona a
      // peça a que se refere: "Certidão de Intimação da Sentença" pintada de
      // dourado atrai o olho exatamente para o que não importa, e é a mistura
      // do expediente com as peças de conteúdo que faz a lista cansar.
      if (RE_RUIDO.test(t)) return { cat: "cat-outro", rel: "ruido" };
      if (RE_CHAVE.test(t)) return { cat: catPorTexto(t), rel: "essencial" };
      const cat = catPorTexto(t);
      // sem sinal de nível NESTE alvo: se ele já dá categoria, o nível é
      // derivado dela; senão, tenta o próximo alvo (título, depois de tipo)
      if (cat !== "cat-outro") return { cat, rel: "relevante" };
    }
    return { cat: "cat-outro", rel: "neutro" };
  }
  function catPorTexto(t) {
    for (const c of CATEGORIAS) if (c.re.test(t)) return c.cls;
    return "cat-outro";
  }
  // Só a categoria — o que chips, preview e popup @ consomem.
  function categoriaDe(docOuTitulo) {
    return classificarPeca(docOuTitulo).cat;
  }
  // Normaliza para busca sem acentos/caixa (ex.: "peticao" acha "Petição").
  function norm(s) {
    return String(s)
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "");
  }

  // Índice de busca de uma peça: título MAIS o tipo oficial, quando a tela
  // "Documentos" do PJe já foi lida. O tipo é o vocabulário controlado do
  // sistema ("Despacho de Mero Expediente") e costuma descrever a peça melhor
  // que o título, que é o nome do arquivo ("Documentos diversos") — enquanto
  // só o título era indexado, buscar "despacho" não achava a peça certa,
  // embora ela já aparecesse com a cor de decisão na lista.
  // Usado pela busca da lista E pelo popup @, para os dois nunca divergirem.
  function textoBusca(d) {
    return norm(d.titulo + " " + (d.tipo || ""));
  }

  // Aviso da lista possivelmente incompleta. Fora do painel ele é UM ÍCONE ⚠️
  // com este texto no title (o aviso ocupava duas linhas fixas na coluna); o
  // texto só volta a ser visível durante o carregamento, quando vira progresso.
  const TIP_PADRAO_ATTR =
    "O PJe só carrega as peças conforme a linha do tempo é rolada — esta lista " +
    "pode estar incompleta. Clique em “Carregar tudo” para rolar a " +
    "linha do tempo até o fim.";
  const TIP_PADRAO = TIP_PADRAO_ATTR;

  // Tooltip do medidor: no painel estreito o texto visível é a forma curta, e
  // a frase completa é acrescentada AQUI pelo setContexto — o dado nunca some.
  const GAUGE_TITLE =
    "Quanto do limite do modelo esta conversa já ocupa (tokens e páginas de " +
    "PDF). Ao encher, desmarque peças (libera espaço na hora) ou use o botão " +
    "“Nova conversa”, no cabeçalho.";

  // Exemplos do estado vazio: clicar PREENCHE o campo (não envia — sem peça
  // marcada o envio falharia). Ensinam o gesto sem gastar um parágrafo.
  const EXEMPLOS = [
    "Resuma a petição inicial e a contestação",
    "Monte a linha do tempo dos atos do processo",
    "Quais as teses da defesa e as provas que as sustentam?",
  ];

  // Formata um valor em dólares para exibição (vírgula decimal pt-BR).
  function fmtUsd(v) {
    if (v == null || !isFinite(v)) return "?";
    if (v > 0 && v < 0.001) return "US$ 0,001";
    return "US$ " + v.toFixed(v < 0.1 ? 3 : 2).replace(".", ",");
  }
  // Formata contagem de tokens de forma legível ("12,3 mil", "870").
  function fmtMil(n) {
    n = n || 0;
    if (n < 1000) return String(n);
    return (n / 1000).toFixed(n < 10000 ? 1 : 0).replace(".", ",") + " mil";
  }

  // Token do popup "/" (prompts salvos): "/" só dispara como PRIMEIRO
  // caractere não-branco da mensagem — diferente do "@", a barra é
  // onipresente no texto jurídico (01/02/2026, art. 5º/CF, "e/ou") e no
  // meio do texto ela nunca é comando. A query não aceita "\n", "@" nem
  // outra "/": um segundo "/" (data/URL colada no início) ou um "@" (o
  // usuário passou a citar peça) fecham o popup sozinhos, por construção.
  function findSlashToken(value, pos) {
    const before = String(value).slice(0, pos);
    const m = before.match(/^\s*\/([^/@\n]*)$/);
    if (!m) return null;
    return { start: before.length - m[1].length - 1, end: pos, query: m[1] };
  }

  // Texto que vai à API quando há prompt salvo ativo: o prompt PRECEDE o
  // que o usuário digitou (linha em branco entre os dois); com o campo
  // vazio, vai o prompt sozinho. Sem prompt, o texto passa intocado.
  function montarTextoEnvio(promptTexto, textoLivre) {
    if (!promptTexto) return textoLivre;
    const livre = String(textoLivre || "").trim();
    return livre ? promptTexto + "\n\n" + livre : promptTexto;
  }

  // As @font-face vão para o <head> da PÁGINA, não para o Shadow DOM: regra
  // @font-face dentro de shadow tree é ignorada pela spec de CSS Scoping (e o
  // Chrome cumpre), então a família nunca seria registrada e todo o painel
  // cairia no fallback — em silêncio, sem erro no console. Injetar só
  // @font-face na página é inócuo: registra nomes, não altera nenhum estilo
  // dela. E o prefixo relativo precisa virar absoluto porque o CSS é injetado
  // como TEXTO (uma url() relativa resolveria contra o host do tribunal).
  // Ver DESIGN.md §3.
  function injetarFontes() {
    if (document.getElementById("pje-ia-fontes")) return;
    fetch(chrome.runtime.getURL("src/fontes.css"))
      .then((r) => r.text())
      .then((css) => {
        const el = document.createElement("style");
        el.id = "pje-ia-fontes";
        el.textContent = css.replaceAll(
          "../vendor/fontes/",
          chrome.runtime.getURL("vendor/fontes/")
        );
        (document.head || document.documentElement).appendChild(el);
      })
      .catch(() => {}); // sem fonte a stack de fallback assume; nada quebra
  }

  function mount() {
    const host = document.createElement("div");
    host.id = "pje-ia-host";
    document.documentElement.appendChild(host);
    const root = host.attachShadow({ mode: "open" });

    const styleEl = document.createElement("style");
    root.appendChild(styleEl);
    fetch(chrome.runtime.getURL("src/panel.css"))
      .then((r) => r.text())
      .then((css) => (styleEl.textContent = css))
      .catch(() => {});
    injetarFontes();

    const iconUrl = chrome.runtime.getURL("icons/icon48.png");
    const wrap = document.createElement("div");
    wrap.className = "wrap pulse";
    wrap.innerHTML = `
      <div class="backdrop"></div>
      <button class="launcher"><span class="sc">${SVG.prompts}</span> Analisar com IA</button>
      <div class="panel">
        <div class="hd">
          <span class="mark"><img src="${iconUrl}" alt=""></span>
          <span class="tit-wrap">
            <span class="ttl">Assistente dos Autos</span>
            <span class="cnj" title="Número do processo em análise"></span>
          </span>
          <div class="hd-grp">
            <button class="dl" title="Baixar a conversa em arquivo (.md)" aria-label="Baixar a conversa em arquivo">${SVG.download}</button>
            <button class="reset" title="Nova conversa (zera o chat e o contexto)" aria-label="Nova conversa">${SVG.reset}</button>
          </div>
          <div class="hd-grp">
            <button class="docsvis" title="Ocultar a lista de peças (mais espaço para o chat)" aria-label="Ocultar ou exibir a lista de peças" aria-pressed="false">${SVG.docshide}</button>
            <button class="expand" title="Painel largo (mostra as peças na lateral)" aria-label="Painel largo">${SVG.expand}</button>
            <button class="side" title="Painel lateral (mantém o processo visível ao lado)" aria-label="Painel lateral">${SVG.side}</button>
            <button class="free" title="Janela livre (arraste pelo título; redimensione pelo canto inferior direito)" aria-label="Janela livre">${SVG.free}</button>
            <button class="fs" title="Tela cheia" aria-label="Tela cheia">${SVG.fs}</button>
          </div>
          <button class="close" title="Fechar o painel" aria-label="Fechar o painel">${SVG.close}</button>
        </div>
        <div class="content">
          <button type="button" class="docs-rail" title="Exibir a lista de peças" aria-label="Exibir a lista de peças">
            <span class="rail-i">${SVG.docsshow}</span>
            <span class="rail-t">Peças do processo</span>
            <span class="rail-n"></span>
          </button>
          <div class="docs">
            <div class="docs-hd">
              <div class="dh-row">
                <strong>Peças do processo</strong>
                <span class="count"></span>
                <button type="button" class="docs-fold" title="Ocultar a lista de peças (mais espaço para o chat)" aria-label="Ocultar a lista de peças">${SVG.fold}</button>
              </div>
              <div class="docsearch">
                <input type="search" class="doc-q" placeholder="Buscar peça… (ex.: contestação)" aria-label="Buscar peça pelo nome">
                <span class="doc-q-n" hidden></span>
                <span class="sel-opts">
                  <label class="all" title="Marca a espinha dorsal do processo: petição inicial, contestação, réplica, saneador, laudo, ata de instrução, memoriais, sentença, acórdão e recursos. Costumam ser cerca de uma dúzia de peças e respondem a maioria das perguntas."><input type="checkbox" class="chk-ess"><span class="op-l">chave</span><span class="op-s">chave</span></label>
                  <label class="all" title="Marca as peças de conteúdo — decisões, audiências, petições e provas —, deixando de fora o expediente (certidões de intimação, avisos de recebimento, guias, procurações). Respeita a busca ativa."><input type="checkbox" class="chk-main"><span class="op-l">principais</span><span class="op-s">princ.</span></label>
                  <label class="all" title="Marca todas as peças da lista (respeita a busca ativa)"><input type="checkbox" class="chk-all"><span class="op-l">todas</span><span class="op-s">todas</span></label>
                </span>
                <span class="sel-nota" hidden></span>
              </div>
            </div>
            <div class="legend" aria-hidden="true">
              <span><i class="l-dot cat-decisao"></i>decisões</span>
              <span><i class="l-dot cat-audiencia"></i>audiências</span>
              <span><i class="l-dot cat-peticao"></i>petições</span>
              <span><i class="l-dot cat-prova"></i>provas</span>
            </div>
            <div class="doclist" title="Arraste para marcar várias peças · Shift+clique marca até aqui · botão direito abre “marcar daqui para baixo/cima”"></div>
            <div class="docs-tip">
              <span class="tip-i" role="note" tabindex="0" title="${TIP_PADRAO_ATTR}" aria-label="${TIP_PADRAO_ATTR}">!</span>
              <span class="tip-txt"></span>
              <button type="button" class="tip-load" title="Rola a linha do tempo do processo automaticamente até o fim para carregar TODAS as peças do processo na lista">${SVG.reload}<span class="lbl">Carregar tudo</span></button>
              <button type="button" class="tip-ia" title="Envia à IA só a LISTA de peças (id, título, tipo e data — nenhum conteúdo) e pede que ela escolha as relevantes. Se houver texto no campo de pergunta, escolhe para AQUELA pergunta; vazio, escolhe as peças que descrevem o processo. Custa alguns centavos e leva poucos segundos.">${SVG.ia}<span class="lbl">Escolher com IA</span></button>
              <button type="button" class="tip-zip" title="Baixa os arquivos ORIGINAIS das peças (PDF, HTML) num único .zip, numerados na ordem do processo e com um índice de tipo, data e autor da juntada. Exporta as peças MARCADAS; sem nenhuma marcada, exporta todas as da lista.">${SVG.zip}<span class="lbl">Baixar .zip</span></button>
            </div>
          </div>
          <div class="main">
            <div class="msgs"></div>
            <div class="ft">
              <div class="mention" hidden>
                <div class="mention-hd">
                  <span>Adicionar peça ao contexto</span>
                  <span class="mention-keys"><kbd>↑↓</kbd> navegar <kbd>↵</kbd> marcar <kbd>esc</kbd> fechar</span>
                </div>
                <div class="mention-q" aria-hidden="true">
                  ${SVG.lupa}<span class="mq-t"></span><span class="mq-caret"></span><span class="mq-n"></span>
                </div>
                <div class="mention-list" role="listbox"></div>
              </div>
              <div class="slash" hidden>
                <div class="slash-hd">
                  <span>Inserir prompt salvo</span>
                  <span class="mention-keys"><kbd>↑↓</kbd> navegar <kbd>↵</kbd> inserir <kbd>esc</kbd> fechar</span>
                </div>
                <div class="mention-q" aria-hidden="true">
                  ${SVG.lupa}<span class="mq-t"></span><span class="mq-caret"></span><span class="mq-n"></span>
                </div>
                <div class="slash-list" role="listbox"></div>
              </div>
              <div class="status" aria-live="polite"></div>
              <div class="alertbar" role="alert" hidden></div>
              <div class="ctxbar" hidden></div>
              <div class="toolbar">
                <div class="tools">
                  <button class="tgl-search" aria-pressed="false" title="Liga/desliga a busca de jurisprudência e legislação em fontes oficiais (STF, STJ, Planalto…). Com a busca ligada, escreva a pergunta e use o botão Enviar normalmente.">${SVG.juris}<span class="lbl">Jurisprudência</span></button>
                  <button class="btn-minuta" title="Liga o modo minuta: a instrução aparece no campo (edite à vontade) e o botão Enviar vira “Gerar minuta” — a resposta abre num editor de texto, em nova aba, de onde você copia para o PJe, baixa em Word (.docx) ou imprime.">${SVG.minuta}<span class="lbl">Minutar</span></button>
                  <button class="btn-mapa" title="Liga o modo mapa mental: a instrução aparece no campo (edite à vontade) e o botão Enviar vira “Gerar mapa” — a resposta abre num mapa mental interativo, em nova aba.">${SVG.mapa}<span class="lbl">Mapa mental</span></button>
                  <button class="btn-plib" title="Seus prompts salvos: crie instruções reutilizáveis (título + texto) e insira-as na conversa digitando “/” no início do campo de mensagem. Sincronizam entre navegadores logados na mesma conta Google.">${SVG.prompts}<span class="lbl">Prompts</span></button>
                  <button class="btn-mlib" title="Seus modelos de peças (sentenças, decisões, despachos, ofícios…): cadastre várias por categoria e, ao gerar uma minuta, escolha a categoria para o assistente seguir a estrutura e o estilo dos seus modelos — os fatos continuam saindo só das peças do processo.">${SVG.modelos}<span class="lbl">Modelos</span></button>
                </div>
                <div class="metarow">
                  <div class="gauge" hidden title="${GAUGE_TITLE}">
                    <div class="gauge-bar"><div class="gauge-fill"></div></div>
                    <span class="gauge-txt"><span class="g-full"></span><span class="g-short"></span></span>
                  </div>
                  <div class="custo" hidden>
                    <span class="custo-txt"><span class="g-full"></span><span class="g-short"></span></span>
                  </div>
                  <button class="modelo-badge" hidden title="Modelo de IA em uso nesta conversa — clique para trocar nas opções da extensão"></button>
                  <span class="cite-note" hidden tabindex="0" role="note" title="Modelos Gemini: as citações de página aparecem no próprio texto da resposta (ex.: “conforme a Contestação, fl. 12”), sem os marcadores [n] automáticos dos modelos Claude." aria-label="Neste modelo as citações de página aparecem no próprio texto da resposta, sem os marcadores numerados dos modelos Claude.">${SVG.info}</span>
                </div>
              </div>
              <div class="minutabar" hidden>
                <span class="docxbar-t">${SVG.minuta} <b>Modo minuta ligado</b> — revise a instrução abaixo e clique em <b>Gerar minuta</b>: a resposta abre num editor, em nova aba, pronta para revisar e levar ao PJe.</span>
                <button class="minutabar-x" title="Cancelar a geração da minuta (Esc)">${SVG.x}</button>
                <div class="minuta-modelo" hidden>
                  <span class="mm-lab">Seguir modelos:</span>
                  <select class="minuta-modelo-sel" aria-label="Categoria de peças-modelo que a minuta deve seguir" title="Escolha uma categoria: o assistente recebe as suas peças-modelo daquela espécie e segue a estrutura e o estilo da mais adequada ao caso — os fatos continuam vindo só das peças do processo."></select>
                  <span class="mm-vazio" hidden>nenhuma peça-modelo cadastrada — a minuta sai no estilo padrão</span>
                  <button class="mm-add" hidden title="Cadastre uma sentença, decisão, despacho ou ofício seu: nas próximas minutas o assistente segue a estrutura e o estilo dela.">${SVG.novo}<span class="lbl">Cadastrar modelo</span></button>
                </div>
              </div>
              <div class="mapabar" hidden>
                <span class="docxbar-t">${SVG.mapa} <b>Modo mapa mental ligado</b> — revise a instrução abaixo e clique em <b>Gerar mapa</b>: a resposta vira um mapa mental interativo, que abre em nova aba.</span>
                <button class="mapabar-x" title="Cancelar a geração do mapa mental (Esc)">${SVG.x}</button>
              </div>
              <div class="promptbar" hidden></div>
              <div class="inrow">
                <textarea class="in" rows="1" placeholder="Pergunte sobre as peças… (@ cita uma peça)"></textarea>
                <button class="send"><span class="lbl">Enviar</span>${SVG.enviar}</button>
              </div>
              <div class="hint-key"><div class="hk-in"><b>@</b> cita peças &nbsp;·&nbsp; <b>/</b> insere um prompt salvo &nbsp;·&nbsp; <b>Enter</b> envia <span class="hk-shift">&nbsp;·&nbsp; <b>Shift+Enter</b> quebra linha</span></div></div>
            </div>
          </div>
        </div>
        <div class="plib" hidden>
          <div class="plib-card" role="dialog" aria-modal="true" aria-label="Prompts salvos" tabindex="-1">
            <div class="plib-hd">
              <span class="t">${SVG.prompts} Prompts salvos</span>
              <button class="plib-new">${SVG.novo}<span class="lbl">Novo</span></button>
              <button class="plib-close" title="Fechar (Esc)" aria-label="Fechar o gerenciador de prompts">${SVG.close}</button>
            </div>
            <div class="plib-list"></div>
            <div class="plib-form" hidden>
              <input type="text" class="plib-ft" maxlength="60" placeholder="Título do prompt (ex.: Relatório de audiência)" aria-label="Título do prompt">
              <textarea class="plib-fx" placeholder="Texto do prompt — a instrução completa, enviada no início da mensagem quando você usar este prompt…" aria-label="Texto do prompt"></textarea>
              <div class="plib-cnt"></div>
              <div class="plib-err" role="alert"></div>
              <div class="plib-form-acts">
                <button class="plib-cancel">Cancelar</button>
                <button class="plib-save">Salvar</button>
              </div>
            </div>
          </div>
        </div>
        <div class="mlib plib" hidden>
          <div class="mlib-card plib-card" role="dialog" aria-modal="true" aria-label="Modelos de peças" tabindex="-1">
            <div class="plib-hd">
              <span class="t">${SVG.modelos} Modelos de peças</span>
              <button class="mlib-new plib-new">${SVG.novo}<span class="lbl">Novo</span></button>
              <button class="mlib-close plib-close" title="Fechar (Esc)" aria-label="Fechar o gerenciador de modelos">${SVG.close}</button>
            </div>
            <div class="mlib-list plib-list"></div>
            <div class="mlib-form plib-form" hidden>
              <input type="text" class="mlib-ft" maxlength="80" placeholder="Título do modelo (ex.: Sentença de improcedência — dano moral)" aria-label="Título do modelo">
              <select class="mlib-fc" aria-label="Categoria do modelo"></select>
              <input type="text" class="mlib-fd" maxlength="120" placeholder="Descrição — opcional (quando usar este modelo)" aria-label="Descrição do modelo">
              <textarea class="mlib-fx" placeholder="Cole o texto da peça-modelo — o assistente imita a ESTRUTURA e o estilo; os fatos vêm sempre das peças do processo, nunca do modelo…" aria-label="Texto do modelo"></textarea>
              <div class="mlib-cnt plib-cnt"></div>
              <div class="mlib-err plib-err" role="alert"></div>
              <div class="plib-form-acts">
                <button class="mlib-cancel plib-cancel">Cancelar</button>
                <button class="mlib-save plib-save">Salvar</button>
              </div>
            </div>
          </div>
        </div>
      </div>`;
    root.appendChild(wrap);

    const $ = (s) => wrap.querySelector(s);
    const launcher = $(".launcher");
    const backdrop = $(".backdrop");
    const resetBtn = $(".reset");
    const expandBtn = $(".expand");
    const closeBtn = $(".close");
    const docsBox = $(".docs");
    const doclist = $(".doclist");
    // Os três degraus de seleção, do mais enxuto ao mais amplo
    const chkEss = $(".chk-ess");
    const chkAll = $(".chk-all");
    const chkMain = $(".chk-main");
    const selNota = $(".sel-nota");
    const countEl = $(".count");
    const railNEl = $(".rail-n"); // badge da aba vertical (lista recolhida)
    const docQ = $(".doc-q");
    const docQN = $(".doc-q-n");
    const tipBox = $(".docs-tip");
    const tipTxt = $(".tip-txt");
    const tipLoad = $(".tip-load");
    const tipZip = $(".tip-zip");
    const tipIa = $(".tip-ia");
    const msgs = $(".msgs");
    const ft = $(".ft");
    const statusEl = $(".status");
    const gaugeEl = $(".gauge");
    const gaugeFill = $(".gauge-fill");
    // Medidor e custo escrevem DUAS versões do mesmo dado: a frase completa
    // (modos largos) e a forma curta (flutuante/lateral, onde a linha de meta
    // é estreita). Quem escolhe é o CSS — nenhuma informação vira só tooltip.
    const gaugeFull = $(".gauge-txt .g-full");
    const gaugeShort = $(".gauge-txt .g-short");
    const custoEl = $(".custo");
    const custoFull = $(".custo-txt .g-full");
    const custoShort = $(".custo-txt .g-short");
    const citeNote = $(".cite-note");
    const modeloBadge = $(".modelo-badge");
    const alertEl = $(".alertbar");
    const ctxbar = $(".ctxbar");
    const mentionEl = $(".mention");
    const mentionList = $(".mention-list");
    const mentionQT = $(".mq-t"); // espelho ao vivo da busca digitada após o @
    const mentionQN = $(".mq-n"); // contador de peças encontradas
    const mentionQC = $(".mq-caret"); // cursor falso (re-sincronizado a cada tecla)
    const inEl = $(".in");
    const sendBtn = $(".send");

    let allDocs = []; // [{id, titulo}] espelho da lista lateral
    // A lista já tem o TIPO oficial (tela "Documentos" do PJe)? Sem ele a
    // classificação sai só do título — que costuma ser o nome do arquivo — e o
    // degrau "chave" seleciona de menos. Não desabilitamos a opção por isso (o
    // título ainda acerta "Sentença", "Petição Inicial", "Contestação",
    // "Laudo"), mas o clique passa a dizer que dá para melhorar.
    let temTipoOficial = false;
    // Peças que JÁ foram enviadas nesta conversa. O anexo é incremental (cada
    // peça entra no histórico uma única vez), então numa conversa longa o
    // usuário perde a conta do que já mandou — e desmarcar/remarcar uma peça
    // que já está no contexto não custa nada, enquanto marcar uma nova custa
    // download, upload e tokens. O dado vive no content script; o painel só o
    // reflete, via setPecasEnviadas.
    let pecasEnviadas = new Set();

    // -------------------------------------------------------------------------
    // Estado vazio em camadas (progressive disclosure): três passos + exemplos
    // clicáveis sempre visíveis; o texto explicativo mora num <details> fechado
    // por padrão (estado lembrado); a referência completa (tabela de modelos,
    // preços, fluxo, dicas de cache) vive só no help.html — o painel APONTA
    // para ela em vez de recitá-la, que era a origem da parede de texto.
    // -------------------------------------------------------------------------
    let hintEl = null;
    let guiaAberta = false;
    function showEmptyHint() {
      if (hintEl || msgs.querySelector(".msg")) return;
      hintEl = document.createElement("div");
      hintEl.className = "hint-empty";
      hintEl.innerHTML =
        '<span class="big">Como posso ajudar?</span>' +
        '<div class="passos">' +
        '<div class="passo"><span class="pn">1</span><b>Marque as peças</b>' +
        // "ao lado" só é verdade nos modos largos: no estreito a lista fica
        // ACIMA do chat. Duas versões no DOM, escolha no CSS — mesmo mecanismo
        // dos rótulos longo/curto do segmented (.op-l/.op-s).
        '<span><span class="p-lado">na lista ao lado</span>' +
        '<span class="p-gaveta">na gaveta acima</span> — <b>chave</b> traz a ' +
        "espinha dorsal do processo; há também a busca e o <b>@</b> no campo</span></div>" +
        '<div class="passo"><span class="pn">2</span><b>Peça o que precisa</b>' +
        "<span>resumo, linha do tempo, minuta — só o que foi marcado é lido</span></div>" +
        '<div class="passo"><span class="pn">3</span><b>Confira a origem</b>' +
        "<span>cada afirmação vem com a peça, o <i>id</i> e a folha</span></div>" +
        "</div>" +
        '<div class="exemplos">' +
        EXEMPLOS.map(
          (t) =>
            '<button type="button" class="ex" title="Coloca este texto no campo de mensagem para você editar">' +
            escapeHtml(t) +
            "</button>"
        ).join("") +
        "</div>" +
        '<details class="guia"' +
        (guiaAberta ? " open" : "") +
        "><summary>Como funciona, limites e alternativas</summary>" +
        "<p><b>Não é um agente autônomo</b> (como o Claude Code): ele não navega no " +
        "processo sozinho. Você marca as peças, envia a solicitação e a resposta usa " +
        "somente os documentos marcados — dá para marcar e desmarcar entre uma " +
        "pergunta e outra.</p>" +
        "<p><b>A lista pode vir incompleta:</b> o PJe só carrega as peças conforme a " +
        "linha do tempo é rolada. Antes de procurar uma peça antiga, use " +
        "<b>Carregar tudo</b>, abaixo da lista.</p>" +
        "<p><b>O contexto é limitado:</b> peças, perguntas e respostas precisam caber " +
        "na janela do modelo. O medidor ao lado das ferramentas mostra o quanto já foi " +
        "usado; se encher, desmarque peças (libera espaço na hora) ou comece uma " +
        "conversa nova.</p>" +
        // O gargalo real do produto, e o que mais surpreende quem começa: a
        // espera não é da IA, é do tribunal entregando peça por peça. Fica no
        // guia (fechado por padrão) para não engordar o estado vazio, mas com
        // destaque próprio — é a diferença entre "a extensão é lenta" e "a
        // minha conexão está ruim".
        "<p><b>Sua conexão manda no tempo de espera:</b> o PJe entrega as peças " +
        "<b>uma de cada vez</b> (cerca de 5 s cada). No Wi-Fi instável isso se " +
        "multiplica por dezenas de documentos e a extensão parece travada, quando na " +
        "verdade está esperando o tribunal. <b>Cabo de rede faz muita diferença</b> — " +
        "e marcar só as peças que interessam, mais ainda.</p>" +
        '<p>Para autos muito grandes, conheça o <a href="https://mcp.tecjustica.com/" ' +
        'target="_blank" rel="noopener">TecJustiça MCP</a>, em que o contexto do processo ' +
        "é gerenciado automaticamente pelo código, e a demonstração com o PJe do Ceará em " +
        '<a href="https://pjece.tecjustica.com/" target="_blank" rel="noopener">' +
        "pjece.tecjustica.com</a>.</p>" +
        "</details>" +
        '<button type="button" class="hint-help">Guia completo, modelos e preços →</button>';
      // exemplos: PREENCHEM o campo (não enviam — sem peça marcada o envio
      // falharia e a primeira experiência seria um erro)
      hintEl.querySelectorAll(".ex").forEach((b) => {
        b.addEventListener("click", () => {
          if (inEl.disabled) return; // resposta em curso: o campo está travado
          inEl.value = b.textContent; // as aspas são ::before/::after, não entram
          autoresize();
          inEl.focus();
        });
      });
      const det = hintEl.querySelector(".guia");
      det.addEventListener("toggle", () => {
        guiaAberta = det.open;
        try {
          chrome.storage.local.set({ guiaAberta: det.open });
        } catch {
          /* contexto da extensão invalidado — segue sem persistir */
        }
      });
      hintEl.querySelector(".hint-help").addEventListener("click", () => {
        try {
          window.open(chrome.runtime.getURL("src/help.html"), "_blank", "noopener");
        } catch {
          /* fora da extensão (harness de teste) */
        }
      });
      msgs.appendChild(hintEl);
      ft.classList.add("novato"); // atalhos de teclado visíveis para quem chega agora
    }
    function clearEmptyHint() {
      ft.classList.remove("novato");
      if (hintEl) {
        hintEl.remove();
        hintEl = null;
      }
    }
    showEmptyHint();
    // Restauração do <details> DEPOIS de showEmptyHint existir e rodar (o stub
    // de teste chama o callback de forma síncrona — mesma armadilha documentada
    // do docsOcultas): se o usuário deixou a guia aberta, ela reabre.
    try {
      chrome.storage.local.get(["guiaAberta"], (v) => {
        if (!v || !v.guiaAberta) return;
        guiaAberta = true;
        const det = hintEl && hintEl.querySelector(".guia");
        if (det) det.open = true;
      });
    } catch {
      /* sem storage (harness de teste): guia fechada */
    }

    function open() {
      wrap.classList.add("open");
      wrap.classList.remove("pulse");
    }
    launcher.addEventListener("click", open);

    // -------------------------------------------------------------------------
    // Modos de layout (classes no .wrap): flutuante (nenhuma), expandido
    // (modal central com backdrop), tela cheia (expanded+full) e lateral
    // (sidebar à direita com a página visível — sem backdrop). "lateral" e
    // "expanded" são mutuamente exclusivas. A preferência persiste em
    // chrome.storage.local (tela cheia é transitória: persiste "expandido").
    // -------------------------------------------------------------------------
    function modoAtual() {
      if (wrap.classList.contains("livre")) return "livre";
      if (wrap.classList.contains("full")) return "cheia";
      if (wrap.classList.contains("expanded")) return "expandido";
      if (wrap.classList.contains("lateral")) return "lateral";
      return "flutuante";
    }
    // Nos modos largos a lista de peças é uma COLUNA estreita (320px), não a
    // faixa de 460px do flutuante — e ali o exemplo do placeholder não cabe:
    // o campo fica com ~137px e o texto sai cortado no meio da palavra, que
    // lê como defeito. O exemplo é uma dica de descoberta e vale nos modos em
    // que há espaço para ele. Chamado por aplicarModo, o ponto único de
    // transição de layout.
    const PH_BUSCA_LONGO = "Buscar peça… (ex.: contestação)";
    const PH_BUSCA_CURTO = "Buscar peça…";
    function ajustarPlaceholderBusca() {
      const estreito =
        wrap.classList.contains("expanded") ||
        wrap.classList.contains("full") ||
        wrap.classList.contains("livre-wide");
      docQ.placeholder = estreito ? PH_BUSCA_CURTO : PH_BUSCA_LONGO;
    }

    function aplicarModo(modo) {
      hidePreview(); // a posição do popover fica inválida ao trocar o layout
      const eraLivre = wrap.classList.contains("livre");
      // Captura a geometria ANTES de tirar a classe (sem .livre o .panel volta
      // a position:absolute e o rect muda) — cobre o resize pela alça nativa
      // mesmo se o ResizeObserver não tiver disparado (janela ocluída suprime
      // callbacks do pipeline de render, mesma razão do setTimeout do
      // "ver na timeline").
      if (eraLivre && modo !== "livre") salvarGeoLivre();
      wrap.classList.remove("expanded", "full", "lateral", "livre", "livre-wide");
      if (modo === "expandido") wrap.classList.add("expanded");
      else if (modo === "cheia") wrap.classList.add("expanded", "full");
      else if (modo === "lateral") wrap.classList.add("lateral");
      else if (modo === "livre") {
        wrap.classList.add("livre");
        aplicarGeoLivre();
      }
      // INVARIANTE: a geometria do modo livre vive em inline styles
      // (left/top/width/height), e inline vence classe — sem esta limpeza os
      // valores vazariam e deformariam o expandido/lateral/flutuante.
      if (eraLivre && modo !== "livre") limparGeoLivre();
      // reavalia as classes de LARGURA aqui também: o ResizeObserver não dispara
      // quando o painel troca de modo sem mudar de largura (flutuante ⇄ lateral
      // numa janela estreita têm os mesmos 420px), e é ele quem chama o
      // ajustarPlaceholderBusca.
      atualizarLargura();
      try {
        chrome.storage.local.set({ layoutModo: modo === "cheia" ? "expandido" : modo });
      } catch {
        /* contexto da extensão invalidado (recarga) — segue sem persistir */
      }
    }

    // ---- Modo livre: janela solta — arrasta pelo cabeçalho e redimensiona
    // pela alça nativa (resize:both) do canto inferior direito. Definido ANTES
    // do restore do layout: o stub de teste chama o callback do storage de
    // forma SÍNCRONA (mesma armadilha documentada do docsOcultas).
    const panelEl = $(".panel");
    const hdEl = $(".hd");
    let geoLivre = null; // {x, y, w, h} — persistido em chrome.storage.local
    function clampGeoLivre(g) {
      const vw = window.innerWidth,
        vh = window.innerHeight;
      const w = Math.min(Math.max(g.w, 340), Math.floor(vw * 0.96));
      const h = Math.min(Math.max(g.h, 380), Math.floor(vh * 0.96));
      // o cabeçalho precisa continuar alcançável para re-arrastar (uma tira
      // de 120px do painel sempre fica dentro da viewport)
      const x = Math.min(Math.max(g.x, 120 - w), vw - 120);
      const y = Math.min(Math.max(g.y, 0), vh - 60);
      return { x, y, w, h };
    }
    // Acima deste limiar de LARGURA DO PAINEL a lista de peças vira coluna
    // lateral (como no expandido). Media query não serve: ela mede a viewport,
    // não o painel — a classe .livre-wide é alternada aqui e no ResizeObserver.
    const LIVRE_LARGO_PX = 740;
    // Abaixo deste limiar cabe UMA fileira de botões e UMA coluna: entra a
    // classe .estreito (DESIGN.md §5). NÃO é uma classe do modo lateral — o
    // flutuante também tem 420px e a janela livre desce até 340. O piso de 1
    // ignora o painel FECHADO, cujo offsetWidth é 0 (`.wrap.open .panel` é que
    // liga o display): sem essa guarda a classe entraria com o painel oculto e
    // o layout piscaria na abertura.
    const ESTREITO_PX = 520;
    function atualizarLargura() {
      const w = panelEl.offsetWidth;
      const on = wrap.classList.contains("livre") && w >= LIVRE_LARGO_PX;
      if (on !== wrap.classList.contains("livre-wide")) hidePreview(); // âncora muda de lugar
      wrap.classList.toggle("livre-wide", on);
      const estreito = w >= 1 && w < ESTREITO_PX;
      if (estreito !== wrap.classList.contains("estreito")) hidePreview();
      wrap.classList.toggle("estreito", estreito);
      // as classes de largura são alternadas AQUI, não em aplicarModo (media
      // query mede a viewport e erraria no modo livre) — então o placeholder da
      // busca, que depende da largura da COLUNA de peças, também precisa ser
      // reavaliado.
      ajustarPlaceholderBusca();
    }
    function aplicarGeoLivre() {
      const vw = window.innerWidth,
        vh = window.innerHeight;
      const padrao = {
        w: Math.min(760, Math.floor(vw * 0.92)),
        h: Math.min(820, Math.floor(vh * 0.85)),
      };
      padrao.x = Math.floor((vw - padrao.w) / 2);
      padrao.y = Math.floor((vh - padrao.h) / 2);
      const g = clampGeoLivre(geoLivre || padrao);
      panelEl.style.left = g.x + "px";
      panelEl.style.top = g.y + "px";
      panelEl.style.width = g.w + "px";
      panelEl.style.height = g.h + "px";
      atualizarLargura();
    }
    function limparGeoLivre() {
      panelEl.style.left = "";
      panelEl.style.top = "";
      panelEl.style.width = "";
      panelEl.style.height = "";
    }
    let geoTimer = null;
    function salvarGeoLivre() {
      const r = panelEl.getBoundingClientRect();
      geoLivre = {
        x: Math.round(r.left),
        y: Math.round(r.top),
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
      clearTimeout(geoTimer);
      geoTimer = setTimeout(() => {
        try {
          chrome.storage.local.set({ livreGeo: geoLivre });
        } catch {
          /* contexto invalidado — segue sem persistir */
        }
      }, 400);
    }
    // Arrasto pelo cabeçalho — MENOS pelos botões (eles mantêm o clique)
    let arrasto = null;
    hdEl.addEventListener("pointerdown", (e) => {
      if (!wrap.classList.contains("livre")) return;
      if (e.button !== 0 || e.target.closest("button")) return;
      const r = panelEl.getBoundingClientRect();
      arrasto = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      try {
        hdEl.setPointerCapture(e.pointerId); // segura o arrasto fora do cabeçalho
      } catch {
        /* pointer sintético/sem id válido: o arrasto ainda funciona sobre o hd */
      }
      hidePreview(); // o popover está ancorado numa row que vai se mover junto
      e.preventDefault(); // sem seleção de texto no meio do arrasto
    });
    hdEl.addEventListener("pointermove", (e) => {
      if (!arrasto) return;
      const g = clampGeoLivre({
        x: e.clientX - arrasto.dx,
        y: e.clientY - arrasto.dy,
        w: panelEl.offsetWidth,
        h: panelEl.offsetHeight,
      });
      panelEl.style.left = g.x + "px";
      panelEl.style.top = g.y + "px";
    });
    const fimArrasto = () => {
      if (!arrasto) return;
      arrasto = null;
      salvarGeoLivre();
    };
    hdEl.addEventListener("pointerup", fimArrasto);
    hdEl.addEventListener("pointercancel", fimArrasto);
    // A alça nativa de resize não emite evento próprio — o observer persiste.
    // Guardas: só no modo livre (ele também dispara em toda troca de layout)
    // e com o painel aberto (fechado, o rect é 0x0 e apagaria a geometria).
    const roLivre = new ResizeObserver(() => {
      atualizarLargura();
      if (
        wrap.classList.contains("livre") &&
        wrap.classList.contains("open") &&
        !arrasto
      )
        salvarGeoLivre();
    });
    roLivre.observe(panelEl);

    // Restaura a preferência de layout (vale a partir do próximo open()).
    try {
      chrome.storage.local.get(["layoutModo", "livreGeo"], (v) => {
        if (v && v.livreGeo) geoLivre = v.livreGeo;
        if (v && v.layoutModo === "lateral") wrap.classList.add("lateral");
        else if (v && v.layoutModo === "expandido") wrap.classList.add("expanded");
        else if (v && v.layoutModo === "livre") {
          wrap.classList.add("livre");
          aplicarGeoLivre();
        }
      });
    } catch {
      /* sem storage (harness de teste): fica no flutuante */
    }

    closeBtn.addEventListener("click", () => {
      hidePreview();
      if (wrap.classList.contains("livre")) salvarGeoLivre(); // antes de tirar a classe
      wrap.classList.remove("open", "expanded", "full", "lateral", "livre", "livre-wide");
      limparGeoLivre();
    });
    expandBtn.addEventListener("click", () =>
      aplicarModo(modoAtual() === "expandido" ? "flutuante" : "expandido")
    );
    // Tela cheia: entrar implica o layout expandido; sair volta ao expandido.
    const fsBtn = $(".fs");
    fsBtn.addEventListener("click", () =>
      aplicarModo(modoAtual() === "cheia" ? "expandido" : "cheia")
    );
    const sideBtn = $(".side");
    sideBtn.addEventListener("click", () =>
      aplicarModo(modoAtual() === "lateral" ? "flutuante" : "lateral")
    );
    const freeBtn = $(".free");
    freeBtn.addEventListener("click", () =>
      aplicarModo(modoAtual() === "livre" ? "flutuante" : "livre")
    );
    backdrop.addEventListener("click", () => aplicarModo("flutuante"));

    // Ocultar/exibir a coluna de peças nos modos expandido/tela cheia (mais
    // espaço para o chat). Só VISUAL: os checkboxes seguem no DOM — seleção,
    // chips, popup @ e envio continuam funcionando com a lista oculta. O
    // botão só aparece nos modos expandidos (CSS) e a preferência persiste.
    const docsVisBtn = $(".docsvis");
    const docsFoldBtn = $(".docs-fold");
    const docsRail = $(".docs-rail");
    function setDocsOcultas(on, persistir) {
      wrap.classList.toggle("docs-collapsed", on);
      docsVisBtn.classList.toggle("on", on);
      docsVisBtn.setAttribute("aria-pressed", String(!!on));
      // o ícone acompanha a ação disponível: chevron ← recolhe, → traz de volta
      docsVisBtn.innerHTML = on ? SVG.docsshow : SVG.docshide;
      docsVisBtn.title = on
        ? "Exibir a lista de peças"
        : "Ocultar a lista de peças (mais espaço para o chat)";
      hidePreview(); // popover ancorado numa row que deixou de existir na tela
      if (persistir !== false) {
        try {
          chrome.storage.local.set({ docsOcultas: !!on });
        } catch {
          /* contexto da extensão invalidado — segue sem persistir */
        }
      }
    }
    docsVisBtn.addEventListener("click", () =>
      setDocsOcultas(!wrap.classList.contains("docs-collapsed"))
    );
    // controles colocados JUNTO da coluna que eles controlam (o botão do
    // header ninguém achava): « no cabeçalho da lista recolhe; a aba
    // vertical que fica no lugar da coluna traz de volta
    docsFoldBtn.addEventListener("click", () => setDocsOcultas(true));
    docsRail.addEventListener("click", () => setDocsOcultas(false));
    try {
      chrome.storage.local.get(["docsOcultas"], (v) => {
        if (v && v.docsOcultas) setDocsOcultas(true, false);
      });
    } catch {
      /* sem storage (harness de teste): lista visível */
    }

    let resetCb = null;
    resetBtn.addEventListener("click", () => {
      if (resetCb) resetCb();
    });

    // Toggle de busca de jurisprudência (estado lido pelo content script no envio)
    const tglSearch = $(".tgl-search");
    let searchOn = false;
    tglSearch.addEventListener("click", () => {
      searchOn = !searchOn;
      tglSearch.setAttribute("aria-pressed", String(searchOn));
      tglSearch.classList.toggle("on", searchOn);
      // feedback imediato: o rótulo e o status dizem o que o toggle faz
      // SÓ o rótulo — o <svg> é irmão dele. Escrever no textContent do botão
      // apagaria o ícone no primeiro clique (e sem erro nenhum).
      rotulo(tglSearch, searchOn ? "Jurisprudência ligada" : "Jurisprudência");
      statusEl.textContent = searchOn
        ? "Busca de jurisprudência ligada: as próximas perguntas enviadas poderão consultar STF, STJ, Planalto e outras fontes oficiais."
        : "Busca de jurisprudência desligada.";
    });

    // Geração de MINUTA por modo explícito: o clique no botão liga o modo — a
    // instrução padrão (editável) entra no campo, a faixa .minutabar explica o
    // passo e o botão Enviar vira "📝 Gerar minuta". Enviar/Enter geram; ✕, Esc
    // ou novo clique no botão cancelam. (Não reintroduzir o fluxo de "dois
    // cliques no mesmo botão": todo mundo aperta Enviar.)
    // Como o mapa mental, o turno é um chat comum — sem skill, sem execução de
    // código —, então funciona em QUALQUER modelo, Claude ou Gemini.
    const INSTRUCAO_MINUTA_PADRAO =
      "Elabore a minuta do ato cabível neste momento do processo, com relatório, " +
      "fundamentação e dispositivo, indicando a origem de cada afirmação.";
    const btnMinuta = $(".btn-minuta");
    const minutabar = $(".minutabar");
    let minutaCb = null;
    let minutaMode = false;
    function setMinutaMode(on) {
      minutaMode = on;
      minutabar.hidden = !on;
      btnMinuta.classList.toggle("on", on);
      rotulo(btnMinuta, on ? "Cancelar minuta" : "Minutar");
      icone(btnMinuta, on ? SVG.cancel : SVG.minuta);
      rotulo(sendBtn, on ? "Gerar minuta" : "Enviar");
      sendBtn.classList.toggle("docx", on);
      inEl.placeholder = on
        ? "Instrução da minuta — edite e clique em Gerar minuta…"
        : "Pergunte sobre as peças… (@ cita uma peça)";
      if (!on) statusEl.textContent = "";
      atualizarSeletorMinuta(on); // popula/oculta o seletor de peça-modelo
    }
    btnMinuta.addEventListener("click", () => {
      if (minutaMode) return setMinutaMode(false); // segundo clique = cancelar
      if (!getSelected().length) {
        statusEl.textContent =
          "Para gerar a minuta, primeiro marque as peças que devem embasá-la.";
        return;
      }
      if (mapaMode) setMapaMode(false); // os dois modos são mutuamente exclusivos
      // preserva o que o usuário já digitou; senão, oferece a instrução
      // padrão — SALVO quando há prompt salvo ativo (chip): ele já é a
      // instrução da minuta, injetar a padrão duplicaria comandos
      if (!inEl.value.trim() && !promptAtivo) {
        inEl.value = INSTRUCAO_MINUTA_PADRAO;
        autoresize();
      }
      setMinutaMode(true);
      inEl.focus();
    });
    minutabar
      .querySelector(".minutabar-x")
      .addEventListener("click", () => setMinutaMode(false));

    // Modo MAPA MENTAL — mesmo contrato do modo documento (o Enviar é
    // sequestrado, a faixa explica o passo, ✕/Esc/segundo clique cancelam).
    // Diferença: não depende de skill nem de execução de código, então roda
    // também nos modelos Gemini; a resposta é markdown e vira mapa em
    // src/mapa.html, numa aba própria.
    const INSTRUCAO_MAPA_PADRAO =
      "Mapeie o processo: partes e representantes, síntese dos fatos, pedidos, teses de cada " +
      "parte, provas produzidas, decisões proferidas e situação atual do feito.";
    const btnMapa = $(".btn-mapa");
    const mapabar = $(".mapabar");
    let mapaCb = null;
    let mapaMode = false;
    function setMapaMode(on) {
      mapaMode = on;
      mapabar.hidden = !on;
      btnMapa.classList.toggle("on", on);
      rotulo(btnMapa, on ? "Cancelar mapa" : "Mapa mental");
      icone(btnMapa, on ? SVG.cancel : SVG.mapa);
      rotulo(sendBtn, on ? "Gerar mapa" : "Enviar");
      sendBtn.classList.toggle("docx", on); // mesmo halo azul do modo documento
      inEl.placeholder = on
        ? "Instrução do mapa mental — edite e clique em Gerar mapa…"
        : "Pergunte sobre as peças… (@ cita uma peça)";
      if (!on) statusEl.textContent = "";
    }
    btnMapa.addEventListener("click", () => {
      if (mapaMode) return setMapaMode(false); // segundo clique = cancelar
      if (!getSelected().length) {
        statusEl.textContent =
          "Para gerar o mapa mental, primeiro marque as peças que devem embasá-lo.";
        return;
      }
      if (minutaMode) setMinutaMode(false); // os dois modos são mutuamente exclusivos
      if (!inEl.value.trim() && !promptAtivo) {
        inEl.value = INSTRUCAO_MAPA_PADRAO;
        autoresize();
      }
      setMapaMode(true);
      inEl.focus();
    });
    mapabar
      .querySelector(".mapabar-x")
      .addEventListener("click", () => setMapaMode(false));

    // Selo do modelo ativo: clique abre a configuração da extensão (o
    // callback é o mesmo do CTA "configure sua chave").
    $(".modelo-badge").addEventListener("click", () => configureCb && configureCb());

    // -------------------------------------------------------------------------
    // Transcript da conversa (para exportar .md e copiar por mensagem).
    // Os placeholders de citação viram [n] no texto exportado.
    // -------------------------------------------------------------------------
    const transcript = []; // [{role, text, cites?}]
    const RE_CIT_PLACEHOLDER = new RegExp("\\uE000(\\d+)\\uE001", "g");
    function textoExportavel(t) {
      return String(t || "").replace(RE_CIT_PLACEHOLDER, "[$1]");
    }

    const dlBtn = $(".dl");
    dlBtn.addEventListener("click", () => {
      if (!transcript.length) return;
      const linhas = ["# Conversa — TecJustiça PJe", ""];
      for (const t of transcript) {
        linhas.push(t.role === "user" ? "## Usuário" : "## Assistente");
        linhas.push("");
        linhas.push(t.text || "");
        if (t.cites && t.cites.length) {
          linhas.push("");
          linhas.push("Fontes:");
          t.cites.forEach((c, i) =>
            linhas.push(
              i + 1 + ". " + c.label +
                // o id é o que permite reencontrar a peça na timeline do PJe
                (c.id ? " (id " + c.id + ")" : "") +
                (c.url ? " — " + c.url : "")
            )
          );
        }
        linhas.push("");
      }
      const blob = new Blob([linhas.join("\n")], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "conversa-pje-ia.md";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    });

    // Estrutura interna da bolha do assistant: raciocínio colapsável + corpo +
    // botão de copiar. Criada sob demanda (a bolha nasce com o indicador de
    // digitação e só ganha estrutura no primeiro delta/thinking).
    function estruturaAssistant(el) {
      if (el.__body) return el;
      el.classList.remove("typing");
      el.innerHTML =
        '<details class="think" hidden><summary>Raciocínio</summary><div class="think-t"></div></details>' +
        '<div class="body"></div>' +
        '<button class="copy" title="Copiar texto da resposta">' + SVG.copy + "</button>";
      el.__think = el.querySelector(".think");
      el.__thinkT = el.querySelector(".think-t");
      el.__body = el.querySelector(".body");
      el.querySelector(".copy").addEventListener("click", () => {
        const entry = el.__entry;
        const txt = textoExportavel(entry && entry.text);
        if (txt && navigator.clipboard) navigator.clipboard.writeText(txt).catch(() => {});
      });
      return el;
    }

    // auto-resize do textarea
    function autoresize() {
      inEl.style.height = "auto";
      inEl.style.height = Math.min(inEl.scrollHeight, 140) + "px";
    }

    // -------------------------------------------------------------------------
    // Seleção de peças: os checkboxes da lista lateral são a fonte de verdade.
    // Chips da barra de contexto, contador e popup @ são visões sincronizadas.
    // -------------------------------------------------------------------------
    function getSelected() {
      return [...doclist.querySelectorAll('input[type="checkbox"]:checked')].map(
        (c) => c.value
      );
    }
    function getSelectedDocs() {
      const ids = new Set(getSelected());
      return allDocs.filter((d) => ids.has(d.id));
    }
    function setDocChecked(id, on) {
      const c = doclist.querySelector('input[value="' + CSS.escape(id) + '"]');
      if (c) c.checked = on;
    }

    let prevChipIds = new Set(); // anima só chips recém-adicionados
    let selChangeCb = null; // content script re-estima o contexto ao mudar a seleção

    // Os TRÊS degraus de seleção, do mais enxuto ao mais amplo. Os conjuntos são
    // ENCAIXADOS (chave ⊂ principais ⊂ todas), que é o que faz os segmentos
    // acenderem em faixa e lerem como um termômetro de abrangência.
    //
    // O eixo aqui é `data-rel` (ver classificarPeca), não a classe de categoria:
    // categoria é cor, relevância é recorte. Enquanto "principais" significava
    // "tudo que não é cat-outro", ele marcava ~120 de 200 peças num processo
    // real — a regra de petição casa quase toda juntada das partes.
    const DEGRAUS = {
      ess: (r) => r.dataset.rel === "essencial",
      main: (r) => r.dataset.rel !== "neutro" && r.dataset.rel !== "ruido",
      all: () => true,
    };

    // Estado dos atalhos de seleção.
    //
    // Eles agem SÓ nas rows visíveis (respeitam a busca ativa), então o estado
    // deles também é relativo ao filtro atual. Enquanto o recálculo varria a
    // lista inteira, o checkbox se desmarcava sozinho no instante seguinte ao
    // clique sempre que havia filtro: as peças escondidas não estavam marcadas
    // e derrubavam o `every`.
    //
    // Separado de `syncSelection` porque `filtrarDocs` precisa recalculá-los
    // SEM disparar `selChangeCb`: digitar na busca não muda a seleção, e
    // avisar o content script a cada tecla o faria re-estimar o contexto à toa.
    function syncAtalhos() {
      const visiveis = rowsVisiveis();
      const todasMarcadas = (filtro) => {
        const rows = visiveis.filter(filtro);
        return (
          rows.length > 0 &&
          rows.every((r) => {
            const c = r.querySelector('input[type="checkbox"]');
            return c && c.checked;
          })
        );
      };
      chkEss.checked = todasMarcadas(DEGRAUS.ess);
      chkMain.checked = todasMarcadas(DEGRAUS.main);
      chkAll.checked = todasMarcadas(DEGRAUS.all);
    }

    function syncSelection() {
      const sel = getSelectedDocs();
      const total = allDocs.length;

      syncAtalhos();
      countEl.textContent = total
        ? sel.length
          ? `${sel.length}/${total} no contexto`
          : `${total} peça` + (total > 1 ? "s" : "")
        : "";
      countEl.classList.toggle("on", sel.length > 0);
      railNEl.textContent = total ? (sel.length ? `${sel.length}/${total}` : `${total}`) : "";

      if (selChangeCb) selChangeCb(sel.map((d) => d.id));

      // chips da barra de contexto
      ctxbar.innerHTML = "";
      if (!sel.length) {
        ctxbar.hidden = true;
        prevChipIds = new Set();
        return;
      }
      ctxbar.hidden = false;
      const lab = document.createElement("span");
      lab.className = "ctxlab";
      lab.textContent = "Peças no contexto (" + sel.length + ")";
      ctxbar.appendChild(lab);
      // bandeja própria para os chips: rolagem interna sem empurrar o rótulo
      const bandeja = document.createElement("div");
      bandeja.className = "chips";
      ctxbar.appendChild(bandeja);
      for (const d of sel) {
        const chip = document.createElement("span");
        chip.className =
          "chip " + categoriaDe(d) + (prevChipIds.has(d.id) ? "" : " new");
        chip.innerHTML =
          SVG.doc +
          '<span class="chip-t" title="' + escapeHtml(d.titulo) + '">' +
          escapeHtml(tituloCurto(d.titulo)) +
          '</span><button class="chip-x" title="Remover do contexto" aria-label="Remover ' +
          escapeHtml(tituloCurto(d.titulo)) + ' do contexto">' + SVG.x + "</button>";
        chip.querySelector(".chip-x").addEventListener("click", () => {
          setDocChecked(d.id, false);
          syncSelection();
        });
        bandeja.appendChild(chip);
      }
      prevChipIds = new Set(sel.map((d) => d.id));
    }

    // Nota dos atalhos: some sozinha no próximo gesto de seleção. Não usa o
    // `.status` (disputado — a estimativa de contexto escreve nele ~900 ms
    // depois e apaga a mensagem) nem a `.docs-tip` (que tem dono, com
    // auto-reset de 12 s).
    function setSelNota(txt) {
      selNota.textContent = txt || "";
      selNota.hidden = !txt;
    }

    // Aplica um degrau de seleção. Os três compartilham o mesmo contrato:
    // agem só nas rows VISÍVEIS (a busca ativa é respeitada) e são ADITIVOS —
    // marcar nunca desmarca o que o usuário escolheu à mão.
    function aplicarDegrau(chk, filtro, nome) {
      const alvo = rowsVisiveis().filter(filtro);
      // Modo de falha silencioso: numa lista sem nenhuma peça do degrau (comum
      // em "chave" antes de a grid ser lida), o clique não faria absolutamente
      // nada e o checkbox voltaria sozinho — indistinguível de um botão
      // quebrado. Dizer o motivo é o mínimo.
      if (!alvo.length) {
        chk.checked = false;
        setSelNota(
          temTipoOficial
            ? "Nenhuma peça desta lista foi reconhecida como “" + nome + "”."
            : "Nenhuma peça reconhecida como “" + nome + "” — a lista ainda não " +
              "tem o tipo oficial de cada peça. Clique em “Carregar tudo” para " +
              "melhorar a classificação."
        );
        return;
      }
      for (const r of alvo) {
        const c = r.querySelector('input[type="checkbox"]');
        if (c) c.checked = chk.checked;
      }
      // Sem o tipo oficial a classificação sai só do título (que costuma ser o
      // nome do arquivo), então "chave" seleciona de menos — em silêncio, que é
      // o pior jeito: o usuário pede o essencial, recebe 3 de 12 e a análise
      // sai sobre autos incompletos sem ninguém perceber.
      setSelNota(
        chk.checked && !temTipoOficial && nome === "chave"
          ? alvo.length + " marcadas só pelo título — “Carregar tudo” melhora a escolha."
          : ""
      );
      syncSelection();
    }

    chkEss.addEventListener("change", () =>
      aplicarDegrau(chkEss, DEGRAUS.ess, "chave")
    );
    chkMain.addEventListener("change", () =>
      aplicarDegrau(chkMain, DEGRAUS.main, "principais")
    );
    chkAll.addEventListener("change", () =>
      aplicarDegrau(chkAll, DEGRAUS.all, "todas")
    );
    // eventos change dos checkboxes individuais borbulham até a lista
    doclist.addEventListener("change", () => {
      setSelNota(""); // a nota fala do último clique em atalho; este é outro gesto
      syncSelection();
    });

    // -------------------------------------------------------------------------
    // SELEÇÃO EM FAIXA — marcar 40 petições em sequência não pode custar 40
    // cliques.
    //
    // Três gestos, todos operando sobre os MESMOS checkboxes (a fonte de verdade
    // de toda a extensão; chips, contador, popup @ e envio são projeções dela):
    //
    //   · arrastar          — marca/desmarca a faixa por onde o ponteiro passa;
    //   · Shift+clique      — do último item tocado até este (padrão universal:
    //                         Explorer, Gmail, GitHub — ninguém precisa aprender);
    //   · botão direito     — menu com "daqui para baixo/cima", que é o que
    //                         resolve quando o outro extremo está fora da tela.
    //
    // Todos respeitam o FILTRO ativo: operam só nas rows visíveis, igual ao
    // "todas" e ao "principais".
    // -------------------------------------------------------------------------
    let ancoraSel = -1; // índice da última row alternada (âncora do Shift)
    let arrastando = false;
    let arrastoValor = true; // marcando ou desmarcando
    let origemMarcada = false; // a row onde o arrasto começou já foi aplicada?

    function rowsVisiveis() {
      return [...doclist.querySelectorAll(".docrow")].filter((r) => !r.hidden);
    }
    function idxDaRow(row) {
      return rowsVisiveis().indexOf(row);
    }
    function aplicarFaixa(de, ate, valor) {
      const rows = rowsVisiveis();
      const a = Math.min(de, ate);
      const b = Math.max(de, ate);
      for (let i = a; i <= b; i++) {
        const inp = rows[i] && rows[i].querySelector("input");
        if (inp) inp.checked = valor;
      }
      syncSelection();
    }

    doclist.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      if (e.target.closest("button")) return; // o .d-ver tem dono próprio
      const row = e.target.closest(".docrow");
      if (!row) return;
      const i = idxDaRow(row);
      if (i < 0) return;
      const inp = row.querySelector("input");
      if (!inp) return;

      if (e.shiftKey && ancoraSel >= 0) {
        // Shift+clique: o label alternaria só esta row — preciso do intervalo.
        e.preventDefault();
        aplicarFaixa(ancoraSel, i, !inp.checked || ancoraSel !== i);
        return;
      }
      // Início de arrasto: o valor alvo é o OPOSTO do estado atual, e ele se
      // propaga para todas as rows que o ponteiro cruzar. O clique normal segue
      // funcionando pelo <label> — não damos preventDefault aqui (ele impediria
      // o label de alternar a row de origem).
      arrastando = true;
      arrastoValor = !inp.checked;
      ancoraSel = i;
      origemMarcada = false; // só vira true se o gesto virar arrasto de fato
      // Sem isto o gesto seleciona os IDS como texto (a exceção
      // `.d-id{user-select:text}` vive dentro da row) e não marca nada: a lista
      // fica azul nos números e o arrasto morre. Como não damos preventDefault,
      // suspender via classe é o único caminho — e só durante o gesto, para o
      // id continuar copiável quando parado.
      doclist.classList.add("arrastando");
    });

    doclist.addEventListener("pointerover", (e) => {
      if (!arrastando) return;
      const row = e.target.closest(".docrow");
      if (!row) return;
      const inp = row.querySelector("input");
      if (!inp) return;
      const i = idxDaRow(row);
      // A row de ORIGEM é alternada pelo <label> — mas só quando o gesto vira um
      // CLIQUE. Num arrasto o clique não se completa, então ela ficava de fora:
      // arrastar da peça 1 até a 5 marcava 2,3,4,5 e deixava justamente aquela
      // onde o dedo começou. Ao cruzar a primeira row diferente, o gesto está
      // confirmado como arrasto — é a hora de marcar a origem também.
      if (i !== ancoraSel && !origemMarcada) {
        origemMarcada = true;
        const rowOrigem = doclist.querySelectorAll(".docrow")[ancoraSel];
        const inpOrigem = rowOrigem && rowOrigem.querySelector("input");
        if (inpOrigem && inpOrigem.checked !== arrastoValor) inpOrigem.checked = arrastoValor;
      }
      if (inp.checked !== arrastoValor && i !== ancoraSel) {
        inp.checked = arrastoValor;
        syncSelection();
      } else if (origemMarcada) syncSelection();
    });

    // No documento, não na lista: o ponteiro solta com frequência fora dela.
    // `fimArrastoLista`, não `fimArrasto`: este nome já pertence ao arrasto da
    // JANELA no modo livre (mount, bem acima). São dois gestos diferentes.
    function fimArrastoLista() {
      if (!arrastando) return;
      arrastando = false;
      doclist.classList.remove("arrastando");
      // Se algo escapou e virou seleção (o pointerdown pode cair num nó já
      // selecionável antes de a classe valer), limpa: deixar os ids pintados
      // de azul depois do gesto faz parecer que o arrasto falhou mesmo quando
      // marcou tudo certo.
      const sel = root.getSelection ? root.getSelection() : window.getSelection();
      if (sel && !sel.isCollapsed) sel.removeAllRanges();
    }
    document.addEventListener("pointerup", fimArrastoLista);
    document.addEventListener("pointercancel", fimArrastoLista);

    // --- menu "daqui para baixo / daqui para cima" ----------------------------
    let menuSel = null;
    function fecharMenuSel() {
      if (menuSel) menuSel.remove();
      menuSel = null;
    }
    doclist.addEventListener("contextmenu", (e) => {
      const row = e.target.closest(".docrow");
      if (!row) return;
      const i = idxDaRow(row);
      if (i < 0) return;
      e.preventDefault();
      fecharMenuSel();
      const total = rowsVisiveis().length;
      const menu = document.createElement("div");
      menu.className = "selmenu";
      menu.setAttribute("role", "menu");
      const opcoes = [
        ["Marcar daqui para baixo", () => aplicarFaixa(i, total - 1, true)],
        ["Marcar daqui para cima", () => aplicarFaixa(0, i, true)],
        ["Desmarcar daqui para baixo", () => aplicarFaixa(i, total - 1, false)],
        ["Desmarcar daqui para cima", () => aplicarFaixa(0, i, false)],
        ["Marcar só esta", () => {
          aplicarFaixa(0, total - 1, false);
          aplicarFaixa(i, i, true);
        }],
      ];
      opcoes.forEach(function (o, n) {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = o[0];
        if (n === 2) b.className = "sep";
        b.addEventListener("click", () => {
          fecharMenuSel();
          o[1]();
          ancoraSel = i;
        });
        menu.appendChild(b);
      });
      wrap.appendChild(menu);
      menuSel = menu;
      // Coordenadas de VIEWPORT (o .selmenu é position:fixed): o .wrap tem
      // tamanho zero e clampar por dentro dele mandaria o menu para o canto.
      const r = row.getBoundingClientRect();
      menu.style.left = Math.max(6, Math.min(e.clientX, window.innerWidth - 214)) + "px";
      menu.style.top = Math.max(6, Math.min(r.bottom + 2, window.innerHeight - 172)) + "px";
    });
    // Fecha em qualquer clique fora, Esc e ao re-renderizar a lista.
    wrap.addEventListener("pointerdown", (e) => {
      if (menuSel && !e.target.closest(".selmenu")) fecharMenuSel();
    });

    // -------------------------------------------------------------------------
    // "Carregar todas as peças": a timeline do PJe carrega sob demanda; o
    // botão pede ao content script para rolá-la até o fim pelo usuário. O
    // estado visual (texto da dica + botão travado) é controlado por
    // setTimelineTip — o content script é quem sabe o progresso real.
    // -------------------------------------------------------------------------
    let carregarTLCb = null;
    tipLoad.addEventListener("click", () => carregarTLCb && carregarTLCb());

    // -------------------------------------------------------------------------
    // "Baixar .zip": exporta as peças MARCADAS — ou todas as da lista, quando
    // nenhuma está marcada. A regra segue a mesma fonte de verdade de todo o
    // resto (os checkboxes); o fallback para "todas" existe porque exportar os
    // autos inteiros é o caso comum, e obrigar a marcar 300 peças antes seria
    // um pedágio sem propósito. Qual dos dois aconteceu vai dito no card de
    // progresso — a ação não pode ser ambígua.
    // -------------------------------------------------------------------------
    let zipCb = null;
    tipZip.addEventListener("click", () => {
      if (!zipCb || tipZip.disabled) return;
      const marcadas = getSelectedDocs();
      const alvo = marcadas.length ? marcadas : allDocs;
      if (!alvo.length) {
        statusEl.textContent = "A lista de peças está vazia — não há o que exportar.";
        return;
      }
      zipCb(alvo, { todas: !marcadas.length });
    });
    // Trava o botão enquanto a exportação corre (o download do PJe é
    // serializado: dois lotes ao mesmo tempo brigariam pela sessão JSF).
    function setZipOcupado(on) {
      tipZip.disabled = !!on;
      // rotulo(), nunca textContent: o botão é <svg> + <span class="lbl">, e
      // escrever no botão inteiro apagaria o ícone no primeiro clique. Era o
      // que acontecia aqui — e ainda com um rótulo ("⬇ Documentos") que nem
      // batia com o do template ("Baixar .zip").
      rotulo(tipZip, on ? "Baixando…" : "Baixar .zip");
    }

    // -------------------------------------------------------------------------
    // ESCOLHER COM IA — camada 2 da seleção.
    //
    // A camada 1 (classificarPeca, por regex) responde em 0 ms, sem chave e sem
    // custo, e é o padrão. O que ela não tem é CONTEXTO: num processo com sete
    // peças chamadas só "Petição", ela não sabe qual é a inicial; um título
    // "Documento 3" não classifica nada.
    //
    // Aqui a lista inteira — id, título, tipo e data, NENHUM conteúdo de peça —
    // vai à IA, que devolve os ids relevantes. É sob demanda de propósito: nada
    // acontece sem o usuário pedir, então não há custo surpresa nem espera não
    // solicitada, e o resultado é sempre atribuível a uma ação dele.
    //
    // A pergunta que estiver no campo vira o OBJETIVO da escolha ("houve
    // prescrição?" traz peças diferentes de "qual o valor da causa?"). Vazio, o
    // objetivo é entender o processo. O texto não é consumido — continua no
    // campo para o usuário enviar em seguida, agora com as peças certas.
    // -------------------------------------------------------------------------
    let iaCb = null;
    tipIa.addEventListener("click", () => {
      if (!iaCb || tipIa.disabled) return;
      if (!allDocs.length) {
        statusEl.textContent = "A lista de peças está vazia.";
        return;
      }
      setSelNota("");
      iaCb(allDocs, inEl.value.trim());
    });
    function setIaOcupado(on) {
      tipIa.disabled = !!on;
      rotulo(tipIa, on ? "Escolhendo…" : "Escolher com IA");
    }
    // Aplica a escolha da IA: marca os ids, DESMARCANDO o resto — aqui a
    // substituição é o contrato certo (ao contrário dos degraus, que somam):
    // o usuário pediu uma escolha, e uma escolha que só acrescenta ao que já
    // estava marcado não é uma escolha. `motivos` alimenta o title de cada row,
    // para o critério ficar auditável peça a peça.
    function aplicarEscolhaIA(ids, motivos) {
      const set = new Set(ids || []);
      for (const r of doclist.querySelectorAll(".docrow")) {
        const c = r.querySelector('input[type="checkbox"]');
        if (!c) continue;
        c.checked = set.has(c.value);
        const m = motivos && motivos[c.value];
        const t = r.querySelector(".d-t");
        if (t) {
          const base = t.dataset.tituloOriginal || t.getAttribute("title") || "";
          if (!t.dataset.tituloOriginal) t.dataset.tituloOriginal = base;
          t.setAttribute("title", m ? base + "\n\n" + m : base);
        }
      }
      syncSelection();
    }
    // Em repouso o aviso é só o ícone ⚠️ (o texto vive no title dele) — ocupava
    // duas linhas fixas da coluna. Com PROGRESSO ou carregando, o texto volta a
    // ser visível: é feedback de uma ação em curso, não um aviso de fundo.
    // A mensagem FINAL ("linha do tempo completa: 38 peças") tem prazo: sem ele
    // o content.js a deixa fixa pelo resto da sessão (o último setTimelineTip
    // vem com carregando:false e nunca mais é chamado), devolvendo à coluna as
    // duas linhas que esta rodada tirou.
    // O aviso padrão fica SEMPRE no .tip-txt (escondido por CSS em repouso): é
    // ele que o hover/foco no ⚠️ revela. Só o progresso o substitui.
    let tipTimer = null;
    function repousoTip() {
      tipTxt.textContent = TIP_PADRAO;
      tipBox.classList.remove("carregando");
    }
    function setTimelineTip(estado) {
      const { texto = null, carregando = false } = estado || {};
      clearTimeout(tipTimer);
      tipLoad.disabled = carregando;
      // rotulo(), nunca textContent: o botão é <svg> + <span class="lbl"> e
      // escrever no botão inteiro apagaria o ícone na primeira carga.
      rotulo(tipLoad, carregando ? "Carregando…" : "Carregar tudo");
      if (!texto && !carregando) return repousoTip();
      tipTxt.textContent = texto || TIP_PADRAO;
      tipBox.classList.add("carregando");
      if (!carregando) tipTimer = setTimeout(repousoTip, 12000);
    }
    repousoTip();

    // -------------------------------------------------------------------------
    // "Ver na timeline": botão por peça (delegado — as rows são recriadas a
    // cada setDocs). O content script rola a página do PJe até o documento.
    // -------------------------------------------------------------------------
    let verTimelineCb = null;
    // Compartilhado pelo botão da lista de peças e pelas citações do chat.
    function irParaPeca(id) {
      if (!id || !verTimelineCb) return;
      hidePreview();
      // No modal (expandido/cheia) a página fica coberta: troca para o modo
      // lateral antes de rolar, para o usuário VER o documento destacado.
      if (wrap.classList.contains("expanded")) aplicarModo("lateral");
      // setTimeout (não rAF: o Chrome suprime rAF em janela ocluída) — dá
      // tempo do layout assentar antes de o content script rolar a página.
      setTimeout(() => verTimelineCb(id), 50);
    }
    doclist.addEventListener("click", (e) => {
      const btn = e.target.closest(".d-ver");
      if (!btn) return;
      // A row é um <label>: sem o preventDefault o clique alternaria o
      // checkbox (fonte de verdade da seleção) e dispararia o change delegado.
      e.preventDefault();
      e.stopPropagation();
      const row = btn.closest(".docrow");
      if (!row) return;
      irParaPeca(row.dataset.id);
    });
    // Citação do rodapé de uma resposta → mesma navegação. Handler DELEGADO no
    // container: as bolhas são re-renderizadas a cada delta do stream, então um
    // listener por linha morreria no primeiro token seguinte.
    msgs.addEventListener("click", (e) => {
      const btn = e.target.closest(".cite-go");
      if (btn) irParaPeca(btn.dataset.id);
    });

    // -------------------------------------------------------------------------
    // Preview de peça no hover (só nos modos expandido/cheia e lateral, onde
    // há espaço). O conteúdo vem SEMPRE do cache do content script (callback
    // síncrono) — o hover NUNCA baixa nada: o download do PJe é serializado
    // na sessão JSF e levaria segundos, travando a extensão. Cache-miss
    // mostra aviso + botão "Baixar" (gesto explícito). Um único popover e no
    // máximo UM blob URL vivos por vez; revogação a cada fechamento.
    // -------------------------------------------------------------------------
    const previewEl = document.createElement("div");
    previewEl.className = "preview";
    previewEl.hidden = true;
    wrap.appendChild(previewEl);

    let previewCb = null; // (id) -> {kind:"pdf"|"text", ...} | null (síncrono)
    let previewDlCb = null; // (id) -> Promise<info> — só no clique em "Baixar"
    let previewId = null; // peça exibida no momento
    let previewUrl = null; // blob URL vivo (no máximo um)
    let previewTimer = null; // debounce de intenção do hover
    let previewHideTimer = null; // fechamento tolerante (mouse indo ao popover)
    let previewCspBloqueado = false; // página barrou embed de blob: PDF (CSP)
    // Download via botão "Baixar" em andamento: a ativação JSF do PJe mexe na
    // timeline → MutationObserver → setDocs, que fecharia o popover no meio.
    // A flag suprime SÓ esse fechamento automático (Esc/scroll seguem valendo).
    let previewDlPendente = false;
    const PREVIEW_HOVER_MS = 400;
    const PREVIEW_MAX_HOVER_B = 15 * 1024 * 1024; // atob de b64 maior travaria a UI

    function limparPreviewUrl() {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
        previewUrl = null;
      }
    }
    function hidePreview() {
      clearTimeout(previewTimer);
      clearTimeout(previewHideTimer);
      previewId = null;
      if (!previewEl.hidden) {
        previewEl.hidden = true;
        previewEl.innerHTML = ""; // solta o <embed> (o viewer de PDF retém memória)
      }
      limparPreviewUrl();
    }
    function b64ParaBlobUrl(b64) {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    }
    function fmtBytes(n) {
      if (!n) return "? KB";
      return n >= 1048576
        ? (n / 1048576).toFixed(1).replace(".", ",") + " MB"
        : Math.max(1, Math.round(n / 1024)) + " KB";
    }

    function renderPreview(row, info) {
      const id = row.dataset.id;
      const d = allDocs.find((x) => x.id === id);
      limparPreviewUrl();
      previewEl.innerHTML = "";
      previewEl.classList.remove("compact");
      // Conteúdo compacto (texto/aviso) dispensa altura manual do resize —
      // herdar a altura de um PDF redimensionado deixaria área em branco.
      const modoCompact = () => {
        previewEl.classList.add("compact");
        previewEl.style.height = "";
      };

      const hd = document.createElement("div");
      hd.className = "preview-hd " + (d ? categoriaDe(d) : "cat-outro");
      hd.innerHTML =
        '<span class="d-dot"></span><span class="t" title="' +
        escapeHtml(d ? d.titulo : id) + '">' +
        escapeHtml(d ? tituloCurto(d.titulo) : id) + "</span>";
      previewEl.appendChild(hd);

      const bd = document.createElement("div");
      bd.className = "preview-bd";
      previewEl.appendChild(bd);

      if (!info) {
        // cache-miss: nada de download automático — só sob gesto explícito
        modoCompact();
        const box = document.createElement("div");
        box.className = "preview-miss";
        box.innerHTML =
          "<span>Peça ainda não carregada nesta conversa.</span>" +
          '<button type="button" class="preview-dl">Abrir documento</button>';
        const btn = box.querySelector(".preview-dl");
        const soAviso = (t) => (box.innerHTML = "<span>" + escapeHtml(t) + "</span>");
        btn.addEventListener("click", async () => {
          if (!previewDlCb) return;
          btn.disabled = true;
          btn.textContent = "Abrindo…";
          previewDlPendente = true;
          try {
            const baixado = await previewDlCb(id);
            // re-renderiza só se o popover ainda mostra ESTA peça
            if (previewId !== id) return;
            if (baixado) {
              renderPreview(row, baixado);
              // o conteúdo pode ter crescido (aviso → PDF): reposiciona na
              // row ATUAL (o setDocs pode ter recriado a lista nesse meio-tempo)
              const anc = doclist.querySelector(
                '.docrow[data-id="' + CSS.escape(id) + '"]'
              );
              if (anc) posicionarPreview(anc);
            } else soAviso("Não foi possível abrir a peça.");
          } catch (err) {
            if (previewId === id)
              soAviso("Falha ao abrir: " + String((err && err.message) || err));
          } finally {
            previewDlPendente = false;
          }
        });
        bd.appendChild(box);
        return;
      }

      if (info.kind === "text") {
        modoCompact();
        const t = document.createElement("div");
        t.className = "preview-txt";
        t.textContent = info.text; // NUNCA innerHTML — conteúdo dos autos
        bd.appendChild(t);
        return;
      }

      // Anexo em imagem. Vai por `data:` URI e não por `blob:` de propósito: a
      // CSP hostil de alguns tribunais barra `blob:` em embed (é o motivo do
      // fallback do PDF logo abaixo), e `img-src data:` passa onde `blob:` não
      // passa. A imagem já vem reduzida a 1568px pelo pje.js, então o custo de
      // memória do data URI é pequeno.
      if (info.kind === "img") {
        const im = document.createElement("img");
        im.className = "preview-img";
        im.alt = "Imagem da peça";
        im.src = "data:" + (info.mime || "image/jpeg") + ";base64," + info.b64;
        bd.appendChild(im);
        return;
      }

      // PDF em cache. A guarda do `!info.b64` é defensiva: hoje toda entrada de
      // PDF no cache vem de `PJE.baixar` com os bytes, mas sem ela um b64 vazio
      // faria o `atob` do preview lançar e derrubar o popover no hover.
      const pesado = (info.size || 0) > PREVIEW_MAX_HOVER_B;
      if (!info.b64) {
        modoCompact();
        const box = document.createElement("div");
        box.className = "preview-miss";
        box.innerHTML =
          "<span>O conteúdo desta peça não está carregado nesta conversa.</span>" +
          '<button type="button" class="preview-dl">Abrir documento</button>';
        const btn = box.querySelector(".preview-dl");
        btn.addEventListener("click", async () => {
          if (!previewDlCb) return;
          btn.disabled = true;
          btn.textContent = "Abrindo…";
          previewDlPendente = true;
          try {
            const baixado = await previewDlCb(id);
            if (previewId !== id) return;
            if (baixado) {
              renderPreview(row, baixado);
              const anc = doclist.querySelector('.docrow[data-id="' + CSS.escape(id) + '"]');
              if (anc) posicionarPreview(anc);
            }
          } catch (err) {
            if (previewId === id) box.textContent = "Falha ao abrir: " + ((err && err.message) || err);
          } finally {
            previewDlPendente = false;
          }
        });
        bd.appendChild(box);
        return;
      }
      if (previewCspBloqueado || pesado) {
        modoCompact();
        const box = document.createElement("div");
        box.className = "preview-miss";
        box.textContent = pesado
          ? "PDF grande — use “Abrir em nova aba” para visualizar."
          : "A pré-visualização embutida foi bloqueada pela política de segurança desta página.";
        bd.appendChild(box);
      } else {
        previewUrl = b64ParaBlobUrl(info.b64);
        const em = document.createElement("embed");
        em.type = "application/pdf";
        // COM a toolbar nativa do Chrome: zoom −/+, ajustar à página e
        // navegação de graça (Ctrl+scroll também faz zoom dentro do viewer).
        em.src = previewUrl;
        bd.appendChild(em);
      }
      const ft = document.createElement("div");
      ft.className = "preview-ft";
      ft.innerHTML =
        "<span>" + (info.pages || 1) + " página(s) · " + fmtBytes(info.size) + "</span>" +
        '<button type="button" class="preview-tab">Abrir em nova aba</button>';
      ft.querySelector(".preview-tab").addEventListener("click", () => {
        // posse do URL vai para a nova aba; revoga com folga para ela carregar
        const u = b64ParaBlobUrl(info.b64);
        window.open(u, "_blank");
        setTimeout(() => URL.revokeObjectURL(u), 30000);
      });
      previewEl.appendChild(ft);
    }

    // Abre à direita da row quando cabe (expandido: docs é a coluna esquerda);
    // senão à esquerda (lateral: painel colado à borda direita da janela).
    function posicionarPreview(row) {
      const r = row.getBoundingClientRect();
      // largura REAL quando o usuário já redimensionou o popover (persiste na
      // sessão); oculto (display:none) o offsetWidth é 0 e cai no estimado
      const W = previewEl.offsetWidth || Math.min(520, window.innerWidth * 0.46);
      const cabeDireita = window.innerWidth - r.right >= W + 24;
      previewEl.style.left = cabeDireita
        ? Math.round(r.right + 12) + "px"
        : Math.round(Math.max(8, r.left - W - 12)) + "px";
      const H = previewEl.offsetHeight || Math.min(640, window.innerHeight * 0.82);
      previewEl.style.top =
        Math.round(
          Math.min(Math.max(8, r.top - 40), Math.max(8, window.innerHeight - H - 8))
        ) + "px";
    }

    function showPreview(row) {
      if (!previewCb || !row.isConnected) return;
      previewId = row.dataset.id;
      renderPreview(row, previewCb(previewId));
      posicionarPreview(row); // 1º passe: posição estimada, ainda oculto
      previewEl.hidden = false;
      posicionarPreview(row); // 2º passe: ajusta com a altura real (.compact)
    }

    // Botão do mouse pressionado dentro do popover = usuário redimensionando
    // pela alça nativa (o ponteiro pode escapar do popover no meio do arrasto —
    // fechar aqui sumiria com ele na mão do usuário).
    let previewInteragindo = false;
    previewEl.addEventListener("pointerdown", () => {
      previewInteragindo = true;
    });
    window.addEventListener("pointerup", () => {
      previewInteragindo = false;
    });
    function agendarFecharPreview() {
      clearTimeout(previewHideTimer);
      previewHideTimer = setTimeout(() => {
        if (previewInteragindo) return agendarFecharPreview(); // resize em curso
        if (!previewEl.matches(":hover") && !doclist.matches(":hover")) hidePreview();
      }, 250);
    }

    // mouseover/mouseout borbulham (mouseenter não) — delegação nas rows
    doclist.addEventListener("mouseover", (e) => {
      if (
        !wrap.classList.contains("expanded") &&
        !wrap.classList.contains("lateral") &&
        !wrap.classList.contains("livre")
      )
        return;
      const row = e.target.closest(".docrow");
      if (!row || !previewCb) return;
      clearTimeout(previewHideTimer);
      if (row.dataset.id === previewId && !previewEl.hidden) return;
      clearTimeout(previewTimer);
      previewTimer = setTimeout(() => showPreview(row), PREVIEW_HOVER_MS);
    });
    doclist.addEventListener("mouseout", (e) => {
      const row = e.target.closest(".docrow");
      if (row && !(e.relatedTarget && row.contains(e.relatedTarget)))
        clearTimeout(previewTimer);
      agendarFecharPreview();
    });
    previewEl.addEventListener("mouseenter", () => clearTimeout(previewHideTimer));
    previewEl.addEventListener("mouseleave", agendarFecharPreview);
    // rolar a lista invalida a âncora do popover
    doclist.addEventListener("scroll", hidePreview, { passive: true });
    // Esc fecha só o preview (stopPropagation: não derruba o modo docx junto)
    root.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !previewEl.hidden) {
        hidePreview();
        e.stopPropagation();
      }
    });
    // CSP da página pode barrar <embed> de blob: PDF — detecção real pelo
    // evento de violação (dispara no document dono, mesmo com Shadow DOM).
    document.addEventListener("securitypolicyviolation", (e) => {
      if (
        String(e.blockedURI || "").startsWith("blob") &&
        /object-src|frame-src|default-src|plugin/.test(String(e.violatedDirective || ""))
      ) {
        previewCspBloqueado = true;
        if (previewId && !previewEl.hidden) {
          const row = doclist.querySelector(
            '.docrow[data-id="' + CSS.escape(previewId) + '"]'
          );
          const info = previewCb && previewCb(previewId);
          if (row && info && info.kind === "pdf") renderPreview(row, info);
        }
      }
    });

    // -------------------------------------------------------------------------
    // Busca de peças: filtra a lista pelo título (sem acentos, via norm()).
    // Só esconde/mostra linhas — os checkboxes continuam sendo a fonte de
    // verdade da seleção (peça marcada e filtrada segue marcada).
    // -------------------------------------------------------------------------
    function filtrarDocs() {
      // O filtro muda QUAIS rows são visíveis, e as faixas operam sobre elas:
      // a âncora antiga apontaria para outra peça.
      ancoraSel = -1;
      fecharMenuSel();
      // rows podem sumir/mudar de lugar sob o popover (exceto durante o
      // download do próprio preview — o refresh da timeline passa por aqui)
      if (!previewDlPendente) hidePreview();
      const q = norm(docQ.value.trim());
      let visiveis = 0;
      for (const row of doclist.querySelectorAll(".docrow")) {
        const hit = !q || (row.dataset.busca || "").includes(q);
        row.hidden = !hit;
        if (hit) visiveis++;
      }
      const aviso = doclist.querySelector(".doc-noresult");
      if (aviso) aviso.remove();
      if (q && !visiveis && allDocs.length) {
        const d = document.createElement("div");
        d.className = "empty doc-noresult";
        d.textContent = "Nenhuma peça com esse nome.";
        doclist.appendChild(d);
      }
      docQN.hidden = !q;
      docQN.textContent = q ? visiveis + "/" + allDocs.length : "";
      // O conjunto visível mudou, e é sobre ele que os atalhos agem: sem isto
      // "principais"/"todas" ficavam com o estado da lista anterior ao filtro.
      syncAtalhos();
    }
    docQ.addEventListener("input", filtrarDocs);
    docQ.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        docQ.value = "";
        filtrarDocs();
      }
    });

    // -------------------------------------------------------------------------
    // Menção @: digitar "@" abre um popup com as peças; selecionar marca a peça
    // (mesmo estado da lista lateral) e remove o token "@busca" do texto.
    // -------------------------------------------------------------------------
    let mention = null; // {start, end, items:[{id,titulo}], idx}

    function findMentionToken() {
      const pos = inEl.selectionStart;
      const before = inEl.value.slice(0, pos);
      // "@" no início ou após espaço/pontuação de abertura; busca pode ter espaços
      const m = before.match(/(^|[\s([{])@([^@\n]*)$/);
      if (!m) return null;
      return { start: pos - m[2].length - 1, end: pos, query: m[2] };
    }

    function closeMention() {
      mention = null;
      mentionEl.hidden = true;
    }

    const MENTION_MAX = 50; // itens visíveis no popup; o excedente vira aviso

    function updateMention() {
      const tok = findMentionToken();
      if (!tok || !allDocs.length) return closeMention();
      const q = norm(tok.query.trim());
      const all = allDocs.filter((d) => !q || textoBusca(d).includes(q));
      // Busca sem resultado NÃO fecha o popup na hora (o campo de busca
      // sumir no meio da digitação parecia travamento) — mostra o estado
      // vazio. MAS: se a query sem resultado passa de 20 chars, o usuário
      // está escrevendo a frase (um "@" que não é peça), não buscando —
      // aí sim o popup fecha e para de re-renderizar a cada tecla.
      if (!all.length && tok.query.trim().length > 20) return closeMention();
      const items = all.slice(0, MENTION_MAX);
      const prevId =
        mention && mention.items[mention.idx] ? mention.items[mention.idx].id : null;
      const keepIdx = items.findIndex((d) => d.id === prevId);
      mention = {
        start: tok.start,
        end: tok.end,
        items,
        extra: all.length - items.length,
        idx: keepIdx >= 0 ? keepIdx : 0,
        query: tok.query, // CRU (sem trim): o espelho mostra até o espaço final
        total: all.length,
      };
      renderMention();
    }

    function renderMention() {
      const ids = new Set(getSelected());
      // campo de busca visível: espelha o que o usuário digita depois do @
      // (a digitação continua no campo de mensagem — aqui é só o reflexo,
      // com contador de resultados; a mecânica de filtro é a mesma de sempre)
      mentionQT.classList.toggle("vazio", !mention.query);
      mentionQT.textContent =
        mention.query || "digite para buscar pelo nome da peça…";
      // cursor de verdade fica SÓLIDO enquanto se digita e pisca parado:
      // reinicia a animação a cada render (o keyframe começa na fase visível)
      mentionQC.style.animation = "none";
      void mentionQC.offsetWidth; // força o reflow que zera a animação
      mentionQC.style.animation = "";
      mentionQN.textContent =
        mention.total === 0
          ? "nenhuma peça"
          : mention.total === 1
            ? "1 peça"
            : mention.total + " peças";
      mentionList.innerHTML = "";
      if (!mention.items.length) {
        const vazio = document.createElement("div");
        vazio.className = "mrow-more";
        vazio.textContent =
          "Nenhuma peça com esse nome — apague para ver todas (esc fecha).";
        mentionList.appendChild(vazio);
        mentionEl.hidden = false;
        return;
      }
      mention.items.forEach((d, i) => {
        const row = document.createElement("div");
        row.setAttribute("role", "option");
        row.setAttribute("aria-selected", i === mention.idx ? "true" : "false");
        row.className =
          "mrow " + categoriaDe(d) +
          (i === mention.idx ? " active" : "") + (ids.has(d.id) ? " on" : "");
        row.innerHTML =
          SVG.doc +
          '<span class="t" title="' + escapeHtml(d.titulo) + '">' +
          escapeHtml(d.titulo) +
          "</span>" +
          (ids.has(d.id)
            ? '<span class="on-badge">' + SVG.check + " no contexto</span>"
            : "");
        // mousedown (não click) para agir antes do blur do textarea
        row.addEventListener("mousedown", (e) => {
          e.preventDefault();
          pickMention(i);
        });
        row.addEventListener("mouseenter", () => {
          if (mention && mention.idx !== i) {
            mention.idx = i;
            renderMention();
          }
        });
        mentionList.appendChild(row);
      });
      if (mention.extra > 0) {
        const more = document.createElement("div");
        more.className = "mrow-more";
        more.textContent =
          "… e mais " + mention.extra + " peças — continue digitando para filtrar";
        mentionList.appendChild(more);
      }
      mentionEl.hidden = false;
      const act = mentionList.querySelector(".mrow.active");
      if (act) act.scrollIntoView({ block: "nearest" });
    }

    function pickMention(i) {
      if (!mention || !mention.items[i]) return;
      const d = mention.items[i];
      const already = new Set(getSelected()).has(d.id);
      // remove o token "@busca" do texto
      const v = inEl.value;
      inEl.value = v.slice(0, mention.start) + v.slice(mention.end);
      const caret = mention.start;
      setDocChecked(d.id, !already); // alterna: marcado sai, desmarcado entra
      syncSelection();
      closeMention();
      autoresize();
      inEl.focus();
      inEl.setSelectionRange(caret, caret);
    }

    // -------------------------------------------------------------------------
    // Biblioteca de prompts: "/" no INÍCIO da mensagem abre o popup com os
    // prompts salvos (PLIB, storage.sync); selecionar remove o token e liga o
    // CHIP na .promptbar — o texto do prompt precede a mensagem só no envio,
    // nunca é despejado no textarea. Gerenciador (CRUD) no modal .plib.
    // -------------------------------------------------------------------------
    const slashEl = $(".slash");
    const slashList = $(".slash-list");
    const slashQT = $(".slash .mq-t");
    const slashQN = $(".slash .mq-n");
    const slashQC = $(".slash .mq-caret");
    const promptbar = $(".promptbar");
    const inrowEl = $(".inrow");
    const btnPlib = $(".btn-plib");
    const plibEl = $(".plib");
    const plibCard = $(".plib-card");
    const plibListEl = $(".plib-list");
    const plibForm = $(".plib-form");
    const plibFT = $(".plib-ft");
    const plibFX = $(".plib-fx");
    const plibCnt = $(".plib-cnt");
    const plibErr = $(".plib-err");

    let promptsLib = []; // espelho ordenado de PLIB.listar
    let slash = null; // {start, end, items, idx, query, total, extra}
    let promptAtivo = null; // {id, titulo, texto} — no máximo UM por mensagem
    let plibEditId = null; // id em edição no form (null = novo)
    let plibIdNovo = ""; // id sorteado para o prompt novo em edição
    let plibDelArm = null; // id com exclusão "armada" (2º clique confirma)

    // PLIB é content script carregado antes deste — mas o harness de teste
    // pode não incluí-lo: sem ele a feature some em silêncio, nada quebra.
    const temPlib = typeof PLIB !== "undefined";
    if (temPlib) {
      PLIB.listar((ps) => {
        promptsLib = ps;
      });
      // mudanças em qualquer aba (ou vindas do sync de outra máquina)
      PLIB.aoMudar((ps) => {
        promptsLib = ps;
        if (slash) updateSlash();
        if (!plibEl.hidden) renderPlibList();
      });
    } else {
      btnPlib.hidden = true;
    }

    function previaDe(texto) {
      const l =
        String(texto || "")
          .split("\n")
          .map((s) => s.trim())
          .find(Boolean) || "";
      return l.length > 90 ? l.slice(0, 90) + "…" : l;
    }

    function closeSlash() {
      slash = null;
      slashEl.hidden = true;
    }

    function keyDeItem(it) {
      return it.tipo === "prompt" ? "p:" + it.p.id : it.tipo;
    }

    function updateSlash() {
      if (!temPlib) return;
      const tok = findSlashToken(inEl.value, inEl.selectionStart);
      if (!tok) return closeSlash();
      const q = norm(tok.query.trim());
      const all = promptsLib.filter((p) => !q || norm(p.titulo).includes(q));
      // mesma regra do popup @: busca sem resultado não fecha na hora (o
      // estado vazio orienta), mas acima de 20 chars o usuário está
      // escrevendo uma frase que começa com "/", não buscando
      if (!all.length && tok.query.trim().length > 20) return closeSlash();
      const items = all
        .slice(0, MENTION_MAX)
        .map((p) => ({ tipo: "prompt", p }));
      // ações fixas no rodapé: salvar o texto atual (quando há texto além
      // do token) e abrir o gerenciador (vira o CTA de criação na 1ª vez)
      const resto = (inEl.value.slice(0, tok.start) + inEl.value.slice(tok.end)).trim();
      if (resto) items.push({ tipo: "salvar" });
      items.push({ tipo: "gerenciar" });
      const prevKey =
        slash && slash.items[slash.idx] ? keyDeItem(slash.items[slash.idx]) : null;
      const keepIdx = items.findIndex((it) => keyDeItem(it) === prevKey);
      slash = {
        start: tok.start,
        end: tok.end,
        items,
        idx: keepIdx >= 0 ? keepIdx : 0,
        query: tok.query, // CRU (sem trim): o espelho mostra até o espaço final
        total: all.length,
        extra: all.length - Math.min(all.length, MENTION_MAX),
      };
      renderSlash();
    }

    function renderSlash() {
      slashQT.classList.toggle("vazio", !slash.query);
      slashQT.textContent = slash.query || "digite para buscar pelo título do prompt…";
      // cursor falso: sólido enquanto digita, piscando parado (igual ao @)
      slashQC.style.animation = "none";
      void slashQC.offsetWidth;
      slashQC.style.animation = "";
      slashQN.textContent =
        slash.total === 0
          ? "nenhum prompt"
          : slash.total === 1
            ? "1 prompt"
            : slash.total + " prompts";
      slashList.innerHTML = "";
      if (slash.total === 0 && slash.query.trim()) {
        const vazio = document.createElement("div");
        vazio.className = "mrow-more";
        vazio.textContent =
          "Nenhum prompt com esse título — apague para ver todos (esc fecha).";
        slashList.appendChild(vazio);
      } else if (slash.total === 0 && !promptsLib.length) {
        const vazio = document.createElement("div");
        vazio.className = "mrow-more";
        vazio.textContent =
          "Você ainda não tem prompts salvos — instruções reutilizáveis que entram no início da mensagem.";
        slashList.appendChild(vazio);
      }
      slash.items.forEach((it, i) => {
        const row = document.createElement("div");
        row.setAttribute("role", "option");
        row.setAttribute("aria-selected", i === slash.idx ? "true" : "false");
        if (it.tipo === "prompt") {
          row.className = "mrow srow" + (i === slash.idx ? " active" : "");
          row.innerHTML =
            '<span class="pchip-i" aria-hidden="true">' + SVG.prompts + '</span>' +
            '<span class="scol"><span class="t" title="' + escapeHtml(it.p.titulo) + '">' +
            escapeHtml(it.p.titulo) +
            '</span><span class="mrow-sub">' + escapeHtml(previaDe(it.p.texto)) +
            "</span></span>";
        } else {
          row.className = "mrow mrow-acao" + (i === slash.idx ? " active" : "");
          row.textContent =
            it.tipo === "salvar"
              ? "Salvar o texto atual como prompt…"
              : promptsLib.length
                ? "Gerenciar prompts…"
                : "Criar seu primeiro prompt…";
        }
        // mousedown (não click) para agir antes do blur do textarea
        row.addEventListener("mousedown", (e) => {
          e.preventDefault();
          pickSlash(i);
        });
        row.addEventListener("mouseenter", () => {
          if (slash && slash.idx !== i) {
            slash.idx = i;
            renderSlash();
          }
        });
        slashList.appendChild(row);
      });
      if (slash.extra > 0) {
        const more = document.createElement("div");
        more.className = "mrow-more";
        more.textContent =
          "… e mais " + slash.extra + " prompts — continue digitando para filtrar";
        slashList.appendChild(more);
      }
      slashEl.hidden = false;
      const act = slashList.querySelector(".mrow.active");
      if (act) act.scrollIntoView({ block: "nearest" });
    }

    function pickSlash(i) {
      if (!slash || !slash.items[i]) return;
      const it = slash.items[i];
      const caret = slash.start;
      // remove o token "/busca" do texto (como o pickMention)
      const v = inEl.value;
      const semToken = v.slice(0, slash.start) + v.slice(slash.end);
      inEl.value = semToken;
      closeSlash();
      autoresize();
      if (it.tipo === "prompt") {
        setPromptAtivo(it.p);
        // devolve o foco ao campo, no lugar onde o token estava
        inEl.focus();
        inEl.setSelectionRange(caret, caret);
      } else if (it.tipo === "salvar") {
        // o modal fica com o foco (o inEl volta a recebê-lo ao fechar)
        abrirPlib({ form: true, texto: semToken.trim() });
      } else {
        abrirPlib(promptsLib.length ? {} : { form: true });
      }
    }

    // Chip do prompt ativo na .promptbar (fundida à caixa de entrada).
    // p = null desliga. A prévia do texto aparece num tooltip CSS no hover.
    function setPromptAtivo(p) {
      promptAtivo = p || null;
      promptbar.innerHTML = "";
      promptbar.hidden = !promptAtivo;
      inrowEl.classList.toggle("com-prompt", !!promptAtivo);
      if (!promptAtivo) return;
      const texto = String(promptAtivo.texto || "");
      const tip = texto.length > 400 ? texto.slice(0, 400) + "…" : texto;
      const chip = document.createElement("span");
      chip.className = "pchip";
      chip.innerHTML =
        '<span class="pchip-i" aria-hidden="true">' + SVG.prompts + '</span>' +
        '<span class="pchip-t" title="' + escapeHtml(promptAtivo.titulo) + '">' +
        escapeHtml(promptAtivo.titulo) + "</span>" +
        '<button class="chip-x pchip-x" title="Remover o prompt da mensagem" aria-label="Remover o prompt ' +
        escapeHtml(promptAtivo.titulo) + ' da mensagem">' + SVG.x + "</button>" +
        '<span class="pchip-tip" aria-hidden="true">' + escapeHtml(tip) + "</span>";
      chip.querySelector(".pchip-x").addEventListener("click", () => setPromptAtivo(null));
      promptbar.appendChild(chip);
      const hint = document.createElement("span");
      hint.className = "promptbar-hint";
      hint.textContent = "enviado no início da mensagem";
      promptbar.appendChild(hint);
    }

    // ----- Gerenciador de prompts (modal .plib) -----
    function abrirPlib(opts) {
      opts = opts || {};
      plibEl.hidden = false;
      plibDelArm = null;
      if (opts.form) abrirPlibForm(null, opts.texto || "");
      else fecharPlibForm();
      renderPlibList();
      if (!opts.form) plibCard.focus();
    }

    function fecharPlib() {
      plibEl.hidden = true;
      fecharPlibForm();
      inEl.focus();
    }

    function abrirPlibForm(p, textoInicial) {
      plibEditId = p ? p.id : null;
      // id do prompt NOVO gerado uma única vez ao abrir o form: o contador
      // de bytes roda a cada tecla e sortear um id a cada chamada seria
      // desperdício (e mediria um tamanho diferente do que será salvo)
      plibIdNovo = p ? null : temPlib ? PLIB.novoId() : "";
      plibFT.value = p ? p.titulo : "";
      plibFX.value = p ? p.texto : textoInicial || "";
      plibErr.textContent = "";
      plibForm.hidden = false;
      plibListEl.hidden = true; // o form substitui a lista (card compacto)
      atualizarPlibCnt();
      plibFT.focus();
    }

    function fecharPlibForm() {
      plibEditId = null;
      plibForm.hidden = true;
      plibListEl.hidden = false;
      plibErr.textContent = "";
    }

    function promptDoForm() {
      const agora = Date.now();
      const antigo = plibEditId && promptsLib.find((x) => x.id === plibEditId);
      return {
        id: plibEditId || plibIdNovo,
        titulo: plibFT.value.trim(),
        texto: plibFX.value.trim(),
        criadoEm: antigo ? antigo.criadoEm : agora,
        atualizadoEm: agora,
      };
    }

    function atualizarPlibCnt() {
      if (!temPlib) return;
      const b = PLIB.bytesDe(promptDoForm());
      const pct = Math.min(999, Math.round((b / PLIB.TETO_BYTES) * 100));
      plibCnt.textContent =
        plibFX.value.length + " caracteres — " + pct + "% do limite de sincronização";
      plibCnt.classList.toggle("estouro", b > PLIB.TETO_BYTES);
    }
    plibFT.addEventListener("input", atualizarPlibCnt);
    plibFX.addEventListener("input", atualizarPlibCnt);
    // Enter no título salva (o texto é multilinha e mantém o Enter próprio)
    plibFT.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        salvarPlibForm();
      }
    });

    function renderPlibList() {
      plibDelArm = null; // re-render desarma qualquer exclusão pendente
      plibListEl.innerHTML = "";
      if (!promptsLib.length) {
        plibListEl.innerHTML =
          '<div class="plib-empty">Nenhum prompt salvo ainda.<br>Clique em <b>Novo</b> para criar o primeiro — depois é só digitar <b>/</b> no campo de mensagem para usá-lo.</div>';
        return;
      }
      for (const p of promptsLib) {
        const row = document.createElement("div");
        row.className = "plib-row";
        row.dataset.id = p.id;
        row.innerHTML =
          '<div class="plib-info"><span class="plib-t" title="' + escapeHtml(p.titulo) + '">' +
          escapeHtml(p.titulo) +
          '</span><span class="plib-prev">' + escapeHtml(previaDe(p.texto)) + "</span></div>" +
          '<div class="plib-acts">' +
          '<button class="plib-use" title="Inserir este prompt na mensagem">usar</button>' +
          '<button class="plib-edit" title="Editar este prompt">editar</button>' +
          '<button class="plib-del" title="Excluir este prompt">excluir</button></div>';
        plibListEl.appendChild(row);
      }
    }

    // ações DELEGADAS na lista (as rows são recriadas a cada render)
    plibListEl.addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      const row = e.target.closest(".plib-row");
      if (!btn || !row) return;
      const p = promptsLib.find((x) => x.id === row.dataset.id);
      if (!p) return;
      if (btn.classList.contains("plib-use")) {
        fecharPlib();
        setPromptAtivo(p);
      } else if (btn.classList.contains("plib-edit")) {
        abrirPlibForm(p);
      } else if (btn.classList.contains("plib-del")) {
        // exclusão em DOIS cliques (nunca confirm() nativo — o dialog da
        // página fica fora do Shadow DOM e congela a extensão)
        if (plibDelArm !== p.id) {
          // desarma o botão de outra linha (senão dois ficariam "excluir?")
          plibListEl.querySelectorAll(".plib-del.arm").forEach((b) => {
            b.textContent = "excluir";
            b.classList.remove("arm");
          });
        }
        if (plibDelArm === p.id) {
          plibDelArm = null;
          PLIB.excluir(p.id, () => {
            // atualização otimista; o storage.onChanged confirma em seguida
            promptsLib = promptsLib.filter((x) => x.id !== p.id);
            renderPlibList();
          });
        } else {
          plibDelArm = p.id;
          btn.textContent = "excluir?";
          btn.classList.add("arm");
        }
      }
    });

    function salvarPlibForm() {
      const p = promptDoForm();
      if (!p.titulo) {
        plibErr.textContent = "Dê um título ao prompt.";
        plibFT.focus();
        return;
      }
      if (!p.texto) {
        plibErr.textContent = "Escreva o texto do prompt.";
        plibFX.focus();
        return;
      }
      PLIB.salvar(p, (erro) => {
        if (erro) {
          plibErr.textContent = "Não foi possível salvar: " + erro;
          return;
        }
        // atualização otimista (o storage.onChanged confirma em seguida)
        promptsLib = promptsLib
          .filter((x) => x.id !== p.id)
          .concat(p)
          .sort((a, b) => String(a.titulo).localeCompare(String(b.titulo), "pt-BR"));
        fecharPlibForm();
        renderPlibList();
      });
    }
    plibCard.querySelector(".plib-save").addEventListener("click", salvarPlibForm);
    plibCard.querySelector(".plib-cancel").addEventListener("click", fecharPlibForm);
    // "✚ Novo" aproveita o que já está escrito no campo como ponto de
    // partida (o caso real: a pessoa redigiu a instrução e só então
    // percebeu que quer guardá-la) — o campo de mensagem não é alterado
    plibCard
      .querySelector(".plib-new")
      .addEventListener("click", () => abrirPlibForm(null, inEl.value.trim()));
    plibCard.querySelector(".plib-close").addEventListener("click", fecharPlib);
    // clique no fundo escuro fecha (padrão de modal)
    plibEl.addEventListener("click", (e) => {
      if (e.target === plibEl) fecharPlib();
    });
    // Esc dentro do modal: fecha o form (se aberto) ou o modal — e NÃO vaza
    // para o Esc do painel (que cancelaria o modo docx junto)
    plibCard.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      if (!plibForm.hidden) fecharPlibForm();
      else fecharPlib();
    });
    btnPlib.addEventListener("click", () =>
      abrirPlib(promptsLib.length ? {} : { form: true })
    );

    // ----- Biblioteca de MODELOS (peças-modelo, MLIB/storage.local) ----------
    // Irmã do PLIB, com dois papéis: (1) o modal .mlib faz o CRUD (título,
    // categoria, descrição, texto); (2) o seletor da .minutabar escolhe uma
    // CATEGORIA e, ao gerar a minuta, TODAS as peças-modelo daquela espécie
    // (até um teto) vão ao request numa moldura XML (content.js): a IA analisa,
    // escolhe a base mais adequada e pode aproveitar estrutura e linguajar das
    // outras — mas os FATOS saem só das peças do processo, NUNCA dos modelos.
    // Ao contrário do prompt, um modelo não é despejado no textarea: ele só
    // acompanha o turno da minuta.
    const btnMlib = $(".btn-mlib");
    const BTN_MLIB_TITLE_ON = btnMlib ? btnMlib.title : ""; // título de HTML (reusado ao reabilitar)
    const mlibEl = $(".mlib");
    const mlibCard = $(".mlib-card");
    const mlibListEl = $(".mlib-list");
    const mlibForm = $(".mlib-form");
    const mlibFT = $(".mlib-ft");
    const mlibFC = $(".mlib-fc");
    const mlibFD = $(".mlib-fd");
    const mlibFX = $(".mlib-fx");
    const mlibCnt = $(".mlib-cnt");
    const mlibErr = $(".mlib-err");
    const minutaModeloWrap = $(".minuta-modelo");
    const minutaModeloSel = $(".minuta-modelo-sel");
    const minutaModeloVazio = $(".mm-vazio");
    const minutaModeloAdd = $(".mm-add");

    let modelosLib = []; // espelho ordenado de MLIB.listar
    let mlibEditId = null;
    let mlibIdNovo = "";
    let mlibDelArm = null;
    // A biblioteca de modelos só faz sentido em modelos de 1M tokens (a minuta
    // manda os autos inteiros + vários modelos): setModelosHabilitado, chamado
    // pelo content.js quando as caps chegam, desliga a feature nos menores
    // (Haiku). Começa true para não sumir no harness de teste (sem caps).
    let modelosHabilitado = true;

    // MLIB é content script carregado antes deste; o harness de teste pode não
    // incluí-lo — sem ele a feature some em silêncio, nada quebra.
    const temMlib = typeof MLIB !== "undefined";
    if (temMlib) {
      // popula o <select> de categoria do form uma única vez
      for (const c of MLIB.CATEGORIAS) {
        const op = document.createElement("option");
        op.value = c.valor;
        op.textContent = c.rotulo;
        mlibFC.appendChild(op);
      }
      MLIB.listar((ms) => {
        modelosLib = ms;
        if (minutaMode) atualizarSeletorMinuta(true);
      });
      MLIB.aoMudar((ms) => {
        modelosLib = ms;
        if (!mlibEl.hidden) renderMlibList();
        if (minutaMode) atualizarSeletorMinuta(true);
      });
    } else {
      if (btnMlib) btnMlib.hidden = true;
      if (minutaModeloWrap) minutaModeloWrap.hidden = true;
    }

    // Detecção da espécie a partir da instrução, para PRÉ-selecionar a
    // categoria no seletor. Espelha o agrupamento de MINUTA_ESPECIE
    // (content.js); é só uma conveniência de UI (o usuário pode trocar).
    function detectarCategoria(texto) {
      const s = norm(String(texto || ""));
      if (/\bsentenc/.test(s)) return "sentenca";
      if (/\bdespacho/.test(s)) return "despacho";
      if (/\b(decisao|decisoes|voto|acordao|acordaos|liminar|tutela)\b/.test(s)) return "decisao";
      if (/\b(ata|audiencia|termo de audiencia)\b/.test(s)) return "ata";
      if (/\boficio/.test(s)) return "oficio";
      if (/\b(mandado|alvara)\b/.test(s)) return "mandado";
      return null;
    }

    // Reconstrói o <select> do modo minuta: uma opção por CATEGORIA que tenha
    // modelos, com a contagem. Preserva a escolha MANUAL anterior; sem ela,
    // pré-seleciona pela categoria detectada na instrução.
    function popularSeletorModelos(preselCat) {
      if (!minutaModeloSel) return;
      const anterior = minutaModeloSel.value; // valor = categoria
      minutaModeloSel.innerHTML = "";
      const nenhum = document.createElement("option");
      nenhum.value = "";
      nenhum.textContent = "— nenhum (estilo padrão) —";
      minutaModeloSel.appendChild(nenhum);
      const comModelo = new Set();
      for (const cat of MLIB.CATEGORIAS) {
        const n = modelosLib.filter((m) => (m.categoria || "outro") === cat.valor).length;
        if (!n) continue;
        comModelo.add(cat.valor);
        const op = document.createElement("option");
        op.value = cat.valor;
        op.textContent = cat.rotulo + " (" + n + ")";
        minutaModeloSel.appendChild(op);
      }
      if (anterior && comModelo.has(anterior)) minutaModeloSel.value = anterior;
      else if (preselCat && comModelo.has(preselCat)) minutaModeloSel.value = preselCat;
      // sem categoria detectada e só UMA categoria com modelos: pré-seleciona
      // essa — a feature "acontece" sem exigir um clique a mais (o usuário
      // ainda pode voltar para "nenhum")
      else if (comModelo.size === 1) minutaModeloSel.value = comModelo.values().next().value;
      else minutaModeloSel.value = "";
    }

    // Modelos enviados por minuta: TODOS os da categoria escolhida, do mais
    // recente ao mais antigo, até dois tetos — nº de modelos e total de
    // caracteres (guarda de contexto: a minuta não tem pré-voo de tokens). O
    // primeiro modelo sempre entra, mesmo acima do teto de caracteres.
    const MODELOS_MAX_ENVIO = 12;
    const MODELOS_TETO_CHARS = 180000; // ~45 mil tokens no total
    function modelosMinutaSelecionados() {
      if (!minutaModeloSel || !minutaModeloWrap || minutaModeloWrap.hidden) return [];
      // A linha aparece também no estado VAZIO (só o convite para cadastrar):
      // ali o <select> está oculto e não há o que enviar. Sem esta guarda a
      // função dependeria de o select estar sem opções para devolver [].
      if (minutaModeloSel.hidden) return [];
      const cat = minutaModeloSel.value;
      if (!cat) return [];
      const doGrupo = modelosLib
        .filter((m) => (m.categoria || "outro") === cat && m.texto)
        .sort((a, b) => (b.atualizadoEm || 0) - (a.atualizadoEm || 0));
      const out = [];
      let chars = 0;
      for (const m of doGrupo) {
        if (out.length >= MODELOS_MAX_ENVIO) break;
        const tam = String(m.texto).length;
        if (out.length && chars + tam > MODELOS_TETO_CHARS) break;
        out.push(m);
        chars += tam;
      }
      // "sem cap silencioso": avisa no console quando corta modelos da categoria
      if (doGrupo.length > out.length) {
        try {
          console.info(
            "[PJe IA] minuta: enviando " + out.length + " de " + doGrupo.length +
              " modelos da categoria (teto de contexto)."
          );
        } catch (e) {}
      }
      return out;
    }

    // Mostra/esconde e popula o seletor conforme o modo minuta, a existência de
    // modelos e o modelo ativo (só 1M). Chamada por setMinutaMode, pelo aoMudar
    // do MLIB e por setModelosHabilitado.
    // Biblioteca VAZIA não esconde a linha: mostra o convite. Sumir era o
    // defeito — quem nunca cadastrou um modelo ligava o modo minuta e não via
    // vestígio nenhum de que a feature existe, concluindo (com razão) que ela
    // não estava lá. É a mesma regra da `.sel-nota` nos degraus de seleção:
    // conjunto vazio se explica, não desaparece. O gate de janela (1M) e a
    // ausência do MLIB continuam escondendo tudo — ali o botão da barra de
    // ferramentas, desabilitado com tooltip, já é a explicação.
    function atualizarSeletorMinuta(on) {
      if (!minutaModeloWrap) return;
      if (!on || !temMlib || !modelosHabilitado) {
        minutaModeloWrap.hidden = true;
        return;
      }
      const vazio = !modelosLib.length;
      if (minutaModeloVazio) minutaModeloVazio.hidden = !vazio;
      if (minutaModeloAdd) minutaModeloAdd.hidden = !vazio;
      minutaModeloSel.hidden = vazio;
      if (!vazio) popularSeletorModelos(detectarCategoria(inEl.value));
      minutaModeloWrap.hidden = false;
    }
    // Atalho do estado vazio: abre o gerenciador já no formulário — o caminho
    // até aqui (barra de ferramentas → Modelos → Novo) é justamente o que
    // ninguém percorre sem saber que existe.
    if (minutaModeloAdd) {
      minutaModeloAdd.addEventListener("click", (e) => {
        e.preventDefault();
        if (!temMlib || !modelosHabilitado) return;
        abrirMlib({ form: true });
      });
    }

    // Liga/desliga toda a feature de modelos conforme a janela do modelo ativo
    // (1M tokens). Em vez de SUMIR nos menores (o usuário ficaria sem saber por
    // quê), o botão do CRUD fica DESABILITADO com tooltip explicando; o seletor
    // da minuta some (o botão já é a explicação) e o modal fecha se aberto.
    // O texto NÃO lista modelos por nome de propósito: o gate é por capacidade
    // (janela de 1M) e o catálogo muda — uma lista aqui envelheceria calada.
    const BTN_MLIB_TITLE_OFF =
      "A biblioteca de modelos precisa de uma janela de 1 milhão de tokens: a minuta " +
      "manda os autos inteiros e ainda os seus modelos. O modelo de IA ativo tem uma " +
      "janela menor — troque nas opções da extensão para usá-la.";
    function setModelosHabilitado(on) {
      modelosHabilitado = !!on;
      if (btnMlib) {
        btnMlib.hidden = !temMlib; // some só no harness sem MLIB
        btnMlib.disabled = temMlib && !modelosHabilitado;
        if (temMlib && !modelosHabilitado) btnMlib.title = BTN_MLIB_TITLE_OFF;
        else if (temMlib) btnMlib.title = BTN_MLIB_TITLE_ON;
      }
      if (!modelosHabilitado && mlibEl && !mlibEl.hidden) fecharMlib();
      if (minutaMode) atualizarSeletorMinuta(true);
    }

    // ----- Gerenciador de modelos (modal .mlib) -----
    function abrirMlib(opts) {
      opts = opts || {};
      mlibEl.hidden = false;
      mlibDelArm = null;
      if (opts.form) abrirMlibForm(null);
      else fecharMlibForm();
      renderMlibList();
      if (!opts.form) mlibCard.focus();
    }

    function fecharMlib() {
      mlibEl.hidden = true;
      fecharMlibForm();
      inEl.focus();
    }

    function abrirMlibForm(m) {
      mlibEditId = m ? m.id : null;
      mlibIdNovo = m ? null : temMlib ? MLIB.novoId() : "";
      mlibFT.value = m ? m.titulo : "";
      mlibFC.value = m ? m.categoria || "outro" : "sentenca";
      mlibFD.value = m ? m.descricao || "" : "";
      mlibFX.value = m ? m.texto : "";
      mlibErr.textContent = "";
      mlibForm.hidden = false;
      mlibListEl.hidden = true;
      atualizarMlibCnt();
      mlibFT.focus();
    }

    function fecharMlibForm() {
      mlibEditId = null;
      mlibForm.hidden = true;
      mlibListEl.hidden = false;
      mlibErr.textContent = "";
    }

    function modeloDoForm() {
      const agora = Date.now();
      const antigo = mlibEditId && modelosLib.find((x) => x.id === mlibEditId);
      return {
        id: mlibEditId || mlibIdNovo,
        titulo: mlibFT.value.trim(),
        categoria: mlibFC.value || "outro",
        descricao: mlibFD.value.trim(),
        texto: mlibFX.value.trim(),
        criadoEm: antigo ? antigo.criadoEm : agora,
        atualizadoEm: agora,
      };
    }

    function atualizarMlibCnt() {
      if (!temMlib) return;
      const b = MLIB.bytesDe(modeloDoForm());
      const pct = Math.min(999, Math.round((b / MLIB.TETO_BYTES) * 100));
      mlibCnt.textContent = mlibFX.value.length + " caracteres — " + pct + "% do limite";
      mlibCnt.classList.toggle("estouro", b > MLIB.TETO_BYTES);
    }
    if (temMlib) {
      mlibFT.addEventListener("input", atualizarMlibCnt);
      mlibFD.addEventListener("input", atualizarMlibCnt);
      mlibFX.addEventListener("input", atualizarMlibCnt);
      // Enter no título salva (o texto é multilinha e mantém o Enter próprio)
      mlibFT.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          salvarMlibForm();
        }
      });
    }

    function renderMlibList() {
      mlibDelArm = null;
      mlibListEl.innerHTML = "";
      if (!modelosLib.length) {
        mlibListEl.innerHTML =
          '<div class="plib-empty">Nenhum modelo cadastrado ainda.<br>Clique em <b>Novo</b> para cadastrar sua primeira peça-modelo — depois, ao gerar uma minuta, escolha a categoria em <b>Seguir modelos</b>.</div>';
        return;
      }
      for (const m of modelosLib) {
        const row = document.createElement("div");
        row.className = "plib-row";
        row.dataset.id = m.id;
        const prev = m.descricao || previaDe(m.texto);
        row.innerHTML =
          '<div class="plib-info"><span class="plib-t" title="' + escapeHtml(m.titulo) + '">' +
          '<span class="mlib-cat">' + escapeHtml(MLIB.rotuloCategoria(m.categoria)) + "</span>" +
          escapeHtml(m.titulo) +
          '</span><span class="plib-prev">' + escapeHtml(prev) + "</span></div>" +
          '<div class="plib-acts">' +
          '<button class="mlib-edit" title="Editar este modelo">editar</button>' +
          '<button class="mlib-del plib-del" title="Excluir este modelo">excluir</button></div>';
        mlibListEl.appendChild(row);
      }
    }

    // ações DELEGADAS na lista (as rows são recriadas a cada render)
    mlibListEl.addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      const row = e.target.closest(".plib-row");
      if (!btn || !row) return;
      const m = modelosLib.find((x) => x.id === row.dataset.id);
      if (!m) return;
      if (btn.classList.contains("mlib-edit")) {
        abrirMlibForm(m);
      } else if (btn.classList.contains("mlib-del")) {
        // exclusão em DOIS cliques (nunca confirm() nativo — congela a página)
        if (mlibDelArm !== m.id) {
          mlibListEl.querySelectorAll(".mlib-del.arm").forEach((b) => {
            b.textContent = "excluir";
            b.classList.remove("arm");
          });
        }
        if (mlibDelArm === m.id) {
          mlibDelArm = null;
          MLIB.excluir(m.id, () => {
            modelosLib = modelosLib.filter((x) => x.id !== m.id);
            renderMlibList();
          });
        } else {
          mlibDelArm = m.id;
          btn.textContent = "excluir?";
          btn.classList.add("arm");
        }
      }
    });

    function salvarMlibForm() {
      const m = modeloDoForm();
      if (!m.titulo) {
        mlibErr.textContent = "Dê um título ao modelo.";
        mlibFT.focus();
        return;
      }
      if (!m.texto) {
        mlibErr.textContent = "Cole o texto da peça-modelo.";
        mlibFX.focus();
        return;
      }
      MLIB.salvar(m, (erro) => {
        if (erro) {
          mlibErr.textContent = "Não foi possível salvar: " + erro;
          return;
        }
        modelosLib = modelosLib
          .filter((x) => x.id !== m.id)
          .concat(m)
          .sort((a, b) => String(a.titulo).localeCompare(String(b.titulo), "pt-BR"));
        fecharMlibForm();
        renderMlibList();
      });
    }
    if (temMlib) {
      mlibCard.querySelector(".mlib-save").addEventListener("click", salvarMlibForm);
      mlibCard.querySelector(".mlib-cancel").addEventListener("click", fecharMlibForm);
      mlibCard.querySelector(".mlib-new").addEventListener("click", () => abrirMlibForm(null));
      mlibCard.querySelector(".mlib-close").addEventListener("click", fecharMlib);
      mlibEl.addEventListener("click", (e) => {
        if (e.target === mlibEl) fecharMlib();
      });
      // Esc no modal: fecha o form (se aberto) ou o modal — e NÃO vaza para o
      // Esc do painel (que cancelaria o modo minuta junto)
      mlibCard.addEventListener("keydown", (e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        if (!mlibForm.hidden) fecharMlibForm();
        else fecharMlib();
      });
      btnMlib.addEventListener("click", () =>
        abrirMlib(modelosLib.length ? {} : { form: true })
      );
    }

    inEl.addEventListener("input", () => {
      autoresize();
      updateMention();
      updateSlash();
    });
    // o caret pode mudar sem input (clique, setas, Home/End) — reavalia o token
    inEl.addEventListener("click", () => {
      updateMention();
      updateSlash();
    });
    inEl.addEventListener("keyup", (e) => {
      if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
        updateMention();
        updateSlash();
      }
    });
    inEl.addEventListener("blur", () =>
      setTimeout(() => {
        closeMention();
        closeSlash();
      }, 120)
    );

    let sendCb = null;
    let configureCb = null;
    function doSend() {
      // prompt salvo ativo (chip) PRECEDE o texto digitado — a combinação
      // acontece aqui, no painel: o content script recebe o texto final e o
      // protocolo/histórico não mudam em nada
      const t = montarTextoEnvio(promptAtivo && promptAtivo.texto, inEl.value);
      // No modo minuta, Enviar/Enter geram a minuta (instrução vazia cai na
      // padrão, tratada pelo content script) — nunca viram mensagem de chat.
      if (minutaMode) {
        if (!minutaCb) return;
        const sel = getSelected();
        if (!sel.length) {
          statusEl.textContent = "Marque as peças que devem embasar a minuta.";
          return;
        }
        // lê os modelos da categoria ANTES de desligar o modo (o seletor some)
        const modelos = modelosMinutaSelecionados();
        setMinutaMode(false);
        minutaCb(t, sel, modelos);
        inEl.value = "";
        inEl.style.height = "auto";
        setPromptAtivo(null); // consumido no envio
        closeMention();
        closeSlash();
        return;
      }
      // Idem no modo mapa mental: Enviar/Enter geram o mapa, nunca uma
      // mensagem de chat.
      if (mapaMode) {
        if (!mapaCb) return;
        const sel = getSelected();
        if (!sel.length) {
          statusEl.textContent = "Marque as peças que devem embasar o mapa mental.";
          return;
        }
        setMapaMode(false);
        mapaCb(t, sel);
        inEl.value = "";
        inEl.style.height = "auto";
        setPromptAtivo(null); // consumido no envio
        closeMention();
        closeSlash();
        return;
      }
      if (!sendCb) return;
      if (!t.trim()) return; // com chip ativo t nunca é vazio: chip sozinho envia
      sendCb(t, getSelected());
      inEl.value = "";
      inEl.style.height = "auto";
      setPromptAtivo(null); // consumido no envio
      closeMention();
      closeSlash();
    }
    sendBtn.addEventListener("click", doSend);
    inEl.addEventListener("keydown", (e) => {
      if (slash && !slashEl.hidden) {
        const n = slash.items.length;
        // sem prompt casando com a busca (query não-vazia), só o Esc é
        // capturado — Enter envia a mensagem que começa com "/" literal
        // (as ações fixas continuam clicáveis pelo mouse)
        const navegavel = slash.total > 0 || !slash.query.trim();
        if (navegavel && e.key === "ArrowDown") {
          e.preventDefault();
          slash.idx = (slash.idx + 1) % n;
          renderSlash();
          return;
        }
        if (navegavel && e.key === "ArrowUp") {
          e.preventDefault();
          slash.idx = (slash.idx - 1 + n) % n;
          renderSlash();
          return;
        }
        if (navegavel && (e.key === "Enter" || e.key === "Tab")) {
          e.preventDefault();
          pickSlash(slash.idx);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          closeSlash();
          return;
        }
      }
      if (mention && !mentionEl.hidden) {
        const n = mention.items.length;
        // com a lista VAZIA (busca sem resultado) só o Esc é capturado —
        // setas movem o caret e Enter envia normalmente (impedir o envio
        // bloquearia mensagens com "@algo" que não é peça)
        if (n && e.key === "ArrowDown") {
          e.preventDefault();
          mention.idx = (mention.idx + 1) % n;
          renderMention();
          return;
        }
        if (n && e.key === "ArrowUp") {
          e.preventDefault();
          mention.idx = (mention.idx - 1 + n) % n;
          renderMention();
          return;
        }
        if (n && (e.key === "Enter" || e.key === "Tab")) {
          e.preventDefault();
          pickMention(mention.idx);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          closeMention();
          return;
        }
      }
      // Esc com o popup @ fechado cancela o modo minuta / mapa mental
      if (e.key === "Escape" && (minutaMode || mapaMode)) {
        e.preventDefault();
        if (minutaMode) setMinutaMode(false);
        if (mapaMode) setMapaMode(false);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        doSend();
      }
    });

    // -------------------------------------------------------------------------
    // Card de preparo: progresso por peça enquanto os PDFs são baixados.
    // -------------------------------------------------------------------------
    let prepEl = null;
    let prepTotal = 0;
    let prepDone = 0;
    let prepOpts = {};

    // opts (todos opcionais, e os padrões reproduzem o comportamento original):
    //   titulo     — cabeçalho enquanto corre ("Preparando peças…")
    //   fim        — texto de conclusão; recebe o total ("N peças anexadas…")
    //   onCancelar — quando presente, acrescenta um botão Cancelar. Só faz
    //                sentido em lotes longos (exportação): o preparo de um
    //                envio dura segundos e um botão ali seria ruído.
    function startPrep(items, opts) {
      endPrep(true);
      clearEmptyHint();
      prepOpts = opts || {};
      prepTotal = items.length;
      prepDone = 0;
      prepEl = document.createElement("div");
      prepEl.className = "prep";
      let rows = "";
      for (const d of items) {
        rows +=
          '<div class="prep-row" data-id="' + escapeHtml(d.id) + '">' +
          '<span class="prep-ic wait"></span>' +
          '<span class="t" title="' + escapeHtml(d.titulo) + '">' +
          escapeHtml(tituloCurto(d.titulo)) +
          "</span></div>";
      }
      prepEl.innerHTML =
        '<div class="prep-hd"><span class="prep-spin"></span><span class="prep-ttl">' +
        escapeHtml(prepOpts.titulo || "Preparando peças…") +
        "</span>" +
        '<span class="prep-n">0/' + prepTotal + "</span>" +
        (prepOpts.onCancelar
          ? '<button type="button" class="prep-cancel" title="Interrompe a exportação">Cancelar</button>'
          : "") +
        "</div>" +
        '<div class="prep-list">' + rows + "</div>" +
        '<div class="prep-bar"><i></i></div>';
      if (prepOpts.onCancelar) {
        prepEl.querySelector(".prep-cancel").addEventListener("click", (ev) => {
          ev.target.disabled = true;
          ev.target.textContent = "Cancelando…";
          prepOpts.onCancelar();
        });
      }
      msgs.appendChild(prepEl);
      msgs.scrollTop = msgs.scrollHeight;
    }

    // Estados de uma peça no card: wait → loading (baixando) → upload (subindo
    // para a API, só nos PDFs) → done. Ou → erro, quando o download falha.
    function setPrepState(id, state) {
      if (!prepEl) return;
      const row = prepEl.querySelector('.prep-row[data-id="' + CSS.escape(id) + '"]');
      if (!row) return;
      const ic = row.querySelector(".prep-ic");
      // O contador conta PEÇAS PRONTAS, não transições de estado. Sem esta
      // guarda, um "done" repetido — fácil de acontecer agora que a peça passa
      // por mais de uma fase — levaria o contador além de N/N e a barra além
      // de 100%. Vale também para a exportação, que usa os mesmos estados.
      const jaTerminou = /(^|\s)(done|erro)(\s|$)/.test(ic.className);
      ic.className = "prep-ic " + state;
      ic.innerHTML = state === "done" ? SVG.check : "";
      // "erro" também ADIANTA o contador: a peça terminou de ser tentada. Sem
      // isso a barra de uma exportação com falhas nunca chegaria ao fim, e o
      // usuário ficaria olhando um progresso travado sem saber que acabou.
      if ((state === "done" || state === "erro") && !jaTerminou) {
        prepDone++;
        prepEl.querySelector(".prep-n").textContent = prepDone + "/" + prepTotal;
        prepEl.querySelector(".prep-bar i").style.width =
          Math.round((prepDone / prepTotal) * 100) + "%";
      }
      msgs.scrollTop = msgs.scrollHeight;
    }

    function endPrep(immediate) {
      if (!prepEl) return;
      const el = prepEl;
      prepEl = null;
      if (immediate) {
        el.remove();
        return;
      }
      // confirma visualmente e recolhe
      const btnCancel = el.querySelector(".prep-cancel");
      if (btnCancel) btnCancel.remove();
      el.querySelector(".prep-ttl").textContent = prepOpts.fim
        ? prepOpts.fim(prepTotal, prepDone)
        : prepTotal === 1
          ? "Peça anexada à conversa"
          : prepTotal + " peças anexadas à conversa";
      el.querySelector(".prep-spin").outerHTML =
        '<span class="prep-okic">' + SVG.check + "</span>";
      el.classList.add("ok");
      setTimeout(() => {
        el.classList.add("fade");
        setTimeout(() => el.remove(), 350);
      }, 1100);
    }

    // Overlay "configure sua chave"
    let needkeyEl = null;
    function setConfigured(ok) {
      if (ok) {
        if (needkeyEl) {
          needkeyEl.remove();
          needkeyEl = null;
        }
        docsBox.style.display = "";
        ft.style.display = "";
        showEmptyHint();
        return;
      }
      docsBox.style.display = "none";
      ft.style.display = "none";
      clearEmptyHint();
      if (!needkeyEl) {
        needkeyEl = document.createElement("div");
        needkeyEl.className = "needkey";
        needkeyEl.innerHTML =
          '<div class="k">Configure sua chave</div><p>Para usar o assistente, informe sua chave de API — da Anthropic (modelos Claude) ou do Google (modelos Gemini), conforme o modelo escolhido.</p><button>Abrir configuração</button>';
        needkeyEl
          .querySelector("button")
          .addEventListener("click", () => configureCb && configureCb());
        msgs.appendChild(needkeyEl);
      }
    }

    return {
      open,
      onSend(cb) {
        sendCb = cb;
      },
      onConfigure(cb) {
        configureCb = cb;
      },
      onReset(cb) {
        resetCb = cb;
      },
      // Notifica quando o usuário marca/desmarca peças (ids selecionados).
      onSelectionChange(cb) {
        selChangeCb = cb;
      },
      // Clique no botão "ver na timeline" de uma peça (recebe o id).
      onVerNaTimeline(cb) {
        verTimelineCb = cb;
      },
      // Botão "Carregar todas as peças" da dica sob a lista.
      onCarregarTimeline(cb) {
        carregarTLCb = cb;
      },
      // Botão "Baixar .zip" da mesma faixa. cb(docs, {todas}) — `docs` já vem
      // resolvido (marcadas, ou todas quando nada está marcado) e `todas` diz
      // qual dos dois caminhos foi tomado, para o content script informar.
      onExportarZip(cb) {
        zipCb = cb;
      },
      // Trava/destrava o botão durante a exportação.
      setZipOcupado,
      // Peças que já estão no contexto da conversa. Chamado ao fim de cada
      // turno e em "Nova conversa" (com lista vazia).
      setPecasEnviadas(ids) {
        pecasEnviadas = new Set(ids || []);
        for (const r of doclist.querySelectorAll(".docrow")) {
          r.classList.toggle("enviada", pecasEnviadas.has(r.dataset.id));
        }
      },
      // Escolha assistida por IA (camada 2 da seleção — a camada 1, por regex,
      // segue sendo o padrão instantâneo)
      onEscolherIA(cb) {
        iaCb = cb;
      },
      setIaOcupado,
      aplicarEscolhaIA,
      setSelNota,
      // usada pelo content script para o teto do inventário de peças não
      // anexadas: o critério de corte é o mesmo da lista
      classificarPeca,
      // Estado da dica: {texto, carregando}. Sem argumento volta ao padrão.
      setTimelineTip,
      // Preview no hover: cb SÍNCRONO que devolve o conteúdo em cache ou null
      // ({kind:"pdf", b64, size, pages} | {kind:"text", text}) — nunca baixa.
      onPreview(cb) {
        previewCb = cb;
      },
      // Botão "Baixar" do preview em cache-miss: cb assíncrono (PJE.baixar).
      onPreviewBaixar(cb) {
        previewDlCb = cb;
      },
      setConfigured,
      clearMessages() {
        msgs.innerHTML = "";
        hintEl = null;
        needkeyEl = null;
        prepEl = null;
        transcript.length = 0;
        setMinutaMode(false); // nova conversa desliga os modos minuta…
        setMapaMode(false); // …e mapa mental
        setPromptAtivo(null); // e solta o chip de prompt salvo
        statusEl.textContent = "";
        alertEl.hidden = true;
        alertEl.innerHTML = "";
        showEmptyHint();
      },
      setDocs(docs) {
        // rows serão recriadas — fecha o popover (nó morto), SALVO durante o
        // download do preview: a ativação JSF do PJe re-dispara setDocs e
        // fecharia o popover "Baixando…" na cara do usuário
        if (!previewDlPendente) hidePreview();
        const cur = new Set(getSelected());
        allDocs = docs.slice();
        // Reclassificação quando a grid chega é de graça: setDocs recria todas
        // as rows e a seleção sobrevive pelo snapshot acima. Note o efeito
        // correto mas surpreendente — a seleção anterior NÃO é re-aplicada, e o
        // segmento "chave" passa a aparecer apagado porque o conjunto de peças
        // essenciais mudou. Isso é o sinal certo (a seleção é estado do
        // usuário); não "conserte" re-aplicando o degrau aqui.
        temTipoOficial = docs.some((d) => d.tipo);
        doclist.innerHTML = "";
        for (const d of docs) {
          const p = partesTitulo(d.titulo);
          const cls = classificarPeca(d);
          const row = document.createElement("label");
          row.className = "docrow " + cls.cat;
          // Relevância vai em DATASET, não em classe: as classes cat-* são
          // semânticas (DESIGN.md §2) e uma classe .rel-* convidaria a pendurar
          // cor nela — o eixo de cor já é a categoria. Aqui o dado serve aos
          // seletores dos atalhos de seleção, não à aparência.
          row.dataset.rel = cls.rel;
          row.dataset.busca = textoBusca(d); // título + tipo, sem acentos
          row.dataset.id = d.id; // usado pelo preview e pelo "ver na timeline"
          if (pecasEnviadas.has(d.id)) row.classList.add("enviada");
          // O TIPO oficial da grid descreve a peça melhor que o título (que é o
          // nome do arquivo) — vai no tooltip, sem custar um pixel na linha.
          const dica = d.tipo && d.tipo !== p.nome ? d.titulo + " — " + d.tipo : d.titulo;
          row.innerHTML =
            `<input type="checkbox" value="${escapeHtml(d.id)}">` +
            '<span class="d-dot" aria-hidden="true"></span>' +
            `<span class="d-t" title="${escapeHtml(dica)}">` +
            `<span class="d-nm">${escapeHtml(p.nome)}</span>` +
            (p.id ? `<span class="d-id">${p.id}</span>` : "") +
            "</span>" +
            // Data de juntada: o eixo CRONOLÓGICO que hoje só existe implícito
            // na ordem da lista. Vem da grid, então nem sempre existe. O CSS a
            // esconde nos modos estreitos, onde não há espaço para ela.
            (d.juntadoEm
              ? `<span class="d-dt">${escapeHtml(String(d.juntadoEm).slice(0, 10))}</span>`
              : "") +
            '<button type="button" class="d-ver" title="Ver esta peça na linha do tempo do processo" aria-label="Localizar esta peça na linha do tempo">' +
            SVG.ver + "</button>";
          if (cur.has(d.id)) row.querySelector("input").checked = true;
          doclist.appendChild(row);
        }
        if (!docs.length) {
          doclist.innerHTML = '<div class="empty">Nenhuma peça encontrada nesta tela.</div>';
        }
        filtrarDocs(); // re-aplica a busca ativa à lista recém-renderizada
        syncSelection();
        // A lista foi recriada: os índices da seleção em faixa não valem mais.
        ancoraSel = -1;
        fecharMenuSel();
        if (mention) updateMention(); // popup aberto: reflete a lista atualizada
      },
      // attachments: títulos das peças anexadas neste turno (opcional)
      addMessage(role, text, attachments) {
        clearEmptyHint();
        const el = document.createElement("div");
        el.className = "msg " + role;
        el.__entry = { role, text: text || "" };
        transcript.push(el.__entry);
        if (role === "assistant") {
          if (text) {
            estruturaAssistant(el).__body.innerHTML = renderMd(text);
          } else {
            // aguardando o modelo: indicador de digitação
            el.classList.add("typing");
            el.innerHTML = '<span class="dots"><i></i><i></i><i></i></span>';
          }
        } else {
          const txt = document.createElement("div");
          txt.className = "txt";
          txt.textContent = text;
          el.appendChild(txt);
          if (attachments && attachments.length) {
            const at = document.createElement("div");
            at.className = "msg-atts";
            for (const t of attachments) {
              const c = document.createElement("span");
              c.className = "chip-mini";
              c.innerHTML =
                SVG.doc + "<span title=\"" + escapeHtml(t) + "\">" +
                escapeHtml(tituloCurto(t)) + "</span>";
              at.appendChild(c);
            }
            el.appendChild(at);
          }
        }
        msgs.appendChild(el);
        msgs.scrollTop = msgs.scrollHeight;
        return el;
      },
      // cites: [{label, url?, id?, trecho?}] — citações do turno; viram
      // sobrescritos [n] no texto e uma lista numerada de fontes no rodapé da
      // bolha. Com `id` (peça do processo), a linha vira botão que rola a
      // timeline até a peça — é o que torna a resposta auditável nos autos.
      updateAssistant(el, fullText, cites) {
        estruturaAssistant(el);
        // recolhe o raciocínio quando a resposta começa a chegar
        if (el.__think && !el.__think.hidden && fullText) el.__think.open = false;
        let html = renderMd(fullText, cites);
        if (cites && cites.length) {
          // Peça dos autos e página da internet são coisas de natureza diferente
          // — uma é prova no processo, a outra é fonte externa —, e até aqui as
          // duas saíam na MESMA lista, com a mesma aparência. Num texto que mistura
          // os autos com jurisprudência (o caso de uso principal) isso apagava a
          // fronteira que mais importa juridicamente. Agora vão em grupos rotulados.
          //
          // O número (n) é capturado ANTES de agrupar e NADA é reordenado: ele é o
          // mesmo do sobrescrito no corpo do texto (placeholder PUA → <sup> no
          // renderMd), então mexer na ordem quebraria a correspondência entre a
          // marca na frase e a linha da fonte.
          const NIVEL_TITULO = {
            superior: "Tribunal superior (STF/STJ)",
            tribunal: "Tribunal deste processo",
            outra: "Outra fonte jurídica",
          };
          const numeradas = cites.map((c, i) => ({ c, n: i + 1 }));
          const ehWeb = (x) => !!(x.c.url && /^https?:\/\//.test(x.c.url));
          const daWeb = numeradas.filter(ehWeb);
          const dosAutos = numeradas.filter((x) => !ehWeb(x));

          const linha = ({ c, n }) => {
            const rot = escapeHtml(c.label);
            // O id só entra no DOM se for realmente numérico (vem do título
            // da peça, que é conteúdo dos autos).
            const id = /^\d+$/.test(String(c.id || "")) ? String(c.id) : "";
            let corpo;
            if (c.url && /^https?:\/\//.test(c.url)) {
              // fontes da web (busca de jurisprudência) viram links
              corpo =
                '<a href="' + escapeHtml(c.url) + '" target="_blank" rel="noopener">' +
                rot + "</a>";
              // Domínio de origem ao lado do título. No Gemini ele NÃO sai da URL
              // (que é um redirecionador do Google) e sim do title — ver
              // hostDaFonte em content.js. E quando o título JÁ É o domínio (o
              // caso do Gemini, que não manda manchete), repetir daria
              // "stj.jus.br stj.jus.br": mostra-se um só.
              if (c.host && c.host.toLowerCase() !== String(c.label || "").trim().toLowerCase()) {
                corpo +=
                  ' <span class="cite-host" title="' +
                  escapeHtml(NIVEL_TITULO[c.nivel] || "Fonte na web") + '">' +
                  escapeHtml(c.host) + "</span>";
              }
            } else if (id) {
              corpo =
                '<button type="button" class="cite-go" data-id="' + id + '"' +
                ' title="Ver esta peça na linha do tempo do processo">' +
                rot + ' <span class="cite-id">id ' + id + "</span></button>";
            } else {
              corpo = rot;
            }
            // char_location não tem folha: o trecho citado é a única âncora.
            if (c.trecho) {
              corpo +=
                ' <span class="cite-tr" title="' + escapeHtml(c.trecho) + '">“' +
                escapeHtml(c.trecho.slice(0, 60)) + "…”</span>";
            }
            return (
              '<span class="cite-row"' +
              (c.nivel ? ' data-nivel="' + escapeHtml(c.nivel) + '"' : "") +
              '><sup class="cit">' + n + "</sup> " + corpo + "</span>"
            );
          };

          // O título de grupo só existe quando HÁ fonte web: sem ela, "veio dos
          // autos" é a expectativa padrão do usuário e o rótulo seria só ruído.
          let bloco = '<div class="cites">';
          if (daWeb.length && dosAutos.length) {
            bloco += '<div class="cites-h">Peças dos autos</div>';
          }
          bloco += dosAutos.map(linha).join("");
          if (daWeb.length) {
            bloco +=
              '<div class="cites-h">Fontes na web (' + daWeb.length + ")</div>" +
              daWeb.map(linha).join("");
          }
          html += bloco + "</div>";
        }
        el.__body.innerHTML = html;
        if (el.__entry) {
          el.__entry.text = fullText;
          el.__entry.cites = cites || null;
        }
        msgs.scrollTop = msgs.scrollHeight;
      },
      // Resumo do raciocínio (thinking) em bloco colapsável no topo da bolha.
      setThinking(el, text) {
        estruturaAssistant(el);
        el.__think.hidden = !text;
        if (text) {
          if (!el.__body.innerHTML) el.__think.open = true;
          el.__thinkT.textContent = text;
        }
        msgs.scrollTop = msgs.scrollHeight;
      },
      removeMessage(el) {
        if (el) {
          const i = transcript.indexOf(el.__entry);
          if (i >= 0) transcript.splice(i, 1);
          el.remove();
        }
        showEmptyHint();
      },
      startPrep,
      setPrepState,
      endPrep,
      isSearchOn() {
        return searchOn;
      },
      onMinuta(cb) {
        minutaCb = cb;
      },
      onMapa(cb) {
        mapaCb = cb;
      },
      // Habilita a biblioteca de modelos só nos modelos de 1M tokens (chamada
      // pelo content.js quando as caps chegam/mudam).
      setModelosHabilitado,
      // Número CNJ do processo, exibido sob o nome do produto no cabeçalho.
      setProcesso(num) {
        const el = $(".cnj");
        if (el) el.textContent = num || "";
      },
      // Resultado do mapa mental: em vez do markdown cru (longo e repetitivo)
      // a bolha vira um card com as ações, e o texto fica num <details>
      // recolhido. O card é escrito no __body da bolha — depois disso NÃO se
      // pode chamar updateAssistant nesse elemento (ela reescreve o innerHTML).
      mostrarCardMapa(el, info) {
        if (!el || !info) return;
        estruturaAssistant(el);
        const entry = el.__entry;
        if (entry) entry.text = info.md || ""; // exportar .md leva o mapa inteiro
        el.__body.innerHTML =
          '<div class="mapacard">' +
          '<div class="mapacard-t">' + SVG.mapa + ' <b>Mapa mental gerado</b>' +
          (info.resumo ? " — " + escapeHtml(info.resumo) : "") +
          "</div>" +
          '<div class="mapacard-acts">' +
          '<button class="mapacard-abrir">Abrir mapa</button>' +
          '<button class="mapacard-md">' + SVG.zip + ' Baixar .md</button>' +
          "</div>" +
          "<details class=\"mapacard-src\"><summary>Ver o texto do mapa</summary>" +
          '<div class="mapacard-md-body">' + renderMd(info.md || "") + "</div>" +
          "</details>" +
          "</div>";
        el.__body
          .querySelector(".mapacard-abrir")
          .addEventListener("click", () => info.onAbrir && info.onAbrir());
        el.__body
          .querySelector(".mapacard-md")
          .addEventListener("click", () => info.onBaixar && info.onBaixar());
        // abrir o texto do mapa cresce a bolha para fora da área visível
        el.__body.querySelector(".mapacard-src").addEventListener("toggle", () => {
          msgs.scrollTop = msgs.scrollHeight;
        });
        msgs.scrollTop = msgs.scrollHeight;
      },
      // Resultado da minuta: mesmo contrato do card do mapa (o __body é
      // reescrito — NÃO chamar updateAssistant nesse elemento depois disto).
      // O texto fica no <details> porque a minuta é longa e o que interessa
      // no chat é a AÇÃO: abrir no editor.
      mostrarCardMinuta(el, info) {
        if (!el || !info) return;
        estruturaAssistant(el);
        const entry = el.__entry;
        if (entry) entry.text = info.md || "";
        el.__body.innerHTML =
          '<div class="mapacard minutacard">' +
          '<div class="mapacard-t">' + SVG.minuta + ' <b>Minuta gerada</b>' +
          (info.resumo ? " — " + escapeHtml(info.resumo) : "") +
          "</div>" +
          '<div class="mapacard-acts">' +
          '<button class="mapacard-abrir">Abrir no editor</button>' +
          '<button class="mapacard-md">' + SVG.zip + ' Baixar .md</button>' +
          "</div>" +
          '<details class="mapacard-src"><summary>Ver o texto da minuta</summary>' +
          '<div class="mapacard-md-body">' + renderMd(info.md || "") + "</div>" +
          "</details>" +
          "</div>";
        el.__body
          .querySelector(".mapacard-abrir")
          .addEventListener("click", () => info.onAbrir && info.onAbrir());
        el.__body
          .querySelector(".mapacard-md")
          .addEventListener("click", () => info.onBaixar && info.onBaixar());
        el.__body.querySelector(".mapacard-src").addEventListener("toggle", () => {
          msgs.scrollTop = msgs.scrollHeight;
        });
        msgs.scrollTop = msgs.scrollHeight;
      },
      // Oferta de editor ao fim de uma resposta de chat COMUM: uma linha de
      // ação abaixo da bolha. Fica no próprio elemento da mensagem (irmã do
      // .body), e não dentro dele, para sobreviver a um updateAssistant
      // posterior. `destaque` a torna um botão cheio — é o que a heurística de
      // intenção liga quando o usuário claramente pediu uma peça redigida.
      adicionarAcaoEditor(el, info) {
        if (!el || !info || el.querySelector(".editor-act")) return;
        estruturaAssistant(el);
        const box = document.createElement("div");
        box.className = "editor-act" + (info.destaque ? " destaque" : "");
        const b = document.createElement("button");
        b.innerHTML =
        SVG.minuta +
        '<span class="lbl">' +
        (info.destaque ? "Abrir no editor" : "Editar como documento") +
        "</span>";
        b.title =
          "Abre esta resposta num editor de texto, em nova aba: revise, copie para " +
          "o PJe, baixe em Word (.docx) ou imprima.";
        b.addEventListener("click", () => info.onAbrir && info.onAbrir(b));
        box.appendChild(b);
        // Quem pede a peça no CHAT comum nunca passa pela barra do modo minuta
        // — e é lá que vive a escolha dos modelos. Sem esta ação a biblioteca
        // fica invisível justamente para quem acabou de pedir uma peça
        // redigida, que é o público dela. Só quando a heurística reconheceu o
        // pedido (`destaque`) e a feature está disponível: numa resposta
        // analítica qualquer, a linha seria ruído.
        if (info.destaque && temMlib && modelosHabilitado && modelosLib.length) {
          const alt = document.createElement("button");
          alt.className = "editor-alt";
          alt.textContent = "Refazer seguindo seus modelos";
          alt.title =
            "Liga o modo minuta, onde você escolhe a categoria das suas peças-modelo: " +
            "o assistente segue a estrutura e o estilo delas (os fatos continuam saindo " +
            "só das peças do processo).";
          alt.addEventListener("click", () => {
            if (!minutaMode) btnMinuta.click(); // reusa validação e instrução padrão
            inEl.focus();
          });
          box.appendChild(alt);
        }
        el.appendChild(box);
        msgs.scrollTop = msgs.scrollHeight;
      },
      // busy=true mostra um spinner antes do texto (trabalho em andamento —
      // análise, geração de documento, upload…), para o usuário ver que a
      // extensão está trabalhando e não travada.
      // `icone` troca o anel genérico de "trabalhando" por um símbolo do que
      // está acontecendo — hoje só "busca" (lupa). O anel diz que ALGO ocorre;
      // a lupa diz O QUE, que é a informação que o usuário quer durante uma
      // pesquisa de jurisprudência.
      setStatus(s, busy, icone) {
        statusEl.textContent = s || "";
        statusEl.classList.toggle("busy", !!busy && !!s);
        statusEl.classList.toggle("buscando", !!busy && !!s && icone === "busca");
      },
      // Nota dentro do card de progresso — hoje usada para avisar que o
      // download está lento. Aparece DURANTE a espera, que é quando a
      // informação vale: um aviso estático sobre Wi-Fi seria ignorado por quem
      // está com rede boa e visto tarde demais por quem não está.
      setPrepNota(texto) {
        if (!prepEl) return;
        let nota = prepEl.querySelector(".prep-nota");
        if (!texto) {
          if (nota) nota.remove();
          return;
        }
        if (!nota) {
          nota = document.createElement("div");
          nota.className = "prep-nota";
          prepEl.appendChild(nota);
        }
        nota.textContent = texto;
      },
      // Relatório das peças que não puderam ser baixadas neste turno.
      //
      // Vive NO CHAT, e não no .status (que é transitório) nem na .alertbar (que
      // é para o que impede de continuar): a análise seguiu com o resto, e o
      // usuário precisa poder ler com calma qual peça faltou e por quê, para
      // tentar de novo depois. Antes, uma única peça com 404 abortava o turno
      // inteiro e a pergunta já digitada se perdia.
      //
      // Fica FECHADO por padrão — é informação de diagnóstico, não deve competir
      // com a resposta.
      // `opts` ({titulo, dica}) existe porque a mesma estrutura — lista de
      // peças + motivo + o que fazer a respeito — serve para mais de um tipo
      // de perda parcial. Hoje: peça que não baixou (padrão) e peça de texto
      // longa demais, que entrou cortada. Sem os opts, o texto é byte a byte o
      // de antes.
      mostrarFalhasPecas(falhas, opts) {
        if (!falhas || !falhas.length) return null;
        const o = opts || {};
        const el = document.createElement("details");
        el.className = "falhas";
        const n = falhas.length;
        const sum = document.createElement("summary");
        sum.textContent =
          o.titulo ||
          (n === 1
            ? "1 peça não pôde ser baixada e ficou de fora desta análise"
            : n + " peças não puderam ser baixadas e ficaram de fora desta análise");
        el.appendChild(sum);
        const ul = document.createElement("ul");
        for (const f of falhas) {
          const li = document.createElement("li");
          const t = document.createElement("b");
          // conteúdo dos autos: textContent, nunca innerHTML
          t.textContent = f.titulo || String(f.id);
          li.appendChild(t);
          const m = document.createElement("span");
          m.textContent = " — " + (f.erro || "falha ao baixar");
          li.appendChild(m);
          ul.appendChild(li);
        }
        el.appendChild(ul);
        const p = document.createElement("p");
        p.className = "falhas-dica";
        p.textContent =
          o.dica ||
          "Elas continuam marcadas: no próximo envio a extensão tenta de novo. Se persistir, abra a peça na linha do tempo do PJe uma vez e envie outra vez.";
        el.appendChild(p);
        msgs.appendChild(el);
        msgs.scrollTop = msgs.scrollHeight;
        return el;
      },

      // Medidor de contexto da conversa: barra + resumo (tokens e páginas
      // acumulados no request vs. limites do modelo). null esconde.
      setContexto(info) {
        if (!info || !info.ctxTokens) {
          gaugeEl.hidden = true;
          return;
        }
        const pctTok = info.tokens / info.ctxTokens;
        const pctPag = info.maxPaginas ? (info.paginas || 0) / info.maxPaginas : 0;
        const pct = Math.min(1, Math.max(pctTok, pctPag));
        gaugeFill.style.width = Math.round(pct * 100) + "%";
        gaugeEl.classList.toggle("warn", pct >= 0.7 && pct < 0.9);
        gaugeEl.classList.toggle("crit", pct >= 0.9);
        // as peças ainda sem download entram nas DUAS versões: fingir precisão
        // seria pior do que a frase ficar um pouco mais longa
        const pend = info.pendentes ? " · " + info.pendentes + " sem medir" : "";
        gaugeFull.textContent =
          (info.pecas || 0) + " peças · ~" +
          Math.round(info.tokens / 1000) + " mil tokens (" +
          Math.round(pctTok * 100) + "%)" +
          (info.maxPaginas
            ? " · " + (info.paginas || 0) + "/" + info.maxPaginas + " págs."
            : "") +
          pend;
        // forma curta (painel estreito): o percentual é o dado acionável
        gaugeShort.textContent =
          Math.round(pct * 100) + "% · " + (info.pecas || 0) + " peças" + pend;
        gaugeEl.title = GAUGE_TITLE + " — " + gaugeFull.textContent;
        gaugeEl.hidden = false;
      },
      // Custo estimado da conversa (US$, calculado pelo worker a partir do
      // usage da API × tabela de preços do modelo). null esconde e zera.
      setCusto(info) {
        if (!info) {
          custoEl.hidden = true;
          custoFull.textContent = "";
          custoShort.textContent = "";
          return;
        }
        custoFull.textContent =
          "~" + fmtUsd(info.turnoUsd) + " nesta resposta · ~" +
          fmtUsd(info.conversaUsd) + " na conversa";
        // curta: o acumulado da conversa é o número que importa no dia a dia
        custoShort.textContent = "~" + fmtUsd(info.conversaUsd);
        const prov = info.provedorNome || "Anthropic";
        const u = info.usage;
        custoEl.title = u
          ? "Estimativa pela tabela de preços da " + prov + " (não inclui impostos). " +
            "Última resposta: " +
            fmtMil(u.input_tokens) + " tokens de entrada, " +
            fmtMil((u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)) +
            " de cache (bem mais baratos) e " +
            fmtMil(u.output_tokens) + " gerados."
          : "Estimativa pela tabela de preços da " + prov + ".";
        custoEl.hidden = false;
      },
      // Barra de ALERTA persistente (contexto cheio): diferente do status
      // (transitório), fica visível até ser resolvida — com ação de recomeço.
      // null/"" esconde.
      setAlerta(msg) {
        if (!msg) {
          alertEl.hidden = true;
          alertEl.innerHTML = "";
          return;
        }
        alertEl.innerHTML =
          '<span class="alert-t">' + escapeHtml(msg) + "</span>" +
          '<button class="alert-reset" title="Começar uma nova conversa do zero">' +
          SVG.reset + " Nova conversa</button>";
        alertEl
          .querySelector(".alert-reset")
          .addEventListener("click", () => resetCb && resetCb());
        alertEl.hidden = false;
      },
      lockInput(b) {
        inEl.disabled = b;
        sendBtn.disabled = b;
        // trava também as ações — clicar durante uma resposta não faz nada,
        // e botão ativo-porém-morto confunde.
        tglSearch.disabled = b;
        btnMinuta.disabled = b;
        btnMapa.disabled = b;
        btnPlib.disabled = b;
        const px = promptbar.querySelector(".pchip-x");
        if (px) px.disabled = b;
      },
      // Nota discreta sobre o modo de citações do modelo atual: "textual"
      // (Gemini — páginas citadas no próprio texto) mostra a nota; "nativa"
      // (Claude — marcadores [n] automáticos) esconde.
      setModoCitacoes(modo) {
        citeNote.hidden = modo !== "textual";
      },
      // Selo do modelo ATIVO na barra de ferramentas ("Gemini 3.6 Flash ·
      // raciocínio alto") — o usuário vê na hora que a troca nas opções
      // valeu, sem precisar confiar às cegas. info: {model, effort, comEffort}.
      setModelo(info) {
        if (!info || !info.model) {
          modeloBadge.hidden = true;
          return;
        }
        const NOMES = {
          "claude-haiku-4-5": "Claude Haiku 4.5",
          "claude-sonnet-5": "Claude Sonnet 5",
          "claude-opus-4-8": "Claude Opus 4.8",
          "claude-fable-5": "Claude Fable 5",
          "gemini-3.6-flash": "Gemini 3.6 Flash",
          "gemini-3.5-flash-lite": "Gemini 3.5 Flash-Lite",
          // Os três GPT faltavam desde que a OpenAI entrou: o fallback abaixo
          // não quebra nada, mas põe o id cru ("gpt-5.6-luna") num selo cujo
          // trabalho é dizer ao usuário, na língua dele, qual modelo respondeu.
          "gpt-5.6-sol": "GPT-5.6 Sol",
          "gpt-5.6-terra": "GPT-5.6 Terra",
          "gpt-5.6-luna": "GPT-5.6 Luna",
        };
        const EFFORTS = { high: "alto", medium: "médio", low: "baixo" };
        let txt = NOMES[info.model] || info.model;
        // modelos sem suporte a effort (Haiku) não mostram o nível — exibir
        // um valor que a API não recebe seria mentira
        if (info.comEffort && EFFORTS[info.effort]) {
          txt += " · raciocínio " + EFFORTS[info.effort];
        }
        modeloBadge.textContent = txt;
        modeloBadge.hidden = false;
      },
    };
  }

  return {
    mount,
    _renderMd: renderMd,
    _findSlashToken: findSlashToken,
    _montarTextoEnvio: montarTextoEnvio,
    _classificarPeca: classificarPeca,
  };
})();
