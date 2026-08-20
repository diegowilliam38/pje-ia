// Piloto do Chrome pelo CDP (Chrome DevTools Protocol), sem dependência npm.
//
// O CDP é o MESMO protocolo que o DevTools usa: JSON sobre WebSocket. O Node 22
// traz `WebSocket` global e estável (desde a 22.4), então falar com o navegador
// não custa `node_modules` nenhum — o que preserva a identidade deste projeto,
// que não tem build step.
//
// POR QUE UM PERFIL DEDICADO, E NÃO O SEU CHROME DE SEMPRE:
// desde o **Chrome 136** o `--remote-debugging-port` é IGNORADO no perfil padrão;
// só vale acompanhado de `--user-data-dir` apontando para outro diretório
// (developer.chrome.com/blog/remote-debugging-port). Foi um endurecimento
// deliberado contra malware que lia cookies por debug remoto. Não é preferência
// nossa: é a única forma possível. O custo é real — você loga uma vez num perfil
// separado do seu — e o ganho é que esse perfil PERSISTE.
//
// O QUE PRECISAMOS DELE: só os cookies. Medido em sessão real (20/08/2026), das
// nove coisas que o navegador mandava **só o `JSESSIONID` é necessário**. Por
// isso aqui não há `Network.enable`, não há captura de requisição, não há
// interpretação de cabeçalho — uma chamada de `Storage.getCookies` e acabou.
// Era o passo mais frágil do desenho, e a medição o eliminou.

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const sono = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Achar o Chrome
// ---------------------------------------------------------------------------

// Hardcodar o caminho é o que `store/gerar.py` faz, e é precedente a NÃO seguir:
// quebra em quem instalou noutro lugar, e quebra em silêncio.
function candidatos() {
  if (process.platform === "win32") {
    const pf = process.env["ProgramFiles"] || "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return [
      path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
      // Edge é Chromium e fala o mesmo CDP. Último recurso: numa máquina de
      // tribunal sem Chrome, ele costuma estar lá.
      path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
    ];
  }
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
  }
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ];
}

export function acharChrome(preferido) {
  if (preferido) {
    if (fs.existsSync(preferido)) return preferido;
    throw new Error("não achei o navegador em " + preferido);
  }
  for (const c of candidatos()) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(
    "não achei o Chrome instalado.\n" +
      "Informe o caminho com --chrome \"C:\\\\Program Files\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe\"\n" +
      "ou use o caminho manual: --sessao-atual (ver `pje ajuda`)."
  );
}

// ---------------------------------------------------------------------------
// Porta e processo
// ---------------------------------------------------------------------------

