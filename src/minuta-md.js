// Conversor Markdown -> HTML dedicado à MINUTA (peça judicial).
//
// Por que não reusar o renderMd do painel: aquele é o renderizador do balão de
// CHAT — achata listas aninhadas e junta parágrafos com <br>. Uma peça
// profissional precisa de listas com níveis reais (I → a) → -), parágrafos
// separados, tabelas com alinhamento e títulos no nível certo. Este módulo faz
// isso, mantendo o princípio de segurança do projeto: ESCAPA PRIMEIRO, formata
// depois (o conteúdo vem dos autos; sem isso um `<img onerror>` numa petição
// executaria).
//
// Roda na página do editor (script normal). Exposto em window.MinutaMd e, para
// os testes fora do navegador, em module.exports.

var MinutaMd = (function () {
  "use strict";

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  // Formatação inline — roda SOBRE texto já escapado. Ordem importa: código
  // primeiro (protege o conteúdo), depois negrito, itálico, tachado e link.
  function inlineMd(s) {
    var h = s;
    h = h.replace(/`([^`]+)`/g, "<code>$1</code>");
    h = h.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    h = h.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    // itálico: um * isolado (os ** já viraram <strong>), sem colar em palavra
    h = h.replace(/(^|[\s(>])\*([^*\s][^*]*?)\*(?=[\s).,;:!?]|<|$)/g, "$1<em>$2</em>");
    h = h.replace(/~~([^~]+)~~/g, "<s>$1</s>");
    h = h.replace(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener">$1</a>'
    );
    return h;
  }

  // ------------------------------------------------------------------ tabelas

  function celulas(linha) {
    var l = linha.trim();
    if (l.charAt(0) === "|") l = l.slice(1);
    if (l.charAt(l.length - 1) === "|") l = l.slice(0, -1);
    return l.split("|").map(function (c) {
      return c.trim();
    });
  }
  function ehSeparadorTabela(linha) {
    if (linha.indexOf("-") === -1 || linha.indexOf("|") === -1) return false;
    var cs = celulas(linha);
    return (
      cs.length > 0 &&
      cs.every(function (c) {
        return /^:?-+:?$/.test(c.replace(/\s/g, ""));
      })
    );
  }
  function alinhamento(sep) {
    var s = sep.trim();
    var l = s.charAt(0) === ":";
    var r = s.charAt(s.length - 1) === ":";
    if (l && r) return "center";
    if (r) return "right";
    if (l) return "left";
    return "";
  }

  // ------------------------------------------------------------------ listas

  var RE_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

  // Constrói a árvore de itens a partir da lista achatada, pela INDENTAÇÃO —
  // é o que dá os níveis reais (o renderMd do chat não faz isto).
  function arvoreDeItens(itens) {
    var raiz = [];
    var pilha = [{ indent: -1, filhos: raiz }];
    itens.forEach(function (it) {
      while (pilha.length > 1 && it.indent <= pilha[pilha.length - 1].indent) pilha.pop();
      var no = { ol: it.ol, text: it.text, filhos: [] };
      pilha[pilha.length - 1].filhos.push(no);
      pilha.push({ indent: it.indent, filhos: no.filhos });
    });
    return raiz;
  }

  function emitirLista(nos) {
    var html = "";
    var i = 0;
    while (i < nos.length) {
      var ol = nos[i].ol;
      var tag = ol ? "ol" : "ul";
      html += "<" + tag + ">";
      while (i < nos.length && nos[i].ol === ol) {
        var n = nos[i++];
        html +=
          "<li>" + inlineMd(n.text) + (n.filhos.length ? emitirLista(n.filhos) : "") + "</li>";
      }
      html += "</" + tag + ">";
    }
    return html;
  }

  // --------------------------------------------------------------- parser de blocos

  function paraHtml(md) {
    var src = escapeHtml(String(md == null ? "" : md).replace(/\r\n?/g, "\n"));
    var lines = src.split("\n");
    var out = [];
    var i = 0;

    while (i < lines.length) {
      var line = lines[i];

      // bloco de código cercado
      if (/^\s*```/.test(line)) {
        var buf = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
        i++; // pula o fecho
        out.push("<pre><code>" + buf.join("\n") + "</code></pre>");
        continue;
      }

      // tabela: linha com | seguida do separador |---|
      if (line.indexOf("|") !== -1 && i + 1 < lines.length && ehSeparadorTabela(lines[i + 1])) {
        var head = celulas(line);
        var aligns = celulas(lines[i + 1]).map(alinhamento);
        i += 2;
        var linhas = [];
        while (i < lines.length && lines[i].indexOf("|") !== -1 && lines[i].trim() !== "") {
          linhas.push(celulas(lines[i++]));
        }
        var estilo = function (k) {
          return aligns[k] ? ' style="text-align:' + aligns[k] + '"' : "";
        };
        var t = "<table><thead><tr>";
        head.forEach(function (c, k) {
          t += "<th" + estilo(k) + ">" + inlineMd(c) + "</th>";
        });
        t += "</tr></thead><tbody>";
        linhas.forEach(function (r) {
          t += "<tr>";
          for (var k = 0; k < head.length; k++) {
            t += "<td" + estilo(k) + ">" + inlineMd(r[k] || "") + "</td>";
          }
          t += "</tr>";
        });
        t += "</tbody></table>";
        out.push(t);
        continue;
      }

      // título (nível REAL: # -> h1, ## -> h2 …)
      var h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        var lvl = h[1].length;
        out.push("<h" + lvl + ">" + inlineMd(h[2].replace(/\s+#+\s*$/, "")) + "</h" + lvl + ">");
        i++;
        continue;
      }

      // linha divisória
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
        out.push("<hr>");
        i++;
        continue;
      }

      // citação recuada (> …), com parágrafos internos separados por <br>
      if (/^\s*&gt;\s?/.test(line)) {
        var q = [];
        while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) {
          q.push(lines[i].replace(/^\s*&gt;\s?/, ""));
          i++;
        }
        out.push("<blockquote>" + q.map(inlineMd).join("<br>") + "</blockquote>");
        continue;
      }

      // lista (com ou sem aninhamento) — coleta as linhas de item consecutivas
      if (RE_ITEM.test(line)) {
        var itens = [];
        while (i < lines.length && RE_ITEM.test(lines[i])) {
          var m = lines[i].match(RE_ITEM);
          itens.push({
            indent: m[1].replace(/\t/g, "  ").length,
            ol: /\d/.test(m[2]),
            text: m[3],
          });
          i++;
        }
        out.push(emitirLista(arvoreDeItens(itens)));
        continue;
      }

      // linha em branco
      if (line.trim() === "") {
        i++;
        continue;
      }

      // parágrafo: junta linhas consecutivas até um bloco ou linha em branco.
      // Duas ou mais linhas no mesmo parágrafo viram uma frase corrida (espaço);
      // um recuo de fim de linha com dois espaços vira quebra dura (<br>).
      var par = [];
      while (
        i < lines.length &&
        lines[i].trim() !== "" &&
        !/^\s*(#{1,6}\s|```|&gt;)/.test(lines[i]) &&
        !RE_ITEM.test(lines[i]) &&
        !/^\s*([-*_])(\s*\1){2,}\s*$/.test(lines[i]) &&
        !(
          lines[i].indexOf("|") !== -1 &&
          i + 1 < lines.length &&
          ehSeparadorTabela(lines[i + 1])
        )
      ) {
        par.push(lines[i]);
        i++;
      }
      var texto = "";
      par.forEach(function (l, k) {
        var quebraDura = /\s\s$/.test(l);
        texto += inlineMd(l.replace(/\s+$/, ""));
        if (k < par.length - 1) texto += quebraDura ? "<br>" : " ";
      });
      out.push("<p>" + texto + "</p>");
    }

    return out.join("");
  }

  return { paraHtml: paraHtml, _inlineMd: inlineMd };
})();

if (typeof module !== "undefined" && module.exports) module.exports = MinutaMd;
