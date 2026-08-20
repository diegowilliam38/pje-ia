// A sessão do PJe: como capturar, guardar e saber se ainda vale.
//
// TRÊS ORIGENS, e nenhuma delas some quando outra entra:
//
//   1. `pje login`      Chrome dedicado por CDP (ver chrome.mjs) — o caminho
//                       normal, e o único que funciona sem ninguém na frente.
//   2. --sessao-atual   "Copy as cURL" no DevTools, lido da área de transferência
//                       (aproveita a sessão que já está aberta no navegador).
//   3. --curl <arq>     o mesmo, mas de um arquivo.
//
// As duas manuais existem porque máquina de tribunal pode ter política
// corporativa bloqueando remote debugging, e aí o caminho 1 falha por algo fora
// do nosso alcance. Mesma disciplina que manteve `carregarTimelineCompleta` viva
// depois que a rota REST entrou na frente dela: o atalho novo é ACELERADOR, não
// substituto.
//
// MEDIDO EM 20/08/2026, sessão real do TJCE: das nove coisas que o navegador
// mandava, **só o `JSESSIONID` é necessário**. Sem os seis cabeçalhos `X-pje-*`,
// sem `Authorization`, sem `KEYCLOAK_IDENTITY` e sem o sticky, as três rotas
// (`currentUser`, `numero-processo/validar`, `documentos`) responderam 200.
// Confirma o mecanismo do `web.xml`: quem autentica é o Seam Filter, pela
// sessão — não há token na história.
//
// Ainda assim guardamos o pote INTEIRO de cookies do host, e replicamos os
// `X-pje-*` quando aparecem. Custa alguns bytes e cobre o tribunal cujo
// balanceador se comporte de outro jeito. O que a medição eliminou foi a
// NECESSIDADE de capturá-los — e com ela o passo mais frágil do `pje login`.

import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { lerSessaoSalva, gravarSessaoSalva } from "./config.mjs";

// ---------------------------------------------------------------------------
// Parser do "Copy as cURL"
// ---------------------------------------------------------------------------

// Cabeçalhos REPLICADOS quando estão no cURL. Allowlist estreita: só o que
// identifica a aplicação legada. Origin, Referer, Sec-Fetch-* e Content-Type
// ficam de fora — são do navegador, descrevem uma requisição cross-site que a
// nossa não é, e alguns o `fetch` do Node nem deixaria definir.
const CABECALHOS_REPLICADOS = /^(x-pje-|x-no-sso$|authorization$)/i;

