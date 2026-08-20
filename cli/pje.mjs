#!/usr/bin/env node
// pje — baixa autos do PJe em lote, uma pasta por processo.
//
//   pje login                        uma vez: abre o Chrome, você loga
//   pje baixar <cnj> [<cnj>...]      baixa; se já estiver em disco, só atualiza
//   pje atualizar                    revisita tudo que já está no destino
//   pje status                       a sessão está viva? o que já baixei?
//
// Zero dependências npm. Node 22+ (usa `fetch` e o `WebSocket` global).
//
// NÃO altera a extensão: `src/exportar.js` e `src/zip.js` são LIDOS, nunca
// modificados, e é daí que vem a garantia de que o pacote produzido aqui é o
// mesmo que o botão "Baixar .zip" do painel produz.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { criarCliente } from "./pje-http.mjs";
import { baixarProcesso, obterPeca, PjeExport } from "./baixador.mjs";
import { docsDe } from "./ficha.mjs";
import { processosNoDestino } from "./cache.mjs";
import { lerConfig, gravarConfig, CAMINHOS, apagarSessaoSalva, apagarPerfil } from "./config.mjs";
import { resolverSessao, salvar, descrever, juntarCookies, tentarDaAreaDeTransferencia } from "./sessao.mjs";
import { abrirChrome, Cdp, colherCookies, estadoDoSso } from "./chrome.mjs";

const RE_CNJ = /\b\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}\b/;
const sono = (ms) => new Promise((r) => setTimeout(r, ms));

// Códigos de saída, para quem encadeia comandos:
//   0 tudo certo · 1 erro de uso · 2 sessão · 3 concluído COM falhas
const SAIDA = { OK: 0, USO: 1, SESSAO: 2, PARCIAL: 3 };

// ---------------------------------------------------------------------------
// Argumentos
// ---------------------------------------------------------------------------

// Flags SEM valor precisam ser DECLARADAS. Sem isto, `--sondar 0205435-...`
// consome o CNJ como se fosse o valor da flag, e o programa termina dizendo
// "nenhum processo informado" com o processo ali na linha de comando. Já
// aconteceu nesta rodada.
const FLAGS = new Set([
  "forcar", "zip", "json", "sessao-atual", "clipboard", "ajuda", "help", "h", "versao", "headless",
]);

function lerArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith("--")) {
      const nome = t.slice(2);
      if (FLAGS.has(nome)) {
        a[nome] = true;
        continue;
      }
      const prox = argv[i + 1];
      if (prox === undefined || prox.startsWith("--")) a[nome] = true;
      else {
        a[nome] = prox;
        i++;
      }
    } else a._.push(t);
  }
  return a;
}

const AJUDA = `
pje — baixa autos do PJe em lote, uma pasta por processo.

COMANDOS
  pje login --sessao-atual
                          APROVEITA a sessão que já está aberta no seu Chrome.
                          Não cria sessão nova, então não briga com o PJe que
                          você tem aberto. O comando guia o passo manual.
  pje login [url]         Abre um Chrome próprio para você logar do zero.
                          Cria uma sessão NOVA — e o PJe não aceita duas suas
                          ao mesmo tempo, então pode conflitar com a que você
                          já tem. Na primeira vez informe a url, ex.:
                            pje login https://pje.tjce.jus.br/pje1grau
  pje baixar <cnj>...     Baixa os processos. Rodar de novo no mesmo processo
                          busca SÓ o que apareceu depois.
  pje atualizar           O mesmo, para tudo que já está no destino (sem CNJ).
  pje sondar <cnj>...     Não baixa: mede quantas peças dá para pegar.
  pje status              A sessão está viva? O que já foi baixado?
  pje logout              Apaga a sessão salva e o perfil do navegador.

OPÇÕES
  --lista <arquivo>       Um CNJ por linha (# vira comentário).
  --destino <pasta>       Onde gravar. Padrão: o do config, ou ./autos
  --zip                   Gera também o .zip, idêntico ao do painel.
  --forcar                Ignora o que já está em disco e rebaixa tudo.
  --concorrencia <n>      Downloads em paralelo (padrão 3, teto 5).
  --json                  Resumo em JSON, para script.
  --limite <n>            Só no sondar: quantas peças testar (padrão 12).

QUAL DOS DOIS LOGINS USAR
  Use --sessao-atual. Ele reaproveita o login que você já fez, e por isso
  funciona mesmo com o PJe aberto e mesmo onde a depuração remota do
  navegador é bloqueada por política corporativa.
  O login sem opção só compensa quando você NÃO está logado no PJe.

A sessão é uma CREDENCIAL AO PORTADOR: quem a tiver entra no PJe como você.
Ela fica em ${CAMINHOS.base}, fora do repositório. \`pje logout\` apaga.
`;

