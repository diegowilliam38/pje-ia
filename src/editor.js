// Editor de minutas — página própria da extensão (chrome-extension://).
//
// Por que uma aba e não um modal no painel: o painel vive em Shadow DOM, e
// `document.getSelection()` não atravessa essa fronteira — todo editor rico
// quebra ali. É a mesma razão de fundo que levou o mapa mental para uma página
// própria (lá, a CSP do tribunal). A página lê a minuta de
// `chrome.storage.local` pelo `?id=` da URL e grava de volta as edições.

(function () {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const elTitulo = $("#titulo");
  const elSub = $("#subtitulo");
  const elSalvo = $("#salvo");
  const elAviso = $("#aviso");

  let chave = null; // "minuta:<id>"
  let dados = null; // {html, titulo, processo, criadoEm, atualizadoEm}
  let editor = null;
  let tSalvar = 0;

  // --------------------------------------------------------------- utilidades

  function mostrarAviso(html) {
    elAviso.innerHTML = html;
    elAviso.hidden = false;
  }

  function horaCurta(ts) {
    const d = new Date(ts);
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }

  function tempoRelativo(ts) {
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 60) return "agora";
    const m = Math.floor(s / 60);
    if (m < 60) return "há " + m + " min";
    const h = Math.floor(m / 60);
    if (h < 24) return "há " + h + " h";
    const dias = Math.floor(h / 24);
    return "há " + dias + (dias > 1 ? " dias" : " dia");
  }

  function escaparTexto(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
    );
  }

  // Nome de arquivo seguro no Windows e no Linux, sem acento perdido.
  function nomeArquivo(ext) {
    const base = (elTitulo.value || "Minuta").trim().replace(/[\\/:*?"<>|]+/g, "-").slice(0, 80);
    const proc = dados && dados.processo ? " " + String(dados.processo).replace(/[^\d.-]/g, "") : "";
    return (base + proc || "Minuta") + ext;
  }

  function baixar(blob, nome) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = nome;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  // Confirmação sem alert()/confirm(): o próprio botão responde por 1,6 s.
  function piscar(btn, texto) {
    const antes = btn.textContent;
    btn.textContent = texto;
    btn.classList.add("feito");
    setTimeout(() => {
      btn.textContent = antes;
      btn.classList.remove("feito");
    }, 1600);
  }

  // ------------------------------------------------------------ persistência

  const temStorage = typeof chrome !== "undefined" && chrome.storage && chrome.storage.local;

  function salvar() {
    if (!chave || !dados || !temStorage) return;
    dados.html = editor.value;
    dados.titulo = elTitulo.value.trim() || "Minuta";
    dados.atualizadoEm = Date.now();
    chrome.storage.local.set({ [chave]: dados }, () => {
      if (chrome.runtime.lastError) {
        elSalvo.className = "salvo";
        elSalvo.textContent = "não salvou";
        elSalvo.title = chrome.runtime.lastError.message;
        return;
      }
      elSalvo.className = "salvo ok";
      elSalvo.textContent = "salvo " + horaCurta(dados.atualizadoEm);
      elSalvo.title = "Rascunho guardado neste computador";
      document.title = dados.titulo + " — TecJustiça PJe";
    });
  }

  function agendarSalvar() {
    elSalvo.className = "salvo editando";
    elSalvo.textContent = "editando…";
    clearTimeout(tSalvar);
    tSalvar = setTimeout(salvar, 800);
  }

  // ----------------------------------------------------- lista de rascunhos
  // O rascunho vive em chrome.storage.local; sem uma forma de listá-los, ficaria
  // órfão no disco. Esta lista é a porta de recuperação — funciona a partir de
  // qualquer aba do editor (dropdown) e da própria página sem ?id (modo lista).
  // Ela CRESCE (uma minuta por geração), então tem busca (filtro por título e
  // número do processo) e exclusão por linha (dois cliques, como no descartar —
  // confirm() nativo trava a página).

  // Busca sem acento (NFD + remoção de diacríticos), o mesmo norm() do painel.
  const norm = (s) =>
    String(s == null ? "" : s).normalize("NFD").replace(/\p{Mn}/gu, "").toLowerCase();

  const SVG_LUPA =
    '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="7" cy="7" r="4.5"/><path d="M10.6 10.6 14 14"/></svg>';
  const SVG_LIXO =
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.6 4h10.8M6 4V2.7h4V4M4.1 4l.6 9a1 1 0 0 0 1 .95h4.6a1 1 0 0 0 1-.95l.6-9M6.6 6.6v5M9.4 6.6v5"/></svg>';

  function listarRascunhos(cb) {
    if (!temStorage) return cb([]);
    chrome.storage.local.get(null, (tudo) => {
      if (chrome.runtime.lastError || !tudo) return cb([]);
      const lista = Object.keys(tudo)
        .filter((k) => k.indexOf("minuta:") === 0)
        .map((k) => Object.assign({ id: k.slice("minuta:".length) }, tudo[k]))
        .sort((a, b) => (b.atualizadoEm || 0) - (a.atualizadoEm || 0));
      cb(lista);
    });
  }

  function vazioHtml() {
    return (
      '<div class="vazio">Nenhuma minuta guardada. Gere uma pelo botão ' +
      "“📝 Minutar” no painel do processo.</div>"
    );
  }

  // Uma linha por rascunho — vale no dropdown e na lista de tela cheia. A âncora
  // (.ropen) abre; o botão .rdel (fora da âncora) exclui.
  function linhasRascunhos(lista, atualId) {
    if (!lista.length) return vazioHtml();
    return lista
      .map((r) => {
        const atual = r.id === atualId;
        const quando = tempoRelativo(r.atualizadoEm || r.criadoEm || Date.now());
        const proc = r.processo ? escaparTexto(r.processo) + " · " : "";
        const busca = norm((r.titulo || "Minuta") + " " + (r.processo || ""));
        return (
          '<div class="rrow' + (atual ? " atual" : "") + '" data-id="' +
          escaparTexto(r.id) + '" data-busca="' + escaparTexto(busca) + '">' +
          '<a class="ropen" href="editor.html?id=' + encodeURIComponent(r.id) + '">' +
          '<span class="rt">' + escaparTexto(r.titulo || "Minuta") + "</span>" +
          '<span class="rm">' + proc + quando + (atual ? " · aberta" : "") + "</span>" +
          "</a>" +
          '<button class="rdel" type="button" title="Excluir esta minuta" ' +
          'aria-label="Excluir minuta">' + SVG_LIXO + "</button>" +
          "</div>"
        );
      })
      .join("");
  }

  // Cabeçalho de busca (fica FORA das linhas re-filtradas, para o campo não
  // perder o foco durante a digitação — o filtro só liga/desliga row.hidden).
  function campoBusca(n) {
    return (
      '<div class="rbusca">' + SVG_LUPA +
      '<input type="search" class="rbusca-in" autocomplete="off" spellcheck="false" ' +
      'placeholder="Buscar por título ou processo…" aria-label="Buscar minuta">' +
      '<span class="rbusca-n">' + n + (n === 1 ? " minuta" : " minutas") + "</span>" +
      "</div>"
    );
  }

  function contarVisiveis(escopo) {
    const lista = escopo.querySelector(".drop-list, .lista-b");
    if (!lista) return;
    const rows = lista.querySelectorAll(".rrow");
    const cnt = escopo.querySelector(".rbusca-n");
    if (cnt) cnt.textContent = rows.length + (rows.length === 1 ? " minuta" : " minutas");
    if (!rows.length) {
      const busca = escopo.querySelector(".rbusca");
      if (busca) busca.hidden = true; // sem itens, buscar não faz sentido
      lista.innerHTML = vazioHtml();
    }
  }

  // Filtro por título/processo. Esc no campo (com texto) só limpa — não fecha o
  // dropdown; vazio, o Esc borbulha e o handler global fecha.
  function ligarBusca(escopo) {
    const inp = escopo.querySelector(".rbusca-in");
    const lista = escopo.querySelector(".drop-list, .lista-b");
    if (!inp || !lista) return;
    inp.addEventListener("input", () => {
      const q = norm(inp.value.trim());
      let vis = 0;
      lista.querySelectorAll(".rrow").forEach((row) => {
        const ok = !q || (row.dataset.busca || "").indexOf(q) !== -1;
        row.hidden = !ok;
        if (ok) vis++;
      });
      let sem = lista.querySelector(".sem-res");
      if (vis === 0) {
        if (!sem) {
          sem = document.createElement("div");
          sem.className = "sem-res";
          lista.appendChild(sem);
        }
        sem.hidden = false;
        sem.textContent = "Nenhuma minuta corresponde a “" + inp.value.trim() + "”.";
      } else if (sem) {
        sem.hidden = true;
      }
      const cnt = escopo.querySelector(".rbusca-n");
      if (cnt) cnt.textContent = vis + (vis === 1 ? " minuta" : " minutas");
    });
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && inp.value) {
        e.stopPropagation();
        inp.value = "";
        inp.dispatchEvent(new Event("input"));
      }
    });
  }

  function desarmarLixo(btn) {
    clearTimeout(btn._t);
    btn.dataset.armado = "";
    btn.classList.remove("armado");
    btn.innerHTML = SVG_LIXO;
  }

  function excluirRascunho(id, feito) {
    const k = "minuta:" + id;
    const fim = () => {
      // se a minuta excluída é a aberta NESTA aba, para o autosave (senão o
      // próximo salvar a recriaria) e sinaliza no indicador de salvamento
      if (chave === k) {
        chave = null;
        clearTimeout(tSalvar);
        elSalvo.className = "salvo";
        elSalvo.textContent = "excluída";
        elSalvo.title = "Esta minuta foi excluída da lista de rascunhos";
      }
      feito && feito();
    };
    if (temStorage) chrome.storage.local.remove(k, fim);
    else fim();
  }

  // Exclusão por linha, delegada no container (as linhas são recriadas a cada
  // abertura). Dois cliques: 1º arma (o botão vira “Excluir?” vermelho, some em
  // 4 s), 2º confirma.
  function ligarExcluir(escopo) {
    const lista = escopo.querySelector(".drop-list, .lista-b");
    if (!lista) return;
    lista.addEventListener("click", (e) => {
      const btn = e.target.closest(".rdel");
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      const row = btn.closest(".rrow");
      if (!row) return;
      if (btn.dataset.armado !== "1") {
        lista.querySelectorAll(".rdel.armado").forEach(desarmarLixo);
        btn.dataset.armado = "1";
        btn.classList.add("armado");
        btn.textContent = "Excluir?";
        btn._t = setTimeout(() => desarmarLixo(btn), 4000);
        return;
      }
      clearTimeout(btn._t);
      excluirRascunho(row.dataset.id, () => {
        row.classList.add("saindo");
        setTimeout(() => {
          row.remove();
          contarVisiveis(escopo);
        }, 170);
      });
    });
  }

  let dropAberto = false;
  function toggleDrop() {
    const drop = $("#drop");
    if (dropAberto) return fecharDrop();
    listarRascunhos((lista) => {
      const atualId = chave ? chave.slice("minuta:".length) : null;
      drop.innerHTML =
        (lista.length ? campoBusca(lista.length) : "") +
        '<div class="drop-list" role="menu" aria-label="Minutas guardadas">' +
        linhasRascunhos(lista, atualId) +
        "</div>";
      ligarBusca(drop);
      ligarExcluir(drop);
      drop.hidden = false;
      dropAberto = true;
      const inp = drop.querySelector(".rbusca-in");
      if (inp) inp.focus();
    });
  }
  function fecharDrop() {
    if (!dropAberto) return;
    $("#drop").hidden = true;
    dropAberto = false;
  }

  // Página sem ?id (ou minuta inexistente): a própria tela vira a lista.
  function mostrarListaCheia(aviso) {
    document.body.classList.add("modo-lista");
    elTitulo.value = "Minhas minutas";
    elTitulo.readOnly = true;
    elSub.textContent = "guardadas neste computador · apagadas após 7 dias";
    listarRascunhos((lista) => {
      mostrarAviso(
        '<div class="lista-box">' +
          (aviso ? '<div class="lista-aviso">' + aviso + "</div>" : "") +
          '<div class="lista-h">Suas minutas recentes</div>' +
          (lista.length ? campoBusca(lista.length) : "") +
          '<div class="lista-b">' + linhasRascunhos(lista, null) + "</div>" +
          "</div>"
      );
      const box = elAviso.querySelector(".lista-box");
      if (box) {
        ligarBusca(box);
        ligarExcluir(box);
      }
    });
  }

  // ------------------------------------------------------------------ Jodit

  function montarEditor(html) {
    editor = Jodit.make("#ed", {
      language: "pt_br",
      theme: "default",
      toolbar: "#barra", // barra fora da folha — ver o comentário no editor.html
      toolbarAdaptive: false,
      toolbarSticky: false,
      statusbar: false,
      spellcheck: true,
      askBeforePasteHTML: false,
      askBeforePasteFromWord: false,
      defaultActionOnPaste: "insert_clear_html",
      minHeight: 700,
      // A CSP da extensão (script-src 'self') proíbe carregar scripts externos.
      // O modo código do Jodit (botão "source") puxa o "ace" de cdnjs e o
      // beautify puxa "js-beautify" — os dois seriam bloqueados. Desligamos
      // ambos: o editor de minutas é WYSIWYG puro, sem visão de HTML cru.
      beautifyHTML: false,
      sourceEditor: "area",
      // Sem imagem, vídeo, emoji, upload nem código-fonte: isto é uma peça.
      buttons: [
        "undo", "redo", "|",
        "paragraph", "|",
        "bold", "italic", "underline", "strikethrough", "|",
        "left", "center", "right", "justify", "|",
        "ul", "ol", "indent", "outdent", "|",
        "table", "link", "|",
        "find", "eraser",
      ],
      controls: {
        paragraph: {
          list: {
            p: "Parágrafo",
            h1: "Título do ato",
            h2: "Seção",
            h3: "Subseção",
            blockquote: "Citação recuada",
          },
        },
      },
    });
    editor.value = html || "<p></p>";
    editor.events.on("change", agendarSalvar);
    return editor;
  }

  // ---------------------------------------------------------------- exportar

  async function copiarFormatado(btn) {
    const html = editor.value;
    const texto = editor.text || "";
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([texto], { type: "text/plain" }),
        }),
      ]);
      piscar(btn, "✓ Copiado");
    } catch (e) {
      // Sem permissão de clipboard ou sem gesto: cai no caminho antigo, que
      // funciona porque a seleção é feita na própria página.
      const tmp = document.createElement("div");
      tmp.innerHTML = html;
      tmp.setAttribute("contenteditable", "true");
      tmp.style.cssText = "position:fixed;left:-9999px;top:0;white-space:pre-wrap";
      document.body.appendChild(tmp);
      const sel = window.getSelection();
      const r = document.createRange();
      r.selectNodeContents(tmp);
      sel.removeAllRanges();
      sel.addRange(r);
      const ok = document.execCommand("copy");
      sel.removeAllRanges();
      tmp.remove();
      piscar(btn, ok ? "✓ Copiado" : "✕ Falhou");
    }
  }

  async function baixarDocx(btn) {
    btn.disabled = true;
    const antes = btn.textContent;
    btn.textContent = "gerando…";
    try {
      const blob = await EditorDocx.gerarBlob(editor.value, elTitulo.value);
      baixar(blob, nomeArquivo(".docx"));
      btn.textContent = antes;
      piscar(btn, "✓ Baixado");
    } catch (e) {
      console.error("[PJe IA] falha ao gerar .docx", e);
      btn.textContent = antes;
      piscar(btn, "✕ Falhou");
    } finally {
      btn.disabled = false;
    }
  }

  function descartar(btn) {
    // Exclusão em dois cliques, como na biblioteca de prompts: confirm() nativo
    // é o tipo de diálogo que trava a página.
    if (btn.dataset.armado !== "1") {
      btn.dataset.armado = "1";
      btn.textContent = "Descartar?";
      btn.classList.add("feito");
      setTimeout(() => {
        if (btn.dataset.armado !== "1") return;
        btn.dataset.armado = "";
        btn.textContent = "Descartar";
        btn.classList.remove("feito");
      }, 4000);
      return;
    }
    clearTimeout(tSalvar);
    const fim = () => {
      chave = null;
      if (editor) editor.destruct();
      mostrarAviso(
        "<b>Rascunho descartado.</b><div>Pode fechar esta aba. " +
          "A conversa no painel do PJe continua lá.</div>"
      );
    };
    if (temStorage && chave) chrome.storage.local.remove(chave, fim);
    else fim();
  }

  function ligarBotoes() {
    $("#copiar").addEventListener("click", (e) => copiarFormatado(e.currentTarget));
    $("#docx").addEventListener("click", (e) => baixarDocx(e.currentTarget));
    $("#imprimir").addEventListener("click", () => window.print());
    $("#descartar").addEventListener("click", (e) => descartar(e.currentTarget));
    $("#rascunhos").addEventListener("click", (e) => {
      e.stopPropagation();
      toggleDrop();
    });
    // clique fora / Esc fecham o dropdown
    document.addEventListener("click", (e) => {
      if (dropAberto && !e.target.closest(".drop-wrap")) fecharDrop();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") fecharDrop();
    });
    elTitulo.addEventListener("input", agendarSalvar);
    // Ctrl+S é reflexo de quem escreve: salva na hora em vez de abrir o
    // "salvar página" do Chrome.
    document.addEventListener("keydown", (ev) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "s") {
        ev.preventDefault();
        clearTimeout(tSalvar);
        salvar();
      }
    });
  }

  // ------------------------------------------------------------------ início

  ligarBotoes();

  const id = new URLSearchParams(location.search).get("id");

  if (!temStorage) {
    // Modo de teste fora da extensão (HTTP local): sobe o editor vazio.
    elSub.textContent = "modo de teste — sem persistência";
    montarEditor("<h1>Minuta</h1><p>Editor em modo de teste.</p>");
  } else if (!id) {
    // Sem identificador: a página vira a lista de rascunhos (recuperação).
    mostrarListaCheia("");
  } else {
    chave = "minuta:" + id;
    chrome.storage.local.get(chave, (res) => {
      const d = res && res[chave];
      if (!d || !(d.html || d.md)) {
        chave = null;
        mostrarListaCheia(
          "<b>Esta minuta não está mais guardada.</b> Rascunhos são apagados " +
            "depois de 7 dias. Abaixo, as que ainda estão disponíveis:"
        );
        return;
      }
      dados = d;
      elTitulo.value = d.titulo || "Minuta";
      document.title = elTitulo.value + " — TecJustiça PJe";
      elSub.textContent = d.processo ? "Processo " + d.processo : "";
      elSalvo.className = "salvo ok";
      elSalvo.textContent = "salvo " + horaCurta(d.atualizadoEm || d.criadoEm || Date.now());
      // HTML editado tem prioridade; na primeira abertura, converte o Markdown
      // cru com o parser dedicado e grava o HTML de volta.
      if (d.html) {
        montarEditor(d.html);
      } else {
        montarEditor(MinutaMd.paraHtml(d.md));
        salvar(); // persiste o HTML convertido para as próximas aberturas
      }
    });
  }
})();
