// Memória de caso: o banco que faz a extensão lembrar de um processo entre
// sessões. Sem ele, fechar a aba joga fora o `docsCache` inteiro — e reabrir o
// mesmo processo custa de novo a fila serializada do PJe (~5,6 s por peça,
// dezenas de minutos num processo grande).
//
// POR QUE ISTO VIVE NO WORKER, e não no content script (é a decisão que sustenta
// o arquivo): content scripts rodam na ORIGEM DA PÁGINA. Um indexedDB.open() em
// content.js abriria o banco de `pje.tjce.jus.br` — os autos ficariam legíveis
// por qualquer script da própria página do tribunal e sumiriam quando o usuário
// limpasse os dados do site. Aqui o banco é da extensão (chrome-extension://) e
// o content script chega por RPC, como já faz para upload e countTokens.
//
// POR QUE IndexedDB, e não chrome.storage.local:
//  (a) COTA. O `chrome.storage.local` tem teto de 10 MB, e ele já hospeda a
//      configuração, as minutas (`minuta:*`) e os modelos de peça (`modelo:*`) —
//      estourar esse teto faz o `set` de uma minuta FALHAR. O IndexedDB segue a
//      cota normal do navegador por origem, que é uma fração do disco livre.
//      (A permissão `unlimitedStorage` existe e NÃO gera aviso de instalação,
//      mas também não é necessária: o teto de 20 casos de texto fica na casa
//      dos poucos MB. O que ela daria de útil é isenção de *eviction* — sem
//      ela o Chrome pode descartar o banco sob pressão de disco. Aceito: a
//      memória é comodidade, e perdê-la só devolve o comportamento antigo.)
//  (b) STRUCTURED CLONE. O histórico do Gemini guarda `{type:"x-gemini-item",
//      raw: step}` que precisa voltar byte a byte no reenvio; o IDB preserva o
//      que um round-trip por JSON deformaria.
//  (c) ESCRITA GRANULAR por peça — as peças são gravadas UMA A UMA conforme
//      baixam, e num store único cada download reescreveria o caso inteiro.
//
// O que NÃO entra aqui: o base64 dos PDFs e das imagens. São os autos inteiros
// no disco, e o valor que se quer (não re-baixar) vem do `fileId` da Files API,
// não dos bytes — `montarBlocos` prefere o fileId e nem toca no b64 quando ele
// existe. Peça de texto (HTML/RTF) guarda o texto porque ELE é o conteúdo que
// vai ao modelo.

const DB_NOME = "pje-casos";
// v2 acrescentou o índice `porAtualizacao`. O `onupgradeneeded` cria só o que
// falta, então subir a versão é seguro para quem já tem o banco da v1.
const DB_VERSAO = 2;
const CASOS = "casos";
const PECAS = "pecas";

// Poda: mesma política das minutas (7 dias/10) e dos mapas (5), calibrada para
// o volume maior de um caso. São tetos de HIGIENE, não de cota — o disco
// aguentaria muito mais, mas trecho de autos guardado além do uso é risco sem
// contrapartida.
export const MAX_CASOS = 20;
export const MAX_DIAS = 14;

// Teto de sanidade do texto de UMA peça. Acima disso grava só os metadados e a
// peça re-baixa quando for usada. NÃO cortar em MAX_CHARS_TEXTO (60.000): quem
// reporta o truncamento ao usuário é `pecasTruncadas`, que mede o texto REAL —
// gravar já cortado faria o aviso aparecer e sumir entre sessões.
const MAX_CHARS_PECA = 2_000_000;

// A conexão é memoizada, mas o memo é DESCARTÁVEL: o worker MV3 é morto a
// qualquer momento e leva a conexão junto, e um `versionchange` de outra aba
// fecharia o banco debaixo de uma operação em voo. Sem soltar o memo nesses
// eventos, toda chamada seguinte falharia com InvalidStateError até o worker
// reiniciar.
let dbPromise = null;