// ---------------------------------------------------------------------------
// Entrada de processos
// ---------------------------------------------------------------------------

function lerListaCnj(args) {
  const brutos = [];
  if (args.lista) brutos.push(...fs.readFileSync(args.lista, "utf8").split(/\r?\n/));
  // `processos` continua aceito: era o nome da flag antes dos subcomandos.
  if (args.processos) brutos.push(...fs.readFileSync(args.processos, "utf8").split(/\r?\n/));
  brutos.push(...args._);

  const cnjs = [];
  const invalidas = [];
  for (const linha of brutos) {
    const t = String(linha).trim();
    if (!t || t.startsWith("#")) continue;
    const m = t.match(RE_CNJ);
    if (m) {
      if (!cnjs.includes(m[0])) cnjs.push(m[0]);
    } else invalidas.push(t);
  }
  // Linha que não é CNJ nunca é ignorada em silêncio: um dígito a menos por erro
  // de digitação viraria "processo não baixado" sem ninguém saber por quê.
  if (invalidas.length) {
    console.log("Ignorado (não é um CNJ no formato NNNNNNN-DD.AAAA.J.TR.OOOO):");
    for (const l of invalidas) console.log("  " + l);
    console.log("");
  }
  return cnjs;
}

// ---------------------------------------------------------------------------
// Sessão
// ---------------------------------------------------------------------------

async function clienteOuFalhar(args, config) {
  const s = resolverSessao(args, config);
  if (!s || !s.cookie) {
    console.log("Nenhuma sessão guardada. Rode:  pje login");
    return null;
  }
  const cli = criarCliente(s);
  if (!(await cli.autenticado())) {
    console.log("A sessão do PJe expirou.");
    console.log("Rode:  pje login");
    console.log("(nada foi gravado)");
    return null;
  }
  return cli;
}

// ---------------------------------------------------------------------------
// pje login
// ---------------------------------------------------------------------------

// Aproveitar a sessão que já está aberta no navegador do usuário.
//
// O NOME DA OPÇÃO DIZ O RESULTADO, NÃO O MECANISMO. Ela se chamou `--clipboard`
// por um tempo, e isso era um defeito de UX: "clipboard" descreve o encanamento
// (a área de transferência) e esconde a única coisa que o usuário precisa saber
// — que NENHUMA sessão nova é criada. E é justamente isso que importa, porque o
// PJe não tolera duas sessões do mesmo usuário: o caminho que abre um navegador
// próprio compete com a que ele já tem; este convive.
//
// E o comando GUIA em vez de recusar. A primeira versão saía com um erro
// mandando fazer o "Copy as cURL" e rodar de novo — duas execuções para uma
// tarefa só. Agora ele explica e ESPERA, relendo a área de transferência até o
// usuário copiar. O nome fica honesto: ele de fato aproveita a sessão atual, e
// conduz o único passo manual que existe.
async function capturarSessaoAtual(urlBaseConhecida) {
  let s = tentarDaAreaDeTransferencia();
  if (!s) {
    console.log("Vou aproveitar a sessão que já está aberta no seu navegador.");
    console.log("(nenhuma sessão nova é criada — você não sai do PJe)");
    console.log("");
    console.log("No Chrome onde o PJe está aberto e logado:");
    console.log("  1. F12 para abrir o DevTools, aba Network");
    console.log("  2. F5 para recarregar a página");
    console.log("  3. botão direito numa requisição do tribunal (ex.: currentUser)");
    console.log("     -> Copy -> Copy as cURL");
    console.log("");
    console.log("Assim que você copiar, eu sigo sozinho. Esperando... (Ctrl+C cancela)");

    const TETO_MS = 5 * 60 * 1000;
    const inicio = Date.now();
    while (!s && Date.now() - inicio < TETO_MS) {
      await sono(1200);
      s = tentarDaAreaDeTransferencia();
    }
    if (!s) {
      console.log("");
      console.log("Passei 5 minutos esperando e não vi um \"Copy as cURL\" do PJe.");
      console.log("Se preferir, salve num arquivo e use:  pje login --curl arquivo.txt");
      return null;
    }
    console.log("  peguei.");
  }
  if (urlBaseConhecida && !s.urlBase) s.urlBase = urlBaseConhecida;
  return s;
}

