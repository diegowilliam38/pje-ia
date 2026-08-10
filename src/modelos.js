// ---------------------------------------------------------------------------
// PJe IA — biblioteca de MODELOS do usuário (peças-modelo para a minuta).
//
// Irmão do PLIB (prompts.js), com duas diferenças de propósito:
//  1. Persiste em chrome.storage.LOCAL, não sync. Um modelo é uma peça inteira
//     (sentença, decisão, ofício…) — facilmente dezenas de KB, muito acima dos
//     8.192 B/item do sync. Local aguenta ~10 MB no total; perde-se o
//     espelhamento entre dispositivos (custo aceito).
//  2. Cada item tem CATEGORIA (a espécie do ato) e DESCRIÇÃO, além de
//     título + texto: a categoria é o que a minuta usa para escolher, na hora
//     de redigir, qual modelo trazer como referência de forma.
//
// Chave "modelo:<id>". ISTO GRAVA TEXTO DO USUÁRIO (possivelmente trecho de
// outros processos) NO DISCO — daí a nota no PRIVACY.md e a exclusão fácil.
// ---------------------------------------------------------------------------
const MLIB = (() => {
  const AREA = "local"; // único ponto de troca local/sync
  const PREFIXO = "modelo:";
  // Teto por modelo: puramente uma barreira de sanidade (o request da minuta
  // já carrega os autos inteiros; um modelo gigante só desperdiça tokens). O
  // local não tem cota por item, então isto é escolha de UX, não da API.
  const TETO_BYTES = 60000;

  // Espécies de ato que o usuário cadastra. `valor` é o que fica gravado e
  // casa com a detecção da minuta (content.js/panel.js); `rotulo` é a UI.
  // A ordem é a de exibição no seletor e no <optgroup>.
  const CATEGORIAS = [
    { valor: "despacho", rotulo: "Despachos" },
    { valor: "sentenca", rotulo: "Sentenças" },
    { valor: "decisao", rotulo: "Decisões, votos e acórdãos" },
    { valor: "ata", rotulo: "Atas de audiência" },
    { valor: "oficio", rotulo: "Ofícios" },
    { valor: "mandado", rotulo: "Mandados e alvarás" },
    { valor: "outro", rotulo: "Outros" },
  ];

  function rotuloCategoria(v) {
    const c = CATEGORIAS.find((x) => x.valor === v);
    return c ? c.rotulo : "Outros";
  }

  function categoriaValida(v) {
    return CATEGORIAS.some((x) => x.valor === v);
  }

  function area() {
    return chrome.storage[AREA];
  }

  function novoId() {
    try {
      return crypto.randomUUID();
    } catch {
      return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
    }
  }

  // Bytes REAIS (UTF-8) — .length mentiria com o texto jurídico acentuado.
  function bytesDe(m) {
    try {
      return new TextEncoder().encode(PREFIXO + m.id + JSON.stringify(m)).length;
    } catch {
      return Infinity;
    }
  }

  function tamanhoOk(m) {
    return bytesDe(m) <= TETO_BYTES;
  }

  // cb(modelos) — sempre chamada, com [] em qualquer falha (harness sem
  // storage, contexto invalidado…): a UI nunca pode quebrar por causa daqui.
  function listar(cb) {
    try {
      area().get(null, (all) => {
        const out = [];
        for (const k in all || {}) {
          if (k.startsWith(PREFIXO) && all[k] && all[k].id) out.push(all[k]);
        }
        out.sort((a, b) =>
          String(a.titulo || "").localeCompare(String(b.titulo || ""), "pt-BR")
        );
        cb(out);
      });
    } catch {
      cb([]);
    }
  }

  // cb(erro) — string amigável ou null. Valida o teto ANTES do set e checa
  // chrome.runtime.lastError (cota total do local): nunca falha mudo.
  function salvar(m, cb) {
    if (!tamanhoOk(m)) {
      cb("o modelo excede o limite de " + Math.round(TETO_BYTES / 1000) + " mil caracteres — encurte o texto.");
      return;
    }
    try {
      area().set({ [PREFIXO + m.id]: m }, () => {
        cb(chrome.runtime.lastError ? chrome.runtime.lastError.message : null);
      });
    } catch (e) {
      cb(String((e && e.message) || e));
    }
  }

  function excluir(id, cb) {
    try {
      area().remove(PREFIXO + id, () => {
        if (cb) cb(chrome.runtime.lastError ? chrome.runtime.lastError.message : null);
      });
    } catch (e) {
      if (cb) cb(String((e && e.message) || e));
    }
  }

  // -------------------------------------------------------------------------
  // IMPORTAÇÃO EM LOTE (.docx) — adivinhação da espécie, ficha e gravação
  //
  // Estas funções são a camada de DOMÍNIO da importação: quem sabe ler o .docx
  // é o DocxImport; quem sabe o que é uma "categoria" e o que é um item válido
  // é este arquivo. Ficam aqui, e não num terceiro global, porque o
  // contradomínio de adivinharCategoria são as CATEGORIAS declaradas acima —
  // renomear uma espécie e esquecer a tabela de regex vira um bug mudo se as
  // duas moram em arquivos diferentes.
  // -------------------------------------------------------------------------

  // Normalização SEM acento, privada. Uma quarta cópia pública deste helper
  // (panel.js, modelos-page.js e content.js já têm a sua) convidaria as quatro
  // a divergirem — e é sobre o texto normalizado que TODA regex abaixo opera.
  const norm = (s) =>
    String(s == null ? "" : s)
      .normalize("NFD")
      .replace(/\p{Mn}/gu, "")
      .toLowerCase();

  // --- Sinal 1: o NOME DO ARQUIVO ------------------------------------------
  // É o sinal mais forte: foi o usuário quem nomeou o arquivo, com a espécie
  // em mente. Regra própria deste sinal: vence o casamento mais À ESQUERDA,
  // não a primeira regra da tabela — nome de arquivo é escrito "Espécie —
  // assunto", então a POSIÇÃO carrega informação. Sem isso, "Despacho
  // designando audiência de instrução.docx" cairia em `ata`.
  //
  // Armadilhas (as mesmas de CATEGORIAS/RE_RUIDO em panel.js):
  //  - `(?<!(cumprimento|execucao|liquidacao|carta) de )sentenca`: as quatro
  //    são FASES ou peças de outra espécie, não sentenças. Sem `carta` no
  //    lookbehind, "Carta de sentença" viraria sentença em vez de mandado.
  //  - `mandado\b(?! de seguranca)`: mandado de segurança é AÇÃO, não expediente.
  //  - `ata(?!\s*notarial)`: ata notarial é prova.
  //  - `acordao` é escrito à parte de `acordo` (que é petição das partes e NÃO
  //    entra aqui) — as duas palavras não se contêm.
  //  - Toda alternativa termina em palavra COMPLETA: `saneadora?` cobre
  //    "saneador" e "saneadora"; nada de `\w*` solto, que faria "inicial"
  //    casar "inicialmente".
  const RE_NOME = [
    ["ata", /\bata(?!\s*notarial)s?\b|\btermo de audiencia\b|\bassentada\b|\baudiencia de (instrucao|conciliacao|justificacao|una)\b/],
    ["sentenca", /(?<!(cumprimento|execucao|liquidacao|carta) de )\bsentencas?\b/],
    ["decisao", /\b(decisao|decisoes|acordao|acordaos|voto|ementa|liminar|tutela|saneadora?)\b/],
    ["despacho", /\b(despachos?|mero expediente)\b/],
    ["mandado", /\bmandados?\b(?! de seguranca)|\balvaras?\b|\bcarta (precatoria|de sentenca)\b/],
    ["oficio", /\boficios?\b/],
  ];

  function doNome(nomeArquivo) {
    const s = norm(nomeArquivo)
      .replace(/\.(docx|rtf)$/, "")
      .replace(/[_\-.]+/g, " ");
    let melhor = null;
    for (const [cat, re] of RE_NOME) {
      const m = re.exec(s);
      // `<` estrito: em empate de posição vence a primeira regra da tabela
      if (m && (!melhor || m.index < melhor.idx)) {
        melhor = { categoria: cat, idx: m.index, origem: "nome" };
      }
    }
    return melhor;
  }

  // --- Sinal 2: o CABEÇALHO -------------------------------------------------
  // Peça judicial abre com o nome da espécie numa linha própria. `textoDoXml`
  // já entrega um parágrafo por linha, com trim, então a regex é ANCORADA em
  // `^` — é o que impede "…conforme a sentença de fls. 30" de passar por
  // cabeçalho. Decide a PRIMEIRA linha que casar qualquer regra.
  const LINHAS_CABECALHO = 12;
  const RE_CABECALHO = [
    ["ata", /^(ata|termo)\b.*\baudiencia\b/],
    ["oficio", /^oficio\b/],
    ["mandado", /^(mandado\b(?! de seguranca)|alvara\b)/],
    ["sentenca", /^sentenca\b/],
    ["decisao", /^(decisao|acordao|voto|ementa)\b/],
    ["despacho", /^despacho\b/],
  ];

  function doCabecalho(linhas) {
    const n = Math.min(LINHAS_CABECALHO, linhas.length);
    for (let i = 0; i < n; i++) {
      const l = norm(linhas[i]);
      for (const [cat, re] of RE_CABECALHO) {
        if (re.test(l)) return { categoria: cat, origem: "cabecalho" };
      }
    }
    return null;
  }

  // --- Sinal 3: o DISPOSITIVO ----------------------------------------------
  // O fecho da peça é o sinal mais discriminante que existe aqui, e a ORDEM da
  // tabela é o que faz ele funcionar: "Intime-se" e "Cumpra-se" aparecem no fim
  // de sentença, de decisão E de despacho. Por isso `sentenca` vem ANTES de
  // `mandado` ("Publique-se… Expeça-se mandado" é sentença) e `despacho` vem
  // POR ÚLTIMO (cite-se/cumpra-se estão em quase todo dispositivo).
  //
  // Armadilha da construção: onde o grupo vai entre `\b…\b`, a alternativa
  // precisa começar E terminar em caractere de palavra — daí `p\.r\.i` (sem o
  // ponto final, que quebraria o `\b` de fechamento) e `art\.? ?48[57]`.
  const LINHAS_DISPOSITIVO = 18;
  const RE_DISPOSITIVO = [
    ["ata", /\bnada mais havendo\b|\bencerrou-se a audiencia\b|\blido e achado conforme\b/],
    ["sentenca", /\bp\.r\.i\b|\bpublique-se\b[\s\S]{0,30}\bregistre-se\b|\bjulgo (procedente|improcedente|parcialmente|extint)|\bresolucao do merito\b|\bart(igo)?\.? ?48[57]\b|\b(condeno|absolvo|homologo)\b/],
    ["decisao", /\b(defiro|indefiro|concedo)\b[\s\S]{0,20}\b(liminar|tutela|antecipacao|efeito suspensivo)\b|\brecebo a denuncia\b|\bconverto o julgamento em diligencia\b/],
    ["mandado", /\bexpeca-se\b[\s\S]{0,12}\b(mandado|alvara)\b|\bsirva\b[\s\S]{0,30}\b(mandado|alvara|oficio)\b/],
    ["oficio", /\b(atenciosamente|respeitosamente)\b|\bao (ilustrissimo|excelentissimo) senhor\b/],
    ["despacho", /\bcite-se\b|\bao contador\b|\ba contadoria\b|\bmanifeste-se\b|\bespecifiquem as provas\b|\babra-se vista\b|\bvista ao ministerio publico\b|\bcumpra-se\b/],
  ];

  function doDispositivo(linhas) {
    const trecho = norm(linhas.slice(Math.max(0, linhas.length - LINHAS_DISPOSITIVO)).join("\n"));
    for (const [cat, re] of RE_DISPOSITIVO) {
      if (re.test(trecho)) return { categoria: cat, origem: "dispositivo" };
    }
    return null;
  }

  function linhasUteis(texto) {
    return String(texto || "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  }

  // Devolve {categoria, confianca, sinal}. A `confianca` e o `sinal` existem
  // para a UI ser AUDITÁVEL — ela mostra "sugerida pelo nome do arquivo" e
  // troca o rótulo para "confira a categoria" quando nada foi reconhecido. O
  // usuário precisa poder discordar de um palpite sabendo de onde ele veio.
  function adivinharCategoria(nomeArquivo, texto) {
    const linhas = linhasUteis(texto);
    const porNome = doNome(nomeArquivo);
    const porCab = doCabecalho(linhas);
    const porDisp = doDispositivo(linhas);
    const sinais = [porNome, porCab, porDisp].filter(Boolean);
    if (!sinais.length) return { categoria: "outro", confianca: "nenhuma", sinal: null };
    // O nome vence quando existe: foi decisão explícita do usuário.
    const venc = porNome || porCab || porDisp;
    const concordam = sinais.filter((s) => s.categoria === venc.categoria).length;
    const confianca =
      concordam >= 2 ? "alta" : sinais.length === 1 && venc.origem === "nome" ? "alta" : "media";
    return { categoria: venc.categoria, confianca, sinal: venc.origem };
  }

  // Chave de comparação de títulos (duplicados). Sem acento e com os espaços
  // colapsados: "Sentença  de   Improcedência" e "sentenca de improcedencia"
  // são o mesmo modelo para quem vai olhar a lista depois.
  function chaveTitulo(s) {
    return norm(s).replace(/\s+/g, " ").trim();
  }

  // Monta a ficha de conferência de um arquivo já lido pelo DocxImport.
  // `criadoEm`/`atualizadoEm` são carimbados JÁ AQUI para o bytesDe ser exato
  // (ele serializa o objeto inteiro, timestamps inclusive).
  function fichaImportada(bruto) {
    const agora = Date.now();
    const sug = adivinharCategoria(bruto.nome, bruto.texto);
    const m = {
      id: novoId(),
      titulo: String(bruto.titulo || "").slice(0, 80) || "Modelo importado",
      categoria: categoriaValida(sug.categoria) ? sug.categoria : "outro",
      descricao: "",
      texto: String(bruto.texto || ""),
      criadoEm: agora,
      atualizadoEm: agora,
    };
    const f = {
      modelo: m,
      arquivo: bruto.nome,
      sugerida: sug,
      catTocada: false, // vira true no 1º change do <select> → some o selo
      duplicado: false, // preenchido por marcarDuplicados
    };
    medirFicha(f);
    // Acima do teto entra DESMARCADA: o botão de cadastrar não pode prometer
    // um número que a gravação vai recusar.
    f.incluir = !f.acimaDoTeto;
    return f;
  }

  // Recalcula tamanho da ficha. Precisa rodar a cada edição do TÍTULO: ele
  // conta bytes como qualquer outro campo, e uma ficha pode cruzar o teto por
  // causa dele.
  function medirFicha(f) {
    f.bytes = bytesDe(f.modelo);
    f.acimaDoTeto = f.bytes > TETO_BYTES;
    return f;
  }

  // Marca `duplicado` comparando contra os modelos JÁ cadastrados e contra as
  // fichas anteriores do próprio lote (dois arquivos com o mesmo nome
  // acontecem). AVISA, não bloqueia, e nunca renomeia sozinho — renomear em
  // silêncio o título que o usuário vai ler depois é pior que o aviso.
  function marcarDuplicados(fichas, existentes) {
    const vistos = new Set((existentes || []).map((m) => chaveTitulo(m.titulo)));
    for (const f of fichas || []) {
      const k = chaveTitulo(f.modelo.titulo);
      f.duplicado = !!k && vistos.has(k);
      if (k) vistos.add(k);
    }
    return fichas;
  }

  // Grava um lote. Serializa o `salvar` (um item por vez, com callback) e
  // AGREGA os erros em vez de parar no primeiro: cb({ok, erros:[{titulo,erro}]}).
  //
  // Por que não um único set() com todas as chaves: uma falha ali perde o lote
  // inteiro e o lastError não diz de QUAL item foi. Aqui, o que grava fica
  // gravado e o relatório nomeia o que não entrou.
  //
  // `atualizadoEm` é recarimbado POR ITEM porque modelosMinutaSelecionados()
  // (panel.js) ordena por recência — oito modelos no mesmo milissegundo
  // ficariam em ordem arbitrária.
  function salvarLote(itens, cb) {
    const lista = itens || [];
    const erros = [];
    let i = 0;
    // Recursão por callback, não async/await: este arquivo não tem uma única
    // Promise e não vai ganhar a primeira aqui. Com um stub SÍNCRONO de storage
    // (harness de teste) a recursão é síncrona — inofensivo nos tamanhos de
    // lote reais (dezenas), mas não transforme isto num laço sobre milhares.
    (function passo() {
      if (i >= lista.length) {
        cb({ ok: lista.length - erros.length, erros });
        return;
      }
      const m = lista[i++];
      m.atualizadoEm = Date.now();
      salvar(m, (erro) => {
        if (erro) erros.push({ id: m.id, titulo: m.titulo, erro });
        passo();
      });
    })();
  }

  // Re-lista a cada mudança na própria aba ou em outra. Filtra a área "local"
  // e o prefixo "modelo:" para NÃO colidir com o storage.onChanged do
  // content.js (config) nem com o do PLIB (área "sync").
  function aoMudar(cb) {
    try {
      chrome.storage.onChanged.addListener((ch, areaName) => {
        if (areaName !== AREA) return;
        if (!Object.keys(ch).some((k) => k.startsWith(PREFIXO))) return;
        listar(cb);
      });
    } catch {
      /* sem storage (harness): sem propagação, a lista local segue valendo */
    }
  }

  return {
    listar,
    salvar,
    excluir,
    tamanhoOk,
    bytesDe,
    aoMudar,
    novoId,
    CATEGORIAS,
    rotuloCategoria,
    categoriaValida,
    TETO_BYTES,
    // importação em lote
    adivinharCategoria,
    chaveTitulo,
    fichaImportada,
    medirFicha,
    marcarDuplicados,
    salvarLote,
    _AREA: AREA,
  };
})();
