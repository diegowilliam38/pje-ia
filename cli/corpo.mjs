// Interpretação do corpo de uma peça, fora do navegador.
//
// Porta de `lerCorpo` (src/pje.js:892-1010) com UMA diferença deliberada de
// propósito: a extensão CONVERTE (HTML vira texto, imagem é reduzida) porque o
// destino é o orçamento de tokens de um modelo. Aqui o destino é o DISCO, e para
// quem vai reprocessar depois (LiteParse, script, Claude Code) os bytes
// originais são estritamente melhor fidelidade.
//
// Consequência boa: some a dependência de `DOMParser`, `createImageBitmap` e
// `OffscreenCanvas` — é o que mantém este CLI com zero dependências npm.
//
// Consequência que exige cuidado: a extensão detecta a CASCA VAZIA de graça
// (depois de virar texto, `trim()` vazio => null). Guardando o HTML bruto esse
// sinal não existe mais, e ele precisa ser reconstruído — ver `textoVisivel`
// abaixo. Errar isso enche a pasta de arquivos de 82 bytes que PARECEM sucesso,
// que é o pior desfecho possível para um pacote que só se confere depois.

// Contrato de saída, exigido por `montarZip` de src/exportar.js:
//   { kind: "pdf"|"img"|"text", fmt, b64|text, pages? }
// `kind` diz como o conteúdo viaja; `fmt` preserva o formato de ORIGEM e vira a
// extensão do arquivo.

// ---------------------------------------------------------------------------
// Tabelas de assinatura — copiadas VERBATIM de src/pje.js:794-812
//
// Só os quatro formatos de imagem que os três provedores aceitam em comum estão
// em IMAGENS. Aqui no CLI a razão é outra (não há provedor nenhum), mas a lista
// é mantida idêntica de propósito: divergir faria o CLI e a extensão
// classificarem a mesma peça de formas diferentes, e o teste que compara os dois
// pacotes deixaria de valer como oráculo.
// ---------------------------------------------------------------------------