async function cmdLogin(args, config) {
  // Caminho que REAPROVEITA a sessão. Nunca sai do produto: é imune ao controle
  // de simultaneidade do PJe e funciona onde a depuração remota é bloqueada por
  // política corporativa.
  const querSessaoAtual = args["sessao-atual"] || args.clipboard; // `--clipboard`: nome antigo
  if (querSessaoAtual || args.curl) {
    const s = args.curl
      ? resolverSessao(args, config)
      : await capturarSessaoAtual(config.base);
    if (!s) return SAIDA.SESSAO;

    const cli = criarCliente(s);
    if (!(await cli.autenticado())) {
      console.log("");
      console.log("Peguei uma sessão, mas o PJe não a reconhece.");
      console.log("Quase sempre é a requisição errada — um CDN ou um recurso de");
      console.log("extensão, que não carregam o cookie do tribunal. Escolha uma cujo");
      console.log("endereço seja do PJe (currentUser, tarefas, etiquetas) e repita.");
      return SAIDA.SESSAO;
    }
    const guardada = { ...s, capturadaEm: new Date().toISOString() };
    salvar(guardada);
    gravarConfig({ base: s.urlBase });
    console.log("");
    console.log("Pronto. " + descrever(guardada));
    console.log("Agora é só:  pje baixar <numero do processo>");
    return SAIDA.OK;
  }

  const urlBase = args._[0] || args.base || config.base;
  if (!urlBase) {
    console.log("Na primeira vez preciso saber o endereço do seu PJe:");
    console.log("  pje login https://pje.tjce.jus.br/pje1grau");
    console.log("");
    console.log("É o que está na barra de endereços até o primeiro pedaço do caminho.");
    return SAIDA.USO;
  }

  // Valida o formato ANTES de abrir o navegador: errar a URL e descobrir depois
  // de uma janela aberta e um login digitado é o pior instante possível.
  const cliTeste = criarCliente({ urlBase, cookie: "x=1" });
  const host = cliTeste.ctx.host;

  console.log("Abrindo o Chrome num perfil dedicado...");
  console.log("(é um perfil separado do seu Chrome normal — o Chrome 136+ não");
  console.log(" permite depuração remota no perfil padrão)");

  const chrome = await abrirChrome({
    perfil: CAMINHOS.perfil,
    url: urlBase,
    chrome: args.chrome || config.chrome,
    headless: !!args.headless,
  });
  if (chrome.reusado) console.log("Reusando a janela que já estava aberta.");

  const cdp = await Cdp.conectar(chrome.versao.webSocketDebuggerUrl);

  console.log("");
  console.log("Faça o login no PJe na janela que abriu. Estou esperando...");
  console.log("(Ctrl+C cancela)");

  // ENQUANTO VOCÊ LOGA, NÃO SE TOCA NO PJe.
  //
  // A primeira versão validava a sessão a cada 1,5 s — isto é, disparava
  // `isAuthenticated`/`currentUser` de um segundo cliente, com o mesmo
  // JSESSIONID, no meio do handshake do SSO. O PJe controla simultaneidade de
  // sessão, e requisição paralela durante a autenticação é justamente o que
  // pode reiniciar o fluxo: o usuário digitava CPF, senha e o código do
  // autenticador, e voltava para a tela de login, em loop.
  //
  // Agora a espera é passiva: só CDP (que fala com o NAVEGADOR, não com o
  // tribunal), e a validação acontece no máximo a cada 10 s — e só quando o
  // navegador já saiu da tela de login.
  const TETO_MS = 10 * 60 * 1000;
  const ESPACO_VALIDACAO_MS = 10000;
  const inicio = Date.now();
  let ultimaValidacao = 0;
  let urlAnterior = "";
  let voltasAoLogin = 0;
  let avisouLeituraLenta = false;

  const ehTelaDeLogin = (u) =>
    /\/(auth|sso|login|realms)\b/i.test(u) || /openid-connect/i.test(u);

  try {
    while (Date.now() - inicio < TETO_MS) {
      await sono(1500);

      // Mostra para onde o navegador foi. É o que torna um loop de login
      // VISÍVEL em vez de o comando parecer travado.
      let urls = [];
      try {
        const { targetInfos } = await cdp.enviar("Target.getTargets");
        urls = (targetInfos || []).filter((t) => t.type === "page").map((t) => t.url);
      } catch {
        console.log("\n  A janela do navegador foi fechada. Nada foi guardado.");
        return SAIDA.SESSAO;
      }
      const atual = urls.find((u) => u && u !== "about:blank") || "";
      if (atual && atual !== urlAnterior) {
        urlAnterior = atual;
        console.log("  ." + " navegando: " + atual.slice(0, 88));
      }

      // DETECTAR O LOOP E EXPLICÁ-LO, em vez de deixar o usuário concluir que
      // não funcionou. Voltar à tela de login depois de já ter passado por ela
      // é o sintoma; dizer o motivo na hora é o que evita a terceira tentativa
      // inútil.
      if (atual && ehTelaDeLogin(atual)) {
        if (++voltasAoLogin === 3) {
          console.log("");
          console.log("  Notei que a tela de login voltou algumas vezes.");
          console.log("  A causa provável é o PJe NÃO ACEITAR DUAS SESSÕES SUAS ao mesmo");
          console.log("  tempo: esta janela concorre com o PJe aberto no seu Chrome normal.");
          console.log("");
          console.log("  Duas saídas:");
          console.log("   a) feche o PJe no seu Chrome normal (ou saia da conta lá) e");
          console.log("      recomece o login NESTA janela; ou");
          console.log("   b) cancele com Ctrl+C e use  pje login --sessao-atual, que aproveita");
          console.log("      a sessão que você já tem e não cria uma segunda.");
          console.log("");
        }
        continue;
      }

      // NUMA ESPERA LONGA, NENHUMA CHAMADA ISOLADA PODE SER FATAL.
      //
      // Estas duas estavam NUAS dentro do `try { while } finally`, e um
      // `finally` não engole exceção: ele fechava o CDP e deixava o erro subir,
      // matando o comando. Relatado no WSL: `Storage.getCookies` pendurou aos
      // 12 s e o "estou esperando dez minutos" acabou ANTES de o usuário digitar
      // o CPF — a janela seguiu aberta, ele logou nela, e o CLI já tinha morrido.
      //
      // A paciência estava no `while` e era desfeita por um `await` sem guarda
      // três linhas abaixo. Mesma regra de "falha de download não derruba o
      // turno": o que falha nesta volta pode dar certo na próxima, e dar certo
      // na próxima é literalmente o que este laço existe para fazer.
      let cookies, sso;
      try {
        cookies = await colherCookies(cdp, host);
        // Ter o JSESSIONID NÃO é estar logado: ele nasce no primeiro acesso.
        // Quem atesta o login concluído é o cookie do Keycloak.
        sso = cookies.has("JSESSIONID") ? await estadoDoSso(cdp) : null;
      } catch (e) {
        // Dito UMA vez, e não a cada 1,5 s: repetir a cada volta viraria ruído
        // que esconde a instrução de logar, que é o que o usuário precisa ler.
        if (!avisouLeituraLenta) {
          avisouLeituraLenta = true;
          console.log("  (o navegador demorou a responder a leitura dos cookies —");
          console.log("   sigo tentando; pode continuar o login normalmente)");
        }
        continue;
      }
      if (!cookies.has("JSESSIONID")) continue;
      if (!sso || !sso.concluido) continue;
      if (Date.now() - ultimaValidacao < ESPACO_VALIDACAO_MS) continue;
      ultimaValidacao = Date.now();

      const sessao = {
        urlBase,
        cookie: juntarCookies(cookies),
        userAgent: (chrome.versao["User-Agent"] || "").replace(/Headless/g, "") || null,
        extras: {},
        origem: "login",
      };
      const cli = criarCliente(sessao);
      if (await cli.autenticado()) {
        // CONFIRMA DE NOVO, alguns segundos depois. Uma sessao derrubada pelo
        // controle de simultaneidade chega a valer por instantes, e gravar esse
        // instante fazia o `pje login` anunciar sucesso para uma sessao que
        // morria em seguida — com a falha aparecendo so no comando seguinte,
        // sem ligacao aparente com o login.
        await sono(4000);
        if (!(await cli.autenticado())) {
          console.log("  a sessao valeu por um instante e caiu; continuo esperando...");
          continue;
        }
        sessao.capturadaEm = new Date().toISOString();
        salvar(sessao);
        gravarConfig({ base: urlBase, chrome: chrome.exe });
        console.log("");
        console.log("Pronto. " + descrever(sessao));
        console.log("Pode fechar a janela do navegador (o login fica guardado).");
        console.log("");
        console.log("Agora:  pje baixar 0000000-00.0000.0.00.0000");
        return SAIDA.OK;
      }
    }
  } finally {
    cdp.fechar();
  }

  console.log("");
  console.log("Passei 10 minutos esperando e a sessão não ficou válida.");
  console.log("");
  console.log("Se o login ficou em LOOP (pede CPF, senha, código e volta ao início),");
  console.log("provavelmente a página que abri não é a que você usa. Tente apontar a");
  console.log("sua tela de entrada:");
  console.log("  pje login --abrir https://ENDERECO-QUE-VOCE-USA");
  console.log("");
  console.log("Ou use o caminho manual, que não depende disto:");
  console.log("  pje login --sessao-atual   (ver `pje ajuda`)");
  return SAIDA.SESSAO;
}

