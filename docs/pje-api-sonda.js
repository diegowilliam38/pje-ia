/* =============================================================================
 * SONDA DA API REST INTERNA DO PJe  —  ferramenta de diagnóstico, não da extensão
 * =============================================================================
 *
 * COMO USAR: abra um processo no PJe (a tela de autos digitais), abra o console
 * do navegador (F12) e cole este arquivo inteiro. O relatório sai no console e
 * fica em `window.__sonda` para inspeção.
 *
 * PARA QUE SERVE: o catálogo em `docs/pje-api-rest.md` foi levantado do
 * código-fonte do PJe legacy (CNJ, snapshot de 2019) cruzado com o que outras
 * extensões usam hoje. Catálogo não é contrato vigente: a rota que a v0.38.0
 * usa (`processos/{id}/documentos`) NÃO existe no fonte de 2019, e rotas do
 * fonte podem ter sumido. Esta sonda é o que separa "consta do catálogo" de
 * "responde neste tribunal, nesta versão, hoje".
 *
 * REGRAS DE CONSTRUÇÃO — nenhuma delas é preciosismo:
 *
 *  · SOMENTE GET. O catálogo tem rotas que movimentam tarefa, criam etiqueta e
 *    assinam documento. Uma sonda que as tocasse alteraria processo de verdade,
 *    e o estrago só apareceria depois. Nenhum POST/PUT/DELETE entra aqui, nem
 *    "para testar".
 *
 *  · SEQUENCIAL, COM PAUSA. A sessão do PJe é uma fila só (ver a seção homônima
 *    no CLAUDE.md). Uma rajada de dezenas de requisições concorreria com o
 *    trabalho do usuário na mesma aba.
 *
 *  · CONTROLE POSITIVO E NEGATIVO, obrigatórios. Sem saber o que este servidor
 *    responde a uma rota que sabidamente existe e a uma que sabidamente não
 *    existe, um 404 é ambíguo — pode ser rota ausente ou sonda quebrada. São
 *    duas requisições que tornam as outras interpretáveis.
 *
 *  · O RELATÓRIO NÃO CARREGA CONTEÚDO DOS AUTOS. Reporta o FORMATO (chaves do
 *    primeiro objeto, contagem de itens, tamanho), nunca os valores. O que se
 *    quer saber é se a rota existe e o que ela devolve, não o que diz o
 *    processo — e o relatório é colado em documento e conversa.
 *
 *  · SÓ PARÂMETROS QUE TEMOS. idProcesso, número CNJ e um idDocumento vindo da
 *    própria lista. Rotas que exigem idTarefa/idTag/idProcessoParte ficam
 *    marcadas como NÃO SONDÁVEIS e vão DITAS no relatório — omitir daria a
 *    impressão de cobertura que não houve.
 *
 *  · TIMEOUT POR REQUISIÇÃO, e ele não é zelo: na sondagem de 13/08/2026 as
 *    rotas FORA do prefixo `pje-legacy/` (fluxo, informacaoSessao, monitoracao)
 *    PENDURARAM — a conexão não voltou e derrubou a execução inteira por
 *    timeout, duas vezes. Sem o AbortController, uma rota assim trava a sonda no
 *    meio e o relatório se perde.
 *
 *  · A LISTA DE ALVOS É EXPLÍCITA, nunca gerada a partir do catálogo. Nem toda
 *    escrita nesta API é POST: `painelUsuario/movimentar/{idTarefa}/{transicao}`
 *    e `modalAudienciaLote/designar/…` são GET e ALTERAM O PROCESSO. Varrer
 *    "todos os GET" movimentaria processo de verdade.
 * ========================================================================== */