const IMAGENS = [
  { fmt: "jpeg", teste: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { fmt: "png", teste: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { fmt: "gif", teste: (b, s) => s.startsWith("GIF8") },
  { fmt: "webp", teste: (b, s) => s.startsWith("RIFF") && s.slice(8, 12) === "WEBP" },
];

// O rótulo é o que o usuário lê no relatório de falhas — daí ser o nome do
// arquivo, não o mime.
const ASSINATURAS = [
  { rot: "imagem BMP", teste: (b, s) => s.startsWith("BM") },
  { rot: "imagem TIFF", teste: (b, s) => s.startsWith("II*\u0000") || s.startsWith("MM\u0000*") },
  { rot: "arquivo de áudio/vídeo", teste: (b, s) => s.startsWith("RIFF") && /WAVE|AVI /.test(s.slice(8, 12)) },
  { rot: "arquivo de áudio/vídeo", teste: (b, s) => s.slice(4, 8) === "ftyp" || s.startsWith("OggS") || s.startsWith("ID3") },
  { rot: "arquivo de vídeo", teste: (b) => b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 },
  { rot: "arquivo compactado ou do Office (ZIP)", teste: (b, s) => s.startsWith("PK\u0003\u0004") || s.startsWith("PK\u0005\u0006") },
  { rot: "arquivo do Office antigo (.doc/.xls)", teste: (b) => b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0 },
];

function casa(lista, bytes, inicio) {
  for (const a of lista) {
    try {
      if (a.teste(bytes, inicio)) return a;
    } catch {
      /* assinatura mais longa que o cabeçalho lido: ignora */
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Contagem de páginas — porta de src/pje.js:609-672
// Roda igual no Node 22: só depende de DecompressionStream, Blob e Response.
// ---------------------------------------------------------------------------

const RE_PAGINA = /\/Type\s*\/Page(?![a-zA-Z])/g;

function contarRe(s, re) {
  const m = s.match(re);
  return m ? m.length : 0;
}

async function inflar(u8) {
  const ds = new DecompressionStream("deflate");
  const st = new Blob([u8]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(st).arrayBuffer());
}

// Latin1 preserva a relação 1:1 entre índice na string e offset no binário — por
// isso dá para achar "stream"/"endstream" na string e fatiar os bytes.
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
    while (fim > ini && (s.charCodeAt(fim - 1) === 10 || s.charCodeAt(fim - 1) === 13)) fim--;
    lidos++;
    try {
      const txt = new TextDecoder("latin1").decode(await inflar(bytes.subarray(ini, fim)));
      total += contarRe(txt, RE_PAGINA);
    } catch {
      /* stream com outro filtro ou corrompido: ignora e segue */
    }
  }
  return total;
}

export async function contarPaginas(bytes) {
  try {
    const s = new TextDecoder("latin1").decode(bytes);
    const pages = contarRe(s, RE_PAGINA);
    if (pages) return pages;
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

// ---------------------------------------------------------------------------
// Última barreira para binário SEM assinatura catalogada — src/pje.js:881-890
//
// O critério é caractere de CONTROLE C0, e NÃO o replacement char: HTML servido
// em ISO-8859-1 sem charset no header chega com um U+FFFD POR ACENTO (petição ->
// peti[?]ão) e é texto legítimo. Barrá-lo derrubaria peças que sempre
// funcionaram.
// ---------------------------------------------------------------------------

export function pareceBinario(texto) {
  const amostra = texto.slice(0, 4000);
  if (!amostra) return false;
  let controle = 0;
  for (let i = 0; i < amostra.length; i++) {
    const c = amostra.charCodeAt(i);
    if ((c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 127) controle++;
  }
  return controle / amostra.length > 0.02;
}

// ---------------------------------------------------------------------------
// RTF -> texto. CÓPIA de `rtfParaTexto` (src/pje.js:708-771).
//
// A duplicação é deliberada e tem precedente no próprio projeto: `docx-importar.js`
// já carrega uma cópia deste extrator, porque roda também em `src/modelos.html`,
// um contexto de extensão que NÃO enxerga o global `PJE`. O CLI está na mesma
// situação, por um motivo ainda mais forte — `pje.js` é um IIFE que depende de
// `document`/`location` e não tem rodapé CommonJS.
//
// Ao mexer num, conferir os outros dois.
// ---------------------------------------------------------------------------

// 0x80-0x9F do CP1252 não batem com Latin-1/Unicode (é onde ficam as aspas
// curvas e o travessão). Os acentos do português vivem em 0xC0-0xFF, que
// coincidem — por isso só estes precisam de mapa.
const CP1252_ALTO = {
  128: "€", 130: "‚", 131: "ƒ", 132: "„", 133: "…",
  134: "†", 135: "‡", 136: "ˆ", 137: "‰", 138: "Š",
  139: "‹", 140: "Œ", 142: "Ž", 145: "‘", 146: "’",
  147: "“", 148: "”", 149: "•", 150: "–", 151: "—",
  152: "˜", 153: "™", 154: "š", 155: "›", 156: "œ",
  158: "ž", 159: "Ÿ",
};

// Grupos cujo CONTEÚDO não é texto do documento. O `\b` vale só para as
// PALAVRAS: depois de `\*` não existe boundary, então um `\b` global fazia
// `{\*\generator ...}` escapar da poda e o texto do grupo vazava.
const RTF_GRUPOS_MORTOS =
  /^\\(?:\*|(?:fonttbl|colortbl|stylesheet|info|pntext|listtable|listoverridetable|rsidtbl|generator|themedata|datastore|xmlnstbl|latentstyles)\b)/;

export function rtfParaTexto(rtf) {
  const s = String(rtf || "");
  let out = "";
  let i = 0;
  let pularUnicode = 0; // \ucN — quantos caracteres de fallback ignorar
  while (i < s.length) {
    const c = s[i];

    if (c === "{") {
      const resto = s.slice(i + 1, i + 40);
      if (RTF_GRUPOS_MORTOS.test(resto)) {
        let nivel = 0;
        while (i < s.length) {
          if (s[i] === "\\" && (s[i + 1] === "{" || s[i + 1] === "}")) { i += 2; continue; }
          if (s[i] === "{") nivel++;
          else if (s[i] === "}") {
            nivel--;
            if (nivel === 0) { i++; break; }
          }
          i++;
        }
        continue;
      }
      i++;
      continue;
    }
    if (c === "}") { i++; continue; }

    if (c === "\\") {
      const n = s[i + 1];
      if (n === "\\" || n === "{" || n === "}") { out += n; i += 2; continue; }
      if (n === "\n" || n === "\r") { out += "\n"; i += 2; continue; }
      if (n === "'") {
        const code = parseInt(s.substr(i + 2, 2), 16);
        if (!isNaN(code)) {
          if (pularUnicode > 0) pularUnicode--;
          else out += CP1252_ALTO[code] || String.fromCharCode(code);
        }
        i += 4;
        continue;
      }
      const m = /^\\([a-zA-Z]+)(-?\d+)?[ ]?/.exec(s.slice(i));
      if (!m) { i += 2; continue; }
      const palavra = m[1];
      const arg = m[2] != null ? parseInt(m[2], 10) : null;
      if (palavra === "par" || palavra === "line" || palavra === "sect") out += "\n";
      else if (palavra === "tab") out += "\t";
      else if (palavra === "uc") pularUnicode = 0;
      else if (palavra === "u" && arg != null) {
        out += String.fromCharCode(arg < 0 ? arg + 65536 : arg);
        pularUnicode = 1;
      }
      i += m[0].length;
      continue;
    }

    if (c === "\r" || c === "\n") { i++; continue; }
    if (pularUnicode > 0) { pularUnicode--; i++; continue; }
    out += c;
    i++;
  }
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ---------------------------------------------------------------------------
// HTML -> texto, sem DOMParser.
//
// A extensão faz `DOMParser` -> remove script/style -> `body.textContent` ->
// colapsa `\n{3,}`. O detalhe que decide a fidelidade: `textContent` NÃO insere
// separador entre elementos — ele concatena os nós de texto crus. As quebras que
// aparecem no resultado vêm do espaço em branco do PRÓPRIO HTML, entre as tags.
//
// Logo, para chegar perto do mesmo resultado, a tag some sem virar espaço. Trocar
// tag por espaço pareceria mais correto e produziria um texto DIFERENTE do que a
// extensão grava — e é a comparação entre os dois pacotes que serve de oráculo.
// ---------------------------------------------------------------------------

const ENTIDADES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
};

function decodificarEntidades(s) {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (todo, corpo) => {
    if (corpo[0] === "#") {
      const n = corpo[1] === "x" || corpo[1] === "X"
        ? parseInt(corpo.slice(2), 16)
        : parseInt(corpo.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : todo;
    }
    const v = ENTIDADES[corpo.toLowerCase()];
    return v === undefined ? todo : v;
  });
}

export function htmlParaTexto(html) {
  const semBlocos = String(html)
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]*>/g, "");
  return decodificarEntidades(semBlocos).replace(/\n{3,}/g, "\n\n");
}

// ---------------------------------------------------------------------------
// O leitor
// ---------------------------------------------------------------------------

const B64 = (u8) => Buffer.from(u8).toString("base64");

// `resposta` é uma Response do fetch. `id` entra só nas mensagens de erro.
//
// Devolve:
//   objeto  -> conteúdo útil
//   null    -> ESTA ROTA NÃO SERVIU (casca vazia, PDF de 0 bytes). O chamador
//              deve tentar a próxima rota; não é erro do documento.
//   lança   -> veio inteiro, mas não é documento que dê para guardar (binário
//              catalogado). Distinguir os dois importa: `null` faz o chamador
//              insistir, a exceção o faz parar e registrar o motivo.
export async function lerCorpo(resposta, id) {
  const ct = (resposta.headers.get("content-type") || "").toLowerCase();
  const bytes = new Uint8Array(await resposta.arrayBuffer());

  let ehPdf = ct.includes("pdf");
  let ehRtf = ct.includes("rtf");

  // Assinatura no binário: o PJe legado serve tanto PDF quanto RTF como
  // octet-stream, e confiar só no content-type mandaria RTF/PDF para o ramo de
  // texto.
  if (!ehPdf && !ehRtf && !ct.includes("html") && bytes.length >= 5) {
    const head = bytes.subarray(0, 1024);
    const inicio = String.fromCharCode(...head);
    ehPdf = inicio.includes("%PDF-");
    if (!ehPdf) ehRtf = /^\s*\{\\rtf/.test(inicio);

    if (!ehPdf && !ehRtf) {
      const img = casa(IMAGENS, head, inicio);
      if (img) {
        // Sem redução: o teto de 1568px da extensão existe para o tokenizador,
        // e aqui o arquivo vai inteiro para o disco.
        return { kind: "img", fmt: img.fmt, b64: B64(bytes), size: bytes.length };
      }
      const bin = casa(ASSINATURAS, head, inicio);
      if (bin) {
        // LANÇA em vez de devolver null: `null` significaria "tente a outra
        // rota", e a peça veio inteira — só não é documento.
        throw new Error("a peça é " + bin.rot + " (" + bytes.length + " bytes)");
      }
    }
  }

  if (ehPdf) {
    if (!bytes.length) return null;
    return {
      kind: "pdf",
      fmt: "pdf",
      b64: B64(bytes),
      size: bytes.length,
      pages: await contarPaginas(bytes),
    };
  }

  // Honra o charset do header quando não for UTF-8: o PJe legado serve HTML em
  // ISO-8859-1, e decodificar como UTF-8 estraga toda a acentuação.
  const charset = (ct.match(/charset=([\w-]+)/) || [])[1];
  let raw;
  if (charset && !/^utf-?8$/i.test(charset)) {
    try {
      raw = new TextDecoder(charset).decode(bytes);
    } catch {
      raw = new TextDecoder().decode(bytes);
    }
  } else {
    raw = new TextDecoder().decode(bytes);
  }

  if (ehRtf) {
    const texto = rtfParaTexto(raw).trim();
    if (!texto) return null;
    return { kind: "text", fmt: "rtf", text: texto, visivel: texto.length };
  }

  // O content-type não é confiável sozinho: a casca de peça não materializada já
  // foi observada chegando sem `text/html`. O sniff cobre o caso.
  const ehHtml = ct.includes("html") || /^\s*<(!doctype|html|body|p|div)\b/i.test(raw);

  if (ehHtml) {
    const texto = htmlParaTexto(raw).trim();
    // AQUI mora a detecção de casca — e é o único ponto em que este CLI precisa
    // de julgamento que a extensão ganhava de graça. `texto` vazio é o caso
    // limpo: o PJe devolveu 200 com um envelope sem conteúdo porque a peça não
    // foi materializada nesta sessão.
    if (!texto) return null;
    // `bruto` viaja junto para o relatório poder sinalizar corpo SUSPEITO de
    // casca (poucos bytes com algum texto dentro) sem descartá-lo por conta
    // própria. Descartar por tamanho seria errado: "Intime-se." é despacho
    // legítimo de 10 caracteres.
    return { kind: "text", fmt: "html", text: texto, visivel: texto.length, bruto: bytes.length };
  }

  const text = raw.trim();
  // Rede final: binário sem assinatura na tabela. Não vale para HTML.
  if (pareceBinario(text)) {
    throw new Error("a peça está num formato que este CLI não sabe ler (" + ct + ")");
  }
  if (!text) return null;
  return { kind: "text", fmt: "texto", text, visivel: text.length };
}