// ---------------------------------------------------------------------------
// pje baixar / atualizar
// ---------------------------------------------------------------------------

function fmtBytes(n) {
  if (!n) return "0 B";
  if (n >= 1048576) return (n / 1048576).toFixed(1) + " MB";
  if (n >= 1024) return Math.round(n / 1024) + " KB";
  return n + " B";
}

async function cmdBaixar(args, config, { todos = false } = {}) {
  const cli = await clienteOuFalhar(args, config);
  if (!cli) return SAIDA.SESSAO;

  const destino = args.destino || config.destino || "autos";
  let cnjs = lerListaCnj(args);

  if (todos) {
    const achados = processosNoDestino(destino);
    if (!achados.length) {
      console.log("Não há nenhum processo baixado em " + destino + ".");
      console.log("Baixe o primeiro com:  pje baixar <numero>");
      return SAIDA.USO;
    }
    const ja = new Set(cnjs);
    for (const a of achados) if (!ja.has(a.cnj)) cnjs.push(a.cnj);
  }

  if (!cnjs.length) {
    console.log("Informe ao menos um processo:");
    console.log("  pje baixar 0000000-00.0000.0.00.0000");
    console.log("  pje baixar --lista processos.txt");
    return SAIDA.USO;
  }

  console.log(
    "Tribunal " + (cli.ctx.sigla || cli.ctx.host) + " · " + cli.ctx.grau +
    " · destino " + path.resolve(destino)
  );
  console.log(cnjs.length + " processo(s)\n");
  fs.mkdirSync(destino, { recursive: true });

  const relatorio = [];
  let houveFalha = false;

  for (const cnj of cnjs) {
    process.stdout.write(cnj + "\n");
    try {
      const r = await baixarProcesso(cli, cnj, {
        destinoRaiz: destino,
        forcar: !!args.forcar,
        concorrencia: Number(args.concorrencia) || config.concorrencia || 3,
        zip: !!args.zip,
        onProgresso: (feitas, total) => {
          if (total) process.stdout.write("\r  baixando " + feitas + "/" + total + "   ");
        },
      });
      process.stdout.write("\r" + " ".repeat(40) + "\r");

      if (r.jaEmDisco && !r.novas) {
        console.log("  nada novo (" + r.jaEmDisco + " peças já em disco)");
      } else {
        console.log(
          "  " + r.resumo.ok + " peças · " + r.resumo.paginas + " páginas · " +
          fmtBytes(r.resumo.bytes) +
          (r.baixadas ? " · " + r.baixadas + " baixadas" : "") +
          (r.reusadas ? " · " + r.reusadas + " do disco" : "")
        );
      }
      if (r.resumo.falhas) {
        houveFalha = true;
        const partes = [];
        if (r.cascas.length) partes.push(r.cascas.length + " precisam ser abertas no PJe");
        if (r.naoServiveis.length) partes.push(r.naoServiveis.length + " sem download (404)");
        if (r.semPermissao.length) partes.push(r.semPermissao.length + " recusadas pelo PJe (403)");
        console.log(
          "  " + r.resumo.falhas + " não entraram" +
          (partes.length ? ": " + partes.join(", ") : "")
        );
      }
      if (r.orfaos) console.log("  " + r.orfaos + " arquivo(s) de numeração antiga removidos");
      if (r.zip) console.log("  zip: " + r.zip);
      relatorio.push(r);

      if (r.sessaoMorreu) {
        console.log("\n  A sessão do PJe caiu no meio. Rode `pje login` e repita —");
        console.log("  o que já baixou está no disco e não será baixado de novo.");
        return SAIDA.SESSAO;
      }
    } catch (e) {
      houveFalha = true;
      console.log("  FALHOU: " + (e && e.message ? e.message : e));
      relatorio.push({ cnj, erro: String((e && e.message) || e) });
    }
  }

  // As duas listas sao SEPARADAS porque a saida de cada uma e outra: a casca se
  // resolve abrindo a peca no PJe; o 404 nao se resolve por aqui nem pela
  // extensao — a rota simplesmente nao serve aquele documento.
  const com403 = relatorio.filter((r) => r.semPermissao && r.semPermissao.length);
  if (com403.length) {
    console.log("\n" + "-".repeat(64));
    console.log("PEÇAS QUE O PJe NÃO ENTREGA (HTTP 403)");
    console.log("O servidor reconheceu a sessão e recusou ESTES documentos. Não é falha");
    console.log("de rede nem de rota — o 403 se repete com e sem os cabeçalhos do PJe,");
    console.log("nas duas rotas e com retry —, e o painel da extensão também não os pega.");
    console.log("");
    console.log("O caso típico é DOCUMENTO CANCELADO: na linha do tempo do PJe ele");
    console.log("aparece com o título riscado, e o PJe não serve o arquivo. Quando é");
    console.log("isso, a ausência no pacote está CORRETA — documento cancelado não");
    console.log("integra o que vale nos autos.");
    for (const r of com403) {
      console.log("");
      console.log("  " + r.cnj + ": " + r.semPermissao.join(", "));
      if (r.pistasCancelamento && r.pistasCancelamento.length) {
        console.log("  movimentações de cancelamento neste processo:");
        for (const p of r.pistasCancelamento.slice(0, 6)) {
          console.log("    · " + p.slice(0, 110));
        }
      }
    }
  }

  const com404 = relatorio.filter((r) => r.naoServiveis && r.naoServiveis.length);
  if (com404.length) {
    console.log("\n" + "-".repeat(64));
    console.log("PEÇAS QUE O DOWNLOAD DIRETO NÃO ALCANÇOU (HTTP 404)");
    console.log("Elas constam da lista do processo. Tentei abrir cada uma na sessão do");
    console.log("navegador e baixar de novo — o que sobrou aqui resistiu a isso.\n");
    for (const r of com404) console.log("  " + r.cnj + ": " + r.naoServiveis.join(", "));
  }

  const comCasca = relatorio.filter((r) => r.cascas && r.cascas.length);
  if (comCasca.length) {
    console.log("\n" + "-".repeat(64));
    console.log("PEÇAS QUE EXIGEM ABRIR O PROCESSO NO NAVEGADOR");
    console.log("O PJe só materializa a peça depois que ela é aberta na sessão — é");
    console.log("estado no servidor, e nenhuma rota contorna. Abra o processo no PJe");
    console.log("e rode este comando de novo: só o que falta será buscado.\n");
    for (const r of comCasca) console.log("  " + r.cnj + ": " + r.cascas.join(", "));
  }

  if (args.json) {
    console.log(JSON.stringify(
      relatorio.map((r) => ({
        cnj: r.cnj, pasta: r.pasta, erro: r.erro || null,
        ok: r.resumo ? r.resumo.ok : 0,
        falhas: r.resumo ? r.resumo.falhas : null,
        baixadas: r.baixadas, reusadas: r.reusadas, zip: r.zip || null,
      })), null, 2));
  }
  return houveFalha ? SAIDA.PARCIAL : SAIDA.OK;
}

