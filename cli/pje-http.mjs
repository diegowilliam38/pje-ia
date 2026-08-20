// Cliente REST do PJe legacy (Seam/JSF) para uso FORA do navegador.
//
// Porta da camada de rede do `src/pje.js`, que continua INTOCADO. Aqui não há
// DOM, não há `location` e não há sessão JSF viva: o contexto vem por parâmetro
// (a URL base) e a autenticação, por cookie.
//
// TRÊS REGRAS QUE NÃO PODEM CAIR, todas herdadas de `docs/pje-api-rest.md`:
//
// 1. SÓ ROTAS SOB `pje-legacy/`. O `web.xml` mapeia o Seam Filter — que dá o
//    contexto de sessão, e é por isso que o cookie basta e não há token — em
//    `*.seam` e em `/seam/resource/rest/pje-legacy/*`. Rota FORA desse prefixo
//    não recebe o filtro e, na sondagem real, PENDUROU: a conexão foi aceita e
//    nunca voltou, derrubando a execução por timeout, duas vezes. Requisição que
//    não volta é pior que erro, porque prende a leva inteira.
//
// 2. SÓ GET, e só as rotas escritas aqui. O catálogo registra que nem toda
//    escrita no PJe é POST — `painelUsuario/movimentar/...` e
//    `usuario/variaveisSessao/adicionar/...` são GET e ALTERAM ESTADO. Nada de
//    varrer catálogo.
//
// 3. TETO DE TEMPO EM TUDO. Ver a regra 1: o modo de falha observado é pendurar,
//    não errar. Sem `AbortController` um endpoint mudo trava tudo.
//
// O cookie NUNCA vai para log, nem em erro, nem em modo verboso: é credencial ao
// portador e vale a sessão inteira do usuário no tribunal.

// O `Accept` do NAVEGADOR, e não um estreito por rota.
//
// Medido em sessão real: `usuario/isAuthenticated` e
// `processos/numero-processo/{CNJ}/validar` respondem **406 Not Acceptable** a
// `Accept: text/plain`, mesmo devolvendo texto puro. Pedir só o que se espera
// parece mais correto e é o que quebra — o servidor negocia conteúdo de um jeito
// que só aceita a lista larga. Mimetizar o navegador é a regra segura.
const ACCEPT_PADRAO = "application/json, text/plain, */*";

const TIMEOUT_PADRAO = 15000;

// A rota de download serve arquivo, não JSON: um PDF de autos passa fácil dos
// 15 s do teto comum numa conexão doméstica.
const TIMEOUT_DOWNLOAD = 120000;

// ---------------------------------------------------------------------------
// Contexto derivado da URL base
// ---------------------------------------------------------------------------

// Espelha `siglaTribunal()` de src/pje.js: o rótulo IMEDIATAMENTE antes de
// `jus`, exceto quando ele for literalmente `pje`. `pje.tjce.jus.br` -> TJCE;
// `pje1g.trf5.jus.br` -> TRF5; `*.cloud.pje.jus.br` -> null (e aí só existe a
// rota curta de download).
export function siglaTribunal(host) {
  const p = String(host || "").split(".");
  const i = p.indexOf("jus");
  return i > 0 && p[i - 1] && p[i - 1] !== "pje" ? p[i - 1].toUpperCase() : null;
}

// Espelha `grauAtual()`: olha o base path E o hostname, porque os tribunais
// codificam o grau ora num, ora noutro.
export function grauDe(base, host) {
  return /2grau|2g(?![a-z])/.test(String(base) + " " + String(host)) ? "2g" : "1g";
}

