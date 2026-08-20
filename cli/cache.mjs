// Cache local: o que já está no disco não é baixado de novo.
//
// A FONTE DE VERDADE é o `indice.json` que o próprio pacote grava. Ele já traz,
// por peça, `id`, `arquivo`, `formato` e `paginas` — isto é, tudo de que se
// precisa para reconstruir o retorno de `obter(id)` sem tocar no PJe. Não há
// banco, não há formato novo, e o cache não pode dessincronizar do pacote,
// porque ele É o pacote.
//
// POR QUE NÃO "baixar só as novas e anexar" (que é o desenho óbvio):
// o `NNN_` do nome do arquivo é a posição CRONOLÓGICA da peça, recalculada sobre
// a lista INTEIRA a cada montagem. Uma peça nova que entre no meio empurra todas
// as seguintes, e anexar deixaria a pasta com o mesmo documento sob dois números
// — sem erro nenhum, e só perceptível ao abrir.
//
// Por isso `montarZip` segue montando o pacote inteiro toda vez. Quem fica
// esperto é o `obter`: peça em disco é lida do disco. O efeito para o usuário é
// o mesmo (só o que é novo trafega), e a pasta nunca fica inconsistente.
//
// Efeito colateral bom e nada óbvio: peça que da última vez voltou como CASCA
// não entrou no índice — logo, ela é RETENTADA na execução seguinte. Abrir o
// processo no navegador e rodar de novo é o caminho natural de recuperação, sem
// nenhum comando especial.

import fs from "node:fs";
import path from "node:path";

// `formato` do índice -> como o conteúdo volta para o `montarZip`. É a inversa
// exata do que `lerCorpo` produz; divergir aqui faria a peça reaparecer com
// `kind` errado e ser gravada de outro jeito na segunda execução.
const BINARIOS = new Set(["pdf", "jpeg", "png", "gif", "webp"]);

export function lerCache(pasta) {
  const arq = path.join(pasta, "indice.json");
  let idx;
  try {
    idx = JSON.parse(fs.readFileSync(arq, "utf8"));
  } catch {
    // Sem índice (primeira execução, ou pasta mexida à mão) o cache é vazio e
    // tudo é baixado. Nunca é erro.
    return { mapa: new Map(), geradoEm: null, total: 0 };
  }

  const mapa = new Map();
  for (const p of idx.pecas || []) {
    if (!p || !p.id || !p.arquivo) continue;
    const alvo = path.join(pasta, "pecas", p.arquivo);
    // O índice pode citar arquivo que já não existe (alguém apagou). Conferir a
    // existência AGORA evita descobrir isso no meio da montagem, quando a peça
    // já teria sido dada como resolvida.
    if (!fs.existsSync(alvo)) continue;
    mapa.set(String(p.id), { caminho: alvo, formato: p.formato || "texto", paginas: p.paginas || null });
  }
  return { mapa, geradoEm: idx.geradoEm || null, total: mapa.size };
}

// Reconstrói o objeto que `lerCorpo` teria devolvido, a partir do arquivo local.
export function lerDoDisco(entrada) {
  const { caminho, formato, paginas } = entrada;
  if (BINARIOS.has(formato)) {
    const bytes = fs.readFileSync(caminho);
    return {
      kind: formato === "pdf" ? "pdf" : "img",
      fmt: formato,
      b64: bytes.toString("base64"),
      size: bytes.length,
      pages: formato === "pdf" ? paginas || 1 : undefined,
      doCache: true,
    };
  }
  const text = fs.readFileSync(caminho, "utf8");
  return { kind: "text", fmt: formato, text, doCache: true };
}