// ---------------------------------------------------------------------------
// pje sondar
// ---------------------------------------------------------------------------

async function cmdSondar(args, config) {
  const cli = await clienteOuFalhar(args, config);
  if (!cli) return SAIDA.SESSAO;

  const cnjs = lerListaCnj(args);
  if (!cnjs.length) {
    console.log("Informe ao menos um processo:  pje sondar 0000000-00.0000.0.00.0000");
    return SAIDA.USO;
  }

  console.log("SONDA — nada é baixado para o disco.");
  console.log("  " + JSON.stringify(await cli.statusInfo()) + "\n");

  const limite = Number(args.limite) || 12;
  let ok = 0;
  let casca = 0;

  for (const cnj of cnjs) {
    console.log(cnj);
    let id;
    try {
      id = await cli.idPorCnj(cnj);
    } catch (e) {
      console.log("  CNJ -> id: FALHOU: " + e.message);
      continue;
    }
    const docs = docsDe(await cli.documentos(id));
    const movs = await cli.movimentacoes(id).catch(() => null);
    console.log(
      "  id " + id + " · " + docs.length + " documentos · " +
      (movs ? movs.length + " movimentações" : "movimentações: falhou")
    );

    const conta = { pdf: 0, texto: 0, imagem: 0, casca: 0, erro: 0 };
    for (const d of docs.slice(0, limite)) {
      const r = await obterPeca(cli, id, d.id);
      if (r.ok) {
        conta[r.corpo.kind === "pdf" ? "pdf" : r.corpo.kind === "img" ? "imagem" : "texto"]++;
        ok++;
      } else if (r.casca) {
        conta.casca++;
        casca++;
      } else conta.erro++;
      await sono(120);
    }
    console.log(
      "  amostra de " + Math.min(limite, docs.length) + ": PDF " + conta.pdf +
      " · texto " + conta.texto + " · imagem " + conta.imagem +
      " · CASCA " + conta.casca + " · erro " + conta.erro
    );
  }

  const testadas = ok + casca;
  console.log("\n" + "-".repeat(64));
  if (!testadas) console.log("Nenhuma peça testada.");
  else {
    const pct = Math.round((casca / testadas) * 100);
    console.log(ok + " de " + testadas + " peças com conteúdo útil · " + pct + "% de casca");
    console.log(pct <= 15
      ? "Fração baixa: o CLI resolve sozinho."
      : "Fração alta: boa parte precisa ser aberta no navegador antes.");
  }
  return SAIDA.OK;
}

