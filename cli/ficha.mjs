// Adaptadores: respostas das rotas REST -> os formatos que `src/exportar.js`
// espera. É o ÚNICO ponto do CLI que produz algo que a extensão produzia de
// outro jeito (lá a ficha vem de raspar `#maisDetalhes` do DOM), então é o
// primeiro lugar onde uma divergência aparece ao comparar os dois pacotes.

// `dataBr` de src/pje.js:1461 — "2026-06-22 15:52:38.789" -> "22/06/2026 15:52".
// O formato BRASILEIRO é contrato: `instanteDe`, `ordenarCronologico` e o índice
// do pacote já o esperam. Converter na ORIGEM é o que faz o resto não mudar uma
// linha — e, portanto, não ter como regredir.
export function dataBr(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) return String(s);
  return m[3] + "/" + m[2] + "/" + m[1] + " " + m[4] + ":" + m[5];
}

function pessoaDe(p) {
  if (!p) return null;
  const nome = p.nomePessoa || p.nomeParte || p.nome || "";
  if (!nome) return null;
  return {
    nome,
    papel: p.tipoParte || p.participacao || "",
    documento: p.documentoPrincipal || p.documentoIdentificatorio || "",
    tipoDocumento: p.tipoPessoa === "J" ? "CNPJ" : p.tipoPessoa === "F" ? "CPF" : "",
    representantes: [],
  };
}

// `blocoFicha` (src/exportar.js:147) quer
// `{campos:{rotulo:valor}, poloAtivo:[], poloPassivo:[]}`.
export function montarFicha({ cnj, enxuta, partes }) {
  const campos = {};
  const por = (rotulo, valor) => {
    if (valor !== undefined && valor !== null && String(valor).trim()) {
      campos[rotulo] = String(valor).trim();
    }
  };

  if (enxuta) {
    por("Número", enxuta.numeroProcesso || cnj);
    por("Classe judicial", enxuta.classeJudicial);
    por("Órgão julgador", enxuta.orgaoJulgador);
    por("Jurisdição", enxuta.jurisdicao);
    por("Distribuição", dataBr(enxuta.dataDistribuicao) || enxuta.dataDistribuicao);
    por("Status", enxuta.status);
    // `sobSegredo` (src/exportar.js:139) procura um campo cujo NOME case
    // /segredo|sigilo/ e cujo valor comece por "sim". É este rótulo que faz o
    // banner de segredo de justiça aparecer no LEIA-ME e no índice — sem ele um
    // processo sigiloso sairia do CLI SEM o aviso que o pacote da extensão põe,
    // e o pacote circula fora da ferramenta.
    if (enxuta.nivelAcesso !== undefined && enxuta.nivelAcesso !== null) {
      const n = Number(enxuta.nivelAcesso);
      por("Segredo de justiça", Number.isFinite(n) && n > 0 ? "Sim" : "Não");
    }
  } else {
    por("Número", cnj);
  }

  const poloAtivo = [];
  const poloPassivo = [];
  if (partes) {
    for (const p of partes.poloAtivoList || []) {
      const q = pessoaDe(p);
      if (q) poloAtivo.push(q);
    }
    for (const p of partes.poloPassivoList || []) {
      const q = pessoaDe(p);
      if (q) poloPassivo.push(q);
    }
  }

  return { numero: cnj, campos, poloAtivo, poloPassivo };
}

// Lista de peças da rota REST -> o shape que `montarZip` espera.
export function docsDe(lista) {
  const docs = [];
  for (const d of lista || []) {
    const id = String(d.id == null ? "" : d.id).trim();
    if (!/^\d{4,}$/.test(id)) continue;
    const tipo = (d.descricao || "").trim();
    docs.push({
      id,
      // Título no formato "id - Nome", o mesmo da extensão: é dele que
      // `nomeArquivo` tira a parte descritiva, depois de remover o id inicial.
      titulo: id + (tipo ? " - " + tipo : ""),
      tipo: tipo || null,
      juntadoEm: dataBr(d.data),
      // A rota REST não traz quem juntou; a grid trazia, e aqui não há grid.
      // Omitir é melhor que inventar: o índice registra o campo como vazio.
      juntadoPor: null,
      binario: d.binario === true,
    });
  }
  return docs;
}
