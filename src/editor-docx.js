// Conversão HTML → .docx no próprio navegador, com a biblioteca `docx`
// (vendor/docx.iife.js, global `docx`).
//
// Por que um mapeador nosso em vez de uma lib "HTML entra, docx sai": o
// documento aqui é uma peça judicial, e o que importa é a formatação forense —
// A4, margens 3/2 cm, Times 12, entrelinha 1,5 e recuo de 1,25 cm na primeira
// linha. Uma conversão genérica aproxima isso a partir do CSS; aqui a página
// é gravada com essas medidas exatas, as mesmas que o editor.css desenha na
// tela. O que se vê é o que se imprime.
//
// Expõe: window.EditorDocx.gerarBlob(htmlOuElemento, titulo) → Promise<Blob>

var EditorDocx = (function () {
  "use strict";

  // ------------------------------------------------------------- medidas
  // Tudo em twips (1/20 de ponto). 1 cm = 566,93 twips.
  const CM = 566.93;
  const cm = (n) => Math.round(n * CM);

  const PAGINA = {
    size: { width: cm(21), height: cm(29.7) }, // A4
    margin: { top: cm(3), right: cm(2), bottom: cm(2), left: cm(3) },
  };
  const FONTE = "Times New Roman";
  const TAM = 24; // meios-pontos → 12 pt
  const ENTRELINHA = 360; // 240 = simples; 360 = 1,5
  const RECUO_1A_LINHA = cm(1.25);
  const NUM_REF = "lista-numerada";

  // ------------------------------------------------------------- inline

  // Formatação acumulada enquanto se desce pelos nós de texto.
  function comFormato(fmt, extra) {
    return Object.assign({}, fmt, extra);
  }

  function textRun(texto, fmt) {
    return new docx.TextRun({
      text: texto,
      bold: !!fmt.bold,
      italics: !!fmt.italics,
      underline: fmt.underline ? {} : undefined,
      strike: !!fmt.strike,
      superScript: !!fmt.sup,
      subScript: !!fmt.sub,
      font: fmt.mono ? "Courier New" : FONTE,
      size: fmt.mono ? TAM - 2 : TAM,
    });
  }

  // Percorre o conteúdo de um bloco e devolve os runs, preservando negrito,
  // itálico, sublinhado, links e quebras de linha.
  function runsDe(no, fmt, saida) {
    saida = saida || [];
    fmt = fmt || {};

    for (const filho of Array.from(no.childNodes)) {
      if (filho.nodeType === 3) {
        // Nó de texto: o HTML colapsa espaços, o Word não — normaliza aqui.
        const t = filho.nodeValue.replace(/\s+/g, " ");
        if (t) saida.push(textRun(t, fmt));
        continue;
      }
      if (filho.nodeType !== 1) continue;

      const tag = filho.tagName.toLowerCase();
      if (tag === "br") {
        saida.push(new docx.TextRun({ break: 1 }));
        continue;
      }
      if (tag === "a" && filho.getAttribute("href")) {
        const dentro = runsDe(filho, comFormato(fmt, { underline: true }), []);
        saida.push(
          new docx.ExternalHyperlink({
            children: dentro,
            link: filho.getAttribute("href"),
          })
        );
        continue;
      }

      let extra = null;
      if (tag === "strong" || tag === "b") extra = { bold: true };
      else if (tag === "em" || tag === "i") extra = { italics: true };
      else if (tag === "u" || tag === "ins") extra = { underline: true };
      else if (tag === "s" || tag === "strike" || tag === "del") extra = { strike: true };
      else if (tag === "code" || tag === "kbd" || tag === "samp") extra = { mono: true };
      else if (tag === "sup") extra = { sup: true };
      else if (tag === "sub") extra = { sub: true };

      // O Jodit escreve negrito/itálico também como estilo inline.
      const st = filho.style || {};
      const peso = String(st.fontWeight || "");
      if (peso === "bold" || peso === "bolder" || Number(peso) >= 600) {
        extra = comFormato(extra || {}, { bold: true });
      }
      if (st.fontStyle === "italic") extra = comFormato(extra || {}, { italics: true });
      if (String(st.textDecoration || "").includes("underline")) {
        extra = comFormato(extra || {}, { underline: true });
      }
      if (String(st.textDecoration || "").includes("line-through")) {
        extra = comFormato(extra || {}, { strike: true });
      }

      runsDe(filho, extra ? comFormato(fmt, extra) : fmt, saida);
    }
    return saida;
  }

  function temTexto(runs) {
    return runs.length > 0;
  }

  // ------------------------------------------------------------- blocos

  const ALINHAMENTOS = {
    left: docx.AlignmentType.LEFT,
    right: docx.AlignmentType.RIGHT,
    center: docx.AlignmentType.CENTER,
    justify: docx.AlignmentType.JUSTIFIED,
    start: docx.AlignmentType.LEFT,
    end: docx.AlignmentType.RIGHT,
  };
  function alinhamentoDe(el, padrao) {
    const a = el && el.style && el.style.textAlign;
    return (a && ALINHAMENTOS[a]) || padrao;
  }

  const NIVEIS = [
    docx.HeadingLevel.HEADING_1,
    docx.HeadingLevel.HEADING_2,
    docx.HeadingLevel.HEADING_3,
    docx.HeadingLevel.HEADING_4,
    docx.HeadingLevel.HEADING_5,
    docx.HeadingLevel.HEADING_6,
  ];

  function paragrafoTitulo(el, n) {
    return new docx.Paragraph({
      children: runsDe(el, { bold: true }),
      heading: NIVEIS[n - 1],
      alignment: alinhamentoDe(el, docx.AlignmentType.CENTER),
      spacing: { before: 280, after: 200, line: ENTRELINHA },
    });
  }

  function paragrafoTexto(el, opts) {
    opts = opts || {};
    const runs = runsDe(el, {});
    if (!temTexto(runs)) return null;
    return new docx.Paragraph({
      children: runs,
      alignment: alinhamentoDe(el, docx.AlignmentType.JUSTIFIED),
      spacing: { after: opts.after == null ? 120 : opts.after, line: ENTRELINHA },
      indent: opts.indent === null ? undefined : opts.indent || { firstLine: RECUO_1A_LINHA },
    });
  }

  // Listas: o Word numera por referência declarada no documento; marcadores
  // saem pelo `bullet` nativo. `nivel` acompanha o aninhamento das <ul>/<ol>.
  function itensDeLista(lista, ordenada, nivel, saida) {
    for (const li of Array.from(lista.children)) {
      if (li.tagName.toLowerCase() !== "li") continue;

      // Separa o texto do próprio item das sublistas que ele contenha.
      const sublistas = [];
      const clone = li.cloneNode(true);
      for (const sub of Array.from(clone.querySelectorAll(":scope > ul, :scope > ol"))) {
        sublistas.push(sub);
        sub.remove();
      }

      const runs = runsDe(clone, {});
      if (temTexto(runs)) {
        saida.push(
          new docx.Paragraph({
            children: runs,
            alignment: docx.AlignmentType.JUSTIFIED,
            spacing: { after: 80, line: ENTRELINHA },
            numbering: ordenada
              ? { reference: NUM_REF, level: Math.min(nivel, 2) }
              : undefined,
            bullet: ordenada ? undefined : { level: Math.min(nivel, 2) },
          })
        );
      }
      for (const sub of sublistas) {
        itensDeLista(sub, sub.tagName.toLowerCase() === "ol", nivel + 1, saida);
      }
    }
    return saida;
  }

  function celula(td, cabecalho) {
    const runs = runsDe(td, cabecalho ? { bold: true } : {});
    return new docx.TableCell({
      children: [
        new docx.Paragraph({
          children: temTexto(runs) ? runs : [textRun("", {})],
          alignment: docx.AlignmentType.LEFT,
          spacing: { after: 0, line: 240 },
        }),
      ],
      shading: cabecalho ? { fill: "EAF2F7" } : undefined,
      margins: { top: 60, bottom: 60, left: 90, right: 90 },
    });
  }

  function tabela(el) {
    const linhas = [];
    for (const tr of Array.from(el.querySelectorAll("tr"))) {
      const celulas = Array.from(tr.children).filter((c) =>
        ["td", "th"].includes(c.tagName.toLowerCase())
      );
      if (!celulas.length) continue;
      linhas.push(
        new docx.TableRow({
          children: celulas.map((c) => celula(c, c.tagName.toLowerCase() === "th")),
          tableHeader: celulas[0].tagName.toLowerCase() === "th",
        })
      );
    }
    if (!linhas.length) return null;
    return new docx.Table({
      rows: linhas,
      width: { size: 100, type: docx.WidthType.PERCENTAGE },
    });
  }

  // Um <div> ou <span> solto do Jodit conta como parágrafo; um <div> que só
  // embrulha outros blocos é atravessado, senão o texto sairia duplicado.
  const BLOCOS = new Set([
    "p", "div", "h1", "h2", "h3", "h4", "h5", "h6",
    "ul", "ol", "table", "blockquote", "pre", "hr",
  ]);
  function ehContainer(el) {
    return Array.from(el.children).some((f) => BLOCOS.has(f.tagName.toLowerCase()));
  }

  function blocosDe(raiz) {
    const saida = [];

    for (const no of Array.from(raiz.childNodes)) {
      // Texto solto na raiz (acontece ao colar) vira parágrafo.
      if (no.nodeType === 3) {
        const t = no.nodeValue.replace(/\s+/g, " ").trim();
        if (t) {
          saida.push(
            new docx.Paragraph({
              children: [textRun(t, {})],
              alignment: docx.AlignmentType.JUSTIFIED,
              spacing: { after: 120, line: ENTRELINHA },
              indent: { firstLine: RECUO_1A_LINHA },
            })
          );
        }
        continue;
      }
      if (no.nodeType !== 1) continue;

      const tag = no.tagName.toLowerCase();
      const h = /^h([1-6])$/.exec(tag);

      if (h) {
        saida.push(paragrafoTitulo(no, Number(h[1])));
      } else if (tag === "ul" || tag === "ol") {
        itensDeLista(no, tag === "ol", 0, saida);
      } else if (tag === "table") {
        const t = tabela(no);
        if (t) {
          saida.push(t);
          // O Word cola tabelas consecutivas se não houver parágrafo entre elas.
          saida.push(new docx.Paragraph({ children: [], spacing: { after: 120 } }));
        }
      } else if (tag === "blockquote") {
        for (const p of blocosDe(no)) saida.push(p);
      } else if (tag === "hr") {
        saida.push(
          new docx.Paragraph({
            children: [],
            border: { bottom: { style: docx.BorderStyle.SINGLE, size: 6, color: "999999" } },
            spacing: { before: 120, after: 200 },
          })
        );
      } else if (tag === "pre") {
        const p = paragrafoTexto(no, { indent: null });
        if (p) saida.push(p);
      } else if (tag === "div" && ehContainer(no)) {
        for (const b of blocosDe(no)) saida.push(b);
      } else if (tag === "script" || tag === "style") {
        continue;
      } else {
        const p = paragrafoTexto(no);
        if (p) saida.push(p);
      }
    }
    return saida;
  }

  // ------------------------------------------------------------- documento

  function estilos() {
    const tituloBase = {
      run: { font: FONTE, color: "000000", bold: true },
      paragraph: { spacing: { before: 280, after: 200, line: ENTRELINHA } },
    };
    return {
      default: {
        document: {
          run: { font: FONTE, size: TAM },
          paragraph: { spacing: { line: ENTRELINHA, after: 120 } },
        },
        heading1: {
          run: { font: FONTE, size: TAM + 4, bold: true, color: "000000" },
          paragraph: tituloBase.paragraph,
        },
        heading2: { run: { font: FONTE, size: TAM, bold: true, color: "000000" }, paragraph: tituloBase.paragraph },
        heading3: { run: { font: FONTE, size: TAM, bold: true, italics: true, color: "000000" }, paragraph: tituloBase.paragraph },
        heading4: { run: { font: FONTE, size: TAM, bold: true, color: "000000" }, paragraph: tituloBase.paragraph },
        heading5: { run: { font: FONTE, size: TAM, bold: true, color: "000000" }, paragraph: tituloBase.paragraph },
        heading6: { run: { font: FONTE, size: TAM, bold: true, color: "000000" }, paragraph: tituloBase.paragraph },
      },
    };
  }

  function numeracao() {
    const nivel = (n, formato, texto) => ({
      level: n,
      format: formato,
      text: texto,
      alignment: docx.AlignmentType.START,
      style: { paragraph: { indent: { left: cm(1.25) * (n + 1), hanging: cm(0.6) } } },
    });
    return {
      config: [
        {
          reference: NUM_REF,
          levels: [
            nivel(0, docx.LevelFormat.DECIMAL, "%1."),
            nivel(1, docx.LevelFormat.LOWER_LETTER, "%2)"),
            nivel(2, docx.LevelFormat.LOWER_ROMAN, "%3."),
          ],
        },
      ],
    };
  }

  // htmlOuElemento: string de HTML ou um elemento já no DOM.
  function gerarBlob(htmlOuElemento, titulo) {
    let raiz;
    if (typeof htmlOuElemento === "string") {
      // DOMParser não executa scripts nem carrega recursos — é o caminho
      // seguro para HTML que teve origem na resposta de um modelo.
      raiz = new DOMParser().parseFromString(
        "<body>" + htmlOuElemento + "</body>",
        "text/html"
      ).body;
    } else {
      raiz = htmlOuElemento;
    }

    let filhos = blocosDe(raiz);
    if (!filhos.length) filhos = [new docx.Paragraph({ children: [textRun("", {})] })];

    const doc = new docx.Document({
      creator: "TecJustiça PJe",
      title: titulo || "Minuta",
      description: "Minuta gerada e editada na extensão TecJustiça PJe",
      styles: estilos(),
      numbering: numeracao(),
      sections: [{ properties: { page: PAGINA }, children: filhos }],
    });
    return docx.Packer.toBlob(doc);
  }

  return { gerarBlob, _blocosDe: blocosDe };
})();

if (typeof module !== "undefined" && module.exports) module.exports = EditorDocx;