// ---------------------------------------------------------------------------
// pje status / logout
// ---------------------------------------------------------------------------

async function cmdStatus(args, config) {
  console.log("Config:  " + CAMINHOS.config);
  console.log("  base ......... " + (config.base || "(não definida — rode `pje login`)"));
  console.log("  destino ...... " + path.resolve(args.destino || config.destino || "autos"));
  console.log("  concorrência . " + (config.concorrencia || 3));

  const s = resolverSessao({}, config);
  console.log("\nSessão:  " + descrever(s));
  if (s && s.cookie) {
    try {
      const cli = criarCliente(s);
      const viva = await cli.autenticado();
      console.log("  estado ....... " + (viva ? "VIVA" : "expirada — rode `pje login`"));
      if (viva) {
        const info = await cli.statusInfo().catch(() => null);
        if (info) console.log("  servidor ..... " + info.tribunal + " · " + info.instancia + " · v" + info.version);
      }
    } catch (e) {
      console.log("  estado ....... não deu para conferir: " + e.message);
    }
  }

  const destino = args.destino || config.destino || "autos";
  const achados = processosNoDestino(destino);
  console.log("\nProcessos em " + path.resolve(destino) + ": " + achados.length);
  for (const a of achados.slice(0, 30)) {
    let n = "?";
    try {
      const idx = JSON.parse(fs.readFileSync(path.join(destino, a.pasta, "indice.json"), "utf8"));
      n = (idx.pecas || []).length + " peças · " +
        new Date(idx.geradoEm).toLocaleDateString("pt-BR");
    } catch {
      /* índice ilegível: mostra o que dá */
    }
    console.log("  " + a.cnj + "  " + n);
  }
  if (achados.length > 30) console.log("  ... e mais " + (achados.length - 30));
  return SAIDA.OK;
}