// Desfaz o escape do cmd do Windows, que é o formato PADRÃO do "Copy as cURL"
// no Chrome em Windows. Ali o `^` escapa o caractere seguinte: `^"` é aspa,
// `^$` é cifrão (comum nos cookies do Google Analytics) e `^\^"` é uma aspa
// LITERAL dentro do valor — que é como vem o sticky do balanceador,
// `PJE-XX-1G-StickySessionRule="servidor:aplicacao"`.
function desescaparCmd(s) {
  if (!/\^"/.test(s)) return s; // formato bash: nada a fazer
  return s.replace(/\^\r?\n\s*/g, " ").replace(/\^(.)/g, "$1");
}

// Um valor entre aspas, respeitando `\"` no meio.
const ASPAS = `(?:"((?:[^"\\\\]|\\\\.)*)"|'([^']*)')`;

function valorDe(m) {
  if (!m) return null;
  return m[1] !== undefined ? m[1].replace(/\\"/g, '"') : m[2] !== undefined ? m[2] : null;
}

export function parsearCookies(str) {
  const mapa = new Map();
  for (const parte of String(str || "").split(";")) {
    const t = parte.trim();
    if (!t) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    mapa.set(t.slice(0, i).trim(), t.slice(i + 1).trim());
  }
  return mapa;
}

export function juntarCookies(mapa) {
  return [...mapa].map(([k, v]) => k + "=" + v).join("; ");
}

export function lerCurl(texto) {
  const s = desescaparCmd(String(texto));

  const headers = {};
  const reH = new RegExp("-H\\s+" + ASPAS, "g");
  let m;
  while ((m = reH.exec(s))) {
    const bruto = valorDe(m);
    if (!bruto) continue;
    const i = bruto.indexOf(":");
    if (i <= 0) continue;
    headers[bruto.slice(0, i).trim().toLowerCase()] = bruto.slice(i + 1).trim();
  }

  // O `-b` e o cabeçalho `X-pje-cookies` NÃO são o mesmo conjunto: numa
  // requisição cross-site o navegador retém por `SameSite` os cookies que o
  // frontend do CNJ então copia para o cabeçalho. Medido: `KEYCLOAK_IDENTITY` e
  // o sticky só aparecem lá. A união é o conjunto completo.
  const cookies = parsearCookies(
    valorDe(s.match(new RegExp("(?:-b|--cookie)\\s+" + ASPAS))) || headers.cookie
  );
  for (const [k, v] of parsearCookies(headers["x-pje-cookies"])) cookies.set(k, v);

  const extras = {};
  for (const [k, v] of Object.entries(headers)) {
    if (CABECALHOS_REPLICADOS.test(k)) extras[k] = v;
  }

  // `--url "..."` antes de `curl "..."`: o Chrome no Windows usa a primeira
  // forma, e um `curl\s+\S+` casaria o próprio `--url`. O base path sairia
  // errado, e em silêncio.
  const mUrl =
    s.match(new RegExp("--url\\s+" + ASPAS)) || s.match(new RegExp("curl\\s+" + ASPAS));
  const url = valorDe(mUrl) || (s.match(/https:\/\/[^\s"']+/) || [])[0];

  let urlBase = null;
  if (url) {
    try {
      const u = new URL(url);
      const primeiro = u.pathname.split("/").filter(Boolean)[0];
      if (primeiro) urlBase = u.origin + "/" + primeiro;
    } catch {
      /* URL estranha: o usuário informa --base à mão */
    }
  }

  return {
    urlBase,
    cookie: cookies.size ? juntarCookies(cookies) : null,
    userAgent: headers["user-agent"] || null,
    extras,
  };
}

// ---------------------------------------------------------------------------
// Área de transferência
// ---------------------------------------------------------------------------

// Sem dependência: cada sistema já traz o seu utilitário. Falha aqui NUNCA é
// fatal — devolve null e o chamador oferece o caminho do arquivo.
// WSL se apresenta como `linux`, mas não tem servidor gráfico nem `xclip` — e
// a área de transferência que interessa é a do WINDOWS, porque é lá que está o
// navegador de onde veio o "Copy as cURL". O `powershell.exe` é alcançável de
// dentro do WSL, então é por ele que se lê.
function ehWsl() {
  if (process.platform !== "linux") return false;
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
  try {
    return /microsoft/i.test(fs.readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

export function lerAreaDeTransferencia() {
  const psWin = ["powershell.exe", ["-NoProfile", "-Command", "Get-Clipboard -Raw"]];
  const tentativas =
    process.platform === "win32"
      ? [["powershell", ["-NoProfile", "-Command", "Get-Clipboard -Raw"]]]
      : process.platform === "darwin"
        ? [["pbpaste", []]]
        : ehWsl()
          ? [psWin, ["xclip", ["-selection", "clipboard", "-o"]]]
          : [
              ["xclip", ["-selection", "clipboard", "-o"]],
              ["xsel", ["--clipboard", "--output"]],
            ];
  for (const [cmd, args] of tentativas) {
    try {
      const out = execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
      if (out && out.trim()) return out;
    } catch {
      /* utilitário ausente ou área vazia: tenta o próximo */
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Resolver a sessão a partir dos argumentos + do que está salvo
// ---------------------------------------------------------------------------

function daOrigem(args) {
  if (args.curl) {
    const bruto = lerCurl(fs.readFileSync(args.curl, "utf8"));
    if (!bruto.cookie) {
      throw new Error(
        "não achei o cabeçalho Cookie em " + args.curl + ".\n" +
          "Confira se colou o comando inteiro do \"Copy as cURL\" e se a requisição\n" +
          "escolhida era do PJe (uma que exija login), não de um CDN ou de uma extensão."
      );
    }
    return { ...bruto, origem: "curl" };
  }
  return null;
}

// Tenta ler uma sessão do que está na área de transferência AGORA.
// Devolve `null` quando não há nada aproveitável — sem lançar, porque o chamador
// usa isso para decidir se guia o usuário ou se já pode seguir.
export function tentarDaAreaDeTransferencia() {
  const txt = lerAreaDeTransferencia();
  if (!txt) return null;
  let bruto;
  try {
    bruto = lerCurl(txt);
  } catch {
    return null;
  }
  if (!bruto.cookie || !/jsessionid=/i.test(bruto.cookie)) return null;
  if (!bruto.urlBase) return null;
  return { ...bruto, origem: "sessao-atual" };
}

// Devolve a sessão a usar, ou `null` quando não há nenhuma.
//
// PRECEDÊNCIA: o que o usuário passou na linha de comando vence o que está
// salvo. Quem digitou `--clipboard` quer capturar de novo — provavelmente
// porque a salva morreu —, e reusar a antiga só produziria o mesmo erro.
export function resolverSessao(args, config) {
  const explicita = daOrigem(args);
  const salva = explicita ? null : lerSessaoSalva();
  const s = explicita || salva;

  if (!s) return null;

  const urlBase = args.base || s.urlBase || config.base;
  if (!urlBase) {
    throw new Error(
      "não sei o endereço do PJe. Rode `pje login`, ou informe --base " +
        "https://pje.SEUTRIBUNAL.jus.br/pje1grau"
    );
  }
  return {
    urlBase,
    cookie: args.cookie || s.cookie,
    userAgent: s.userAgent || null,
    extras: s.extras || {},
    origem: s.origem || "salva",
    capturadaEm: s.capturadaEm || null,
  };
}

export function salvar(sessao) {
  gravarSessaoSalva({
    urlBase: sessao.urlBase,
    cookie: sessao.cookie,
    userAgent: sessao.userAgent || null,
    extras: sessao.extras || {},
    origem: sessao.origem || "login",
    capturadaEm: new Date().toISOString(),
  });
}

// Um resumo SEM SEGREDO, para `pje status` e mensagens. O valor do cookie nunca
// sai daqui — nem truncado: os primeiros caracteres de um JSESSIONID já bastam
// para reduzir muito o espaço de busca.
export function descrever(sessao) {
  if (!sessao) return "nenhuma sessão salva";
  const nomes = [...parsearCookies(sessao.cookie).keys()];
  const quando = sessao.capturadaEm
    ? new Date(sessao.capturadaEm).toLocaleString("pt-BR")
    : "instante desconhecido";
  return (
    "capturada em " + quando +
    " (" + (sessao.origem || "?") + ")" +
    " · " + nomes.length + " cookies" +
    (nomes.includes("JSESSIONID") ? " incluindo JSESSIONID" : " SEM JSESSIONID (suspeito)")
  );
}