function abrir() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NOME, DB_VERSAO);
    req.onupgradeneeded = () => {
      const db = req.result;
      const tx = req.transaction;
      const casos = db.objectStoreNames.contains(CASOS)
        ? tx.objectStore(CASOS)
        : db.createObjectStore(CASOS, { keyPath: "chave" });
      // Índice sobre `atualizadoEm`: é o que permite podar lendo só os
      // TIMESTAMPS, por `openKeyCursor`, sem desserializar as conversas. Sem
      // ele a poda fazia `getAll()` — trazia o histórico inteiro de todos os
      // casos para a memória do worker, a cada gravação.
      if (!casos.indexNames.contains("porAtualizacao")) {
        casos.createIndex("porAtualizacao", "atualizadoEm", { unique: false });
      }
      if (!db.objectStoreNames.contains(PECAS)) {
        // Chave composta: a mesma peça (mesmo id) pode existir em processos
        // diferentes, e o índice por caso é o que permite ler/apagar um
        // processo inteiro sem varrer o store.
        const st = db.createObjectStore(PECAS, { keyPath: ["chave", "id"] });
        st.createIndex("porCaso", "chave", { unique: false });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onclose = () => {
        dbPromise = null;
      };
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error || new Error("não foi possível abrir a memória de casos"));
    };
  });
  // Rejeição também solta o memo: sem isto, uma falha transitória na abertura
  // (disco cheio, perfil recém-criado) ficaria memoizada para sempre.
  return dbPromise.catch((e) => {
    dbPromise = null;
    throw e;
  });
}

// Envelopa uma transação numa promessa. O `oncomplete` é o único sinal de que a
// escrita foi ao disco — resolver no `onsuccess` do request devolveria controle
// antes de a transação fechar, e um erro posterior (quota) se perderia.
function transacao(db, stores, modo, fn) {
  return new Promise((resolve, reject) => {
    let saida;
    const tx = db.transaction(stores, modo);
    tx.oncomplete = () => resolve(saida);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("transação abortada"));
    try {
      saida = fn(tx);
    } catch (e) {
      try {
        tx.abort();
      } catch {
        /* já abortada */
      }
      reject(e);
    }
  });
}