function cmdLogout() {
  const s = apagarSessaoSalva();
  const p = apagarPerfil();
  console.log(s ? "Sessão apagada." : "Não havia sessão guardada.");
  console.log(p ? "Perfil do navegador apagado." : "Não havia perfil.");
  console.log("\nNo navegador, o login do PJe em si continua válido até você sair de lá.");
  return SAIDA.OK;
}

// ---------------------------------------------------------------------------

async function principal() {
  const bruto = process.argv.slice(2);
  const comando = bruto[0] && !bruto[0].startsWith("-") ? bruto.shift() : null;
  const args = lerArgs(bruto);
  const config = lerConfig();

  if (args.ajuda || args.help || args.h || comando === "ajuda" || !comando) {
    console.log(AJUDA);
    return comando ? SAIDA.OK : SAIDA.USO;
  }

  switch (comando) {
    case "login": return cmdLogin(args, config);
    case "baixar": return cmdBaixar(args, config);
    case "atualizar": return cmdBaixar(args, config, { todos: true });
    case "sondar": return cmdSondar(args, config);
    case "status": return cmdStatus(args, config);
    case "logout": return cmdLogout();
    default:
      console.log("Não conheço o comando `" + comando + "`.");
      console.log(AJUDA);
      return SAIDA.USO;
  }
}

// Só roda quando invocado direto. Importado (pelos testes), o módulo apenas
// expõe as funções — sem esta guarda, um `import` dispararia o CLI inteiro.
const invocadoDireto =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invocadoDireto) {
  principal()
    .then((c) => process.exit(c || 0))
    .catch((e) => {
      console.error("\nErro: " + (e && e.message ? e.message : e));
      process.exit(SAIDA.USO);
    });
}

export { lerArgs, lerListaCnj, PjeExport, SAIDA };
