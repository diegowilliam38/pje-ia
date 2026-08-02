// src/zip.js — escritor de arquivos ZIP, sem biblioteca.
//
// Por que escrever um em vez de vendorizar (JSZip, fflate…): o formato ZIP que
// PRECISAMOS é minúsculo — cabeçalho local, diretório central e EOCD —, e a
// compressão sai de graça da API nativa do navegador (CompressionStream). Uma
// biblioteca traria ~30–100 KB ao pacote e um terceiro para auditar, para
// resolver a parte fácil do problema.
//
// Escopo deliberadamente limitado (ver as guardas em `add`/`fechar`):
//   - sem Zip64  → teto de 4 GB por entrada, 4 GB no total e 65.535 entradas;
//   - sem cifra, sem comentário, sem atributos de sistema de arquivos;
//   - nomes sempre em UTF-8 (bit 11 do flag), que é o que o Windows, o macOS e
//     o `unzip` moderno esperam de acentuação.
//
// MEMÓRIA é a restrição de projeto aqui: um processo inteiro pode passar de
// centenas de MB, e concatenar tudo num Uint8Array estouraria a aba. Por isso
// cada pedaço vira um Blob assim que é produzido e o arquivo final é montado
// com `new Blob(partes)` — o navegador mantém os Blobs fora do heap de JS (em
// disco, quando grandes) e só materializa os bytes na hora do download.
(() => {
  "use strict";

  // Tabela do CRC-32 (polinômio refletido 0xEDB88320), construída uma vez.
  const TABELA = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = TABELA[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // Data/hora no formato do MS-DOS, que é o que o ZIP guarda: segundos em
  // passos de 2 e ano a partir de 1980 (datas anteriores são fixadas no piso —
  // não acontece na prática, mas um valor negativo corromperia o campo).
  function dataDos(d) {
    const ano = Math.max(1980, d.getFullYear());
    return {
      hora: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      data: ((ano - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    };
  }

  const TETO_32 = 0xffffffff;
  const TETO_ENTRADAS = 0xffff;
  const METODO_STORE = 0;
  const METODO_DEFLATE = 8;

  const temDeflate = typeof CompressionStream === "function";

  // Comprime com a API nativa. Devolve as fatias, não um buffer único, para o
  // resultado poder virar Blob sem uma segunda cópia na memória.
  async function deflar(bytes) {
    const cs = new CompressionStream("deflate-raw");
    const escritor = cs.writable.getWriter();
    escritor.write(bytes);
    escritor.close();
    const leitor = cs.readable.getReader();
    const fatias = [];
    let tamanho = 0;
    for (;;) {
      const { done, value } = await leitor.read();
      if (done) break;
      fatias.push(value);
      tamanho += value.length;
    }
    return { fatias, tamanho };
  }

  // Serializa os campos do cabeçalho. O ZIP é little-endian em tudo.
  function cabecalho(campos) {
    const buf = new ArrayBuffer(campos.reduce((n, [t]) => n + t, 0));
    const dv = new DataView(buf);
    let off = 0;
    for (const [tam, valor] of campos) {
      if (tam === 2) dv.setUint16(off, valor, true);
      else dv.setUint32(off, valor, true);
      off += tam;
    }
    return new Uint8Array(buf);
  }

  const UTF8 = new TextEncoder();

  function criar(opts) {
    const { data = new Date(), comprimir = true } = opts || {};
    const { hora, data: dataZip } = dataDos(data);
    const partes = []; // BlobParts do arquivo final, na ordem
    const central = []; // registros do diretório central
    const nomes = new Set();
    let deslocamento = 0; // offset corrente = tamanho do que já foi escrito
    let fechado = false;

    // Nome único dentro do ZIP. Dois documentos podem legitimamente ter o mesmo
    // título; deixar o nome repetir produz um ZIP que alguns extratores aceitam
    // (sobrescrevendo em silêncio) e outros recusam.
    function nomeUnico(nome) {
      if (!nomes.has(nome)) {
        nomes.add(nome);
        return nome;
      }
      const ponto = nome.lastIndexOf(".");
      const base = ponto > 0 ? nome.slice(0, ponto) : nome;
      const ext = ponto > 0 ? nome.slice(ponto) : "";
      for (let i = 2; ; i++) {
        const tentativa = base + "(" + i + ")" + ext;
        if (!nomes.has(tentativa)) {
          nomes.add(tentativa);
          return tentativa;
        }
      }
    }

    async function add(nome, dados, opcoes) {
      if (fechado) throw new Error("zip já fechado");
      const bytes = typeof dados === "string" ? UTF8.encode(dados) : dados;
      if (bytes.length > TETO_32) throw new Error("arquivo grande demais para ZIP sem Zip64: " + nome);
      if (central.length >= TETO_ENTRADAS) throw new Error("ZIP sem Zip64 aceita no máximo 65.535 arquivos");

      const nomeFinal = nomeUnico(nome);
      const nomeBytes = UTF8.encode(nomeFinal);
      const crc = crc32(bytes);

      // A escolha de comprimir é do CHAMADOR (`opcoes.comprimir`): PDF já vem
      // deflacionado por dentro, e recomprimi-lo custa CPU para ganhar ~1%. Em
      // texto o ganho passa de 70%, e aí compensa.
      const querComprimir =
        temDeflate && comprimir && (opcoes ? opcoes.comprimir !== false : true) && bytes.length > 0;

      let metodo = METODO_STORE;
      let corpo = [bytes];
      let tamanhoComprimido = bytes.length;
      if (querComprimir) {
        const { fatias, tamanho } = await deflar(bytes);
        // Só vale a pena se de fato encolheu: em conteúdo já comprimido o
        // deflate pode CRESCER, e aí guardar cru é menor e mais rápido de abrir.
        if (tamanho < bytes.length) {
          metodo = METODO_DEFLATE;
          corpo = fatias;
          tamanhoComprimido = tamanho;
        }
      }

      const local = cabecalho([
        [4, 0x04034b50],
        [2, 20], // versão necessária
        [2, 0x0800], // bit 11: nome em UTF-8
        [2, metodo],
        [2, hora],
        [2, dataZip],
        [4, crc],
        [4, tamanhoComprimido],
        [4, bytes.length],
        [2, nomeBytes.length],
        [2, 0], // sem campo extra
      ]);

      central.push({
        nomeBytes,
        metodo,
        crc,
        tamanhoComprimido,
        tamanhoOriginal: bytes.length,
        offset: deslocamento,
      });

      // Cada entrada vira UM Blob: a partir daqui os bytes saem do heap de JS.
      partes.push(new Blob([local, nomeBytes, ...corpo]));
      deslocamento += local.length + nomeBytes.length + tamanhoComprimido;
      if (deslocamento > TETO_32) throw new Error("ZIP passou de 4 GB (sem Zip64)");
      return nomeFinal;
    }

    function fechar(mime) {
      if (fechado) throw new Error("zip já fechado");
      fechado = true;
      const inicioCentral = deslocamento;
      const registros = [];
      for (const e of central) {
        registros.push(
          cabecalho([
            [4, 0x02014b50],
            [2, 20], // versão de quem criou
            [2, 20], // versão necessária
            [2, 0x0800],
            [2, e.metodo],
            [2, hora],
            [2, dataZip],
            [4, e.crc],
            [4, e.tamanhoComprimido],
            [4, e.tamanhoOriginal],
            [2, e.nomeBytes.length],
            [2, 0], // extra
            [2, 0], // comentário
            [2, 0], // disco inicial
            [2, 0], // atributos internos
            [4, 0], // atributos externos
            [4, e.offset],
          ]),
          e.nomeBytes
        );
      }
      const tamanhoCentral = registros.reduce((n, r) => n + r.length, 0);
      const fim = cabecalho([
        [4, 0x06054b50],
        [2, 0], // número do disco
        [2, 0], // disco do diretório central
        [2, central.length],
        [2, central.length],
        [4, tamanhoCentral],
        [4, inicioCentral],
        [2, 0], // sem comentário
      ]);
      return new Blob([...partes, ...registros, fim], {
        type: mime || "application/zip",
      });
    }

    return {
      add,
      fechar,
      get entradas() {
        return central.length;
      },
      get bytes() {
        return deslocamento;
      },
    };
  }

  window.ZipW = { criar, crc32, _temDeflate: temDeflate };
})();
