// Camada de acesso ao PJe. Roda no contexto (mundo isolado) da página dos autos.
// Reutiliza os mecanismos validados ao vivo: timeline no DOM + endpoint REST de download.
var PJE = (function () {
  // Base path do PJe (ex.: "pje1grau"). Deriva da URL para tolerar variações.
  function getBase() {
    return location.pathname.split("/")[1] || "pje1grau";
  }

  // Lê o idProcesso da querystring dos autos.
  function getIdProcesso() {
    return new URLSearchParams(location.search).get("idProcesso");
  }

  // Número CNJ do processo (NNNNNNN-DD.AAAA.J.TR.OOOO). Vai ao system prompt
  // para o modelo não precisar garimpá-lo nos PDFs — sem ele, o título do mapa
  // mental saía com número inventado. O padrão CNJ é nacional, então a mesma
  // regex serve qualquer tribunal.
  // Busca em cascata do barato para o caro: título da aba → cabeçalho dos autos
  // → um PEDAÇO do texto da página. Nunca varrer o body inteiro: a página dos
  // autos é enorme e isto roda no boot. null quando não encontra (todo o
  // consumo é condicional).
  // O cache é POR PROCESSO, não por página: o PJe novo é uma SPA e troca de
  // autos sem recarregar — um cache permanente devolveria o número do processo
  // anterior para o system prompt do processo novo.
  const RE_CNJ = /\b\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}\b/;
  let numeroCache; // undefined = ainda não procurou; null = procurou e não achou
  let numeroCacheDe = null; // idProcesso a que o cache acima pertence
  function getNumeroProcesso() {
    const proc = getIdProcesso();
    if (numeroCache !== undefined && numeroCacheDe === proc) return numeroCache;
    numeroCacheDe = proc;
    // Thunks, não valores: ler innerText da página dos autos custa caro (força
    // layout num DOM enorme) e não pode acontecer quando o título já resolveu.
    const fontes = [
      () => document.title,
      () =>
        (document.querySelector("#navbar, .navbar, #cabecalho, .cabecalho") || {})
          .textContent,
      () => ((document.body && document.body.innerText) || "").slice(0, 5000),
    ];
    for (const f of fontes) {
      const m = String(f() || "").match(RE_CNJ);
      if (m) return (numeroCache = m[0]);
    }
    return (numeroCache = null);
  }

  // Varre a timeline (#divTimeLine) e devolve [{id, titulo}] sem duplicatas.
  function listarDocumentos() {
    const links = [...document.querySelectorAll("#divTimeLine a")];
    const seen = new Set();
    const out = [];
    for (const a of links) {
      const t = (a.textContent || "").trim().replace(/\s+/g, " ");
      const m = t.match(/^(\d{6,})\s*-\s*(.+)$/);
      if (m && !seen.has(m[1])) {
        seen.add(m[1]);
        out.push({ id: m[1], titulo: t.slice(0, 140) });
      }
    }
    return out;
  }

  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

  // Localiza o <a> de uma peça na timeline (usado pela ativação e pelo scroll).
  function acharLink(id) {
    return (
      [...document.querySelectorAll("#divTimeLine a")].find((a) =>
        (a.textContent || "").trim().startsWith(id)
      ) || null
    );
  }

  // O endpoint de download é STATEFUL: o servidor só autoriza a peça que foi
  // "aberta" na sessão. Quando o download dá 404, disparamos o clique da peça
  // na timeline (A4J) para registrá-la e tentamos de novo. As ativações são
  // serializadas — o JSF não tolera dois submits simultâneos na mesma view.
  let activationChain = Promise.resolve();
  function ativarPeca(id) {
    const run = async () => {
      const link = acharLink(id);
      if (!link) throw new Error("peça " + id + " não está visível na linha do tempo");
      link.click();
      // aguarda o servidor registrar a peça na sessão (poll no próprio download)
      const url =
        "/" + getBase() + "/seam/resource/rest/pje-legacy/documento/download/" + id;
      for (let i = 0; i < 8; i++) {
        await sleep(700);
        const probe = await fetch(url, { method: "HEAD", credentials: "include" });
        if (probe.ok) return;
      }
      throw new Error("o PJe não liberou a peça " + id + " a tempo — tente novamente");
    };
    activationChain = activationChain.then(run, run);
    return activationChain;
  }

  // Baixa uma peça pelo id. Endpoint REST autenticado por cookie de sessão.
  // Retorna {kind:"pdf", b64, size} ou {kind:"text", text} — ver lerCorpo
  // (content-type + assinatura %PDF- no binário).
  // Corpo vazio com HTTP 200 é tratado como "peça não liberada na sessão":
  // ativa a peça na timeline e tenta uma segunda vez antes de desistir.
  async function baixar(id) {
    const url =
      "/" + getBase() + "/seam/resource/rest/pje-legacy/documento/download/" + id;
    let r = await fetch(url, { credentials: "include" });
    if (r.status === 404) {
      await ativarPeca(id); // registra a peça na sessão e aguarda liberar
      r = await fetch(url, { credentials: "include" });
    }
    if (!r.ok) throw new Error("falha ao baixar a peça " + id + " (HTTP " + r.status + ")");
    let corpo = await lerCorpo(r, id);
    if (!corpo) {
      await ativarPeca(id);
      r = await fetch(url, { credentials: "include" });
      if (!r.ok) throw new Error("falha ao baixar a peça " + id + " (HTTP " + r.status + ")");
      corpo = await lerCorpo(r, id);
      if (!corpo) {
        throw new Error(
          "a peça " + id + " retornou vazia — abra-a na linha do tempo do processo e tente novamente"
        );
      }
    }
    return corpo;
  }

  // Conta as páginas de um PDF por heurística no binário, em três passos:
  // 1) ocorrências de "/Type /Page" (objetos de página) no texto cru;
  // 2) maior "/Count N" da árvore de páginas;
  // 3) PDFs modernos guardam os objetos em object streams comprimidos — nada
  //    aparece no cru; descomprime os streams /ObjStm (FlateDecode) com a API
  //    nativa do navegador e conta os objetos de página lá dentro.
  const RE_PAGINA = /\/Type\s*\/Page(?![a-zA-Z])/g;

  async function contarPaginas(blob) {
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const s = new TextDecoder("latin1").decode(bytes);
      const m = s.match(RE_PAGINA);
      if (m && m.length) return m.length;
      let max = 0;
      const re = /\/Count\s+(\d+)/g;
      let mm;
      while ((mm = re.exec(s))) max = Math.max(max, parseInt(mm[1], 10));
      if (max) return max;
      return (await contarPaginasObjStm(bytes, s)) || 1;
    } catch {
      return 1;
    }
  }

  // Latin1 preserva a relação 1:1 entre índice na string e offset no binário —
  // por isso dá para achar "stream"/"endstream" na string e fatiar os bytes.
  async function contarPaginasObjStm(bytes, s) {
    let total = 0;
    let lidos = 0;
    const re = /\/Type\s*\/ObjStm/g;
    let m;
    while ((m = re.exec(s)) && lidos < 400) {
      const st = s.indexOf("stream", m.index);
      if (st < 0) break;
      let ini = st + 6;
      if (s.charCodeAt(ini) === 13) ini++;
      if (s.charCodeAt(ini) === 10) ini++;
      let fim = s.indexOf("endstream", ini);
      if (fim < 0) break;
      // remove o fim-de-linha entre os dados e "endstream" (bytes extras
      // depois do terminador zlib fariam a descompressão falhar)
      while (fim > ini && (s.charCodeAt(fim - 1) === 10 || s.charCodeAt(fim - 1) === 13)) fim--;
      lidos++;
      try {
        const txt = new TextDecoder("latin1").decode(await inflar(bytes.subarray(ini, fim)));
        const mm = txt.match(RE_PAGINA);
        if (mm) total += mm.length;
      } catch {
        /* stream com outro filtro ou corrompido: ignora e segue */
      }
    }
    return total;
  }

  // Descomprime um stream FlateDecode (formato zlib) com DecompressionStream.
  async function inflar(u8) {
    const ds = new DecompressionStream("deflate");
    const st = new Blob([u8]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(st).arrayBuffer());
  }

  // Interpreta o corpo da resposta. Devolve null quando veio vazio
  // (PDF de 0 bytes ou texto em branco após a extração).
  // Detecção de PDF em DUAS camadas: content-type E assinatura %PDF- no início
  // do binário — o PJe pode servir PDF como application/octet-stream (ou sem
  // content-type), e sem o sniff a peça cairia no ramo de texto virando lixo
  // UTF-8 no contexto (até ~17 mil tokens desperdiçados por peça).
  async function lerCorpo(r, id) {
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    const blob = await r.blob();
    let ehPdf = ct.includes("pdf");
    if (!ehPdf && !ct.includes("html") && blob.size >= 5) {
      // a spec permite lixo antes do %PDF- — procura nos primeiros 1024 bytes
      const head = new Uint8Array(await blob.slice(0, 1024).arrayBuffer());
      ehPdf = String.fromCharCode(...head).includes("%PDF-");
    }
    if (ehPdf) {
      if (!blob.size) {
        console.debug("[PJe IA] peça", id, "PDF de 0 bytes");
        return null;
      }
      const pages = await contarPaginas(blob);
      console.debug("[PJe IA] peça", id, "PDF de", blob.size, "bytes,", pages, "página(s)");
      const b64 = await blobToB64(blob);
      return { kind: "pdf", b64, size: blob.size, pages };
    }
    // blob.text() decodifica sempre UTF-8; honra o charset do header quando
    // outro (PJe legado pode servir HTML em ISO-8859-1 — acentuação).
    let raw;
    const charset = (ct.match(/charset=([\w-]+)/) || [])[1];
    if (charset && !/^utf-?8$/i.test(charset)) {
      try {
        raw = new TextDecoder(charset).decode(await blob.arrayBuffer());
      } catch {
        raw = await blob.text();
      }
    } else {
      raw = await blob.text();
    }
    // Peças HTML: extrai só o texto legível (sem tags/scripts) para o modelo.
    let text = raw;
    if (ct.includes("html")) {
      try {
        const doc = new DOMParser().parseFromString(raw, "text/html");
        doc.querySelectorAll("script,style").forEach((n) => n.remove());
        text = (doc.body ? doc.body.textContent : raw).replace(/\n{3,}/g, "\n\n");
      } catch {
        /* mantém o bruto */
      }
    }
    text = text.trim();
    console.debug("[PJe IA] peça", id, "texto de", text.length, "chars (" + ct + ")");
    if (!text) return null;
    return { kind: "text", text };
  }

  // Rola a timeline do PJe até a peça e a destaca com um flash temporário.
  // NÃO clica no link (zero efeito A4J/JSF, não entra na activationChain) —
  // é só navegação visual. Retorna false quando a peça não está na timeline
  // (SPA pode não ter carregado o trecho); o chamador orienta o usuário.
  // O estilo do flash é injetado no DOM da PÁGINA (o alvo vive fora do
  // Shadow DOM do painel, onde o CSS da extensão não alcança).
  function garantirEstiloFlash() {
    if (document.getElementById("pje-ia-flash-style")) return;
    const st = document.createElement("style");
    st.id = "pje-ia-flash-style";
    st.textContent =
      "@keyframes pjeIaFlash{0%,100%{box-shadow:0 0 0 0 rgba(0,120,170,0);background:transparent}" +
      "20%{box-shadow:0 0 0 5px rgba(0,120,170,.45);background:rgba(0,120,170,.16)}}" +
      ".pje-ia-flash{animation:pjeIaFlash 1.1s ease-out 2;border-radius:4px}";
    document.head.appendChild(st);
  }

  let flashEl = null;
  let flashTimer = null;
  function scrollAte(id) {
    const link = acharLink(id);
    if (!link) return false;
    garantirEstiloFlash();
    const alvo = link.closest("li, tr, .media") || link.parentElement || link;
    if (flashEl) {
      flashEl.classList.remove("pje-ia-flash");
      clearTimeout(flashTimer);
    }
    alvo.scrollIntoView({ behavior: "smooth", block: "center" });
    void alvo.offsetWidth; // reinicia a animação quando o alvo é o mesmo nó
    alvo.classList.add("pje-ia-flash");
    flashEl = alvo;
    flashTimer = setTimeout(() => {
      alvo.classList.remove("pje-ia-flash");
      flashEl = null;
    }, 2400);
    return true;
  }

  // A timeline carrega as peças sob demanda (scroll infinito): em processos
  // maiores, só o trecho já rolado existe no DOM — e, portanto, na lista do
  // painel. Esta função faz o trabalho pelo usuário: rola o container da
  // timeline programaticamente até o fim, aguarda cada leva chegar do
  // servidor e repete até a lista parar de crescer (ou 90 s). NÃO clica em
  // nada — zero efeito na activationChain; é o mesmo gesto de rolagem que o
  // usuário faria à mão (a rolagem programática dispara o evento scroll
  // nativo que o lazy load do PJe escuta). Ao final, devolve a rolagem para
  // onde estava. onProgress recebe o total de peças a cada rodada.
  function rolavel(el) {
    return (
      /(auto|scroll)/.test(getComputedStyle(el).overflowY) &&
      el.scrollHeight > el.clientHeight + 10
    );
  }

  function acharScroller(tl) {
    // O elemento que de fato rola varia por tribunal/tema. No TJCE (validado
    // ao vivo) é um DESCENDENTE da timeline: div.eventos-timeline.scroll-y —
    // o #divTimeLine em si e todos os seus ancestrais têm overflow visible.
    // Ordem de busca: (1) descendente rolável que contenha os links das
    // peças; (2) ancestral rolável; (3) a janela, como último recurso.
    const desc = [...tl.querySelectorAll("*")].find(
      (el) => rolavel(el) && el.querySelector("a")
    );
    if (desc) return desc;
    for (let el = tl; el && el !== document.body; el = el.parentElement) {
      if (rolavel(el)) return el;
    }
    return window;
  }

  async function carregarTimelineCompleta(onProgress) {
    let tl = document.querySelector("#divTimeLine");
    if (!tl) return { total: 0, completo: true };
    const scrollAntes = (() => {
      const sc = acharScroller(tl);
      return sc === window ? window.scrollY : sc.scrollTop;
    })();
    const contar = () => document.querySelectorAll("#divTimeLine a").length;
    const inicio = Date.now();
    const TETO_MS = 90000;
    let total = contar();
    let estaveis = 0; // rodadas seguidas sem crescimento — 2 encerram
    while (estaveis < 2 && Date.now() - inicio < TETO_MS) {
      // Re-localiza timeline e scroller a CADA rodada: o re-render A4J que
      // anexa as peças novas pode substituir os nós no DOM — uma referência
      // guardada apontaria para um elemento morto e a rolagem viraria no-op.
      tl = document.querySelector("#divTimeLine");
      if (!tl) break; // página re-renderizou/navegou no meio
      const sc = acharScroller(tl);
      if (sc === window) {
        window.scrollTo(0, document.documentElement.scrollHeight);
      } else {
        sc.scrollTop = sc.scrollHeight;
      }
      let cresceu = false;
      for (let i = 0; i < 10 && !cresceu; i++) {
        await sleep(300);
        const agora = contar();
        if (agora > total) {
          total = agora;
          cresceu = true;
        }
      }
      if (onProgress) onProgress(listarDocumentos().length);
      estaveis = cresceu ? 0 : estaveis + 1;
    }
    const tlFim = document.querySelector("#divTimeLine");
    if (tlFim) {
      const sc = acharScroller(tlFim);
      if (sc === window) window.scrollTo(0, scrollAntes);
      else sc.scrollTop = scrollAntes;
    }
    return {
      total: listarDocumentos().length,
      completo: Date.now() - inicio < TETO_MS,
    };
  }

  // Converte Blob -> base64 puro (sem prefixo data: e sem quebras de linha).
  function blobToB64(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => {
        const s = String(fr.result);
        resolve(s.slice(s.indexOf(",") + 1));
      };
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
  }

  // ==========================================================================
  // Rota alternativa de listagem: a tela "Documentos" (grid paginada)
  //
  // Os Autos Digitais listam por SCROLL INFINITO, e "parou de crescer" é um
  // heurístico temporal, não uma garantia: se o servidor demorar mais que a
  // janela de espera, `carregarTimelineCompleta` para cedo e devolve uma lista
  // parcial SEM ERRO NENHUM. A tela "Documentos" (menu ☰ → Documentos) é uma
  // grid tabular paginada que resolve isso — ela informa o TOTAL de páginas, o
  // que dá um oráculo de completude: dá para AFIRMAR que leu tudo, e avisar
  // quando não leu. De quebra traz o TIPO oficial da peça ("Despacho de Mero
  // Expediente", "Certidão de Intimação"), a data da juntada e quem juntou —
  // nada disso existe na timeline, onde a categoria é adivinhada por regex.
  //
  // POR QUE UM IFRAME e não uma aba em segundo plano: a paginação faz POST de
  // página INTEIRA e recria o documento, então não dá para segurar estado nele
  // — e fazer isso na aba do usuário tiraria da tela o documento que ele está
  // lendo. Um iframe oculto same-origin isola o documento destruído sem custar
  // as permissões `tabs`+`scripting` (que mudariam o aviso de instalação da
  // Web Store), e o estado da paginação fica aqui, no content script. Dentro do
  // iframe clicamos no link REAL: quem monta o POST do RichFaces é o próprio
  // A4J do PJe, então não replicamos parâmetros de JSF na mão.
  //
  // Tudo aqui é BEST-EFFORT: qualquer falha devolve null e o chamador cai no
  // scroll de sempre. Nunca lançar para o content script.
  // ==========================================================================

  const semAcento = (s) =>
    String(s == null ? "" : s).normalize("NFD").replace(/\p{Mn}/gu, "").toLowerCase();

  // Os <th> do RichFaces vêm com <script> CDATA embutido no texto.
  function limparCelula(t) {
    return String(t == null ? "" : t)
      .replace(/\/\/<!\[CDATA\[[\s\S]*?\/\/\]\]>/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Assinatura mínima da grid de documentos: uma tabela com Id + Juntado em +
  // Tipo só pode ser essa. É o segundo critério porque o id
  // `processoDocumentoGridList` some conforme o A4J re-renderiza.
  const GRID_ASSINATURA = ["id", "juntado em", "tipo"];

  function acharGrid(doc) {
    const cands = [];
    const porId = doc.querySelector("#processoDocumentoGridList");
    if (porId) {
      const t = porId.tagName === "TABLE" ? porId : porId.querySelector("table");
      if (t) cands.push(t);
    }
    for (const tb of doc.querySelectorAll("table")) {
      const ths = [...tb.querySelectorAll("th")].map((th) => semAcento(limparCelula(th.textContent)));
      if (ths.length < 3) continue;
      const casa = GRID_ASSINATURA.every((c) =>
        ths.some((t) => t === semAcento(c) || t.indexOf(semAcento(c)) === 0)
      );
      if (casa && cands.indexOf(tb) < 0) cands.push(tb);
    }
    if (!cands.length) return null;
    // As tabelas do RichFaces são ANINHADAS e o ancestral aparece antes na
    // ordem do documento. Queremos a mais INTERNA: se pegássemos a de fora, os
    // <th> de tudo o que ela embrulha desalinhariam o mapa de colunas.
    return cands.find((t) => !cands.some((o) => o !== t && t.contains(o))) || cands[cands.length - 1];
  }

  // Mapa nome-da-coluna -> índice, lido do CABEÇALHO. Se um tribunal reordenar
  // ou acrescentar coluna, o parser acompanha em vez de ler o campo errado.
  function mapaColunas(tb) {
    for (const tr of tb.querySelectorAll("tr")) {
      const ths = [...tr.children].filter((c) => c.tagName === "TH");
      if (ths.length < 3) continue;
      const mapa = {};
      ths.forEach((th, i) => {
        const nome = semAcento(limparCelula(th.textContent));
        if (nome && !(nome in mapa)) mapa[nome] = i;
      });
      if ("id" in mapa) return mapa;
    }
    return null;
  }

  function lerLinhas(tb, mapa) {
    const out = [];
    const cel = (tds, nome) => {
      const i = mapa[semAcento(nome)];
      return i == null || !tds[i] ? "" : limparCelula(tds[i].textContent);
    };
    for (const tr of tb.querySelectorAll("tr")) {
      const tds = [...tr.children].filter((c) => c.tagName === "TD");
      if (tds.length < 3) continue;
      const id = cel(tds, "id");
      if (!/^\d{4,}$/.test(id)) continue; // cabeçalho, rodapé ou linha de controle
      const documento = cel(tds, "documento");
      const tipo = cel(tds, "tipo");
      out.push({
        id,
        // MESMO formato da timeline ("123456 - Nome"): é por ele que o id
        // viaja até o modelo, no `title` do bloco document.
        titulo: (id + " - " + (documento || tipo || "Documento")).slice(0, 140),
        tipo,
        juntadoEm: cel(tds, "juntado em"),
        juntadoPor: cel(tds, "juntado por"),
      });
    }
    return out;
  }

  function totalPaginasGrid(doc) {
    const el = doc.querySelector(".rich-inslider-right-num");
    const v = parseInt(limparCelula(el && el.textContent), 10);
    return Number.isFinite(v) && v > 0 ? v : 1;
  }

  // Carimba o documento ANTES de submeter: o documento novo nasce sem o
  // atributo. Sem isso não há como saber que a página trocou — o valor do
  // slider foi escrito por nós, então testá-lo passa na página velha.
  function carimbar(doc) {
    try {
      doc.documentElement.setAttribute("data-pje-stale", "1");
    } catch {
      /* documento já substituído */
    }
  }

  function irParaPagina(doc, n) {
    const inp = doc.querySelector("input.rich-inslider-field");
    if (!inp) return false;
    const W = doc.defaultView; // eventos precisam ser do realm do IFRAME
    carimbar(doc);
    inp.value = String(n);
    for (const ev of ["input", "change", "blur"]) {
      inp.dispatchEvent(new W.Event(ev, { bubbles: true }));
    }
    inp.dispatchEvent(
      new W.KeyboardEvent("keyup", { bubbles: true, key: "Enter", keyCode: 13 })
    );
    return true;
  }

  // Documento do iframe, ou null se a origem estiver bloqueada (X-Frame-Options).
  function docDe(iframe) {
    try {
      return iframe.contentDocument || null;
    } catch {
      return null; // cross-origin: o tribunal barrou o enquadramento
    }
  }

  // Pronto = sem carimbo + carregado + grid presente + (se pedido) o slider na
  // página esperada. Timeouts generosos: ~270 KB de HTML com <script> inline
  // por linha deixam o renderer sem resposta por dezenas de segundos.
  async function esperarGrid(iframe, pagina, tetoMs) {
    const fim = Date.now() + (tetoMs || 30000);
    while (Date.now() < fim) {
      await sleep(400);
      const doc = docDe(iframe);
      if (!doc || doc.readyState !== "complete") continue;
      if (doc.documentElement.hasAttribute("data-pje-stale")) continue;
      const tb = acharGrid(doc);
      if (!tb) continue;
      if (pagina != null) {
        const inp = doc.querySelector("input.rich-inslider-field");
        if (!inp || String(inp.value).trim() !== String(pagina)) continue;
      }
      return tb;
    }
    return null;
  }

  // O clique pode ser engolido em silêncio: o A4J.AJAX.Submit sai, o servidor
  // devolve a mesma tela e nada muda, sem erro (provável relação com a
  // conversação Seam ainda se estabelecendo). Daí as re-tentativas.
  async function abrirAbaDocumentos(iframe) {
    for (let tentativa = 0; tentativa < 3; tentativa++) {
      const doc = docDe(iframe);
      if (!doc) return null;
      const link =
        doc.querySelector('a[id$="linkAbaDocumentos"]') ||
        doc.querySelector('a[onclick*="linkAbaDocumentos"]');
      if (!link) return null;
      carimbar(doc);
      try {
        link.click();
      } catch {
        return null;
      }
      const tb = await esperarGrid(iframe, null, 25000);
      if (tb) return tb;
    }
    return null;
  }

  /**
   * Lista os documentos pela grid. Devolve
   *   {docs, total, paginas, paginasLidas, incompleto}
   * ou `null` quando a rota não está disponível (aí o chamador usa o scroll).
   *
   * `incompleto` é o ponto da coisa toda: quando páginas lidas < total, a
   * lista É parcial e dá para AVISAR — ao contrário do scroll, que entrega
   * parcial com cara de completo.
   */
  async function listarPelaGrid(onProgress) {
    if (!getIdProcesso()) return null;
    if (!document.body) return null;
    const iframe = document.createElement("iframe");
    iframe.setAttribute("aria-hidden", "true");
    iframe.setAttribute("tabindex", "-1");
    iframe.setAttribute("title", "");
    // Fora da tela em vez de display:none — o RichFaces mede componentes no
    // carregamento e um frame sem caixa pode render nada.
    iframe.style.cssText =
      "position:fixed;left:-20000px;top:0;width:1280px;height:900px;border:0;opacity:0;pointer-events:none;visibility:hidden;";
    const inicio = Date.now();
    const TETO_MS = 120000;
    try {
      iframe.src = location.href; // mesma URL: leva idProcesso, ca e a sessão
      document.body.appendChild(iframe);
      await new Promise((res) => {
        let feito = false;
        const ok = () => {
          if (!feito) {
            feito = true;
            res();
          }
        };
        iframe.addEventListener("load", ok, { once: true });
        setTimeout(ok, 30000);
      });
      if (!docDe(iframe)) return null; // X-Frame-Options / origem bloqueada

      let tb = await abrirAbaDocumentos(iframe);
      if (!tb) return null;

      const doc0 = docDe(iframe);
      const paginas = totalPaginasGrid(doc0);
      const mapa = mapaColunas(tb);
      if (!mapa) return null;

      const vistos = new Set();
      const docs = [];
      const acumular = (linhas) => {
        for (const l of linhas) {
          if (vistos.has(l.id)) continue;
          vistos.add(l.id);
          docs.push(l);
        }
        if (onProgress) onProgress(docs.length);
      };
      acumular(lerLinhas(tb, mapa));

      let lidas = 1;
      for (let n = 2; n <= paginas; n++) {
        if (Date.now() - inicio > TETO_MS) break;
        const doc = docDe(iframe);
        if (!doc || !irParaPagina(doc, n)) break;
        const tbn = await esperarGrid(iframe, n, 25000);
        if (!tbn) break; // conta como incompleto — não silencia
        const mn = mapaColunas(tbn) || mapa;
        acumular(lerLinhas(tbn, mn));
        lidas++;
      }

      if (!docs.length) return null;
      return {
        docs,
        total: docs.length,
        paginas,
        paginasLidas: lidas,
        incompleto: lidas < paginas,
      };
    } catch {
      return null; // qualquer falha: o chamador usa o scroll
    } finally {
      iframe.remove(); // SEMPRE, inclusive em erro
    }
  }

  return {
    getBase,
    getIdProcesso,
    getNumeroProcesso,
    listarDocumentos,
    baixar,
    scrollAte,
    carregarTimelineCompleta,
    listarPelaGrid,
    // expostos para teste fora do navegador
    _acharGrid: acharGrid,
    _mapaColunas: mapaColunas,
    _lerLinhas: lerLinhas,
    _limparCelula: limparCelula,
    _totalPaginasGrid: totalPaginasGrid,
  };
})();