// A URL base é o que se copia da barra de endereços até o base path:
// `https://pje.tjce.jus.br/pje1grau`. Dela saem host, base, sigla e grau — os
// quatro dados que no navegador vinham de `location`.
export function lerBase(urlBase) {
  let u;
  try {
    u = new URL(String(urlBase));
  } catch {
    throw new Error(
      "URL base inválida: " + urlBase +
        "\nEsperado algo como https://pje.tjce.jus.br/pje1grau"
    );
  }
  if (u.protocol !== "https:") throw new Error("a URL base precisa ser https");
  const base = u.pathname.split("/").filter(Boolean)[0];
  if (!base) {
    throw new Error(
      "falta o base path na URL: " + urlBase +
        "\nEle é o primeiro segmento do caminho (pje1grau, pje, 1g, primeirograu...)."
    );
  }
  // Portão de dialeto, igual ao `PJE.dialeto` da extensão: o PJe KZ (frontend
  // novo) não tem a árvore `seam` nem o id na querystring. O sinal é POSITIVO (o
  // base path), nunca "a resposta veio vazia".
  if (/^pjekz$/i.test(base)) {
    throw new Error(
      "este tribunal usa o PJe KZ (base path `pjekz`), que não expõe as rotas " +
        "`seam/resource/rest/pje-legacy/` das quais este CLI depende."
    );
  }
  return {
    origem: u.origin,
    host: u.hostname,
    base,
    sigla: siglaTribunal(u.hostname),
    grau: grauDe(base, u.hostname),
  };
}

// ---------------------------------------------------------------------------
// Cliente
// ---------------------------------------------------------------------------