function portaLivre() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function versaoCdp(porta, teto = 1500) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), teto);
  try {
    const r = await fetch("http://127.0.0.1:" + porta + "/json/version", { signal: ctl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// A porta usada da última vez fica gravada DENTRO do perfil. Sem isso não há
// como reencontrar uma instância já aberta — e relançar o Chrome com o mesmo
// `--user-data-dir` apenas abre uma aba na instância existente e o processo novo
// morre em seguida, o que pareceria "o Chrome não subiu".
function arquivoPorta(perfil) {
  return path.join(perfil, ".pje-cdp-porta");
}

async function instanciaViva(perfil) {
  try {
    const porta = Number(fs.readFileSync(arquivoPorta(perfil), "utf8").trim());
    if (!porta) return null;
    const v = await versaoCdp(porta);
    return v ? { porta, versao: v } : null;
  } catch {
    return null;
  }
}

export async function abrirChrome({ perfil, url, chrome, headless = false }) {
  const exe = acharChrome(chrome);

  const jaAberto = await instanciaViva(perfil);
  if (jaAberto) return { ...jaAberto, exe, reusado: true };

  fs.mkdirSync(perfil, { recursive: true });
  const porta = await portaLivre();

  const args = [
    "--remote-debugging-port=" + porta,
    "--user-data-dir=" + perfil,
    "--no-first-run",
    "--no-default-browser-check",
    // Sem isto o Chrome pode abrir a aba de boas-vindas por cima do PJe e o
    // usuário não vê a tela de login.
    "--disable-features=ChromeWhatsNewUI",
  ];
  if (headless) args.push("--headless=new");
  if (url) args.push(url);

  const filho = spawn(exe, args, { detached: true, stdio: "ignore" });
  filho.unref();

  // Espera a porta responder. Chrome frio em disco lento passa de 5 s.
  for (let i = 0; i < 60; i++) {
    await sono(400);
    const v = await versaoCdp(porta);
    if (v) {
      try {
        fs.writeFileSync(arquivoPorta(perfil), String(porta), "utf8");
      } catch {
        /* perfil sem permissão de escrita: só perde o reuso */
      }
      return { porta, versao: v, exe, reusado: false };
    }
  }
  throw new Error(
    "o navegador não abriu a porta de depuração em 24 s.\n" +
      "Isso costuma ser política corporativa ou antivírus bloqueando depuração remota.\n" +
      "Use o caminho manual: `pje login --sessao-atual`, que aproveita a sessão\n" +
      "que já está aberta no seu Chrome de sempre."
  );
}

// ---------------------------------------------------------------------------
// Cliente CDP mínimo
// ---------------------------------------------------------------------------

export class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.proximoId = 1;
    this.pendentes = new Map();
    ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      const p = this.pendentes.get(msg.id);
      if (!p) return; // evento sem pedido: não usamos eventos aqui
      this.pendentes.delete(msg.id);
      if (msg.error) p.rejeitar(new Error(msg.error.message || "erro do CDP"));
      else p.resolver(msg.result);
    });
  }

  static conectar(wsUrl, teto = 10000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const t = setTimeout(() => {
        try {
          ws.close();
        } catch {
          /* já fechado */
        }
        reject(new Error("não consegui falar com o navegador (CDP) em " + teto / 1000 + "s"));
      }, teto);
      ws.addEventListener("open", () => {
        clearTimeout(t);
        resolve(new Cdp(ws));
      });
      ws.addEventListener("error", () => {
        clearTimeout(t);
        reject(new Error("falha ao conectar no CDP"));
      });
    });
  }

  // `sessionId` (opcional) endereça um alvo ANEXADO — é o modo "flatten" do CDP,
  // em que a sessão viaja como campo de topo da mesma conexão em vez de exigir
  // um segundo WebSocket. Sem ele o comando vai para o alvo do NAVEGADOR.
  enviar(method, params = {}, teto = 10000, sessionId) {
    const id = this.proximoId++;
    return new Promise((resolver, rejeitar) => {
      const t = setTimeout(() => {
        this.pendentes.delete(id);
        rejeitar(new Error("o navegador não respondeu a " + method));
      }, teto);
      this.pendentes.set(id, {
        resolver: (v) => {
          clearTimeout(t);
          resolver(v);
        },
        rejeitar: (e) => {
          clearTimeout(t);
          rejeitar(e);
        },
      });
      const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      this.ws.send(JSON.stringify(msg));
    });
  }

  fechar() {
    try {
      this.ws.close();
    } catch {
      /* já fechado */
    }
  }
}

// ---------------------------------------------------------------------------
// Colher os cookies
// ---------------------------------------------------------------------------