function pedir(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ---------------------------------------------------------------- leitura

// Lê o caso e TODAS as suas peças de uma vez: a hidratação precisa dos dois
// juntos e duas viagens de RPC dobrariam a latência do boot sem ganho nenhum.
export async function lerCaso(chave) {
  if (!chave) return null;
  const db = await abrir();
  const tx = db.transaction([CASOS, PECAS], "readonly");
  const caso = await pedir(tx.objectStore(CASOS).get(chave));
  if (!caso) return null;
  const pecas = await pedir(tx.objectStore(PECAS).index("porCaso").getAll(chave));
  return { ...caso, pecas: pecas || [] };
}

// Lista os casos SEM as peças e SEM a conversa — é o que a tela de gestão
// mostra. Carregar o conteúdo de 20 casos para desenhar 20 linhas seria
// desperdício de memória no worker, que é justamente o processo que o Chrome
// mata primeiro.
export async function listarCasos() {
  const db = await abrir();
  const tx = db.transaction([CASOS, PECAS], "readonly");
  const casos = (await pedir(tx.objectStore(CASOS).getAll())) || [];
  const st = tx.objectStore(PECAS).index("porCaso");
  const out = [];
  for (const c of casos) {
    out.push({
      chave: c.chave,
      cnj: c.cnj || null,
      host: c.host || null,
      grau: c.grau || null,
      criadoEm: c.criadoEm || 0,
      atualizadoEm: c.atualizadoEm || 0,
      mensagens: Array.isArray(c.transcript) ? c.transcript.length : 0,
      pecas: await pedir(st.count(IDBKeyRange.only(c.chave))),
    });
  }
  out.sort((a, b) => b.atualizadoEm - a.atualizadoEm);
  return out;
}

// ---------------------------------------------------------------- escrita

// Grava o caso. `patch` é MESCLADO sobre o que já existe: o content script salva
// ora a conversa, ora só a seleção, ora só a grid, e um put cru apagaria os
// campos ausentes daquela chamada.
// `base` é o `atualizadoEm` que o chamador leu quando hidratou. Serve para
// detectar DUAS ABAS no mesmo processo: se o registro mudou desde então, quem
// está gravando tem um retrato velho da conversa.
//
// A resolução não é um merge — merge de conversas é impossível: são duas
// sequências de turnos com raciocínio assinado, e intercalá-las produziria um
// histórico que nenhuma API aceita. O que se faz é separar o que CONFLITA do
// que não conflita: `conversation`/`transcript`/`selecao`/custo são estado de
// UMA sessão e ficam de fora; o resto (as peças e a ficha do processo) é
// aditivo e passa. Assim a aba parada deixa de apagar a conversa da aba ativa,
// e o download que ela adiantou continua aproveitado pelas duas.
const CAMPOS_DE_SESSAO = [
  "conversation", "transcript", "selecao", "custoConversaUsd",
  "conversaProvider", "buscaNaConversa", "ultimoTotalExato",
];

export async function salvarCaso(chave, patch, base) {
  if (!chave) return null;
  const db = await abrir();
  const agora = Date.now();
  let conflito = false;
  let carimbo = agora;
  let criado = false;
  await transacao(db, [CASOS], "readwrite", (tx) => {
    const st = tx.objectStore(CASOS);
    const req = st.get(chave);
    req.onsuccess = () => {
      criado = !req.result;
      const antes = req.result || { chave, criadoEm: agora };
      let usar = patch;
      if (base && antes.atualizadoEm && antes.atualizadoEm > base) {
        conflito = true;
        usar = { ...patch };
        for (const c of CAMPOS_DE_SESSAO) delete usar[c];
      }
      // O carimbo é ESTRITAMENTE monotônico, e não `Date.now()` cru: duas
      // gravações dentro do mesmo milissegundo (comum — o debounce de uma aba
      // e o fim de turno de outra) deixariam `atualizadoEm` igual à `base`, e
      // a comparação `>` acima deixaria o conflito passar. Perde-se a precisão
      // de "quando" por alguns ms; ganha-se um contador que nunca empata.
      carimbo = Math.max(agora, (antes.atualizadoEm || 0) + 1);
      st.put({ ...antes, ...usar, chave, atualizadoEm: carimbo });
    };
    return agora;
  });
  // A poda anda de carona na escrita, mas SÓ quando um caso NOVO nasce — e não
  // a cada gravação. Gravação há a cada 1,2 s de debounce enquanto se trabalha;
  // caso novo há uma vez por processo. Como só a criação faz o número de casos
  // crescer, é o único momento em que o teto de QUANTIDADE pode ser cruzado; a
  // poda por IDADE é coberta por aqui e pelo `onInstalled`. Falha dela nunca
  // derruba a gravação: o caso já está salvo.
  if (criado) {
    try {
      await podarCasos();
    } catch {
      /* faxina é best-effort */
    }
  }
  return { atualizadoEm: carimbo, conflito };
}

// Grava um lote de peças. Cada peça é MESCLADA sobre a anterior pelo mesmo
// motivo do caso: o download traz `kind`/`pages`/`text` e o upload, minutos
// depois, traz só o `fileId` — um put cru no segundo apagaria o primeiro e a
// peça voltaria a precisar de download.
//
// `size` funciona como assinatura do conteúdo: quando a peça é substituída no
// PJe com o mesmo id, o tamanho muda e o fileId gravado deixa de valer (a
// cacheKey do upload também inclui o tamanho, então os dois lados concordam).
export async function salvarPecas(chave, lista) {
  if (!chave || !Array.isArray(lista) || !lista.length) return 0;
  const db = await abrir();
  return transacao(db, [PECAS], "readwrite", (tx) => {
    const st = tx.objectStore(PECAS);
    for (const p of lista) {
      if (!p || p.id == null) continue;
      const id = String(p.id);
      const req = st.get([chave, id]);
      req.onsuccess = () => {
        const antes = req.result || {};
        const novo = { ...antes, ...p, chave, id };
        // O b64 NUNCA vai ao disco, mesmo que o chamador o inclua por descuido:
        // esta é a última barreira e ela é barata.
        delete novo.b64;
        delete novo.semBytes;
        if (typeof novo.text === "string") {
          if (novo.text.length > MAX_CHARS_PECA) delete novo.text;
        }
        if (antes.size != null && p.size != null && antes.size !== p.size) {
          // conteúdo trocou no PJe: o upload antigo aponta para outro arquivo
          delete novo.fileId;
          delete novo.fileProvider;
          delete novo.fileExp;
          delete novo.chaveHash;
        }
        st.put(novo);
      };
    }
    return lista.length;
  });
}

// ---------------------------------------------------------------- remoção

export async function esquecerCaso(chave) {
  if (!chave) return 0;
  const db = await abrir();
  await transacao(db, [CASOS, PECAS], "readwrite", (tx) => {
    tx.objectStore(CASOS).delete(chave);
    // Apagar por CURSOR no índice, não por range no keyPath: a chave composta é
    // ["chave", id] e um IDBKeyRange sobre ela dependeria da ordem lexicográfica
    // dos ids, que não é garantida para o que queremos.
    const req = tx.objectStore(PECAS).index("porCaso").openKeyCursor(IDBKeyRange.only(chave));
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return;
      tx.objectStore(PECAS).delete(cur.primaryKey);
      cur.continue();
    };
  });
  return 1;
}

