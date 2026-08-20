// O núcleo: baixar as peças de um processo e montar o pacote.
//
// Compartilhado por `pje baixar`, `pje atualizar` e `pje sondar` — os três fazem
// a mesma coisa com escopos diferentes, e duplicar isto faria os três divergirem
// no primeiro ajuste.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { lerCorpo } from "./corpo.mjs";
import { sinkPasta } from "./sink-fs.mjs";
import { lerCache, lerDoDisco, limparOrfaos } from "./cache.mjs";
import { montarFicha, docsDe } from "./ficha.mjs";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// `exportar.js` é puro de propósito (src/exportar.js:14-16) e tem rodapé
// CommonJS (src/exportar.js:876): carrega no Node sem shim nenhum.
//
// É este reuso que garante que o pacote saia IDÊNTICO ao do botão do painel — e
// é por isso que o CLI mora no repositório da extensão em vez de ser um pacote
// npm solto: um pacote solto teria de duplicar este arquivo, e a cópia
// divergiria no primeiro ajuste.
export const PjeExport = require(path.join(AQUI, "..", "src", "exportar.js"));

const sono = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Uma peça
// ---------------------------------------------------------------------------

// Erros que valem uma segunda chance: rate limit, indisponibilidade momentânea e
// queda de rede. Um 404 não entra — ele é definitivo, e re-tentar só gasta tempo
// e a paciência do servidor.
function ehTransitorio(status) {
  return status === 429 || status === 408 || (status >= 500 && status < 600);
}

// O STATUS QUE VALE É O DA ROTA COMPLETA, não o da última tentada.
//
// As duas rotas fracassam de formas diferentes e a curta é a MENOS informativa:
// medido neste processo, ela devolve 404 para TODA peça — inclusive para as que
// a completa entrega com 200. Guardar "o último status" fazia um 403 da rota boa
// ser reportado como 404 da rota ruim, e 404 e 403 são diagnósticos opostos:
// "não existe" contra "você não pode". O relatório mandava o usuário procurar a
// peça no lugar errado.
function statusMaisInformativo(a, b) {
  // 0 = nem respondeu. Qualquer resposta vale mais que nenhuma.
  if (!a) return b;
  if (!b) return a;
  // Entre duas respostas, a que NÃO é 404 diz mais: 403/500/429 apontam causa.
  if (a !== 404) return a;
  return b;
}

export async function obterPeca(cli, idProcesso, idDoc, { tentativas = 3 } = {}) {
  const urls = cli.urlsDownload(idProcesso, idDoc);
  let melhorStatus = 0;
  let houveErroDeRede = false;
  let recusa = null;

  for (let t = 0; t < tentativas; t++) {
    houveErroDeRede = false;
    for (const u of urls) {
      let r;
      try {
        r = await cli.baixarBruto(u);
      } catch {
        // Rede caiu ou o teto de tempo estourou. Isso É transitório e precisa
        // valer re-tentativa — antes ele não valia, porque sem `status` a
        // guarda de transitório nunca disparava e a peça era dada como perdida
        // por um soluço de rede.
        houveErroDeRede = true;
        continue;
      }
      melhorStatus = statusMaisInformativo(melhorStatus, r.status);
      if (!r.ok) continue;
      try {
        const corpo = await lerCorpo(r, idDoc);
        if (corpo) return { ok: true, corpo };
      } catch (e) {
        // Veio inteiro, mas não é documento que dê para guardar. Não adianta
        // tentar a outra rota nem re-tentar: guarda o motivo e para.
        recusa = e.message;
        return { ok: false, motivo: recusa };
      }
    }
    if (!houveErroDeRede && !ehTransitorio(melhorStatus)) break;
    await sono(800 * (t + 1)); // backoff simples e crescente
  }

  if (recusa) return { ok: false, motivo: recusa };

  if (melhorStatus === 403) {
    // O servidor entendeu quem somos e RECUSOU este documento. Não é falha
    // técnica e não há retry que resolva — medido: 403 com e sem os cabeçalhos
    // `X-pje-*`, com e sem `Referer`, nas duas rotas.
    return {
      ok: false,
      motivo: "HTTP 403 (o PJe recusou o acesso a esta peça)",
      semPermissao: true,
    };
  }
  if (melhorStatus === 404) {
    return {
      ok: false,
      motivo: "HTTP 404 (o PJe não tem download para esta peça)",
      naoServivel: true,
    };
  }
  if (houveErroDeRede && !melhorStatus) {
    return { ok: false, motivo: "a rede não respondeu depois de " + tentativas + " tentativas" };
  }
  if (melhorStatus && melhorStatus !== 200) {
    return { ok: false, motivo: "HTTP " + melhorStatus };
  }
  // O limite conhecido: o PJe não materializa a peça até ela ser aberta na
  // sessão. Não é a rota — é estado no servidor.
  return {
    ok: false,
    motivo: "não materializada nesta sessão (o PJe devolveu envelope vazio)",
    casca: true,
  };
}