// DUAS ROTAS PARA O POTE DE COOKIES, e a segunda não é zelo.
//
// A primeira é `Storage.getCookies` no alvo do NAVEGADOR, que devolve o pote
// inteiro — a vantagem sobre o "Copy as cURL", que só mostra o que UMA
// requisição mandou (numa requisição cross-site o navegador retém por
// `SameSite` justamente o sticky do balanceador e o cookie do Keycloak).
//
// MEDIDO EM 20/08/2026, Ubuntu 24.04 sob WSLg: ela **PENDUROU** — não devolveu
// erro, simplesmente não respondeu, enquanto `Target.getTargets` respondia na
// mesma conexão. O mesmo Chrome no Windows responde na hora. Não interessa se a
// causa é o cookie store ainda carregando ou uma mudança de protocolo: rota que
// pendura precisa de alternativa, e esta e a regra que o `pje-http.mjs` ja
// aplica as rotas do PJe.
//
// A segunda anexa a uma ABA e usa `Network.getAllCookies`, que apesar do nome
// devolve o pote do navegador inteiro, não o da página. Vive noutro domínio do
// protocolo e noutro alvo, então não compartilha o modo de falha da primeira.
async function todosOsCookies(cdp) {
  try {
    const r = await cdp.enviar("Storage.getCookies", {}, 6000);
    if (Array.isArray(r && r.cookies)) return r.cookies;
  } catch {
    /* pendurou ou o alvo do navegador nao aceita: cai para a aba */
  }

  const { targetInfos } = await cdp.enviar("Target.getTargets", {}, 6000);
  const aba = (targetInfos || []).find((t) => t.type === "page");
  if (!aba) throw new Error("nao ha aba aberta para ler os cookies");

  // `flatten: true`: a sessao viaja como campo de topo da MESMA conexao. Sem
  // ele o CDP exige um segundo WebSocket por alvo, e o modo antigo esta
  // depreciado ha varias versoes.
  const { sessionId } = await cdp.enviar(
    "Target.attachToTarget",
    { targetId: aba.targetId, flatten: true },
    6000
  );
  try {
    // `Network.enable` antes: em boa parte das versões o getter funciona sem
    // ele, mas onde NÃO funciona o erro é obscuro, e o preço aqui é um
    // roundtrip em localhost. Os eventos que ele passa a emitir são ignorados
    // pelo cliente (mensagem sem `id` pendente é descartada), e o `disable`
    // logo abaixo os corta.
    try {
      await cdp.enviar("Network.enable", {}, 5000, sessionId);
    } catch {
      /* segue: talvez esta versão dispense */
    }
    const r = await cdp.enviar("Network.getAllCookies", {}, 8000, sessionId);
    return (r && r.cookies) || [];
  } finally {
    try {
      await cdp.enviar("Network.disable", {}, 3000, sessionId);
    } catch {
      /* a aba pode ter fechado */
    }
    // Desanexar sempre: uma sessao esquecida por rodada do laco acumularia uma
    // sessao a cada 1,5 s durante os dez minutos de espera.
    try {
      await cdp.enviar("Target.detachFromTarget", { sessionId }, 3000);
    } catch {
      /* a aba pode ter fechado; nao ha o que desfazer */
    }
  }
}

export async function colherCookies(cdp, host) {
  const cookies = await todosOsCookies(cdp);
  const alvo = String(host || "").toLowerCase();
  const mapa = new Map();
  for (const c of cookies || []) {
    const d = String(c.domain || "").replace(/^\./, "").toLowerCase();
    // Aceita o host exato e os domínios-pai que o cobrem (`.tjce.jus.br` cobre
    // `pje.tjce.jus.br`). Cookie de outro host não tem por que viajar.
    if (alvo === d || alvo.endsWith("." + d)) mapa.set(c.name, c.value);
  }
  return mapa;
}

// O SSO TERMINOU? — a pergunta que separa "tenho um cookie" de "estou logado".
//
// O `JSESSIONID` nasce no PRIMEIRO acesso, antes de qualquer autenticação, e
// por isso não prova nada. Quem prova é o Keycloak: `KEYCLOAK_IDENTITY` (ou
// `KEYCLOAK_SESSION`) só existe depois do login concluído.
//
// O contrário também informa, e foi o que apareceu no teste real: um
// `OAuth_Token_Request_State` SEM `KEYCLOAK_IDENTITY` é a assinatura de um fluxo
// OAuth iniciado e nunca fechado — exatamente o que se vê quando a tela de login
// volta ao início depois do código do autenticador.
//
// Sem esta checagem o `pje login` anunciava sucesso com a sessão pela metade, e
// a falha só aparecia no comando seguinte, sem ligação aparente com o login.
export async function estadoDoSso(cdp) {
  const nomes = new Set((await todosOsCookies(cdp)).map((c) => c.name));
  return {
    concluido: nomes.has("KEYCLOAK_IDENTITY") || nomes.has("KEYCLOAK_SESSION"),
    emCurso: nomes.has("OAuth_Token_Request_State") || nomes.has("KC_RESTART"),
  };
}