// Devolve QUANTOS casos foram apagados — quem chama mostra isso ao usuário, e
// um `true` ali viraria "1 processo apagado" em qualquer situação.
export async function esquecerTudo() {
  const db = await abrir();
  const n = await new Promise((resolve, reject) => {
    const tx = db.transaction([CASOS], "readonly");
    const req = tx.objectStore(CASOS).count();
    req.onsuccess = () => resolve(req.result || 0);
    req.onerror = () => reject(req.error);
  });
  await transacao(db, [CASOS, PECAS], "readwrite", (tx) => {
    tx.objectStore(CASOS).clear();
    tx.objectStore(PECAS).clear();
  });
  return n;
}

// Poda dupla, como a das minutas: por IDADE (o que não se usa há duas semanas
// não é mais o processo do momento) e por QUANTIDADE (teto duro, para uma
// semana intensa não virar um arquivo permanente dos autos de todo mundo).
export async function podarCasos(max = MAX_CASOS, dias = MAX_DIAS) {
  const db = await abrir();
  // `openKeyCursor` num ÍNDICE devolve só a chave indexada (`atualizadoEm`) e a
  // primaryKey (`chave`) — o VALOR do registro nunca é lido. É a diferença
  // entre percorrer 20 timestamps e desserializar 20 conversas inteiras, e a
  // poda roda a cada caso novo. O cursor vem em ordem crescente de
  // `atualizadoEm`, então os primeiros são os mais antigos.
  const pares = await new Promise((resolve, reject) => {
    const tx = db.transaction([CASOS], "readonly");
    const req = tx.objectStore(CASOS).index("porAtualizacao").openKeyCursor();
    const out = [];
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return resolve(out);
      out.push({ chave: cur.primaryKey, quando: cur.key || 0 });
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  });
  const limite = Date.now() - dias * 24 * 60 * 60 * 1000;
  const vivos = pares.filter((p) => p.quando >= limite);
  const apagar = pares
    .filter((p) => p.quando < limite) // por IDADE
    .concat(vivos.slice(0, Math.max(0, vivos.length - max))) // por QUANTIDADE
    .map((p) => p.chave);
  for (const chave of apagar) await esquecerCaso(chave);
  return apagar.length;
}

// Emergência de cota. O `salvarCaso` que tomar QuotaExceededError chama isto e
// tenta UMA vez; se falhar de novo, quem chamou desliga a gravação na sessão e
// avisa. Nunca derrubar o turno por causa de faxina.
export async function podarAgressivo() {
  const db = await abrir();
  // Mesmo motivo do `podarCasos`, e aqui ele é ainda mais forte: isto roda
  // DEPOIS de um QuotaExceededError, ou seja, exatamente quando carregar as
  // conversas todas para a memória é a última coisa que se deveria fazer.
  const chaves = await new Promise((resolve, reject) => {
    const tx = db.transaction([CASOS], "readonly");
    const req = tx.objectStore(CASOS).index("porAtualizacao").openKeyCursor();
    const out = [];
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return resolve(out);
      out.push(cur.primaryKey); // ordem crescente: os mais antigos primeiro
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  });
  const apagar = chaves.slice(0, Math.floor(chaves.length / 2));
  for (const chave of apagar) await esquecerCaso(chave);
  return apagar.length;
}
