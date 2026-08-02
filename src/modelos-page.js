// ---------------------------------------------------------------------------
// Página "Meus modelos de peças" (src/modelos.html).
//
// Por que existe, se o painel do PJe já tem o modal .mlib: cadastrar modelos é
// tarefa de PREPARAÇÃO — feita uma vez, sentado, com as peças-referência em
// mãos —, não algo que se faça no meio da análise de um processo. Exigir uma
// aba de autos aberta só para cadastrar era uma dependência artificial.
//
// A camada de DADOS é a mesma (MLIB, de modelos.js): esta página só desenha uma
// UI de tela cheia sobre ela. Nada de esquema novo, e o que se cadastra aqui
// aparece no painel na hora (MLIB.aoMudar propaga pelo storage.onChanged).
// ---------------------------------------------------------------------------
(() => {
  const $ = (s) => document.querySelector(s);
  const temMlib = typeof MLIB !== "undefined";

  const elLista = $("#lista");
  const elTelaLista = $("#telaLista");
  const elTelaForm = $("#telaForm");
  const elBarraBusca = $("#barraBusca");
  const elBusca = $("#busca");
  const elCont = $("#contador");
  const elFormTit = $("#formTit");
  const elFT = $("#fTitulo");
  const elFC = $("#fCategoria");
  const elFD = $("#fDescricao");
  const elFX = $("#fTexto");
  const elChars = $("#contChars");
  const elErro = $("#formErro");

  let modelos = [];
  let editId = null;
  let idNovo = "";
  let delArm = null; // id com exclusão "armada" (dois cliques)

  // ------------------------------------------------------------- utilidades
  function escapar(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  const norm = (s) =>
    String(s == null ? "" : s).normalize("NFD").replace(/\p{Mn}/gu, "").toLowerCase();

  function previa(texto) {
    const t = String(texto || "").replace(/\s+/g, " ").trim();
    return t.length > 110 ? t.slice(0, 110) + "…" : t;
  }

  function quando(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" });
  }

  // ----------------------------------------------------------------- lista
  function vazioHtml() {
    return (
      '<div class="vazio-pg">' +
      '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>' +
      '<path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>' +
      '<path d="M9 7h7M9 11h5"/></svg>' +
      '<div class="vt">Nenhum modelo cadastrado ainda</div>' +
      '<div class="vd">Cadastre as suas peças-modelo — sentenças, decisões, despachos, ' +
      "ofícios — e, ao gerar uma minuta, o assistente segue a <b>estrutura</b> e o estilo " +
      "delas. Os fatos continuam saindo apenas das peças do processo em tela.</div>" +
      "</div>"
    );
  }

  // A lista é AGRUPADA por categoria, na ordem de MLIB.CATEGORIAS. Repetir a
  // etiqueta da espécie em cada linha fazia um rótulo em caixa alta ("DECISÕES,
  // VOTOS E ACÓRDÃOS") competir com o título, que é o que se procura de fato. E
  // a categoria é justamente o eixo em que se pensa aqui — a minuta seleciona os
  // modelos POR categoria —, então ela vale como cabeçalho de seção, uma vez só.
  function linhaHtml(m) {
    const sub = m.descricao || previa(m.texto);
    const cat = temMlib ? MLIB.rotuloCategoria(m.categoria) : "";
    const busca = norm(m.titulo + " " + cat + " " + (m.descricao || ""));
    return (
      '<div class="mrow" data-id="' + escapar(m.id) + '" data-busca="' + escapar(busca) + '" ' +
      'tabindex="0" role="button" aria-label="Editar ' + escapar(m.titulo) + '">' +
      '<div class="info">' +
      '<span class="mt">' + escapar(m.titulo) + "</span>" +
      '<span class="mm">' + escapar(sub) +
      (m.atualizadoEm ? " · " + quando(m.atualizadoEm) : "") + "</span>" +
      "</div>" +
      '<div class="acts">' +
      '<button class="edit" type="button">Editar</button>' +
      '<button class="del" type="button">Excluir</button>' +
      "</div></div>"
    );
  }

  function render() {
    delArm = null;
    if (!modelos.length) {
      elBarraBusca.hidden = true;
      elLista.innerHTML = vazioHtml();
      elLista.classList.add("solta");
      return;
    }
    elBarraBusca.hidden = false;
    elLista.classList.remove("solta");
    let html = "";
    for (const cat of MLIB.CATEGORIAS) {
      const doGrupo = modelos.filter((m) => (m.categoria || "outro") === cat.valor);
      if (!doGrupo.length) continue;
      html +=
        '<section class="grupo">' +
        '<h2 class="ghd">' + escapar(cat.rotulo) +
        '<span class="gn">' + doGrupo.length + "</span></h2>" +
        '<div class="glinhas">' + doGrupo.map(linhaHtml).join("") + "</div>" +
        "</section>";
    }
    elLista.innerHTML = html;
    filtrar();
  }

  function filtrar() {
    const q = norm(elBusca.value.trim());
    let n = 0;
    elLista.querySelectorAll(".mrow").forEach((row) => {
      const bate = !q || row.dataset.busca.includes(q);
      row.hidden = !bate;
      if (bate) n++;
    });
    // grupo sem nenhuma linha visível some inteiro — senão sobrariam cabeçalhos
    // de categoria pairando sobre o vazio durante a busca
    elLista.querySelectorAll(".grupo").forEach((g) => {
      g.hidden = !g.querySelector(".mrow:not([hidden])");
    });
    const anterior = elLista.querySelector(".sem-res");
    if (anterior) anterior.remove();
    if (!n) {
      const d = document.createElement("div");
      d.className = "sem-res";
      d.textContent = "Nenhum modelo corresponde a “" + elBusca.value.trim() + "”.";
      elLista.appendChild(d);
    }
    elCont.textContent = n + (n === 1 ? " modelo" : " modelos");
  }

  // ------------------------------------------------------------ formulário
  function abrirForm(m) {
    editId = m ? m.id : null;
    idNovo = m ? null : temMlib ? MLIB.novoId() : "";
    elFormTit.textContent = m ? "Editar modelo" : "Novo modelo";
    elFT.value = m ? m.titulo || "" : "";
    elFC.value = m ? m.categoria || "outro" : "sentenca";
    elFD.value = m ? m.descricao || "" : "";
    elFX.value = m ? m.texto || "" : "";
    elErro.hidden = true;
    elTelaLista.hidden = true;
    elTelaForm.hidden = false;
    // "✚ Novo modelo" no cabeçalho não faz sentido com o formulário aberto —
    // clicá-lo descartaria o que está sendo digitado sem aviso nenhum
    document.body.classList.add("editando");
    atualizarChars();
    elFT.focus();
    document.querySelector(".mesa").scrollTop = 0;
  }

  function fecharForm() {
    editId = null;
    elTelaForm.hidden = true;
    elTelaLista.hidden = false;
    elErro.hidden = true;
    document.body.classList.remove("editando");
  }

  function doForm() {
    const agora = Date.now();
    const antigo = editId && modelos.find((x) => x.id === editId);
    return {
      id: editId || idNovo,
      titulo: elFT.value.trim(),
      categoria: elFC.value || "outro",
      descricao: elFD.value.trim(),
      texto: elFX.value.trim(),
      criadoEm: antigo ? antigo.criadoEm : agora,
      atualizadoEm: agora,
    };
  }

  function atualizarChars() {
    if (!temMlib) return;
    const b = MLIB.bytesDe(doForm());
    const pct = Math.min(999, Math.round((b / MLIB.TETO_BYTES) * 100));
    elChars.textContent = elFX.value.length + " caracteres — " + pct + "% do limite";
    elChars.classList.toggle("estouro", b > MLIB.TETO_BYTES);
  }

  function salvar() {
    const m = doForm();
    if (!m.titulo) {
      mostrarErro("Dê um título ao modelo.", elFT);
      return;
    }
    if (!m.texto) {
      mostrarErro("Cole o texto da peça-modelo.", elFX);
      return;
    }
    MLIB.salvar(m, (erro) => {
      if (erro) return mostrarErro("Não foi possível salvar: " + erro, null);
      // o aoMudar re-lista sozinho; atualiza já para a volta ser instantânea
      modelos = modelos
        .filter((x) => x.id !== m.id)
        .concat(m)
        .sort((a, b) => String(a.titulo).localeCompare(String(b.titulo), "pt-BR"));
      fecharForm();
      render();
    });
  }

  function mostrarErro(msg, foco) {
    elErro.textContent = msg;
    elErro.hidden = false;
    if (foco) foco.focus();
  }

  // ------------------------------------------------------------------ boot
  if (!temMlib) {
    elLista.innerHTML =
      '<div class="sem-res">Não foi possível acessar o armazenamento da extensão.</div>';
    return;
  }

  for (const c of MLIB.CATEGORIAS) {
    const op = document.createElement("option");
    op.value = c.valor;
    op.textContent = c.rotulo;
    elFC.appendChild(op);
  }

  MLIB.listar((ms) => {
    modelos = ms;
    render();
  });
  MLIB.aoMudar((ms) => {
    modelos = ms;
    // só re-desenha a lista se ela estiver à vista — re-render por baixo do
    // formulário aberto faria o usuário perder o que está digitando
    if (!elTelaLista.hidden) render();
  });

  // ações DELEGADAS (as linhas são recriadas a cada render)
  elLista.addEventListener("click", (e) => {
    const row = e.target.closest(".mrow");
    if (!row) return;
    const m = modelos.find((x) => x.id === row.dataset.id);
    if (!m) return;
    const btn = e.target.closest("button");
    // clicar na LINHA (fora dos botões) edita: é a ação óbvia e a linha inteira
    // é um alvo bem maior que o botão que só aparece no hover
    if (!btn) return abrirForm(m);
    if (btn.classList.contains("edit")) return abrirForm(m);
    if (!btn.classList.contains("del")) return;
    // exclusão em DOIS cliques — confirm() nativo trava a página
    if (delArm !== m.id) {
      elLista.querySelectorAll(".del.arm").forEach((b) => {
        b.textContent = "Excluir";
        b.classList.remove("arm");
      });
    }
    if (delArm === m.id) {
      delArm = null;
      MLIB.excluir(m.id, () => {
        modelos = modelos.filter((x) => x.id !== m.id);
        render();
      });
    } else {
      delArm = m.id;
      btn.textContent = "Excluir?";
      btn.classList.add("arm");
    }
  });

  // teclado: Enter/Espaço na linha focada edita (a linha é role="button")
  elLista.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const row = e.target.closest && e.target.closest(".mrow");
    if (!row || e.target.tagName === "BUTTON") return;
    e.preventDefault();
    const m = modelos.find((x) => x.id === row.dataset.id);
    if (m) abrirForm(m);
  });

  $("#novo").addEventListener("click", () => abrirForm(null));
  $("#salvar").addEventListener("click", salvar);
  $("#cancelar").addEventListener("click", fecharForm);
  elBusca.addEventListener("input", filtrar);
  elBusca.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && elBusca.value) {
      e.stopPropagation();
      elBusca.value = "";
      filtrar();
    }
  });
  for (const el of [elFT, elFD, elFX]) el.addEventListener("input", atualizarChars);
  elFT.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      salvar();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !elTelaForm.hidden) fecharForm();
  });
})();