// Remove os arquivos de peça que a montagem NOVA não produziu.
//
// Sem isto, o cache seria uma armadilha: a renumeração faz a mesma peça mudar de
// nome, o arquivo antigo permanece, e a pasta acumula duplicatas sob números
// diferentes a cada execução — exatamente o defeito que motivou remontar o
// pacote inteiro em vez de anexar.
//
// Só apaga o que casa o padrão gerado (`NNN_...`), nunca um arquivo que o
// usuário tenha posto ali.
// `nomesValidos`: os arquivos que a montagem ACABOU de escrever.
// `idsRegravados`: os ids que entraram nessa montagem.
//
// A REGRA É POR ID, NÃO POR NOME, e isso não é refinamento — é o que impede a
// limpeza de destruir dados. Uma rodada que aborta no meio (sessão caiu, rede
// sumiu) produz um índice PARCIAL; com o critério ingênuo "não está no índice
// novo, apaga", tudo o que ainda não tinha sido reescrito vira órfão e some.
// Aconteceu: 84 peças boas apagadas porque a rodada parou na peça 50.
//
// Só é órfão o arquivo cujo id FOI regravado agora sob outro nome — isto é, a
// sobra de uma renumeração. Arquivo de um id que não entrou nesta rodada é
// download anterior e FICA, aconteça o que acontecer com a rodada.
export function limparOrfaos(pasta, nomesValidos, idsRegravados, idsNoProcesso) {
  const dir = path.join(pasta, "pecas");
  let removidos = 0;
  let nomes;
  try {
    nomes = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  const validos = new Set(nomesValidos);
  const regravados = new Set((idsRegravados || []).map(String));
  // `null` = "não sei quais são" (chamador antigo). Nesse caso o critério de
  // "saiu do processo" não pode ser aplicado, e o seguro é preservar.
  const noProcesso = idsNoProcesso ? new Set(idsNoProcesso.map(String)) : null;

  for (const n of nomes) {
    if (!/^\d{3}_/.test(n)) continue; // não é arquivo gerado por nós
    if (validos.has(n)) continue; // é o arquivo atual deste id

    // O id é o último grupo de dígitos antes da extensão — é assim que
    // `nomeArquivo` (src/exportar.js:68) o coloca, e é o que sobrevive a sair da
    // ferramenta.
    const m = n.match(/_(\d{4,})\.[^.]+$/);
    const id = m ? m[1] : null;
    if (!id) continue; // nome que não reconhecemos: não é nosso para apagar

    // DOIS motivos legítimos para apagar, e só eles:
    const sobraDeRenumeracao = regravados.has(id); // este id foi regravado com outro nome
    const saiuDoProcesso = noProcesso ? !noProcesso.has(id) : false;

    // Fora desses, PRESERVA — e o caso que isso protege é o que mais dói: peça
    // que está no processo e falhou NESTA rodada (sessão caiu, rede sumiu). Ela
    // não aparece no índice novo, e sem esta guarda seria apagada justamente
    // quando o download anterior é a única cópia que resta.
    if (!sobraDeRenumeracao && !saiuDoProcesso) continue;

    try {
      fs.unlinkSync(path.join(dir, n));
      removidos++;
    } catch {
      /* arquivo em uso ou sem permissão: não é motivo para derrubar a execução */
    }
  }
  return removidos;
}

// Descobre os processos já baixados numa pasta de destino, para o modo
// `--atualizar` não precisar da lista de CNJ de novo.
//
// O CNJ sai do CAMPO `processo` do índice, nunca do nome da pasta: `nomePasta`
// remove tudo que não seja dígito, ponto ou hífen, então o nome é uma projeção
// com perda. Ler o campo é exato — e ainda confirma que a pasta é mesmo um
// pacote nosso, e não uma pasta qualquer que alguém pôs no destino.
export function processosNoDestino(destino) {
  let entradas;
  try {
    entradas = fs.readdirSync(destino, { withFileTypes: true });
  } catch {
    return [];
  }
  const achados = [];
  for (const e of entradas) {
    if (!e.isDirectory()) continue;
    try {
      const idx = JSON.parse(fs.readFileSync(path.join(destino, e.name, "indice.json"), "utf8"));
      if (idx && idx.processo) achados.push({ cnj: String(idx.processo), pasta: e.name });
    } catch {
      /* pasta sem índice legível: não é um pacote nosso */
    }
  }
  return achados;
}
