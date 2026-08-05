// ---------------------------------------------------------------------------
// Leitura de .docx no navegador — extrai o TEXTO de um documento do Word para
// cadastrar peças-modelo sem copiar e colar à mão.
//
// Sem biblioteca: um .docx é um arquivo ZIP cujo conteúdo textual vive em
// `word/document.xml`. O Chrome já traz as duas peças necessárias —
// `DecompressionStream("deflate-raw")` para o inflate e `DOMParser` para o XML —,
// então o leitor inteiro cabe em ~150 linhas e não acrescenta nada ao `vendor/`
// (o `docx.iife.js` que já existe só GERA .docx; não lê).
//
// SEGURANÇA: só se extrai TEXTO (`textContent` dos nós `w:t`). Nada do arquivo
// vira HTML em momento algum — o .docx pode vir de qualquer lugar e o texto que
// sai daqui vai para um `<textarea>` por `.value`, nunca por innerHTML.
//
// Expõe o global `DocxImport` (script clássico, como os demais).
// ---------------------------------------------------------------------------
const DocxImport = (() => {
  const SIG_EOCD = 0x06054b50; // fim do diretório central
  const SIG_CD = 0x02014b50; // entrada do diretório central
  const SIG_LFH = 0x04034b50; // cabeçalho local de arquivo

  // Procura o End Of Central Directory do fim para o início: ele fica nos
  // últimos 22 bytes, salvo se houver comentário no ZIP (daí a janela de 64 KB).
  function acharEOCD(dv) {
    const min = Math.max(0, dv.byteLength - 65558);
    for (let i = dv.byteLength - 22; i >= min; i--) {
      if (dv.getUint32(i, true) === SIG_EOCD) return i;
    }
    return -1;
  }

  // Percorre o diretório central e devolve o mapa nome -> descritor da entrada.
  function lerEntradas(buf) {
    const dv = new DataView(buf);
    const eocd = acharEOCD(dv);
    if (eocd < 0) throw new Error("arquivo .docx inválido (não parece um ZIP)");
    const total = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true); // offset do diretório central
    const td = new TextDecoder("utf-8");
    const saida = new Map();
    for (let i = 0; i < total; i++) {
      if (dv.getUint32(p, true) !== SIG_CD) break;
      const metodo = dv.getUint16(p + 10, true);
      const tamComp = dv.getUint32(p + 20, true);
      const nomeLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const comentLen = dv.getUint16(p + 32, true);
      const offLocal = dv.getUint32(p + 42, true);
      const nome = td.decode(new Uint8Array(buf, p + 46, nomeLen));
      saida.set(nome, { metodo, tamComp, offLocal });
      p += 46 + nomeLen + extraLen + comentLen;
    }
    return saida;
  }

  // Extrai UMA entrada. O cabeçalho local repete os campos de nome/extra com
  // tamanhos possivelmente diferentes dos do diretório central — é por ele que
  // se calcula onde os bytes comprimidos realmente começam.
  async function extrair(buf, ent) {
    const dv = new DataView(buf);
    if (dv.getUint32(ent.offLocal, true) !== SIG_LFH) {
      throw new Error("arquivo .docx corrompido");
    }
    const nomeLen = dv.getUint16(ent.offLocal + 26, true);
    const extraLen = dv.getUint16(ent.offLocal + 28, true);
    const ini = ent.offLocal + 30 + nomeLen + extraLen;
    const dados = new Uint8Array(buf, ini, ent.tamComp);
    if (ent.metodo === 0) return dados; // stored
    if (ent.metodo !== 8) throw new Error("compressão do .docx não suportada");
    const ds = new DecompressionStream("deflate-raw");
    const stream = new Blob([dados]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // Converte o corpo do documento em texto com parágrafos. Regras:
  //  - cada <w:p> vira um parágrafo (linha);
  //  - <w:t> são os pedaços de texto (preserva espaços de xml:space="preserve");
  //  - <w:tab/> vira tabulação e <w:br/> quebra de linha DENTRO do parágrafo;
  //  - parágrafo com estilo de título ganha uma linha em branco antes, para o
  //    texto colado manter a estrutura visível (não geramos Markdown: o campo do
  //    modelo é texto puro e a IA lê a forma pelo próprio texto).
  function textoDoXml(xml) {
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    if (doc.querySelector("parsererror")) {
      throw new Error("não foi possível ler o conteúdo do documento");
    }
    const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
    const paras = doc.getElementsByTagNameNS(W, "p");
    const linhas = [];
    for (const p of paras) {
      let txt = "";
      // percorre em ordem de documento para tab/br caírem no lugar certo
      const it = doc.createTreeWalker(p, NodeFilter.SHOW_ELEMENT);
      let n = it.currentNode;
      while (n) {
        if (n.namespaceURI === W) {
          if (n.localName === "t") txt += n.textContent || "";
          else if (n.localName === "tab") txt += "\t";
          else if (n.localName === "br") txt += "\n";
        }
        n = it.nextNode();
      }
      const estilo = p.getElementsByTagNameNS(W, "pStyle")[0];
      const nomeEstilo = estilo ? estilo.getAttributeNS(W, "val") || "" : "";
      const ehTitulo = /^(Heading|Ttulo|Titulo|Title)/i.test(nomeEstilo);
      if (ehTitulo && linhas.length && linhas[linhas.length - 1] !== "") linhas.push("");
      linhas.push(txt.trim());
    }
    // normaliza: no máximo uma linha em branco seguida, sem sobras nas pontas
    return linhas
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  // API: recebe um File (do <input type="file">) e devolve o texto.
  async function lerArquivo(file) {
    if (!file) throw new Error("nenhum arquivo escolhido");
    const nome = String(file.name || "").toLowerCase();
    if (nome.endsWith(".doc") && !nome.endsWith(".docx")) {
      throw new Error(
        "o formato .doc (Word 97-2003) não pode ser lido aqui — abra no Word e salve como .docx"
      );
    }
    if (!nome.endsWith(".docx")) throw new Error("escolha um arquivo .docx");
    if (typeof DecompressionStream === "undefined") {
      throw new Error("este navegador não sabe descompactar .docx — atualize o Chrome");
    }
    const buf = await file.arrayBuffer();
    const entradas = lerEntradas(buf);
    const alvo = entradas.get("word/document.xml");
    if (!alvo) throw new Error("o arquivo não contém um documento do Word");
    const bytes = await extrair(buf, alvo);
    const texto = textoDoXml(new TextDecoder("utf-8").decode(bytes));
    if (!texto) throw new Error("o documento está vazio ou só tem imagens");
    return texto;
  }

  // Título sugerido a partir do nome do arquivo (sem extensão, com espaços).
  function tituloDe(file) {
    return String((file && file.name) || "")
      .replace(/\.docx$/i, "")
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
  }

  // Lê VÁRIOS .docx de uma vez. Devolve um item por arquivo, na ordem em que
  // vieram: {ok:true, nome, titulo, texto} ou {ok:false, nome, titulo, erro}.
  //
  // Invariantes que não podem cair:
  //  - SERIALIZADO (for + await, nunca Promise.all). Dez DecompressionStream
  //    simultâneos, cada um com o arrayBuffer inteiro do .docx na memória, é um
  //    pico grande e um progresso mentiroso — mesma razão do "UM LOTE POR VEZ"
  //    do pipeline de upload das peças.
  //  - Falha de UM arquivo NUNCA derruba o lote (a mesma regra da tolerância a
  //    falha de download das peças): o erro vira um item e o laço segue. Quem
  //    arrastou nove arquivos e errou um não pode perder os outros oito.
  //  - `sinal.cancelado` é conferido ENTRE arquivos, nunca no meio de um, e o
  //    que já foi lido é DEVOLVIDO: cancelar não descarta trabalho.
  //  - `onItem` roda dentro de try/catch — uma exceção da UI não pode matar a
  //    leitura dos arquivos que faltam.
  //
  // Não se filtra extensão aqui de propósito: um .pdf solto no meio recebe a
  // mensagem específica do lerArquivo e vira uma linha de erro VISÍVEL. Sumir
  // com ele em silêncio deixaria o usuário procurando um arquivo que ele acha
  // que importou.
  async function lerLote(arquivos, opts) {
    const o = opts || {};
    const lista = Array.from(arquivos || []);
    const saida = [];
    for (let i = 0; i < lista.length; i++) {
      if (o.sinal && o.sinal.cancelado) break;
      const file = lista[i];
      const base = { nome: String((file && file.name) || ""), titulo: tituloDe(file) };
      let r;
      try {
        r = Object.assign({ ok: true, texto: await lerArquivo(file) }, base);
      } catch (e) {
        r = Object.assign({ ok: false, erro: String((e && e.message) || e) }, base);
      }
      saida.push(r);
      if (o.onItem) {
        try {
          o.onItem(r, i + 1, lista.length);
        } catch {
          /* a UI que se vire; a leitura continua */
        }
      }
    }
    return saida;
  }

  return { lerArquivo, lerLote, tituloDe, _textoDoXml: textoDoXml };
})();