export function criarCliente({ urlBase, cookie, userAgent, extras }) {
  const ctx = lerBase(urlBase);
  if (!cookie || !String(cookie).trim()) throw new Error("sessão sem cookie");

  const prefixo = ctx.origem + "/" + ctx.base + "/seam/resource/rest/pje-legacy/";
  const ua = userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";

  // Cabeçalhos `X-pje-*` / `X-no-sso` / `Authorization` capturados do cURL.
  //
  // Quando a sessão nasce no frontend novo do CNJ, o backend legado do tribunal
  // identifica a aplicação por eles (`X-pje-legacy-app`), e o filtro de CORS que
  // atende `/seam/resource/rest/pje-legacy/.*` os lê. Replicar o que o navegador
  // manda é a escolha mais segura: se o backend os exigir, funcionam; se os
  // ignorar, custam alguns bytes. O contrário — omitir e descobrir depois — daria
  // um 401 ou, pior, um 200 sem os dados.
  const cabecalhosExtras = extras && typeof extras === "object" ? extras : {};

  // Toda requisição passa por aqui. Um ponto único é o que garante que o teto de
  // tempo, os cabeçalhos e a guarda de prefixo valham para todas — e não só para
  // as que alguém lembrou de proteger.
  async function pedir(caminho, opts = {}) {
    const url = caminho.startsWith("https:") ? caminho : prefixo + caminho;
    if (!url.startsWith(prefixo)) {
      throw new Error("rota fora de pje-legacy/ é proibida: " + caminho);
    }
    const ctl = new AbortController();
    const teto = opts.timeout || TIMEOUT_PADRAO;
    const relogio = setTimeout(() => ctl.abort(), teto);
    try {
      return await fetch(url, {
        method: "GET",
        redirect: "follow",
        headers: {
          ...cabecalhosExtras,
          Cookie: cookie,
          Accept: opts.accept || ACCEPT_PADRAO,
          // Espelhar o navegador é o comportamento menos surpreendente para o
          // balanceador que emitiu o cookie sticky.
          "User-Agent": ua,
        },
        signal: ctl.signal,
      });
    } catch (e) {
      if (e && e.name === "AbortError") {
        throw new Error("a rota não respondeu em " + Math.round(teto / 1000) + "s: " + caminho);
      }
      throw new Error("falha de rede em " + caminho + ": " + (e && e.message ? e.message : e));
    } finally {
      clearTimeout(relogio);
    }
  }

  async function pedirJson(caminho, opts = {}) {
    const r = await pedir(caminho, opts);
    if (!r.ok) throw new Error("HTTP " + r.status + " em " + caminho);
    const txt = await r.text();
    if (!txt.trim()) return null;
    try {
      return JSON.parse(txt);
    } catch {
      throw new Error("resposta não é JSON em " + caminho);
    }
  }

  return {
    ctx,
    prefixo,
    pedir,
    pedirJson,

    // Versão, tribunal, instância. 12 ms na medição. É o controle POSITIVO da
    // sonda: se responde, o cookie chegou e o Seam Filter aceitou.
    statusInfo: () => pedirJson("status/info"),

    // "A sessão está viva?" respondida ANTES de gastar qualquer coisa.
    //
    // DUAS rotas, e a segunda não é redundância. `usuario/isAuthenticated`
    // responde **406 Not Acceptable** quando o `Accept` não lhe serve — medido
    // em sessão real, com a sessão PERFEITAMENTE viva. Tratar não-ok como "não
    // autenticado" fazia o CLI anunciar "o cookie expirou" para um cookie bom, e
    // mandar o usuário refazer um login que não era o problema.
    //
    // Por isso: o `Accept` é o mesmo do navegador, e qualquer resposta que não
    // seja um `true`/`false` limpo cai em `usuario/currentUser`, que devolve o
    // usuário da sessão e é inequívoca. Só depois das duas é que se afirma que a
    // sessão morreu.
    autenticado: async () => {
      try {
        const r = await pedir("usuario/isAuthenticated", {});
        if (r.ok) {
          const t = (await r.text()).trim().toLowerCase();
          if (t === "true") return true;
          if (t === "false") return false;
        }
      } catch {
        /* cai para a segunda rota */
      }
      try {
        const r = await pedir("usuario/currentUser", {});
        if (!r.ok) return false;
        const j = JSON.parse(await r.text());
        return !!(j && (j.idUsuario || j.login || j.nomeUsuario));
      } catch {
        return false;
      }
    },

    // CNJ -> idProcesso. É a rota que dispensa o formulário de Consulta
    // Processual inteiro (6 campos, A4J, views queimadas). Devolve TEXTO PURO,
    // não JSON — daí o accept.
    idPorCnj: async (cnj) => {
      const r = await pedir(
        "processos/numero-processo/" + encodeURIComponent(cnj) + "/validar"
      );
      if (!r.ok) throw new Error("HTTP " + r.status + " ao resolver o CNJ " + cnj);
      const txt = (await r.text()).trim();
      const m = txt.match(/\d{2,}/);
      if (!m) {
        throw new Error(
          "o CNJ " + cnj + " não foi encontrado nesta instância. Confira: " +
            "tribunal certo? grau certo (1º x 2º)? dígito verificador correto? " +
            "processo em segredo de justiça sem acesso deste usuário?"
        );
      }
      return m[0];
    },

    fichaEnxuta: (id) => pedirJson("processos/" + id),
    fichaMni: (id) => pedirJson("api/v1/processos-judiciais/" + id),
    partes: (id) => pedirJson("cadastro-partes/processos/" + id + "/partes"),
    documentos: (id) => pedirJson("processos/" + id + "/documentos"),
    movimentacoes: (id) => pedirJson("processos/" + id + "/movimentacoes"),

    // As DUAS rotas de download, na ordem de `urlsDownload()` do pje.js:
    // 1. COMPLETA — serve os dois tipos de peça (nascida digital e binária);
    // 2. CURTA — retrocompatibilidade, só funciona para PDF. Em peça HTML o
    //    servidor devolve 200 com CASCA VAZIA, porque sem o contexto do processo
    //    ele não sabe montar o documento.
    // Host sem sigla clara (*.cloud.pje.jus.br) só tem a curta.
    urlsDownload(idProcesso, idDoc) {
      const raiz = prefixo + "documento/download/";
      const urls = [];
      if (ctx.sigla && idProcesso) {
        urls.push(raiz + ctx.sigla + "/" + ctx.grau + "/" + idProcesso + "/" + idDoc);
      }
      urls.push(raiz + idDoc);
      return urls;
    },

    baixarBruto(url) {
      return pedir(url, { accept: "*/*", timeout: TIMEOUT_DOWNLOAD });
    },
  };
}