(async () => {
  "use strict";

  // --- contexto -------------------------------------------------------------
  // O base path varia por tribunal e por grau (pje1grau, pje, pje2g…): é o
  // primeiro segmento do caminho, a mesma derivação que `getBase()` em pje.js.
  const BASE = location.pathname.split("/")[1] || "";
  const RAIZ = "/" + BASE + "/seam/resource/rest/";
  const ID = new URLSearchParams(location.search).get("idProcesso");

  // Número CNJ: raspado da tela, best-effort. Sem ele, a rota que o consome
  // sai como não sondável em vez de ir com um valor inventado.
  const CNJ = (document.body.innerText.match(/\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}/) || [])[0] || null;

  if (!ID) {
    console.error("[sonda] sem ?idProcesso na URL — abra a tela de autos digitais de um processo.");
    return;
  }

  const PAUSA = 250; // ms entre requisições: cede a sessão ao usuário
  const TETO = 8000; // ms por requisição — ver a regra do timeout no cabeçalho
  const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

  // --- uma requisição -------------------------------------------------------
  // Devolve SEMPRE um registro, mesmo em falha de rede ou pendura: "não deu para
  // saber" é um resultado, e some do relatório se a exceção subir.
  async function sondar(rotulo, caminho, opts = {}) {
    const url = RAIZ + caminho.replace(/^\/+/, "");
    const t0 = performance.now();
    const reg = { rotulo, caminho, url };
    const ac = new AbortController();
    const corta = setTimeout(() => ac.abort(), TETO);
    try {
      const r = await fetch(url, {
        credentials: "include",
        headers: { Accept: opts.accept || "application/json" },
        redirect: "manual", // um 302 para a tela de login é resposta, não sucesso
        cache: "no-store", // resposta de sonda nunca deve vir do cache do Chrome
        signal: ac.signal,
      });
      reg.status = r.status;
      reg.tipo = (r.headers.get("content-type") || "").split(";")[0];
      reg.ms = Math.round(performance.now() - t0);

      // `redirect:"manual"` faz o fetch devolver uma resposta opaca (status 0)
      // quando o servidor redireciona — é o sinal de sessão expirada.
      if (r.type === "opaqueredirect" || r.status === 0) {
        reg.veredito = "REDIRECIONA (sessão?)";
        return reg;
      }

      const corpo = await r.text();
      reg.bytes = corpo.length;

      if (!r.ok) {
        reg.veredito = r.status === 404 ? "AUSENTE" : r.status === 401 || r.status === 403 ? "NEGADA" : "ERRO " + r.status;
        // a primeira linha do corpo de erro costuma dizer o motivo; sem autos dentro
        reg.nota = corpo.slice(0, 120).replace(/\s+/g, " ").trim();
        return reg;
      }

      // 200 com corpo vazio é a "casca" que já nos mordeu no download de peça:
      // HTTP ok não é o mesmo que resposta útil.
      if (!corpo.trim()) {
        reg.veredito = "VAZIA (200 sem corpo)";
        return reg;
      }

      // FORMATO, nunca conteúdo.
      if (/json/.test(reg.tipo) || /^[[{]/.test(corpo.trim())) {
        try {
          const j = JSON.parse(corpo);
          if (Array.isArray(j)) {
            reg.forma = `array[${j.length}]`;
            if (j.length && j[0] && typeof j[0] === "object") reg.campos = Object.keys(j[0]);
          } else if (j && typeof j === "object") {
            reg.forma = "objeto";
            reg.campos = Object.keys(j);
          } else {
            reg.forma = typeof j;
          }
          reg.veredito = "CONFIRMADA";
          reg.json = j; // fica só em window.__sonda, nunca no resumo impresso
        } catch {
          reg.forma = "não-JSON";
          reg.veredito = "CONFIRMADA (corpo não-JSON)";
          reg.nota = corpo.slice(0, 80).replace(/\s+/g, " ").trim();
        }
      } else {
        reg.forma = reg.tipo || "sem content-type";
        reg.veredito = "CONFIRMADA";
        // texto curto (a chave de acesso, por exemplo) cabe no relatório sem risco
        if (corpo.length < 60) reg.nota = corpo.trim();
      }
      return reg;
    } catch (e) {
      reg.veredito = e && e.name === "AbortError" ? `PENDUROU (>${TETO}ms)` : "FALHA";
      if (reg.veredito === "FALHA") reg.nota = String(e && e.message).slice(0, 100);
      reg.ms = Math.round(performance.now() - t0);
      return reg;
    } finally {
      clearTimeout(corta);
    }
  }

  // --- o que sondar ---------------------------------------------------------
  // Ordem deliberada: controles primeiro. Se eles não se comportarem, o resto
  // do relatório não quer dizer nada e é melhor saber disso no começo.
  const p = "pje-legacy/";
  const alvos = [
    ["CONTROLE +  (rota que sabemos viva)", p + "processos/" + ID + "/documentos"],
    ["CONTROLE −  (rota inventada)", p + "rota-que-nao-existe-" + Date.now()],

    // — o processo em si ---------------------------------------------------
    ["ficha do processo", p + "processos/" + ID],
    ["status do processo", p + "processos/" + ID + "/status"],
    ["movimentações (todas)", p + "processos/" + ID + "/movimentacoes"],
    ["último movimento", p + "processos/" + ID + "/ultimoMovimento"],
    ["atos processuais (peças)", p + "processos/" + ID + "/atosProcessuais"],
    ["polo passivo", p + "processos/" + ID + "/poloPassivo"],
    ["tarefas abertas", p + "processos/" + ID + "/tarefas"],

    // — rotas vistas em outra extensão, ausentes no fonte de 2019 -----------
    // A 1ª deu 404 no TJCE 2.9.7.0 e a 2ª devolveu o processo em formato MNI:
    // fica nas duas listas justamente para reconferir em outro tribunal.
    ["dados completos (sem id)", p + "api/v1/dados-completos/"],
    ["dados completos (com id)", p + "api/v1/dados-completos/" + ID],
    ["MNI processos-judiciais", p + "api/v1/processos-judiciais/" + ID],

    // — partes -------------------------------------------------------------
    ["partes (todas)", p + "cadastro-partes/processos/" + ID + "/partes"],
    ["partes polo ativo", p + "cadastro-partes/processos/" + ID + "/partes/ativo"],
    ["partes polo passivo", p + "cadastro-partes/processos/" + ID + "/partes/passivo"],

    // — sessão e ambiente --------------------------------------------------
    ["sessão viva?", p + "usuario/isAuthenticated"],
    ["usuário atual", p + "usuario/currentUser"],
    ["informações do usuário", p + "usuario/listarInformacaoUsuario"],
    ["painel: dados do usuário", p + "painelUsuario/dadosUsuario"],
    ["cabeçalho do sistema", p + "parametros/cabecalhoSistema"],
    ["status/health", p + "status/health"],
    ["status/info (versão)", p + "status/info"],
    ["identity/auth", p + "identity/auth"],

    // — chave de acesso (o `ca` da URL) ------------------------------------
    ["chave de acesso", p + "painelUsuario/gerarChaveAcessoProcesso/" + ID, { accept: "text/plain" }],

    // — tabelas de apoio (baratas, e dizem se a família responde) -----------
    ["histórico de tarefas", p + "painelUsuario/historicoTarefas/" + ID],
    ["etiquetas do processo", p + "painelUsuario/processoTags/listar/" + ID],
    ["órgãos julgadores", p + "painelUsuario/orgaosJulgadores"],
  ];

  // CNJ → idProcesso: a rota que dá à extensão uma capacidade que ela não tem
  // (hoje o id só vem da URL). Sem CNJ na tela, sai como não sondável.
  if (CNJ) alvos.push(["CNJ -> idProcesso", p + "processos/numero-processo/" + CNJ + "/validar", { accept: "text/plain" }]);

  // --- execução -------------------------------------------------------------
  console.log(`[sonda] base=${BASE} idProcesso=${ID} cnj=${CNJ || "(não achado)"} — ${alvos.length} rotas`);
  const res = [];
  for (const [rotulo, caminho, opts] of alvos) {
    res.push(await sondar(rotulo, caminho, opts));
    await dormir(PAUSA);
  }

  // Uma peça de verdade, tirada do controle positivo: é o único jeito honesto
  // de sondar a rota de PDF sem inventar um id.
  const ctrl = res[0];
  const idDoc = Array.isArray(ctrl && ctrl.json) && ctrl.json.length ? (ctrl.json[0] || {}).id : null;
  if (idDoc) {
    res.push(await sondar("PDF oficial (rota mobile)", p + "api/v1/mobile/processos/documentos/gerar-pdf/" + idDoc, { accept: "application/pdf" }));
  } else {
    res.push({ rotulo: "PDF oficial (rota mobile)", veredito: "NÃO SONDADA", nota: "sem idDocumento — o controle positivo não devolveu lista" });
  }

  // --- relatório ------------------------------------------------------------
  const linhas = res.map((r) => {
    const st = r.status != null ? String(r.status).padStart(3) : "  —";
    const forma = r.forma ? ` ${r.forma}` : "";
    const campos = r.campos ? `  {${r.campos.slice(0, 9).join(", ")}${r.campos.length > 9 ? ", …" : ""}}` : "";
    const nota = r.nota ? `  «${r.nota}»` : "";
    return `${(r.veredito || "?").padEnd(22)} ${st}  ${(r.rotulo || "").padEnd(28)}${forma}${campos}${nota}`;
  });

  const naoSondaveis = [
    "painelUsuario/transicoes/{idTarefa} e todo o grupo de TAREFA — exige idTarefa",
    "painelUsuario/recuperarProcesso/{idTaskInstance}/{assinatura} — exige idTaskInstance",
    "informacoes-criminais/** — exige idProcessoParte (sai das partes, se elas responderem)",
    "modalAudienciaLote/** e modalPericiaLote/** — exigem idTipoAudiencia/idEspecialidade",
    "tudo que é POST/PUT/DELETE — fora da sonda por decisão, não por falta de dado",
  ];

  const texto =
    `\n===== SONDA DA API REST DO PJe =====\n` +
    `base=${BASE}  idProcesso=${ID}  cnj=${CNJ || "—"}\n` +
    `host=${location.host}\n\n` +
    linhas.join("\n") +
    `\n\nNÃO SONDÁVEIS nesta passada (dito, não omitido):\n  · ` +
    naoSondaveis.join("\n  · ") +
    `\n\nCONFERIR AGORA, na mesma aba: a timeline ainda responde? Se a premissa de\n` +
    `que estas rotas não consomem view JSF estiver errada, é aqui que aparece.\n`;

  console.log(texto);
  window.__sonda = { registros: res, texto, base: BASE, id: ID, cnj: CNJ };
  return texto;
})();