// ---------------------------------------------------------------------------
// Pool de prefetch
//
// `montarZip` chama `obter(id)` UM POR VEZ, em ordem cronológica, e esse
// contrato não muda — o que mudaria a numeração e o índice. O paralelismo entra
// por baixo: uma janela vai baixando adiante e `obter` só aguarda a promessa que
// já está em voo. Mesmo truque do pipeline de upload da extensão
// (`baixarSelecionadas`), e `src/exportar.js` segue intocado.
//
// A JANELA É LIMITADA de propósito. Disparar as 141 de uma vez traria todas para
// a memória ao mesmo tempo — e o conteúdo é base64, ~1,33x os bytes. Num
// processo grande isso mata o Node antes de gravar a primeira peça.
//
// O paralelo é legítimo aqui, ao contrário do que a extensão faz: a serialização
// que ela obedece é da ativação A4J na sessão JSF, que este caminho não toca.
// O catálogo mediu 5 requisições REST simultâneas respondendo, duas vezes.
// ---------------------------------------------------------------------------

function criarPool(ids, concorrencia, buscar) {
  const emVoo = new Map();
  let proximo = 0;

  function encher() {
    while (emVoo.size < concorrencia && proximo < ids.length) {
      const id = ids[proximo++];
      emVoo.set(id, buscar(id));
    }
  }
  encher();

  return async function obter(id) {
    if (!emVoo.has(id)) emVoo.set(id, buscar(id)); // fora de ordem: busca avulsa
    const p = emVoo.get(id);
    try {
      return await p;
    } finally {
      emVoo.delete(id);
      encher();
    }
  };
}

// ---------------------------------------------------------------------------
// Um processo
// ---------------------------------------------------------------------------

export async function baixarProcesso(cli, cnj, opcoes = {}) {
  const {
    destinoRaiz = "autos",
    forcar = false,
    concorrencia = 3,
    zip = false,
    onProgresso = null,
  } = opcoes;

  const id = await cli.idPorCnj(cnj);

  const [enxuta, partes] = await Promise.all([
    cli.fichaEnxuta(id).catch(() => null),
    cli.partes(id).catch(() => null),
  ]);
  const ficha = montarFicha({ cnj, enxuta, partes });

  const docs = docsDe(await cli.documentos(id));
  if (!docs.length) throw new Error("a lista de peças veio vazia");

  const pasta = path.join(destinoRaiz, PjeExport.nomePasta(cnj));
  fs.mkdirSync(pasta, { recursive: true });

  // O cache é lido ANTES da montagem: durante ela os arquivos são reescritos, e
  // um índice lido no meio já não descreveria o que está no disco.
  const cache = forcar ? { mapa: new Map(), geradoEm: null } : lerCache(pasta);
  const novas = docs.filter((d) => !cache.mapa.has(d.id));

  let baixadas = 0;
  let reusadas = 0;
  const cascas = [];
  const naoServiveis = [];
  const semPermissao = [];
  let sessaoMorreu = false;

  const buscar = async (idDoc) => {
    const doCache = cache.mapa.get(idDoc);
    if (doCache) {
      reusadas++;
      return { ok: true, corpo: lerDoDisco(doCache) };
    }
    const r = await obterPeca(cli, id, idDoc);
    if (r.ok) {
      baixadas++;
      if (onProgresso) onProgresso(baixadas, novas.length);
    }
    return r;
  };

  // Só as peças NOVAS entram no pool — as do cache resolvem na hora e não devem
  // ocupar a janela.
  const poolObter = criarPool(
    docs.map((d) => d.id),
    Math.max(1, Math.min(5, concorrencia)),
    buscar
  );

  const obter = async (idDoc) => {
    if (sessaoMorreu) throw new Error("sessão do PJe encerrada durante a rodada");
    const r = await poolObter(idDoc);
    if (!r.ok) {
      if (r.casca) cascas.push(idDoc);
      if (r.naoServivel) naoServiveis.push(idDoc);
      if (r.semPermissao) semPermissao.push(idDoc);
      // "A SESSÃO CAIU" É UMA AFIRMAÇÃO FORTE E PRECISA SER CONFIRMADA.
      //
      // Tratar todo 403 como sessão morta foi um defeito caro: um 403 POR
      // DOCUMENTO — que é o caso real, com as outras 134 peças respondendo 200
      // na mesma sessão — abortava o lote inteiro. A diferença entre "você não
      // pode ver ESTE documento" e "você não está mais logado" não está no
      // status; está em perguntar.
      //
      // Uma requisição a mais por 403 é barata, e só acontece no caminho de
      // exceção.
      if (r.semPermissao && !(await cli.autenticado())) sessaoMorreu = true;
      throw new Error(r.motivo);
    }
    return r.corpo;
  };

  const origemLista =
    "lista oficial de documentos do PJe (rota REST), lida em " +
    new Date().toLocaleDateString("pt-BR");

  const res = await PjeExport.montarZip({
    docs, obter, cnj, ficha, origemLista, zip: sinkPasta(pasta),
  });

  // A renumeração cronológica faz a mesma peça mudar de nome quando entra uma
  // peça nova antes dela. Sem esta limpeza a pasta acumularia o mesmo documento
  // sob dois números a cada execução.
  const orfaos = limparOrfaos(
    pasta,
    res.itens.map((it) => it.arquivo),
    res.itens.map((it) => it.id),
    docs.map((d) => d.id)
  );

  // Quando houve 403, vale uma requisição a mais para trazer a EVIDÊNCIA.
  //
  // Medido num processo real do TJCE: as quatro peças "Mandado" recusadas
  // correspondem a quatro movimentos que dizem `Situacao: Cancelado em
  // 26/07/2024` — e na linha do tempo do PJe elas aparecem com o título RISCADO.
  // O PJe não serve documento cancelado, e o 403 é isso.
  //
  // Isso muda o que o relatório significa: a ausência dessas peças não é lacuna
  // do pacote, é o pacote refletindo os autos. Um mandado cancelado não integra
  // o que vale no processo.
  //
  // A ligação movimento -> peça NÃO é automática: o `textoFinalExterno` só traz
  // `Documento: NNNN` em alguns eventos, e nestes não traz. Por isso o CLI
  // OFERECE as movimentações de cancelamento como pista para quem lê, em vez de
  // afirmar qual peça corresponde a qual — afirmar exigiria um pareamento que
  // este dado não sustenta.
  let pistasCancelamento = [];
  if (semPermissao.length) {
    try {
      const movs = await cli.movimentacoes(id);
      pistasCancelamento = (movs || [])
        .map((m) => [m.dsEvento, m.textoFinalExterno].filter(Boolean).join(" | "))
        .filter((t) => /cancelad|sem efeito|tornad[oa] sem efeito/i.test(t))
        .map((t) => t.replace(/\s+/g, " ").trim());
    } catch {
      /* sem as movimentações o relatório continua correto, só menos informativo */
    }
  }

  let arquivoZip = null;
  if (zip) arquivoZip = await gerarZip(pasta, cnj, res, ficha, origemLista);

  return {
    cnj, pasta, id,
    resumo: res.resumo,
    falhas: res.falhasDetalhe,
    cascas, naoServiveis, semPermissao, pistasCancelamento, baixadas, reusadas, orfaos,
    total: docs.length,
    jaEmDisco: cache.mapa.size,
    novas: novas.length,
    sessaoMorreu,
    zip: arquivoZip,
  };
}

// O `.zip` é montado a partir do que JÁ ESTÁ NA PASTA, não de uma segunda ida ao
// PJe: `lerCache` devolve exatamente o `obter` que `montarZip` precisa. Custa
// leitura de disco e nada de rede.
async function gerarZip(pasta, cnj, res, ficha, origemLista) {
  // `src/zip.js` termina em `window.ZipW = {...}`, e `window` não existe no
  // Node. Uma linha resolve, e o arquivo segue INTOCADO — o que importa, porque
  // ele é content script da extensão publicada.
  if (typeof globalThis.window === "undefined") globalThis.window = globalThis;
  require(path.join(AQUI, "..", "src", "zip.js"));
  const ZipW = globalThis.window.ZipW;

  const cache = lerCache(pasta);
  const docs = res.itens.map((it) => ({
    id: it.id,
    titulo: it.tituloCompleto || it.titulo,
    tipo: it.tipo,
    juntadoEm: it.juntadoEm,
    juntadoPor: it.juntadoPor,
  }));

  const saida = await PjeExport.montarZip({
    docs,
    obter: async (id) => {
      const c = cache.mapa.get(id);
      if (!c) throw new Error("peça não está na pasta");
      return lerDoDisco(c);
    },
    cnj, ficha, origemLista, zip: ZipW,
  });

  const alvo = path.join(path.dirname(pasta), saida.nome);
  fs.writeFileSync(alvo, Buffer.from(await saida.blob.arrayBuffer()));
  return alvo;
}
