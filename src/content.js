// Orquestra o painel: lista documentos, baixa peças marcadas, mantém a conversa
// e faz streaming da resposta do Claude (via Port com o service worker).
(function () {
  if (window.__pjeIaLoaded) return;
  window.__pjeIaLoaded = true;

  // SÓ no documento de topo. O guard acima é por CONTEXTO, e todo iframe é um
  // contexto novo — sem esta linha o content script se injetaria também dentro
  // dos iframes da página. Isso importa desde que `PJE.listarPelaGrid` passou a
  // abrir um iframe com a PRÓPRIA URL dos autos: lá dentro existe #divTimeLine,
  // então um painel inteiro (com observers, porta para o worker e requisição de
  // caps) seria montado num frame invisível a cada leitura da grid. Vale também
  // para os iframes do próprio PJe: o painel só faz sentido na janela de topo.
  if (window.top !== window.self) return;

  // O content script roda em QUALQUER página *.jus.br (matches do manifest),
  // mas a maioria não é uma tela de autos do PJe (login SSO, portais,
  // consultas públicas…). Todo o boot do painel vive em iniciar(), chamada
  // uma única vez quando a timeline de autos (#divTimeLine) existe — sem ela,
  // nada é injetado no DOM da página. O bootstrap fica no fim do arquivo.
  function iniciar() {

  // Tribunal do processo aberto, derivado da URL (pje1g.trf5.jus.br → trf5.jus.br).
  // Fica AQUI, no topo, e NÃO junto da lista de domínios lá embaixo: o system
  // prompt logo abaixo o consome, e um `const` declarado depois disso lançaria
  // "Cannot access before initialization" já na montagem — a zona morta temporal
  // que já derrubou o painel inteiro uma vez (ver CLAUDE.md, "Desenvolvimento").
  const TRIBUNAL_DO_PROCESSO = (() => {
    const raiz = location.hostname.split(".").slice(-3).join(".");
    return /\.jus\.br$/.test(raiz) ? raiz : null;
  })();

  // Trechos comuns do system prompt; a parte de CITAÇÕES varia por provedor:
  // a Anthropic gera citações estruturadas por página (citations API); o
  // Gemini não tem esse recurso — o modelo é instruído a citar a peça e a
  // página NO PRÓPRIO texto (caps.citacoesNativas === false).
  // A identificação da peça (nome + id) vive no trecho COMPARTILHADO porque é
  // requisito do produto nos dois provedores: o id é o número que abre o título
  // de cada peça e é por ele que o usuário reencontra a peça na timeline do PJe
  // (mesma convenção do SUFIXO_MAPA e do SUFIXO_MINUTA).
  const PROMPT_INICIO = [
    "Você é um assistente jurídico que analisa autos de processos do PJe.",
    "Responda sempre em português do Brasil.",
    "Baseie-se SOMENTE nos documentos anexados (peças selecionadas pelo usuário).",
    "Toda afirmação sobre os autos precisa ser rastreável até a peça de origem.",
    "Cada peça anexada tem um id — o número que abre o seu título (em",
    "'123456 - Contestação', o id é 123456) — e é por ele que o usuário reencontra",
    "a peça na linha do tempo do processo. NUNCA invente id, folha, data ou valor.",
    // Divergência entre peças é o DADO da análise processual, não ruído a ser
    // resolvido: o autor e o réu narram o mesmo fato de formas diferentes, e
    // escolher uma versão em silêncio esconde justamente o que está em disputa.
    "Quando duas peças divergirem sobre o mesmo fato, valor ou data, APONTE a",
    "divergência e dê a origem das duas versões — não escolha uma nem faça média.",
    // Sem isto o modelo narra na ordem em que leu as peças (que é a ordem da
    // seleção), e não na ordem em que os atos aconteceram.
    "Ao narrar fatos ou atos processuais, siga a ordem CRONOLÓGICA e informe a",
    "data de cada um quando ela constar da peça.",
  ];
  const PROMPT_FIM = [
    "Seja objetivo e técnico. Comece pela resposta: nada de preâmbulo do tipo 'Vou",
    "analisar as peças' ou 'Com base nos documentos fornecidos'.",
    "Se a informação não estiver nos documentos selecionados,",
    "diga explicitamente que não consta nas peças fornecidas — não invente.",
    // O inventário das peças NÃO marcadas viaja no texto do turno (ver
    // inventarioNaoMarcadas). Sem esta regra o modelo trataria a lista como
    // conteúdo disponível e passaria a afirmar coisas sobre peças que não leu.
    "Você pode receber, ao fim da mensagem, a lista das peças do processo que NÃO",
    "foram anexadas — apenas id e título. NUNCA afirme nada sobre o conteúdo",
    "delas: você não as leu. Use-a só para uma coisa — quando a resposta não",
    "estiver nas peças anexadas e o título de uma não anexada indicar que ela",
    "provavelmente a contém, diga isso e informe o id para o usuário marcá-la e",
    "perguntar de novo. Distinga sempre 'não consta das peças anexadas' de 'não",
    "existe no processo'.",
    "Atenção a peças de mero encaminhamento: no PJe é comum a petição conter apenas",
    "uma remissão como 'Em anexo' ou 'Segue anexo', com o conteúdo real nos documentos",
    "anexos protocolados junto dela. Nesse caso, diga claramente que a peça é só um",
    "encaminhamento e oriente o usuário a marcar também os anexos correspondentes",
    "(ex.: as peças 'Documento de Comprovação' logo abaixo dela na lista).",
    "Use markdown — títulos curtos, listas e tabelas (ex.: linha do tempo dos atos,",
    "partes, pedidos) — quando a resposta tiver mais de um eixo; para uma pergunta",
    "pontual, responda em uma ou duas frases corridas, sem estruturar.",
  ];
  // Ordem de prioridade das fontes na busca web. Vive em trecho PRÓPRIO porque os
  // DOIS system prompts precisam dele: até aqui a instrução de busca existia só no
  // caminho de citação textual (Gemini/OpenAI) e o caminho Anthropic não tinha
  // NENHUMA — dependia só de `allowed_domains`, que é binário (dentro/fora) e não
  // sabe dizer "STF e STJ primeiro". Prioridade é RANKING, e nenhuma das três APIs
  // tem parâmetro de ranking: só o prompt expressa isso, nos três provedores.
  const PROMPT_BUSCA = [
    "Se usar a busca na web, siga esta ordem de prioridade das fontes:",
    "(1) STF (stf.jus.br) e STJ (stj.jus.br) — súmulas, repetitivos e precedentes",
    "vinculantes têm precedência sobre qualquer outra fonte;",
    TRIBUNAL_DO_PROCESSO
      ? "(2) o tribunal deste processo (" +
        TRIBUNAL_DO_PROCESSO +
        ") — a jurisprudência local aplicável ao caso;"
      : "(2) o tribunal do próprio processo, quando identificável;",
    "(3) as demais fontes (TST, CNJ, repositórios de jurisprudência) apenas quando",
    "as anteriores não responderem — e, nesse caso, diga que a resposta não veio de",
    "fonte superior. Para texto de lei, use planalto.gov.br.",
    "Cite a fonte de cada informação obtida na web.",
  ];
  // DESTAQUES — o que o usuário precisa bater o olho e ver.
  //
  // A observação que muda a leitura do processo ("esta peça é só encaminhamento,
  // a defesa está na 205649798"; "a peça decisiva não foi anexada"; "não deu
  // para confirmar este valor") chegava como mais um parágrafo no meio de uma
  // resposta longa. Quem lê autos lê por VARREDURA: ressalva sem peso visual é
  // ressalva não lida — e aqui o custo disso é decidir com base errada.
  //
  // A sintaxe é a dos "alerts" do GitHub (`> [!ALERTA]`) por ADERÊNCIA, não por
  // gosto: os modelos a conhecem muito bem do treino, e uma marcação inventada
  // aqui seria obedecida pela metade. Ela é uma citação markdown legítima, então
  // um provedor que ignore a instrução degrada para blockquote em vez de vazar
  // marcação estranha. Quem desenha o bloco colorido é `lerCallout` em panel.js
  // — os rótulos DAQUI e os aceitos LÁ precisam continuar batendo.
  //
  // Vai nos DOIS system prompts (citação nativa e textual). NÃO vai na minuta
  // nem no mapa: os dois têm sufixo próprio, e um "[!ALERTA]" no meio de uma
  // sentença seria um defeito, não um destaque.
  const PROMPT_DESTAQUES = [
    "Quando houver algo que o usuário PRECISE notar de imediato, escreva um aviso em",
    "bloco: uma citação markdown cuja primeira linha é só o rótulo entre colchetes e",
    "cujo texto vem nas linhas seguintes, todas começando com '>'. Assim:",
    "\n> [!ATENÇÃO]\n> A peça 205649792 - Contestação é apenas encaminhamento ('SEGUE" +
      " ANEXO'); o conteúdo da defesa está na peça 205649798.\n",
    "Use [!ALERTA] para o que pode levar a erro de análise ou de decisão: divergência",
    "entre peças sobre fato, valor ou data; prazo, prescrição ou preclusão em jogo; peça",
    "essencial que NÃO foi anexada; documento que contradiz a conclusão.",
    "Use [!ATENÇÃO] para ressalvas sobre a BASE da resposta: peça que é só",
    "encaminhamento; documento ilegível ou digitalizado sem texto; conteúdo cortado por",
    "tamanho; informação que você não conseguiu confirmar na peça.",
    "Use [!NOTA] para observação útil que não é risco.",
    "Todo aviso nomeia a peça e o id de que trata. No máximo TRÊS avisos por resposta e",
    "nunca para o conteúdo principal — um destaque que aparece em tudo deixa de",
    "destacar. Não use esses blocos dentro de tabelas.",
  ];
  const SYSTEM_PROMPT = PROMPT_INICIO.concat(
    [
      "As citações precisas de trechos são geradas automaticamente pelo sistema e já",
      "mostram peça, id e folha ao usuário — apoie cada afirmação relevante no trecho",
      "correspondente e NÃO repita id nem folha no corpo do texto.",
      "Peças digitalizadas sem camada de texto podem não permitir citação automática;",
      "só nesse caso escreva a referência no próprio texto (ex.: 'na Contestação, id",
      "123456') e avise o usuário de que aquela peça não é citável.",
    ],
    PROMPT_BUSCA,
    PROMPT_FIM,
    PROMPT_DESTAQUES
  ).join(" ");
  const SYSTEM_PROMPT_CIT_TEXTUAL = PROMPT_INICIO.concat(
    [
      "Ao afirmar fatos relevantes, cite a peça, o id E a página no PRÓPRIO texto,",
      "no formato '(Contestação, id 123456, fl. 12)' — indique sempre a página do",
      "PDF de origem quando conseguir identificá-la; sem folha identificável, use",
      "'(Contestação, id 123456)'.",
    ],
    PROMPT_BUSCA,
    PROMPT_FIM,
    PROMPT_DESTAQUES
  ).join(" ");
  // Instruções personalizadas do usuário (persona/preferências — magistrado,
  // assessor, advogado…), definidas nas opções. Entram DEPOIS das regras-base
  // com um rótulo que preserva a autoridade delas (não inventar, só usar as
  // peças). Vazio (default) = prompt byte a byte idêntico ao de sempre — quem
  // não usa o recurso não muda NADA, em nenhum provedor. Custo aceito: editar
  // no meio de uma conversa invalida o cache de prefixo (mesma regra da troca
  // de modelo/busca).
  let customPrompt = "";

  // O system prompt do turno depende do modelo ATUAL (caps) e das instruções
  // personalizadas — usado no envio (chat, minuta e mapa) E no count_tokens, para o
  // pré-voo medir o mesmo request que vai de fato. Anthropic recebe como
  // `system`; Gemini como `system_instruction` (o worker repassa verbatim).
  // Contexto do caso que o modelo não tem como deduzir dos PDFs com segurança:
  // o número CNJ (sem ele o mapa mental titulava com número inventado) e a data
  // de hoje (prazos, prescrição e "situação atual" sairiam calculados contra o
  // conhecimento congelado do modelo). Custo de cache desprezível: o cache é
  // ephemeral de 5 min, então a virada diária nunca cai dentro de uma janela viva.
  //
  // Além do CNJ, vai a FICHA do processo: classe, assunto, órgão julgador e as
  // partes de cada polo. São ~80 tokens que o modelo não consegue deduzir com
  // segurança dos PDFs — nem sempre a peça marcada é a inicial —, e sem eles
  // ele confunde os polos (chama o réu de autor), erra o rito e não sabe a
  // competência. `PJE.lerCabecalhoProcesso` já existia; até agora só a
  // exportação em .zip a usava.
  //
  // Lida UMA vez por sessão: a ficha não muda enquanto a página está aberta, e
  // `systemPromptAtual()` é chamado duas vezes por turno (count_tokens + envio).
  const CAMPOS_FICHA = [
    "classe judicial", "classe", "assunto", "orgao julgador", "órgão julgador",
    "jurisdicao", "jurisdição", "competencia", "competência",
  ];
  let fichaCache; // undefined = ainda não lida; null = não há ficha nesta página
  function resumoFicha() {
    if (fichaCache === undefined) {
      try {
        fichaCache = PJE.lerCabecalhoProcesso();
      } catch {
        fichaCache = null; // best-effort: sem ficha, o system segue como antes
      }
    }
    if (!fichaCache) return "";
    const partes = [];
    const campos = fichaCache.campos || {};
    // casa sem depender do acento/caixa exatos do rótulo, que varia por tribunal
    for (const [rotulo, valor] of Object.entries(campos)) {
      const r = rotulo.toLowerCase().trim();
      if (CAMPOS_FICHA.some((c) => r === c || r.startsWith(c))) {
        partes.push(rotulo + ": " + valor);
      }
    }
    const polo = (lista, nome) => {
      if (!lista || !lista.length) return null;
      // só os titulares, sem os representantes: a lista de advogados dobraria o
      // tamanho da ficha sem ajudar a entender o caso
      const nomes = lista.slice(0, 6).map((p) => p.nome).filter(Boolean);
      if (!nomes.length) return null;
      return (
        nome + ": " + nomes.join("; ") +
        (lista.length > nomes.length ? " e mais " + (lista.length - nomes.length) : "")
      );
    };
    const a = polo(fichaCache.poloAtivo, "Polo ativo");
    const p = polo(fichaCache.poloPassivo, "Polo passivo");
    if (a) partes.push(a);
    if (p) partes.push(p);
    if (!partes.length) return "";
    return (
      " Ficha do processo, lida da tela do PJe (use para situar o caso; o teor" +
      " vem SEMPRE das peças anexadas): " + partes.join(". ") + "."
    );
  }

  function contextoDoProcesso() {
    let s = "";
    try {
      const num = PJE.getNumeroProcesso();
      if (num) s += " Processo em análise: " + num + ".";
    } catch {
      /* página sem número identificável — segue sem ele */
    }
    return s + resumoFicha() + " Hoje é " + new Date().toLocaleDateString("pt-BR") + ".";
  }

  function systemPromptAtual() {
    const base =
      (modelCaps && modelCaps.citacoesNativas === false
        ? SYSTEM_PROMPT_CIT_TEXTUAL
        : SYSTEM_PROMPT) + contextoDoProcesso();
    if (!customPrompt) return base;
    return (
      base +
      " Instruções adicionais definidas pelo usuário desta extensão (perfil e " +
      "preferências dele — siga-as no que não conflitar com as regras acima): " +
      customPrompt
    );
  }

  // Limite de payload do FALLBACK base64 (quando o upload à Files API falha):
  // a API da Anthropic aceita 32 MB por requisição (teto de 24 MB com folga);
  // a do Gemini aceita ~20 MB (teto de 15 MB). base64 infla ~33%. No caminho
  // normal as peças são referenciadas por file_id/uri e o teto não se aplica.
  const MAX_TOTAL_B64_CHARS = 24 * 1024 * 1024;
  const MAX_TOTAL_B64_CHARS_GEMINI = 15 * 1024 * 1024;
  // OpenAI aceita 50 MB (arquivo e somados por request); 40 MB de base64 (~30 MB
  // decodificados) fica com folga confortável sob o limite.
  const MAX_TOTAL_B64_CHARS_OPENAI = 40 * 1024 * 1024;

  // Teto do bloco de TEXTO de uma peça (HTML do editor, RTF de processo
  // migrado) — cerca de 30 páginas. Sentença com transcrição de depoimentos e
  // relatório longo passam disso.
  //
  // O corte em si é aceitável; cortar EM SILÊNCIO não é. O modelo veria metade
  // da peça e responderia "não consta" sobre o que estava na outra metade — e
  // essa resposta é indistinguível de uma correta. Por isso o texto cortado
  // leva um aviso explícito para o modelo (MARCA_TRUNCADO) e a peça é listada
  // para o usuário no fim do turno.
  const MAX_CHARS_TEXTO = 60000;
  const MARCA_TRUNCADO =
    "\n\n[ATENÇÃO: esta peça é longa e foi cortada aqui, no limite de " +
    "60.000 caracteres. O restante do conteúdo dela NÃO está nesta análise — " +
    "não conclua que algo 'não consta' desta peça; diga que ela entrou " +
    "parcialmente e indique até onde você conseguiu ler.]";

  // Betas enviadas em todos os requests de chat (documentos por file_id).
  const BETAS_CHAT = ["files-api-2025-04-14"];

  // Fontes confiáveis da busca, em TRÊS DEGRAUS de autoridade. A distinção não é
  // cosmética: num parecer, "o STJ decidiu" e "um blog jurídico noticiou" não têm
  // o mesmo peso, e até aqui a extensão tratava as dez fontes como equivalentes.
  //
  // Os degraus servem a dois consumidores diferentes:
  //  - `DOMINIOS_JURIDICOS` (a UNIÃO) é o que vai em `allowed_domains`: a API só
  //    entende dentro/fora, então o filtro continua binário e nada é excluído;
  //  - a ORDEM vai por PROMPT_BUSCA (nos três provedores) e o NÍVEL de cada fonte
  //    citada vira rótulo na bolha (`nivelFonte`), para o usuário ver de onde veio.
  const FONTES_SUPERIORES = ["stf.jus.br", "stj.jus.br"];
  // Multi-PJe: o tribunal do processo entra como 2º degrau. Vindo da URL, cobre
  // qualquer tribunal (pje1g.trf5.jus.br → trf5.jus.br) sem lista fixa — por isso
  // "tjce.jus.br" deixou de ser hardcoded: num processo do TRF5, jurisprudência do
  // TJCE é ruído, e num processo do TJCE ela entra por aqui de qualquer forma.
  const FONTES_TRIBUNAL = TRIBUNAL_DO_PROCESSO ? [TRIBUNAL_DO_PROCESSO] : [];
  const FONTES_DEMAIS = [
    "tst.jus.br",
    "cnj.jus.br",
    "planalto.gov.br", // legislação, não jurisprudência
    "lexml.gov.br",
    "jusbrasil.com.br",
    "conjur.com.br",
    "migalhas.com.br",
  ];
  const DOMINIOS_JURIDICOS = [
    ...new Set([...FONTES_SUPERIORES, ...FONTES_TRIBUNAL, ...FONTES_DEMAIS]),
  ];

  // Nível de uma fonte pelo host, para o rótulo da citação. Sufixo além de
  // igualdade porque a busca devolve subdomínio (noticias.stf.jus.br,
  // processo.stj.jus.br — ambos vistos no smoke test real).
  function nivelFonte(host) {
    const casa = (d) => host === d || host.endsWith("." + d);
    if (FONTES_SUPERIORES.some(casa)) return "superior";
    if (FONTES_TRIBUNAL.some(casa)) return "tribunal";
    return "outra";
  }

  // Ferramentas de busca web na versão suportada pelo modelo atual.
  // Gemini: google_search não aceita allowed_domains — ali a priorização de
  // fontes depende SÓ da instrução do PROMPT_BUSCA (garantia mole). Nos outros
  // dois a allowlist é aplicada no servidor (garantia dura); o PROMPT_BUSCA vai
  // junto assim mesmo, porque é ele que expressa a ORDEM entre os três degraus.
  function toolsBusca() {
    if (!modelCaps) return [];
    if (modelCaps.provider === "gemini") return [{ type: "google_search" }];
    // OpenAI: web_search embutida da Responses API (o tipo antigo
    // "web_search_preview" é legado e não aceita os controles novos). Aqui a
    // restrição de domínios EXISTE — vai em `filters.allowed_domains` (teto de
    // 100 domínios, nomes sem protocolo) —, ao contrário do Gemini, que não
    // tem o recurso. Sem ela a busca de jurisprudência varreria a web inteira
    // e devolveria blog no lugar de fonte oficial: num uso jurídico isso não é
    // detalhe, e deixaria o GPT pior que o Claude sem motivo técnico.
    if (modelCaps.provider === "openai") {
      return [{ type: "web_search", filters: { allowed_domains: DOMINIOS_JURIDICOS } }];
    }
    return [
      {
        type: modelCaps.webSearch,
        name: "web_search",
        max_uses: 5,
        allowed_domains: DOMINIOS_JURIDICOS,
      },
      {
        type: modelCaps.webFetch,
        name: "web_fetch",
        max_uses: 3,
        allowed_domains: DOMINIOS_JURIDICOS,
      },
    ];
  }

  const docsCache = new Map(); // id -> {kind:"pdf",b64,size,pages,fileId?} | {kind:"text",text}

  // ANEXOS DO INPUT — arquivos que o usuário anexa na própria caixa de mensagem
  // (PDF, TXT, MD), para conversar sobre eles junto das peças do processo, ou
  // sozinhos. Vivem SÓ na sessão, de propósito: ao contrário das peças, não têm
  // origem no PJe para re-baixar, e gravar bytes de arquivo do usuário no disco
  // é justamente o que a extensão evita (a mesma regra do b64 das peças). Cada
  // anexo ganha um id sintético "anexo:<n>" e uma entrada no mesmo FORMATO do
  // `docsCache` ({kind, fmt, b64|text, pages…}) — é o que deixa `montarBlocos` e
  // as contas de página/token tratarem anexo e peça pelo mesmo caminho, via
  // `entradaDoc`. NUNCA entram no `docsCache` nem na fila de gravação
  // (`pecasSujas`): o que os distingue de uma peça é só esta Map.
  const anexos = new Map(); // "anexo:<n>" -> {id, nome, kind, fmt, b64|text, size, pages?, mime?, w?, h?, fileId?, fileProvider?, fileExp?, chaveHash?}
  let anexoSeq = 0; // gera os ids sintéticos (Date.now/Math.random são proibidos aqui — ver CLAUDE.md)
  // Anexos ainda NÃO enviados (delta deste turno). Ordenados pela ordem em que o
  // usuário os soltou; viram parte do histórico ao serem enviados, como as peças.
  const anexosPendentes = [];

  // A entrada de conteúdo de um id, seja peça (docsCache) ou anexo. Ponto único
  // para `montarBlocos`, `paginasDe` e afins não precisarem saber a origem.
  function entradaDoc(id) {
    return docsCache.get(id) || anexos.get(id);
  }

  let conversation = []; // [{role, content}]
  let custoConversaUsd = 0; // soma dos custos estimados dos turnos (US$)

  // Registra o custo de um turno concluído (chat, minuta ou mapa) no medidor do
  // rodapé. O worker calcula o valor pela tabela de preços do modelo; a API
  // devolve só as contagens de tokens (usage).
  function registrarCusto(fim) {
    if (!fim || fim.custoUsd == null) return;
    custoConversaUsd += fim.custoUsd;
    panel.setCusto({
      turnoUsd: fim.custoUsd,
      conversaUsd: custoConversaUsd,
      usage: fim.usage,
      provedorNome:
        modelCaps && modelCaps.provider === "gemini"
          ? "Google"
          : modelCaps && modelCaps.provider === "openai"
            ? "OpenAI"
            : "Anthropic",
    });
  }
  // Peças cujos blocos document JÁ estão no histórico desta conversa. Anexamos
  // só o DELTA a cada turno: reanexar tudo duplicaria as páginas/tokens no
  // request (o histórico não pode ser editado) e estourava os limites já no
  // segundo envio. Peça desmarcada permanece no histórico até "Nova conversa".
  let pecasNaConversa = new Set();
  // A busca web foi usada nesta conversa: o histórico contém blocos de
  // ferramenta, então as tools continuam declaradas nos turnos seguintes
  // (mesmo com o toggle desligado) — remover trocaria o conjunto de tools,
  // invalidando o cache de prefixo e arriscando rejeição do histórico.
  let buscaNaConversa = false;
  // Provedor (anthropic|gemini|openai) do PRIMEIRO turno da conversa: o
  // histórico de um provedor não é traduzível para o outro (thinking assinado
  // da Anthropic vs. thought signatures do Gemini vs. reasoning criptografado
  // da OpenAI) — trocar no meio exige "Nova conversa".
  let conversaProvider = null;
  let alertaTrocaLigado = false; // o alerta atual é o de troca de provedor
  let busy = false;
  // Estimativa dinâmica de contexto (dispara quando a seleção muda): timer de
  // debounce + número de sequência para descartar respostas atrasadas +
  // chave da última medição (refreshs da timeline re-disparam syncSelection
  // sem mudança real — não vale re-medir).
  let estTimer = null;
  let estSeq = 0;
  let ultimaChaveEst = "";
  // Total de tokens do último request FÍSICO, medido pelo usage da API (exato e
  // de graça). Base para dispensar o count_tokens do turno seguinte quando a
  // folga sobre a janela é larga — ver podePularPreVoo.
  let ultimoTotalExato = 0;

  // Texto do alerta persistente de contexto cheio (barra vermelha no rodapé).
  const ALERTA_CTX_CHEIO =
    "O contexto da IA encheu: a conversa e as peças ocupam quase todo o limite do modelo. " +
    "Novas mensagens não serão aceitas — desmarque peças na lista para liberar espaço " +
    "(elas saem do contexto na hora) ou comece uma nova conversa.";
  const ALERTA_TROCA_PROVEDOR =
    "Você trocou de provedor de IA no meio da conversa (entre Claude, Gemini e OpenAI) — o " +
    "histórico de um não é compatível com o outro (raciocínio assinado pelo provedor). Clique " +
    "em ⟲ Nova conversa para usar o novo modelo, ou volte ao modelo anterior nas opções.";

  const panel = PjePanel.mount();

  // ATENÇÃO ao acrescentar estado lido por callback do painel: este arquivo
  // REGISTRA os callbacks muito antes de declarar as variáveis que eles leem e
  // chama `refresh()` no meio — que roda `panel.setDocs` de forma SÍNCRONA. Um
  // `const`/`let` do escopo deste IIFE declarado DEPOIS dessa chamada e lido por
  // um desses callbacks cai na ZONA MORTA TEMPORAL: lança "Cannot access before
  // initialization" dentro do setDocs, que aborta no meio e derruba o resto do
  // content.js junto. Uma linha de posição errada já apagou metade do painel.
  // Estado assim vive AQUI, junto do `panel`.

  // ---------------------------------------------------------------------------
  // MEMÓRIA DE CASO — estado. Mora aqui pela regra do parágrafo acima: o
  // `onSelectionChange` (registrado ~1.400 linhas abaixo) chama `agendarSalvar`,
  // e o `refresh()` do boot dispara esse callback de forma SÍNCRONA.
  // ---------------------------------------------------------------------------
  const memoriaDisponivel = typeof CASO !== "undefined";
  // Identidade do processo (host|grau|idProcesso). null = página sem idProcesso:
  // a memória fica desligada nesta aba em vez de inventar uma chave que
  // agruparia processos distintos.
  let casoChave = null;
  // TRAVA DE GRAVAÇÃO, e o bug nº 1 desta rodada mora aqui: o `refresh()` do
  // boot roda setDocs → syncSelection → selChangeCb ANTES de qualquer leitura,
  // com a lista de peças ainda vazia. Sem esta trava, a primeira gravação
  // salvaria `selecao: []` por cima da memória do processo — a extensão
  // apagaria sozinha o que existe para lembrar.
  let casoCarregado = false;
  let salvarTimer = null;
  // Instante do primeiro pedido de gravação da rodada atual de debounce. O
  // debounce agrupa, mas NÃO pode adiar para sempre: durante um prefetch cada
  // peça que baixa pede uma gravação, e sem teto o timer seria empurrado peça
  // após peça — num processo de 200 a gravação só aconteceria no fim, e fechar
  // a aba no meio perderia justamente o download que a memória existe para
  // preservar. Passado o teto, grava e recomeça a contar.
  let salvarDesde = 0;
  // Teto de adiamento do debounce. Fica AQUI, antes de `agendarSalvar`, e não
  // logo abaixo dela: `const` tem zona morta temporal, e `agendarSalvar` é
  // chamada pelo `selChangeCb` que o `refresh()` do boot dispara de forma
  // síncrona. Hoje a guarda de `casoChave` retorna antes de a constante ser
  // lida — mas depender disso é exatamente a armadilha que já derrubou o painel
  // inteiro uma vez.
  const TETO_ADIAR = 5000;
  // Ids cujo registro mudou desde a última gravação. Gravar a lista inteira a
  // cada peça baixada reescreveria centenas de registros por turno.
  const pecasSujas = new Set();
  // Desliga a gravação nesta sessão depois que o disco encheu mesmo com a poda
  // de emergência: insistir só gastaria RPC para falhar de novo.
  let memoriaMorta = false;
  // Impressão digital da chave da API em uso (vem do worker no `caps`). É ela
  // que invalida um fileId gravado quando o usuário troca de conta.
  let chaveHashAtual = null;
  // Peças que a última montagem de blocos deixou de fora por não ter conteúdo
  // anexável — preenchida por `montarBlocos`, relatada pelo envio.
  let semConteudo = [];

  // Seleção EFETIVA: os checkboxes marcados mais as peças restauradas da
  // memória cuja row a timeline lazy do PJe ainda não criou. Ponto único, usado
  // pelo filtro do histórico e pela gravação — os dois precisam do mesmo
  // conjunto, e divergir aqui faria a peça sair do request numa sessão e do
  // disco na seguinte. Degrada para os checkboxes se o painel for antigo.
  function selecaoEfetiva() {
    return panel.selecaoParaMemoria ? panel.selecaoParaMemoria() : panel.getSelected();
  }
  // Conversa ABERTA nesta aba e o carimbo do retrato dela. O carimbo vai em
  // toda gravação para o banco detectar que outra aba escreveu na mesma
  // conversa no meio-tempo — e ramificar em vez de sobrescrever.
  let convAtual = null;
  let convVersao = 0;
  let avisouConflito = false;
  // Resumos das conversas deste processo, para a lista do painel.
  let conversasDoCaso = [];

  // Extrai de uma entrada do docsCache só o que vai ao disco. O `b64` fica de
  // fora POR CONSTRUÇÃO — são os autos inteiros, e o que evita o re-download é o
  // `fileId`, não os bytes (montarBlocos prefere o fileId e nem toca no b64).
  function pecaParaBanco(id) {
    const d = docsCache.get(id);
    if (!d) return null;
    const p = {
      id: String(id),
      kind: d.kind,
      fmt: d.fmt,
      size: d.size,
      baixadoEm: Date.now(),
    };
    // O título só entra quando a peça está MESMO na lista. `metaDe` tem
    // fallback (`"Peça 123"`) para nunca devolver undefined, e usá-lo aqui era
    // um apagador silencioso: a timeline do PJe é lazy, então numa sessão em
    // que o usuário não rolou até a peça o `docsIndex` não a tem — e a
    // gravação trocaria "184100639 - Contestação" por "Peça 184100639" no
    // disco, para sempre. Omitir o campo faz a mesclagem do banco preservar o
    // título bom.
    const m = docsIndex.get(id);
    if (m && m.titulo) p.titulo = m.titulo;
    if (m && m.tipo) p.tipo = m.tipo;
    if (m && m.juntadoEm) p.juntadoEm = m.juntadoEm;
    if (m && m.juntadoPor) p.juntadoPor = m.juntadoPor;
    if (d.kind === "pdf") p.pages = d.pages;
    if (d.kind === "img") {
      p.mime = d.mime;
      p.w = d.w;
      p.h = d.h;
    }
    // Só peça de TEXTO guarda conteúdo: nela o texto É o que vai ao modelo, e
    // guardá-lo dispensa o download por completo (não depende de fileId nenhum).
    if (d.kind === "text" && d.text) p.text = d.text;
    if (d.fileId) {
      p.fileId = d.fileId;
      p.fileProvider = d.fileProvider || "anthropic";
      if (d.fileExp) p.fileExp = d.fileExp;
      if (d.chaveHash) p.chaveHash = d.chaveHash;
    }
    return p;
  }

  // Monta o registro do caso a partir do estado vivo. Recalcula a chave e
  // ABORTA se ela mudou: o PJe novo é uma SPA e troca de autos sem recarregar a
  // página — gravar aqui escreveria a conversa de um processo no registro de
  // outro, que é pior do que não gravar nada.
  function snapshotCaso() {
    if (PJE.chaveDoCaso() !== casoChave) return null;
    return {
      cnj: PJE.getNumeroProcesso() || null,
      host: location.hostname,
      grau: casoChave.split("|")[1] || null,
      idProcesso: PJE.getIdProcesso() || null,
      versaoExt: (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || null,
    };
  }

  // O que pertence a UMA conversa (e não ao processo). Separado do caso porque
  // agora há várias por processo: o que muda a cada turno é isto, e reescrever
  // o caso inteiro junto seria trabalho à toa.
  function snapshotConversa() {
    return {
      conversation,
      pecasNaConversa: [...pecasNaConversa],
      transcript: panel.lerTranscript ? panel.lerTranscript() : [],
      // `selecaoEfetiva` e não `getSelected`: inclui as peças restauradas que
      // ainda esperam a timeline lazy do PJe carregar as rows delas.
      selecao: selecaoEfetiva(),
      custoConversaUsd,
      conversaProvider,
      buscaNaConversa,
      ultimoTotalExato,
    };
  }

  // Há o que gravar nesta conversa? O critério é PRODUTO na tela, e ele tem duas
  // metades, cada uma corrigindo um erro oposto:
  //
  // - `conversation` sozinho NÃO serve: minuta, mapa mental e "escolher com IA"
  //   são requests ISOLADOS e, por decisão de projeto, não entram nele. Medir
  //   por ele fazia uma sessão inteira de minutas e mapas nunca virar conversa
  //   no disco — a tela com meia dúzia de cards, o banco vazio, e fechar a aba
  //   apagava tudo sem aviso. Foi o bug que abriu esta rodada.
  // - O transcript INTEIRO também não serve: quando um turno falha, o histórico
  //   é desfeito (`conversation.pop()`) e a bolha do assistente é removida, mas
  //   a pergunta do usuário fica na tela. Gravar ali encheria a lista de
  //   conversas com perguntas que nunca foram respondidas.
  //
  // Sobra o certo: houve resposta — uma entrada de `assistant`, que é o que a
  // minuta e o mapa deixam — ou já existe histórico de API.
  function temProduto(transcript) {
    if (conversation.length) return true;
    return (transcript || []).some((t) => t && t.role === "assistant" && t.text);
  }

  // Grava agora. Chamada nos `finally` dos turnos — o fim de um turno é o
  // momento mais valioso para persistir, e é também quando `busy` acabou de
  // cair. NUNCA rejeita: a memória de caso é comodidade, e um
  // `unhandledrejection` aqui derrubaria o turno que ela deveria proteger.
  // Gravações são SERIALIZADAS numa fila. Sem isto, duas chamadas concorrentes
  // (o `finally` de um turno e o debounce da seleção, por exemplo) leem
  // `convAtual` ainda `null` — a primeira ainda não respondeu — e cada uma
  // MANDA CRIAR uma conversa. O sintoma na tela é exatamente o relatado: uma
  // pergunta vira duas conversas idênticas na lista.
  let filaSalvar = Promise.resolve();
  function salvarCasoAgora() {
    clearTimeout(salvarTimer);
    salvarDesde = 0;
    if (!memoriaDisponivel || !casoChave || !casoCarregado || memoriaMorta) {
      return Promise.resolve();
    }
    // `.catch` na CAUDA da fila, e não em volta: um erro numa gravação não pode
    // envenenar a promessa que as próximas encadeiam.
    filaSalvar = filaSalvar.then(gravarCasoEConversa, gravarCasoEConversa);
    return filaSalvar;
  }

  async function gravarCasoEConversa() {
    if (!memoriaDisponivel || !casoChave || !casoCarregado || memoriaMorta) return;
    try {
      const patch = snapshotCaso();
      if (!patch) return; // trocou de processo no meio (SPA)
      if (pecasSujas.size) {
        const ids = [...pecasSujas];
        const lote = ids.map(pecaParaBanco).filter(Boolean);
        // Limpa ANTES de gravar (para uma peça que mude no meio do await entrar
        // na próxima rodada), mas DEVOLVE os ids se a gravação falhar — senão
        // uma falha transitória do worker faria a peça baixada nunca chegar ao
        // disco, e o download seria repetido na sessão seguinte.
        pecasSujas.clear();
        try {
          await CASO.pecas(casoChave, lote);
        } catch (e) {
          for (const id of ids) pecasSujas.add(id);
          throw e;
        }
      }
      const r = await CASO.salvar(casoChave, patch);
      if (r && r.cheio) {
        memoriaMorta = true;
        console.log("[PJe IA] memória: DESLIGADA nesta sessão (disco cheio)");
        return;
      }
      // A conversa só é gravada quando existe: uma sessão em que o usuário só
      // marcou peças e não perguntou nada não cria conversa vazia na lista.
      //
      // O critério é o TRANSCRIPT, nunca `conversation` sozinho — e essa
      // distinção foi um bug de perda de trabalho. `conversation` é o histórico
      // que vai à API; minuta, mapa mental e "escolher com IA" são requests
      // ISOLADOS e, por decisão de projeto, não entram nele. Medir por ele
      // fazia uma sessão inteira de minutas e mapas nunca virar conversa no
      // disco: a tela com meia dúzia de cards, o banco vazio, e fechar a aba
      // apagava tudo sem aviso. O que o usuário reconhece como "a conversa" é
      // o que está na tela, e é o transcript que guarda isso.
      const snap = snapshotConversa();
      if (!temProduto(snap.transcript)) return;
      const c = await CASO.salvarConversa(casoChave, convAtual, snap, convVersao);
      if (!c || !c.convId) {
        // Silêncio aqui era o pior modo de falha do recurso: o worker pode não
        // responder (morto, contexto órfão, mensagem grande demais) e o
        // usuário seguiria trabalhando achando que está guardado.
        console.log(
          "[PJe IA] memória: a conversa NÃO foi gravada — o serviço da extensão não respondeu"
        );
        return;
      }
      convAtual = c.convId;
      // O carimbo desta gravação vira a base da próxima: sem atualizá-lo, a
      // segunda gravação desta mesma aba pareceria vir de um retrato velho e
      // seria tratada como conflito consigo mesma.
      convVersao = c.atualizadoEm || 0;
      if (c.ramificou && !avisouConflito) {
        // Outra aba estava na MESMA conversa e gravou antes. Em vez de perder
        // um dos dois trabalhos, o banco criou um ramo — e este passa a ser o
        // desta aba. Avisa UMA vez: repetir a cada gravação viraria ruído.
        avisouConflito = true;
        panel.setStatus(
          "Este processo está aberto em outra aba. Para não perder nada, o que você " +
            "fizer aqui virou uma conversa separada — ela aparece na lista de conversas."
        );
        atualizarListaConversas();
      }
    } catch (e) {
      // `console.log`, e não `debug`: o nível Verbose do DevTools vem
      // DESLIGADO por padrão, então um `debug` aqui é instrumentação que
      // ninguém vê — inútil justamente quando é preciso diagnosticar.
      console.log("[PJe IA] memória: FALHOU ao gravar —", e && e.message);
    }
  }

  // Gravação com debounce, para os gatilhos de alta frequência (cada clique na
  // seleção, cada peça que termina de baixar).
  function agendarSalvar() {
    if (!memoriaDisponivel || !casoChave || !casoCarregado || memoriaMorta) return;
    // Durante um turno ou uma exportação, quem grava é o `finally` de cada um:
    // o estado no meio do caminho é parcial (peças anexadas sem a resposta que
    // as consumiu) e a gravação disputaria o worker com o próprio streaming.
    if (busy || exportando) return;
    const agora = Date.now();
    if (!salvarDesde) salvarDesde = agora;
    // Teto de adiamento: passou de TETO_ADIAR sendo empurrado, grava já.
    if (agora - salvarDesde >= TETO_ADIAR) return void salvarCasoAgora();
    clearTimeout(salvarTimer);
    salvarTimer = setTimeout(() => {
      salvarCasoAgora();
    }, 1200);
  }

  // ---------------------------------------------------------------------------
  // Contexto órfão: quando a extensão é atualizada/recarregada em
  // chrome://extensions, o content script antigo continua vivo na aba, mas
  // QUALQUER chamada a chrome.runtime/chrome.storage passa a lançar
  // "Extension context invalidated" (erro não capturável no console do
  // usuário). Todas as chamadas passam por estas guardas: silenciam o erro
  // e avisam UMA vez para recarregar a aba (F5 injeta o script novo).
  // ---------------------------------------------------------------------------
  const MSG_CTX_PERDIDO =
    "A extensão foi atualizada ou recarregada. Recarregue esta página (F5) para voltar a usar o assistente.";
  let contextoPerdido = false;
  function avisarContextoPerdido() {
    if (contextoPerdido) return;
    contextoPerdido = true;
    try {
      panel.setAlerta(MSG_CTX_PERDIDO);
      panel.lockInput(true);
    } catch {
      /* painel pode não existir mais — nada a fazer */
    }
  }
  function extensaoViva() {
    try {
      if (chrome.runtime && chrome.runtime.id) return true;
    } catch {
      /* no contexto órfão até LER chrome.runtime pode lançar */
    }
    avisarContextoPerdido();
    return false;
  }

  // Request/response com o worker (upload, contagem de tokens, capacidades).
  function rpc(msg) {
    return new Promise((resolve, reject) => {
      if (!extensaoViva()) return reject(new Error(MSG_CTX_PERDIDO));
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          if (chrome.runtime.lastError)
            return reject(new Error(chrome.runtime.lastError.message));
          if (!resp) return reject(new Error("sem resposta do serviço da extensão"));
          if (resp.error) {
            // O worker classifica o erro (429/5xx/queda de rede = transitório) e
            // o `retryable` viajava até aqui só para ser jogado fora na
            // construção do Error. Quem re-tenta precisa dele.
            const err = new Error(resp.error);
            if (resp.retryable) err.retryable = true;
            return reject(err);
          }
          resolve(resp);
        });
      } catch {
        avisarContextoPerdido();
        reject(new Error(MSG_CTX_PERDIDO));
      }
    });
  }

  // Capacidades do modelo atual (limite de páginas, contexto, ferramentas web)
  // + id do modelo e nível de raciocínio ativos (mostrados no selo do rodapé).
  let modelCaps = null;
  let modelInfo = null; // {model, effort} da última resposta de caps

  // Reflete na UI o que o modelo atual suporta: selo do modelo ativo, nota de
  // citações textuais (Gemini) e a guarda de troca de provedor no meio da
  // conversa. Chamada sempre que modelCaps muda.
  function aplicarCapsNaUI() {
    if (!modelCaps) return;
    panel.setModelo(
      modelInfo && {
        model: modelInfo.model,
        effort: modelInfo.effort,
        comEffort: modelCaps.effort !== false,
      }
    );
    panel.setModoCitacoes(modelCaps.citacoesNativas === false ? "textual" : "nativa");
    // A biblioteca de modelos assume 1M tokens (a minuta manda os autos + vários
    // modelos): habilitada só nesses; nos menores (Haiku) a feature some.
    panel.setModelosHabilitado((modelCaps.contextTokens || 0) >= 1000000);
    const prov = modelCaps.provider || "anthropic";
    if (conversation.length && conversaProvider && prov !== conversaProvider) {
      panel.setAlerta(ALERTA_TROCA_PROVEDOR);
      alertaTrocaLigado = true;
    } else if (alertaTrocaLigado) {
      // voltou ao provedor da conversa: o alerta de troca se resolve sozinho
      panel.setAlerta(null);
      alertaTrocaLigado = false;
    }
  }

  function refreshCaps() {
    if (!extensaoViva()) return;
    try {
      chrome.runtime.sendMessage({ type: "caps" }, (r) => {
        void chrome.runtime.lastError; // worker pode estar acordando — sem ruído
        // Impressão digital da chave em uso: este handler já roda no boot E a
        // cada troca de chave/modelo, então é por ele que os fileId gravados no
        // disco são invalidados quando o usuário muda de conta — sem um caminho
        // novo só para isso.
        if (r && "chaveHash" in r) chaveHashAtual = r.chaveHash || null;
        if (r && r.caps) {
          modelCaps = r.caps;
          modelInfo = { model: r.model, effort: r.effort };
          aplicarCapsNaUI();
        }
      });
    } catch {
      avisarContextoPerdido();
    }
  }
  refreshCaps();

  // Garante as capacidades ANTES de validar limites (o primeiro envio pode
  // chegar antes do refreshCaps inicial responder — a guarda ficaria muda).
  function garantirCaps() {
    if (modelCaps) return Promise.resolve();
    return new Promise((resolve) => {
      if (!extensaoViva()) return resolve();
      try {
        chrome.runtime.sendMessage({ type: "caps" }, (r) => {
          void chrome.runtime.lastError;
          if (r && r.caps) {
            modelCaps = r.caps;
            modelInfo = { model: r.model, effort: r.effort };
            aplicarCapsNaUI();
          }
          resolve(); // sem caps segue mesmo assim: count_tokens e a API guardam
        });
      } catch {
        avisarContextoPerdido();
        resolve();
      }
    });
  }

  // Estado da chave: mostra CTA de configuração quando ausente e reage a mudanças
  // (ex.: quando o usuário salva a chave pelo popup, sem recarregar a página).
  function refreshKey() {
    if (!extensaoViva()) return;
    try {
      // a chave exigida é a do PROVEDOR do modelo escolhido (Anthropic, Google
      // ou OpenAI) — o provedor sai do prefixo do id, sem esperar o caps
      // chegar. customPrompt pega carona na mesma leitura (evita um get a mais).
      chrome.storage.local.get(
        ["apiKey", "geminiApiKey", "openaiApiKey", "model", "customPrompt"],
        (v) => {
          customPrompt = (v.customPrompt || "").trim();
          const m = String(v.model || "");
          const configurado = m.startsWith("gemini-")
            ? !!v.geminiApiKey
            : m.startsWith("gpt-")
              ? !!v.openaiApiKey
              : !!v.apiKey;
          panel.setConfigured(configurado);
        }
      );
      // Número do processo no cabeçalho: com vários processos abertos em abas,
      // era impossível saber a qual deles o painel se referia (ver DESIGN.md).
      try {
        panel.setProcesso(PJE.getNumeroProcesso() || "");
      } catch {
        /* página sem número identificável — o cabeçalho fica só com o produto */
      }
    } catch {
      avisarContextoPerdido();
    }
  }
  refreshKey();
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === "local" && (ch.apiKey || ch.geminiApiKey || ch.openaiApiKey || ch.model))
      refreshKey();
    // effort entra aqui por causa do selo do modelo (mostra o nível ativo)
    if (
      area === "local" &&
      (ch.model || ch.apiKey || ch.geminiApiKey || ch.openaiApiKey || ch.effort)
    )
      refreshCaps();
    if (area === "local" && ch.customPrompt) {
      customPrompt = String(ch.customPrompt.newValue || "").trim();
      // o system mudou → a última medição de contexto não vale mais
      ultimaChaveEst = "";
    }
  });
  panel.onConfigure(() => {
    if (!extensaoViva()) return;
    try {
      chrome.runtime.sendMessage({ type: "openOptions" });
    } catch {
      avisarContextoPerdido();
    }
  });

  panel.onReset(async () => {
    if (busy) return; // não zera no meio de uma resposta
    // Havia o que arquivar? MESMO critério da gravação (`temProduto`) — se a
    // mensagem dissesse "ficou guardada" num caso em que nada foi gravado, ela
    // seria mentira, e mentira sobre memória é pior do que silêncio.
    const tinhaTrabalho = temProduto(panel.lerTranscript ? panel.lerTranscript() : []);
    // ARQUIVA a conversa atual antes de abrir a nova. Esta é a correção de uma
    // decisão errada da rodada anterior: enquanto nada era persistido, "Nova
    // conversa" só limpava a tela. Com memória, sobrescrever significaria
    // DESTRUIR trabalho gravado — sem aviso e sem volta. Agora a anterior
    // continua no disco e reaparece na lista de conversas.
    await salvarCasoAgora();
    clearTimeout(estTimer);
    estSeq++; // descarta estimativas em voo
    zerarEstadoDaConversa();
    // `null` faz a próxima gravação CRIAR uma conversa, em vez de escrever por
    // cima da que acabou de ser arquivada.
    convAtual = null;
    convVersao = 0;
    panel.clearMessages();
    refreshKey(); // re-renderiza CTA de chave se necessário
    // As PEÇAS não são tocadas: elas são do processo, custaram download e
    // servem a todas as conversas dele. Para esquecer o processo inteiro há o
    // botão próprio na faixa de retomada.
    CASO.salvar(casoChave, { convAtual: null });
    atualizarListaConversas();
    // "Nova conversa" APAGA a tela, e uma tela apagada é indistinguível de
    // trabalho perdido — a queixa não é hipotética. O status diz para onde a
    // conversa foi e por qual botão se volta a ela.
    if (tinhaTrabalho) {
      panel.setStatus(
        "Conversa anterior guardada — ela continua na lista de conversas deste processo " +
          "(o botão com o número, no topo do painel)."
      );
    }
  });

  // "Ver na timeline": rola a página do PJe até a peça com destaque temporário
  // (PJE.scrollAte não clica em nada — zero efeito JSF, zero download).
  panel.onVerNaTimeline((id) => {
    if (!PJE.scrollAte(id)) {
      panel.setStatus(
        'A peça "' + metaDe(id).titulo +
          '" ainda não está na linha do tempo — use "⟳ Carregar tudo" (abaixo da lista) e tente de novo.'
      );
    }
  });

  // "Carregar todas as peças": rola a timeline do PJe até o fim pelo usuário
  // (o PJe carrega as peças sob demanda). O MutationObserver da timeline vai
  // repovoando a lista sozinho durante o processo; aqui só cuidamos do
  // feedback na dica. Sem guarda de busy: a rolagem não clica em nada (zero
  // efeito JSF) — é o mesmo gesto que o usuário faria à mão a qualquer hora.
  // Peças vindas da GRID (tela "Documentos"): mescladas às da timeline em
  // `setDocs`. Guardamos o `tipo` oficial de cada uma — a timeline não tem esse
  // dado e a categoria acaba adivinhada por regex sobre o título.
  let docsDaGrid = null;
  // Cobertura da última leitura da grid, para a exportação poder DIZER de onde
  // a lista veio em vez de deixar implícito que é o processo inteiro.
  let gridInfo = null;

  let carregandoTimeline = false;
  panel.onCarregarTimeline(async () => {
    if (carregandoTimeline) return;
    // A ROTA 1 (grid) faz submits A4J dentro do iframe, e a exportação está
    // ativando peças na timeline — duas frentes na MESMA sessão JSF, que o
    // PJe serializa. É a outra ponta da guarda `bloqueadoPelaExportacao`: sem
    // ela, o único caminho que mexe no JSF sem passar por lá seria este.
    if (exportando) {
      panel.setTimelineTip({
        texto: "Exportação em andamento — aguarde o .zip terminar para recarregar a lista.",
      });
      return;
    }
    carregandoTimeline = true;
    try {
      // ROTA 1 — grid da tela "Documentos" (ver docs/pje-tela-documentos.md).
      // Ela sabe o TOTAL de páginas, então dá para afirmar que leu tudo; o
      // scroll só consegue inferir pelo "parou de crescer" e entrega lista
      // parcial sem avisar. Best-effort: null = indisponível, cai na rota 2.
      panel.setTimelineTip({
        texto: "Consultando a lista oficial de documentos do processo…",
        carregando: true,
      });
      const grid = await PJE.listarPelaGrid((n) =>
        panel.setTimelineTip({
          texto: "Lendo a lista oficial… " + n + " documento(s).",
          carregando: true,
        })
      );
      if (grid && grid.docs.length) {
        docsDaGrid = grid.docs;
        gridInfo = grid;
        atualizarListaPecas();
        panel.setTimelineTip({
          texto: grid.incompleto
            ? grid.total +
              " documento(s) — leitura PARCIAL (" +
              grid.paginasLidas +
              " de " +
              grid.paginas +
              " páginas). Clique de novo para tentar o resto."
            : "Lista completa: " +
              grid.total +
              " documento(s) (" +
              grid.paginas +
              " de " +
              grid.paginas +
              " páginas lidas).",
        });
        return;
      }

      // ROTA 2 — fallback: rolar a timeline até o fim, como sempre.
      const res = await PJE.carregarTimelineCompleta((n) =>
        panel.setTimelineTip({
          texto: "Carregando a linha do tempo… " + n + " peça(s) na lista.",
          carregando: true,
        })
      );
      panel.setTimelineTip({
        texto: res.completo
          ? "Linha do tempo completa: " + res.total + " peça(s) na lista."
          : res.total +
            " peça(s) na lista — a linha do tempo pode ter mais; clique de novo para continuar.",
      });
    } catch (e) {
      console.warn("[PJe IA] carregar timeline:", e);
      panel.setTimelineTip(null); // volta ao padrão; o botão segue disponível
    } finally {
      carregandoTimeline = false;
      agendarSalvar();
    }
  });

  // ---------------------------------------------------------------------------
  // "Baixar .zip": exporta as peças para trabalhar os autos FORA da extensão.
  //
  // Sem a permissão "downloads", de propósito: ela mudaria o aviso de instalação
  // da Web Store numa extensão já publicada — o mesmo motivo que fez a leitura da
  // grid virar iframe em vez de aba. Blob + âncora `download` (o caminho que o
  // mapa e a minuta já usam) resolve, e como o resultado é UM arquivo, não há a
  // enxurrada de downloads que a API evitaria.
  // ---------------------------------------------------------------------------
  let exportando = false;
  panel.onExportarZip(async (docs, opcoes) => {
    if (exportando) return;
    if (busy) {
      panel.setStatus("Aguarde a resposta atual terminar para exportar as peças.");
      return;
    }
    if (carregandoTimeline) {
      panel.setStatus("Aguarde a leitura da lista de peças terminar para exportar.");
      return;
    }
    if (typeof PjeExport === "undefined" || typeof ZipW === "undefined") {
      panel.setStatus("Exportação indisponível: recarregue a página do processo.");
      return;
    }
    exportando = true;
    const sinal = { cancelado: false };
    const todas = !!(opcoes && opcoes.todas);
    panel.setZipOcupado(true);
    // `docs` já são os objetos {id, titulo} do painel — passar por metaDe
    // (que recebe um ID) devolveria "Peça [object Object]" em cada linha.
    panel.startPrep(docs, {
      titulo: todas
        ? "Exportando as " + docs.length + " peças da lista…"
        : "Exportando " + docs.length + " peça(s) marcada(s)…",
      fim: (total, feitas) =>
        feitas === total
          ? "Arquivo .zip gerado com " + total + " peça(s)"
          : "Arquivo .zip gerado — " + feitas + " de " + total + " peça(s)",
      onCancelar: () => {
        sinal.cancelado = true;
      },
    });
    try {
      const r = await PjeExport.montarZip({
        docs,
        cnj: PJE.getNumeroProcesso(),
        // Ficha do processo (classe, assunto, partes…): sai do DOM que já está
        // na tela e é o que faz o pacote se explicar sozinho no destino.
        ficha: PJE.lerCabecalhoProcesso(),
        origemLista: descreverOrigemLista(todas),
        sinal,
        onEtapa: (id, estado) => panel.setPrepState(id, estado),
        // Mesmo caminho do envio: o que já está em cache não baixa de novo, e o
        // que baixar aqui fica disponível para a conversa (prefetch de graça).
        // `{bytes:true}` porque o pacote leva o ARQUIVO ORIGINAL: uma peça
        // retomada da memória tem `fileId` e nenhum byte, e sem a flag ela saía
        // vazia do `.zip` — em silêncio, num arquivo que só se abre depois.
        obter: (id) => garantirBaixada(id, { bytes: true }),
      });
      panel.endPrep();
      baixarBlob(r.nome, r.blob);
      const partes = [r.resumo.ok + " peça(s)"];
      if (r.resumo.paginas) partes.push(r.resumo.paginas + " páginas");
      partes.push(fmtMB(r.blob.size));
      panel.setStatus(
        "✅ " + r.nome + " — " + partes.join(", ") +
          (r.resumo.falhas
            ? ". " + r.resumo.falhas + " peça(s) falharam (a relação está no indice.txt)."
            : ".")
      );
    } catch (e) {
      const msg = (e && e.message) || String(e);
      panel.endPrep(true);
      panel.setStatus(
        msg === "cancelado" ? "Exportação cancelada." : "Não foi possível exportar: " + msg
      );
      if (msg !== "cancelado") console.warn("[PJe IA] exportar zip:", e);
    } finally {
      exportando = false;
      panel.setZipOcupado(false);
      // A exportação baixou dezenas de peças que a memória ainda não conhece —
      // gravá-las aqui é o que faz um "Baixar .zip" adiantar o turno seguinte.
      salvarCasoAgora();
    }
  });

  // De onde veio a lista que está sendo exportada — vai escrito no LEIA-ME e no
  // índice. "Pode estar incompleta" precisa ser dito COM o motivo; sem ele, a
  // ressalva vira ruído que ninguém lê.
  function descreverOrigemLista(todas) {
    let base;
    if (gridInfo && !gridInfo.incompleto) {
      base =
        "lida da tela oficial “Documentos” do PJe, por completo (" +
        gridInfo.total +
        " documentos em " +
        gridInfo.paginas +
        " página(s))";
    } else if (gridInfo) {
      base =
        "lida da tela oficial “Documentos” do PJe, mas PARCIALMENTE (" +
        gridInfo.paginasLidas +
        " de " +
        gridInfo.paginas +
        " páginas)";
    } else {
      base =
        "lida da linha do tempo do processo, que o PJe carrega sob demanda conforme " +
        "a rolagem — peças antigas podem não ter entrado";
    }
    return base + (todas ? "" : "; e esta exportação inclui apenas as peças marcadas na lista");
  }

  function fmtMB(n) {
    return n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.round(n / 1024) + " KB";
  }

  // Preview no hover: fornece o conteúdo JÁ em cache (síncrono, nunca baixa —
  // download do PJe é serializado na sessão JSF e travaria a cada passada de
  // mouse). Cache-miss devolve null e o painel oferece o botão "Baixar".
  panel.onPreview((id) => docsCache.get(id) || null);

  // Botão "Baixar" do preview: idempotente e compartilhado com o envio (a
  // peça baixada aqui entra no docsCache que baixarSelecionadas reaproveita).
  panel.onPreviewBaixar(async (id) => {
    if (busy) throw new Error("aguarde a resposta atual terminar para abrir a peça");
    if (exportando) throw new Error("aguarde a exportação terminar para abrir a peça");
    // `{bytes:true}`: o preview desenha o PDF/a imagem na tela, então precisa do
    // conteúdo aqui — uma peça retomada da memória tem `fileId` e nenhum byte, e
    // sem esta flag o download era pulado e o botão não fazia nada.
    return await garantirBaixada(id, { bytes: true });
  });

  let docsIndex = new Map(); // id -> {id, titulo} (para chips e card de progresso)

  // Une as duas fontes de listagem. A GRID (tela "Documentos") é a boa quando
  // existe — ela é completa e traz o TIPO oficial da peça —, mas a timeline
  // segue mandando na ORDEM (é a ordem cronológica que o usuário vê na tela) e
  // é a única fonte enquanto a grid não foi consultada. Peças que só a grid
  // conhece entram no fim: são justamente as que o scroll não tinha alcançado.
  function mesclarDocs() {
    const daTimeline = PJE.listarDocumentos();
    if (!docsDaGrid || !docsDaGrid.length) return daTimeline;
    const porId = new Map(docsDaGrid.map((d) => [d.id, d]));
    const out = [];
    const vistos = new Set();
    for (const d of daTimeline) {
      const g = porId.get(d.id);
      vistos.add(d.id);
      // título da timeline (o usuário reconhece) + os dados que só a grid tem:
      // tipo oficial (usado por `categoriaDe`), a procedência da juntada (data
      // e autor) e as colunas `extras` daquele tribunal — todos alimentam o
      // índice da exportação em ZIP. `extras` PRECISA vir junto: ele existe
      // justamente para preservar o que só aquela grid tem, e a peça que está
      // nas DUAS fontes é o caso comum — deixá-lo de fora aqui faria o campo
      // sobreviver só nas peças que a timeline não alcançou.
      out.push(
        g
          ? Object.assign({}, d, {
              tipo: g.tipo,
              juntadoEm: g.juntadoEm,
              juntadoPor: g.juntadoPor,
              extras: g.extras,
            })
          : d
      );
    }
    for (const g of docsDaGrid) if (!vistos.has(g.id)) out.push(g);
    return out;
  }

  function atualizarListaPecas() {
    const docs = mesclarDocs();
    docsIndex = new Map(docs.map((d) => [d.id, d]));
    panel.setDocs(docs);
  }
  const refresh = atualizarListaPecas;
  refresh();

  function metaDe(id) {
    const a = anexos.get(id);
    if (a) return { id, titulo: a.titulo || a.nome || ("Anexo " + id) };
    return docsIndex.get(id) || { id, titulo: "Peça " + id };
  }

  // Anexa o observer à timeline. Se #divTimeLine ainda não existe (a página pode
  // renderizá-la após o document_idle), espera-a surgir e então observa.
  function attachTimelineObserver() {
    const tl = document.querySelector("#divTimeLine");
    if (!tl) return false;
    let t;
    new MutationObserver(() => {
      clearTimeout(t);
      t = setTimeout(refresh, 400);
    }).observe(tl, { childList: true, subtree: true });
    refresh();
    return true;
  }
  if (!attachTimelineObserver()) {
    const bodyObs = new MutationObserver(() => {
      if (attachTimelineObserver()) bodyObs.disconnect();
    });
    bodyObs.observe(document.documentElement, { childList: true, subtree: true });
  }

  // Acima disto o download está fora do normal e vale dizer ao usuário que o
  // problema é a rede — a ativação JSF de uma peça leva ~5,6 s em condições boas.
  const SEGUNDOS_PECA_LENTO = 12;

  // Baixa a peça uma única vez por aba: o download do PJe é serializado na
  // sessão JSF (~5,6 s cada), então todo caminho que precisa do conteúdo passa
  // por aqui e reaproveita o cache — envio, preview, exportação e medição.
  // opts.bytes: exige os BYTES na aba, não só "dá para enviar" (ver `temBytes`).
  // É o que o preview e a exportação `.zip` pedem — para eles um `fileId` não
  // substitui o conteúdo.
  async function garantirBaixada(id, opts) {
    let d = docsCache.get(id);
    const precisa = opts && opts.bytes ? !temBytes(id) : precisaBaixar(id);
    if (precisa) {
      const novo = await PJE.baixar(id);
      // MESCLA, nunca substitui: a entrada que veio do disco carrega o `fileId`
      // e o `chaveHash`, e um `set` cru os apagaria — a peça subiria de novo à
      // Files API a cada sessão, anulando metade da economia. `semBytes` sai
      // porque agora os bytes estão aqui.
      d = Object.assign({}, d || {}, novo);
      delete d.semBytes;
      docsCache.set(id, d);
      // Peça nova (ou completada) no cache: entra na fila da memória. O que vai
      // ao disco são os metadados e o texto — nunca o base64.
      pecasSujas.add(id);
      agendarSalvar();
    }
    return d;
  }

  // Baixa as peças com concorrência limitada (3 por vez), com progresso por
  // peça no card de preparo (spinner -> check + barra de progresso).
  //
  // Peça que falha NÃO interrompe o turno. O PJe devolve 404 em peças que
  // existem na lista mas não têm download servível (atos ordinatórios vindos de
  // sistema anterior, por exemplo), e antes uma única dessas abortava a análise
  // inteira: o usuário desmarcava, mandava de novo, e caía na seguinte. Agora o
  // envio segue com o que deu certo e as falhas viram um relatório — quem quiser
  // investigar tem a lista e o motivo de cada uma.
  //
  // Devolve {ok:[ids], falhas:[{id, titulo, erro}]}.
  async function baixarSelecionadas(ids) {
    panel.startPrep(ids.map(metaDe));
    const queue = ids.slice();
    const falhas = [];

    // BOMBA DE UPLOAD — o upload de cada peça começa assim que ELA baixa, em
    // vez de esperar a fila inteira. Antes o turno custava Σdownload + Σupload;
    // agora custa Σdownload + o upload da última peça, porque os demais já
    // aconteceram debaixo do download das seguintes.
    //
    // Ela mora AQUI, e não no handler de envio, porque há três pares
    // baixar→subir idênticos (chat, minuta e mapa): assim os três ganham o
    // pipeline sem mudar uma linha nos call sites.
    //
    // Os `await subirPecas(...)` que vêm logo depois nos call sites passam a ser
    // no-ops para as peças que subiram (o filtro `precisaUpload` descarta quem
    // já tem fileId do provedor atual) e uma SEGUNDA TENTATIVA para as que
    // falharam. Isso é intencional: a falha típica de upload é 429 por rate
    // limit depois de muitos arquivos, e alguns segundos depois ela costuma
    // passar. O custo aparece só quando a falha é permanente (arquivo grande
    // demais), e aí o fallback base64 assume de qualquer forma. São no máximo
    // duas tentativas por peça e por turno.
    //
    // Três invariantes que não podem cair:
    //  · UM LOTE POR VEZ (`bombeando`). O cache de upload do worker é
    //    read-then-write: duas chamadas simultâneas com a mesma cacheKey erram
    //    o cache as duas e sobem o arquivo duas vezes.
    //  · try/catch em volta de CADA lote. Uma rejeição não tratada se
    //    propagaria pelo `await cadeiaUpload` lá embaixo e derrubaria o turno
    //    inteiro por causa de um upload — o oposto exato do design atual, em
    //    que falha de upload apenas devolve a peça ao fallback base64.
    //  · `await cadeiaUpload` ANTES de devolver. Sem isso o chamador seguiria
    //    para o seu próprio `subirPecas` com uploads ainda em voo, e voltaria a
    //    corrida do primeiro item.
    const filaUpload = [];
    let bombeando = false;
    let cadeiaUpload = Promise.resolve();
    function bombear() {
      if (bombeando) return;
      bombeando = true;
      cadeiaUpload = (async () => {
        while (filaUpload.length) {
          const lote = filaUpload.splice(0);
          try {
            // silencioso: quem fala durante esta fase é o card de preparo; um
            // status "Enviando peças…" competindo com "Preparando peças 3/12"
            // descreveria duas coisas ao mesmo tempo.
            await subirPecas(lote, { silencioso: true });
          } catch (e) {
            console.debug("[PJe IA] lote de upload falhou:", e && e.message);
          }
          // Pronta — inclusive a que falhou no upload: ela entra no request
          // pelo fallback base64, então marcá-la como erro diria ao usuário
          // que a peça ficou de fora, o que é falso. A única lista de peças
          // ausentes continua sendo `falhas` (download).
          for (const id of lote) panel.setPrepState(id, "done");
        }
        bombeando = false;
      })();
    }

    // Ritmo do download. O gargalo real da extensão é este: o PJe serializa a
    // entrega das peças, então a banda do usuário domina o tempo total. Quando
    // fica ruim, a extensão PARECE travada — e o usuário não tem como saber que
    // o problema é a rede dele. Medimos e dizemos.
    const t0 = Date.now();
    let baixadas = 0;
    let avisouLento = false;
    async function worker() {
      while (queue.length) {
        const id = queue.shift();
        panel.setPrepState(id, "loading");
        if (precisaBaixar(id)) {
          try {
            await garantirBaixada(id);
            baixadas++;
            // Throughput real (segundos por peça ENTREGUE), não o tempo de uma
            // peça isolada: é o número que o usuário sente esperando.
            const media = (Date.now() - t0) / 1000 / baixadas;
            // A partir da 2ª peça (a 1ª carrega a latência de abrir a sessão) e
            // com folga sobre os ~5,6 s normais de uma ativação JSF.
            if (!avisouLento && baixadas >= 2 && media > SEGUNDOS_PECA_LENTO) {
              avisouLento = true;
              panel.setPrepNota(
                "Download lento (~" +
                  Math.round(media) +
                  " s por peça). O gargalo costuma ser a rede: uma conexão por cabo " +
                  "é bem mais estável que o Wi-Fi para baixar os autos."
              );
            }
          } catch (e) {
            falhas.push({
              id,
              titulo: metaDe(id).titulo,
              erro: (e && e.message ? e.message : String(e)).replace(/^falha ao baixar a peça \d+ ?/i, ""),
            });
            // `erro` também adianta o contador do card — sem isso a barra de um
            // envio com falhas nunca chegaria ao fim (mesma regra da exportação)
            panel.setPrepState(id, "erro");
            continue;
          }
        }
        // A peça está em cache. Se ainda falta subir à Files API, ela tem uma
        // SEGUNDA fase pela frente e o card precisa dizer isso: enquanto o
        // contador batia N/N no fim do download, o card ficava congelado em
        // 100% durante todo o upload, parecendo travado. Este ponto cobre
        // também a peça que JÁ estava em cache (o `if` acima foi pulado) —
        // desejável, porque ela pode não ter fileId, ou tê-lo de outro provedor.
        if (precisaUpload(id)) {
          panel.setPrepState(id, "upload");
          filaUpload.push(id);
          bombear();
        } else {
          panel.setPrepState(id, "done");
        }
      }
    }
    await Promise.all([worker(), worker(), worker()]);
    bombear(); // a última peça pode ter entrado na fila com a bomba parada
    await cadeiaUpload;
    const perdidas = new Set(falhas.map((f) => f.id));
    const ok = ids.filter((id) => !perdidas.has(id));
    return { ok, falhas };
  }

  // Precisa de upload à Files API? Só PDF, e só quando ainda não há fileId do
  // provedor ATUAL (um file_id da Anthropic não serve num request Gemini).
  // Extraída para ser a fonte ÚNICA da regra: `subirPecas` a usa para montar a
  // fila e o card de progresso a usa para saber se aquela peça ainda tem uma
  // fase pela frente. Duplicar isso garantiria divergência — `fileProvider` já
  // é sutil o bastante.
  function precisaUpload(id) {
    const d = docsCache.get(id);
    if (!d || d.kind !== "pdf") return false;
    // Sem bytes não há o que subir. Acontece com peça HIDRATADA da memória de
    // caso: ela volta do disco só com metadados e fileId, e quem decide se
    // precisa de download é `precisaBaixar`, não este predicado.
    if (!d.b64) return false;
    const provAtual = (modelCaps && modelCaps.provider) || "anthropic";
    return !d.fileId || (d.fileProvider || "anthropic") !== provAtual;
  }

  // ---------------------------------------------------------------------------
  // MEMÓRIA DE CASO — os três predicados que decidem o que fazer com uma peça
  // que voltou do disco SEM os bytes (marca interna `semBytes`).
  //
  // Esta é a economia inteira do recurso: uma peça PDF cujo `fileId` ainda vale
  // é reenviada à API sem baixar nada — `montarBlocos` prefere o file_id e nem
  // toca no base64. Peça de TEXTO nem isso precisa: o texto veio junto.
  // ---------------------------------------------------------------------------

  // O fileId gravado ainda serve para o request de agora? Três formas de não
  // servir, e as três dariam erro críptico da API se passassem batidas:
  //  - provedor diferente (um file_id da Anthropic num request Gemini = 400);
  //  - vencido (a File API do Google apaga os arquivos em 48 h);
  //  - de OUTRA CONTA (o usuário trocou a chave; os arquivos são da conta).
  // A folga de 60 s na expiração evita o caso em que o arquivo vence entre a
  // checagem e a chegada do request ao servidor.
  function fileIdValido(d) {
    if (!d || !d.fileId) return false;
    const provAtual = (modelCaps && modelCaps.provider) || "anthropic";
    if ((d.fileProvider || "anthropic") !== provAtual) return false;
    if (d.fileExp && d.fileExp <= Date.now() + 60000) return false;
    // `chaveHash` ausente = upload feito antes desta versão: não dá para
    // afirmar que mudou de conta, e recusar por precaução só custaria um
    // download desnecessário a quem não trocou de chave.
    if (d.chaveHash && chaveHashAtual && d.chaveHash !== chaveHashAtual) return false;
    return true;
  }

  // Dá para anexar esta peça ao request AGORA, do jeito que ela está?
  //
  // A resposta depende de COMO cada tipo viaja, e por isso os ramos são
  // explícitos: só o PDF tem a rota por referência (Files API). A IMAGEM vai
  // sempre em base64 inline nos três provedores — um fileId não a dispensa de
  // nada, e tratá-la junto do PDF faria uma peça sem bytes parecer pronta.
  function podeAnexar(id) {
    const d = docsCache.get(id);
    if (!d) return false;
    if (d.kind === "text") return !!d.text;
    if (d.kind === "img") return !!d.b64;
    return !!(d.b64 || fileIdValido(d));
  }

  // Precisa passar pelo PJe (a fila serializada de ~5,6 s por peça)? É a
  // pergunta que a memória de caso existe para responder "não".
  function precisaBaixar(id) {
    const d = docsCache.get(id);
    if (!d) return true; // nunca vista
    if (!d.semBytes) return false; // veio inteira nesta sessão
    return !podeAnexar(id);
  }

  // Os BYTES desta peça estão aqui, nesta aba?
  //
  // NÃO é a mesma pergunta de `precisaBaixar`, e confundir as duas foi um bug
  // real: aquela responde "preciso baixar para ENVIAR?", e a resposta lá é
  // *não* quando existe um `fileId` válido — o modelo recebe a peça por
  // referência da Files API e os bytes são dispensáveis. Só que há dois
  // consumidores que não têm essa saída, porque não mandam a peça a lugar
  // nenhum: o PREVIEW, que desenha pixels na tela, e a EXPORTAÇÃO `.zip`, que
  // grava o arquivo original no pacote. Para eles o `fileId` não serve de nada.
  //
  // O sintoma era diferente em cada um, e o da exportação era o pior: no
  // preview o botão "Abrir documento" ficava sem efeito (baixava zero, o
  // popover re-renderizava o mesmo aviso); no `.zip`, a peça saía VAZIA ou
  // derrubava a entrada — em silêncio, num pacote que o usuário só abre depois.
  // Nos dois casos só acontecia com peça vinda da memória de caso, que é
  // justamente o caminho comum ao reabrir um processo.
  function temBytes(id) {
    const d = docsCache.get(id);
    if (!d) return false;
    if (d.kind === "text") return !!d.text; // ali o texto É o conteúdo
    return !!d.b64;
  }

  // ---------------------------------------------------------------------------
  // MEMÓRIA DE CASO — revalidação do que está no HISTÓRICO.
  //
  // O caso difícil do recurso, e o mais provável de dar errado sem tratamento:
  // `conversation` guarda blocos `{type:"document", source:{type:"file",
  // file_id}}` dos turnos anteriores. Numa conversa retomada dias depois, esses
  // file_id podem não existir mais no provedor (Gemini apaga em 48 h; trocar de
  // chave leva junto os da Anthropic e da OpenAI).
  //
  // E isso NÃO se conserta re-baixando a peça: o bloco antigo continua
  // apontando para o arquivo morto, e o usuário recebe um 400 críptico da API
  // logo na primeira mensagem da sessão — sem nada que ligue o erro à causa.
  //
  // Roda ANTES do download das peças novas, e no caminho normal custa zero (sai
  // na primeira linha quando não há nada a revalidar).
  // ---------------------------------------------------------------------------

  // Percorre o histórico trocando o file_id de cada bloco pela referência ATUAL
  // da peça. Mutação in-place é legítima aqui: o request é remontado do zero a
  // cada turno e o bloco `document` não carrega assinatura do provedor (ao
  // contrário do thinking, que é intocável).
  function reescreverFileIdsNoHistorico(perdidas) {
    let trocados = 0;
    for (const turno of conversation) {
      if (!Array.isArray(turno.content)) continue;
      const mantidos = [];
      for (const b of turno.content) {
        const id = b && b.__pecaId;
        if (!id || !b.source || b.source.type !== "file") {
          mantidos.push(b);
          continue;
        }
        if (perdidas.has(id)) continue; // some do histórico junto com a peça
        const d = docsCache.get(id);
        if (d && d.fileId && d.fileId !== b.source.file_id) {
          b.source.file_id = d.fileId;
          trocados++;
        }
        mantidos.push(b);
      }
      if (mantidos.length !== turno.content.length) turno.content = mantidos;
    }
    return trocados;
  }

  // O provedor disse que o arquivo referenciado não existe. As três APIs
  // escrevem isso de formas diferentes, e nenhuma tem um código estável para
  // isto — o casamento é por texto, de propósito conservador: um falso positivo
  // aqui só custa um re-upload no envio seguinte.
  function erroDeArquivoSumido(e) {
    const m = String((e && e.message) || e || "");
    return /(file|arquivo|files\/)/i.test(m) && /(not found|não encontrad|404|expired|invalid)/i.test(m);
  }

  // Solta as referências de upload do provedor atual: as peças voltam a precisar
  // de upload (e de download, se os bytes também não estiverem aqui) no próximo
  // envio. Não apaga nada do banco — `pecaParaBanco` regrava sem fileId na
  // próxima gravação, que é o efeito desejado.
  function esquecerUploadsDoProvedor() {
    const provAtual = (modelCaps && modelCaps.provider) || "anthropic";
    for (const [id, d] of docsCache) {
      if (!d || !d.fileId || (d.fileProvider || "anthropic") !== provAtual) continue;
      delete d.fileId;
      delete d.fileProvider;
      delete d.fileExp;
      delete d.chaveHash;
      pecasSujas.add(id);
    }
  }

  async function revalidarPecasDoHistorico(ativos) {
    if (!pecasNaConversa.size) return;
    // Só peças que (a) estão no histórico POR REFERÊNCIA, (b) seguem marcadas —
    // `prepararEnvio` já filtra as desmarcadas do request — e (c) cuja
    // referência não vale mais.
    const porReferencia = new Set();
    for (const turno of conversation) {
      if (!Array.isArray(turno.content)) continue;
      for (const b of turno.content) {
        if (b && b.__pecaId && b.source && b.source.type === "file") porReferencia.add(b.__pecaId);
      }
    }
    const alvo = [...porReferencia].filter(
      (id) => (!ativos || ativos.has(id)) && !fileIdValido(docsCache.get(id))
    );
    if (!alvo.length) return; // caminho normal

    console.debug("[PJe IA] revalidando", alvo.length, "peça(s) do histórico");
    const dl = await baixarSelecionadas(alvo);
    await subirPecas(dl.ok);
    // Quem não voltou sai do histórico: um bloco apontando para arquivo morto
    // derrubaria o turno inteiro, e a peça some do contexto de forma HONESTA —
    // volta a ser "nova" e pode ser reanexada marcando-a de novo.
    const perdidas = new Set(alvo.filter((id) => !fileIdValido(docsCache.get(id))));
    reescreverFileIdsNoHistorico(perdidas);
    for (const id of perdidas) pecasNaConversa.delete(id);
    if (perdidas.size) {
      panel.setPecasEnviadas([...pecasNaConversa]);
      panel.mostrarFalhasPecas(
        [...perdidas].map((id) => ({
          id,
          titulo: metaDe(id).titulo,
          erro: "o arquivo enviado antes expirou e a peça não pôde ser baixada de novo",
        })),
        {
          titulo: "peça(s) saíram do contexto desta conversa",
          dica: "Marque-as de novo para reanexá-las ao próximo envio.",
        }
      );
    }
  }

  // Sobe as peças PDF ainda sem file_id para a Files API (2 por vez). Falha de
  // upload não interrompe: a peça cai no fallback base64 (teto de 24 MB).
  //
  // `opts.silencioso` existe para a bomba de upload de `baixarSelecionadas`:
  // quando o upload corre POR BAIXO do download, quem narra a fase é o card de
  // preparo, e um `.status` competindo com ele descreveria duas coisas ao mesmo
  // tempo. Chamada sem opts, o comportamento é o de sempre.
  async function subirPecas(ids, opts) {
    const idProc = PJE.getIdProcesso() || "proc";
    // um fileId da Anthropic não serve num request Gemini (e vice-versa):
    // peça com upload de OUTRO provedor re-sobe para o provedor atual
    const pend = ids.filter(precisaUpload);
    if (!pend.length) return;
    if (!opts || !opts.silencioso) panel.setStatus("Enviando peças para análise…", true);
    const queue = pend.slice();
    async function w() {
      while (queue.length) {
        const id = queue.shift();
        const d = docsCache.get(id);
        // Sem bytes não se sobe nada. Sem esta guarda o worker receberia
        // `b64: undefined`, subiria um arquivo VAZIO, devolveria um fileId
        // perfeitamente válido para ele e contaminaria o cache de sessão E o
        // banco — o modelo então responderia "não consta" sobre peças que
        // recebeu em branco. Falha silenciosa e persistente, a pior espécie.
        if (!d || !d.b64) continue;
        try {
          const r = await rpc({
            type: "upload",
            payload: {
              filename: "peca-" + id + ".pdf",
              b64: d.b64,
              mime: "application/pdf",
              cacheKey: idProc + ":" + id + ":" + (d.size || 0),
            },
          });
          d.fileId = r.fileId;
          d.fileProvider = r.provider || "anthropic";
          // `exp` (Gemini, 48 h) e `chaveHash` (conta da chave) são o que
          // permite, na sessão seguinte, decidir se este fileId ainda vale sem
          // ter de descobrir isso por um 400 no meio do turno.
          if (r.exp) d.fileExp = r.exp;
          if (r.chaveHash) d.chaveHash = r.chaveHash;
          pecasSujas.add(id);
          agendarSalvar();
        } catch (e) {
          console.debug("[PJe IA] upload da peça", id, "falhou; usando base64:", e && e.message);
        }
      }
    }
    await Promise.all([w(), w()]);
  }

  // Sobe à Files API os ANEXOS PDF do input ainda sem file_id do provedor atual.
  // Gêmeo enxuto de `subirPecas`, separado de propósito: os anexos não são peças
  // do PJe, então ficam FORA da fila de gravação da memória de caso (`pecasSujas`
  // / `agendarSalvar`) — nada de arquivo do usuário vai ao disco. Falha de upload
  // não interrompe: o anexo cai no fallback base64 de `montarBlocos` (teto de
  // b64 compartilhado com as peças). Imagem e texto vão sempre inline; só PDF
  // sobe.
  async function subirAnexos(ids) {
    const provAtual = (modelCaps && modelCaps.provider) || "anthropic";
    const pend = ids.filter((id) => {
      const d = anexos.get(id);
      return (
        d && d.kind === "pdf" && d.b64 &&
        (!d.fileId || (d.fileProvider || "anthropic") !== provAtual)
      );
    });
    if (!pend.length) return;
    const idProc = PJE.getIdProcesso() || "proc";
    const queue = pend.slice();
    async function w() {
      while (queue.length) {
        const id = queue.shift();
        const d = anexos.get(id);
        if (!d || !d.b64) continue;
        try {
          const r = await rpc({
            type: "upload",
            payload: {
              filename: d.nome || "anexo-" + id + ".pdf",
              b64: d.b64,
              mime: "application/pdf",
              cacheKey: idProc + ":" + id + ":" + (d.size || 0),
            },
          });
          d.fileId = r.fileId;
          d.fileProvider = r.provider || "anthropic";
          if (r.exp) d.fileExp = r.exp;
          if (r.chaveHash) d.chaveHash = r.chaveHash;
        } catch (e) {
          console.debug("[PJe IA] upload do anexo", id, "falhou; usando base64:", e && e.message);
        }
      }
    }
    await Promise.all([w(), w()]);
  }

  // Tokens de um anexo em imagem: a fórmula da Anthropic é largura × altura / 750 (o Gemini cobra por
  // ladrilhos e a OpenAI por tiles — a mesma ordem de grandeza, e o count_tokens
  // do pré-voo corrige de graça). `pje.js` já entrega a imagem reduzida a 1568px
  // no lado maior, então o teto real desta conta é ~3.300 tokens. Sem dimensões
  // (o navegador não conseguiu decodificar), usa o valor de uma foto típica já
  // reduzida — errar para mais aqui só antecipa um aviso.
  function tokensImagem(d) {
    if (d && d.w && d.h) return Math.ceil((d.w * d.h) / 750);
    return 1600;
  }

  // Páginas de PDF — a guarda que isto alimenta é `MODEL_CAPS.maxPages`, que é
  // um limite de PÁGINAS DE PDF POR REQUEST, não de anexos. Imagem não entra na
  // conta de propósito: ela tem limite próprio (a Anthropic aceita até 100 por
  // request) e somá-la aqui faria um processo com 30 fotos e 2 PDFs bater num
  // teto que ele não bateu.
  function paginasDe(ids) {
    let total = 0;
    for (const id of ids) {
      const d = entradaDoc(id);
      if (d && d.kind === "pdf") total += d.pages || 1;
    }
    return total;
  }

  // Bloqueia envios acima do limite de páginas de PDF por request do modelo
  // (600 nos modelos de 1M de contexto; 100 no Haiku). Conta SÓ as peças
  // ativas (selecionadas) — peça desmarcada sai do request e não conta mais.
  function guardaPaginas(ids) {
    if (!modelCaps) return 0;
    const total = paginasDe(ids);
    if (total > modelCaps.maxPages) {
      const dica =
        modelCaps.maxPages <= 100
          ? " Dica: o Haiku aceita só 100 páginas — nas opções da extensão, troque para o Sonnet 5 (até 600 páginas)."
          : "";
      throw new Error(
        "as peças selecionadas somam ~" + total + " páginas — acima do limite de " +
          modelCaps.maxPages + " páginas por análise deste modelo. Desmarque algumas peças e analise por partes." +
          dica
      );
    }
    return total;
  }

  // Pré-voo gratuito de tokens (count_tokens): estima o tamanho do contexto e
  // bloqueia acima de 90% da janela do modelo. Falha da estimativa não bloqueia.
  // IMPORTANTE: recebe as MESMAS tools/betas do turno — depois de uma busca, o
  // histórico contém blocos de ferramenta e o count_tokens sem as tools
  // declaradas seria rejeitado (o medidor e a guarda de 90% morreriam mudos).
  async function estimarContexto(messages, opts) {
    let r = null;
    try {
      const payload = {
        system: systemPromptAtual(),
        messages,
        betas: (opts && opts.betas) || BETAS_CHAT,
      };
      if (opts && opts.tools) payload.tools = opts.tools;
      r = await rpc({ type: "countTokens", payload });
    } catch (e) {
      // estimativa é opcional, mas a falha precisa ser diagnosticável (F12)
      console.debug("[PJe IA] count_tokens falhou:", (e && e.message) || e);
      return null;
    }
    if (!r || !r.tokens || !r.contextTokens) return null;
    const pct = Math.round((r.tokens / r.contextTokens) * 100);
    if (r.tokens > r.contextTokens * 0.9) {
      // desmarcar peça agora LIBERA contexto (o bloco sai do request) — a
      // orientação principal é desmarcar; nova conversa é o recomeço total.
      const err = new Error(
        "a conversa ocupa ~" + pct + "% do contexto da IA (" +
          Math.round(r.tokens / 1000) + " mil tokens) — não sobra espaço para a análise. " +
          "Desmarque peças na lista (elas saem do contexto na hora) ou clique em ⟲ (Nova conversa)."
      );
      err.ctxCheio = true;
      err.pct = pct;
      throw err;
    }
    return { tokens: r.tokens, ctxTokens: r.contextTokens, pct };
  }

  // A API rejeita citações reenviadas no histórico do assistant: além de
  // campos extras (ex.: file_id em page_location → 400 "Extra inputs are not
  // permitted"), ela REVALIDA os índices (document_index) contra o layout do
  // request atual — e com o anexo incremental (documentos novos entram em
  // mensagens posteriores) essa revalidação falha (400 "Invalid citation
  // indices: Document not found for placeholder citation"). O caminho robusto
  // é remover o campo `citations` dos blocos de texto antes de gravar no
  // histórico: bloco de texto sem citações é sempre válido, o texto integral
  // segue visível ao modelo e a UI mantém as citações renderizadas do turno.
  function sanearCitacoes(blocks) {
    return blocks.map((b) => {
      if (!b || b.type !== "text" || b.citations == null) return b;
      const semCit = Object.assign({}, b);
      delete semCit.citations;
      return semCit;
    });
  }

  // Remove breakpoints de cache antigos do histórico (a API aceita no máx. 4).
  function stripOldCacheControl() {
    for (const turn of conversation) {
      if (Array.isArray(turn.content)) {
        for (const block of turn.content) {
          if (block && block.cache_control) delete block.cache_control;
        }
      }
    }
  }

  // Peças de texto que serão cortadas por MAX_CHARS_TEXTO — a MESMA constante
  // que `montarBlocos` usa para cortar, para as duas leituras nunca divergirem.
  // O formato do retorno é o de `mostrarFalhasPecas` ({id, titulo, erro}).
  function pecasTruncadas(ids) {
    const out = [];
    for (const id of ids) {
      const d = docsCache.get(id);
      if (d && d.kind === "text" && d.text && d.text.length > MAX_CHARS_TEXTO) {
        out.push({
          id,
          titulo: metaDe(id).titulo,
          erro:
            "peça longa (~" +
            Math.round(d.text.length / 1000) +
            " mil caracteres): entrou só até os primeiros 60 mil",
        });
      }
    }
    return out;
  }
  // Rótulos do relatório de peças cortadas. Não pode reusar o texto padrão do
  // relatório de download: lá as peças ficaram DE FORA, aqui elas entraram —
  // pela metade, que é uma perda de outra natureza e com outra saída.
  function avisoTrunc(n) {
    return {
      titulo:
        n === 1
          ? "1 peça é longa demais e entrou cortada nesta análise"
          : n + " peças são longas demais e entraram cortadas nesta análise",
      dica:
        "Elas entraram, mas só até o corte — o que vem depois não foi lido, e o " +
        "modelo foi avisado para não afirmar que algo 'não consta' delas. Para " +
        "alcançar o restante, pergunte especificamente sobre a parte final da " +
        "peça ou use ⬇ Baixar .zip e trabalhe o documento inteiro fora da " +
        "extensão.",
    };
  }

  // ---------------------------------------------------------------------------
  // INVENTÁRIO das peças que estão na lista mas NÃO foram anexadas.
  //
  // Fecha o ciclo entre a IA e a seleção: sem ele, a resposta a "qual foi o
  // valor da perícia?" com o laudo desmarcado é um "não consta" seco, e o
  // usuário não tem como saber que a peça existe e está a um clique. Com ele, o
  // modelo devolve o id da peça para marcar.
  //
  // Vai no TEXTO DO TURNO, e não no system: a lista muda a cada refresh da
  // timeline do PJe (MutationObserver com debounce de 400 ms) e no system
  // invalidaria o cache de prefixo o tempo todo.
  //
  // E é anexado só na CÓPIA que vai à API (`prepararEnvio` já devolve uma), never
  // em `conversation`: no histórico ele se acumularia turno a turno — dez turnos
  // de uma conversa com 200 peças seriam ~20 mil tokens de listas repetidas e
  // desatualizadas, competindo com o conteúdo real.
  const INVENTARIO_MAX = 80; // acima disto, só as peças de maior relevância
  function inventarioNaoMarcadas(idsAnexados) {
    const dentro = new Set(idsAnexados);
    // Map preserva a ordem de inserção, que aqui é a da timeline do PJe — ou
    // seja, a ordem em que o usuário vê as peças na tela.
    let fora = [...docsIndex.values()].filter((d) => !dentro.has(d.id));
    if (!fora.length) return "";
    const total = fora.length;
    let cortou = false;
    if (fora.length > INVENTARIO_MAX) {
      // O critério de corte é o mesmo do atalho "principais": expediente
      // (certidão de intimação, AR, guia, procuração) não ajuda a decidir o que
      // marcar, e é justamente o que enche a lista nos processos grandes.
      const relevantes = fora.filter((d) => {
        const rel = classificarDoc(d);
        return rel !== "neutro" && rel !== "ruido";
      });
      if (relevantes.length && relevantes.length < fora.length) {
        fora = relevantes;
        cortou = true;
      }
      if (fora.length > INVENTARIO_MAX) {
        fora = fora.slice(0, INVENTARIO_MAX);
        cortou = true;
      }
    }
    return (
      "\n\n[Peças deste processo que NÃO estão anexadas — apenas id e título, " +
      "você não leu o conteúdo delas: " +
      fora.map((d) => d.titulo).join("; ") +
      "." +
      (cortou
        ? " (Listadas " + fora.length + " de " + total + "; as demais são de expediente.)"
        : "") +
      "]"
    );
  }
  // Relevância de uma peça, pela MESMA regra que classifica a lista no painel —
  // duplicar a tabela aqui garantiria que as duas divergissem com o tempo.
  // Degrada para "relevante" (nunca corta nada) se o painel não expuser a API.
  function classificarDoc(d) {
    try {
      return panel.classificarPeca(d).rel;
    } catch {
      return "relevante";
    }
  }

  // Monta os blocos das peças; marca o último com cache_control para que os
  // turnos seguintes reaproveitem o prefixo (economia de ~90% nos tokens).
  // O "title" nos blocos document permite ao modelo citar a peça pelo nome.
  // Cada bloco carrega __pecaId (campo INTERNO, removido em prepararEnvio antes
  // de qualquer request) — é o que permite desmarcar uma peça e liberá-la do
  // contexto de verdade, filtrando o bloco no reenvio do histórico.
  function montarBlocos(ids) {
    const blocks = [];
    let totalB64 = 0;
    // Peças que ficaram de fora por não ter mais conteúdo anexável (memória de
    // caso com fileId vencido). Vive no escopo do IIFE, e não no retorno, porque
    // `montarBlocos` é chamada de quatro lugares e mudar a assinatura obrigaria
    // os quatro a lidar com um segundo valor que só um deles reporta.
    semConteudo = [];
    // fileId só vale se o upload foi feito para o provedor ATUAL — um URI da
    // File API do Google num request Anthropic (ou o inverso) daria 400
    const provAtual = (modelCaps && modelCaps.provider) || "anthropic";
    for (const id of ids) {
      const d = entradaDoc(id);
      // Peça sem conteúdo no cache (download falhou) é PULADA, nunca uma
      // exceção: os chamadores já filtram, mas um TypeError aqui derrubaria o
      // turno inteiro por causa de uma peça — exatamente o que a tolerância a
      // falha de download existe para evitar.
      if (!d) continue;
      // Peça HIDRATADA da memória cujo fileId não vale mais e cujos bytes não
      // foram rebaixados: não há o que anexar. Sai da lista e é REPORTADA — um
      // `continue` mudo faria o modelo responder sobre um conjunto de peças
      // diferente do que o usuário marcou, sem nada na tela dizendo isso.
      // (Sem esta guarda o ramo de fallback faria `d.b64.length` e o TypeError
      // derrubaria o turno inteiro por causa de uma peça.)
      if (!podeAnexar(id)) {
        semConteudo.push({
          id,
          titulo: metaDe(id).titulo,
          erro: "o arquivo enviado antes não está mais disponível no provedor",
        });
        continue;
      }
      if (d.kind === "pdf") {
        if (d.fileId && (d.fileProvider || "anthropic") === provAtual) {
          // caminho normal: referência por file_id (Files API) — payload mínimo
          blocks.push({
            type: "document",
            source: { type: "file", file_id: d.fileId },
            title: metaDe(id).titulo,
            citations: { enabled: true },
            __pecaId: id,
          });
        } else {
          // fallback: base64 inline (upload indisponível)
          totalB64 += d.b64.length;
          blocks.push({
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: d.b64 },
            title: metaDe(id).titulo,
            citations: { enabled: true },
            __pecaId: id,
          });
        }
      } else if (d.kind === "img") {
        // Anexo em IMAGEM (foto do BO, print de conversa, comprovante): vai
        // como imagem mesmo — os três provedores enxergam. Antes ele caía no
        // ramo de texto de `lerCorpo` e chegava aqui como `����JFIF…`.
        //
        // DOIS blocos, e o de texto não é enfeite: a Citations API não cita
        // imagem (não há página nem trecho), então o rótulo com título e id é
        // o ÚNICO jeito de o modelo dizer de onde tirou o que viu — a regra
        // peça·id·folha vale aqui como nas outras saídas. Sem ele o modelo
        // descreve "uma foto de um boletim" sem poder apontar qual peça é.
        //
        // Os dois levam `__pecaId`: desmarcar a peça tem de remover o par
        // inteiro, senão sobra um rótulo anunciando um anexo que não foi.
        totalB64 += d.b64.length;
        blocks.push({
          type: "text",
          text: "[Peça anexada como imagem: " + metaDe(id).titulo + "]",
          __pecaId: id,
        });
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: d.mime || "image/jpeg", data: d.b64 },
          __pecaId: id,
        });
      } else {
        // peças HTML/RTF viram documento de texto puro — também citáveis.
        // O corte em MAX_CHARS_TEXTO leva o aviso junto: sem ele o modelo lê
        // uma peça pela metade sem saber disso e responde "não consta" sobre o
        // que ficou de fora — erro que a UI não tem como distinguir de acerto.
        const cortado = d.text.length > MAX_CHARS_TEXTO;
        blocks.push({
          type: "document",
          source: {
            type: "text",
            media_type: "text/plain",
            data: cortado ? d.text.slice(0, MAX_CHARS_TEXTO) + MARCA_TRUNCADO : d.text,
          },
          title: metaDe(id).titulo,
          citations: { enabled: true },
          __pecaId: id,
        });
      }
    }
    const tetoB64 =
      provAtual === "gemini"
        ? MAX_TOTAL_B64_CHARS_GEMINI
        : provAtual === "openai"
          ? MAX_TOTAL_B64_CHARS_OPENAI
          : MAX_TOTAL_B64_CHARS;
    if (totalB64 > tetoB64) {
      const mb = Math.round(totalB64 / 1024 / 1024);
      throw new Error(
        `as peças selecionadas somam ~${mb} MB — acima do limite da análise. Desmarque algumas peças maiores e tente de novo.`
      );
    }
    // Breakpoint de cache é conceito EXCLUSIVO da Anthropic; Gemini e OpenAI
    // usam cache automático (implicit) e os clientes deles nem copiariam o
    // campo — mas não sujar o histórico evita surpresas se o usuário voltar ao
    // Claude.
    if (blocks.length && provAtual === "anthropic") {
      blocks[blocks.length - 1].cache_control = { type: "ephemeral" };
    }
    return blocks;
  }

  // Prepara o histórico para envio: a API é STATELESS (o histórico inteiro é
  // remontado a cada request), então dá para filtrar os blocos document das
  // peças desmarcadas — desmarcar libera contexto de verdade, sem esperar
  // "Nova conversa". Regras:
  //  - `ativos` (Set de ids) mantém só as peças marcadas; null mantém todas.
  //  - o campo interno __pecaId NUNCA vai para a API (rejeitaria campo extra).
  //  - blocos do assistant (thinking assinado, ferramentas) não são tocados —
  //    só turnos de usuário carregam __pecaId.
  // Custo aceito: mudar a seleção invalida o cache de prefixo daquele ponto em
  // diante (mesma regra já aceita para o toggle de busca/troca de modelo).
  function prepararEnvio(msgs, ativos) {
    return msgs.map((t) => {
      if (!Array.isArray(t.content)) return t;
      const content = [];
      for (const b of t.content) {
        if (b && b.__pecaId != null) {
          if (ativos && !ativos.has(b.__pecaId)) continue; // peça desmarcada: fora do request
          const limpo = Object.assign({}, b);
          delete limpo.__pecaId;
          content.push(limpo);
        } else {
          content.push(b);
        }
      }
      return { role: t.role, content };
    });
  }

  // Acrescenta o inventário de peças não anexadas ao ÚLTIMO bloco de texto do
  // último turno do usuário. Opera sobre a saída de `prepararEnvio`, que já é
  // uma cópia — por isso `conversation` nunca vê o inventário e ele não se
  // acumula no histórico.
  function comInventario(msgs, idsAnexados) {
    const txt = inventarioNaoMarcadas(idsAnexados);
    if (!txt || !msgs.length) return msgs;
    const i = msgs.length - 1;
    const ultima = msgs[i];
    if (ultima.role !== "user") return msgs;
    if (typeof ultima.content === "string") {
      return msgs
        .slice(0, i)
        .concat([{ role: "user", content: ultima.content + txt }]);
    }
    if (!Array.isArray(ultima.content)) return msgs;
    // o último bloco de texto é o da pergunta; os anteriores são as peças
    let alvo = -1;
    for (let k = ultima.content.length - 1; k >= 0; k--) {
      if (ultima.content[k] && ultima.content[k].type === "text") {
        alvo = k;
        break;
      }
    }
    if (alvo < 0) return msgs;
    const content = ultima.content.map((b, k) =>
      k === alvo ? Object.assign({}, b, { text: b.text + txt }) : b
    );
    return msgs.slice(0, i).concat([{ role: "user", content }]);
  }

  // Peças que a RESPOSTA citou como faltantes: ids que o modelo escreveu no
  // texto (tipicamente num aviso "o comprovante está na peça 214661494, que não
  // foi anexada") mas que NÃO estão no contexto. Viram botões de "adicionar"
  // abaixo da bolha — o modelo já apontou a peça, o clique poupa procurá-la.
  //
  // Só entram ids que são peça REAL desta timeline (`docsIndex`): comparar
  // contra ela é o que elimina os falsos positivos (um valor, uma data, um
  // número de lei que por acaso tenha 6+ dígitos quase nunca casa um id real).
  // Já-no-contexto (marcadas ou no histórico) ficam de fora. Teto de sanidade.
  function pecasCitadasFaltantes(texto) {
    if (!texto) return [];
    const jaTem = new Set([...selecaoEfetiva(), ...pecasNaConversa]);
    const vistos = new Set();
    const out = [];
    const re = /\d{6,}/g;
    let m;
    while ((m = re.exec(texto))) {
      const id = m[0];
      if (vistos.has(id)) continue;
      vistos.add(id);
      if (!docsIndex.has(id) || jaTem.has(id)) continue;
      out.push({ id, titulo: metaDe(id).titulo });
      if (out.length >= 12) break;
    }
    return out;
  }

  // Abre um canal com o worker e resolve quando o turno termina.
  // Resolve com {content, stopReason}: os blocos completos da resposta
  // (necessários no histórico para citações, ferramentas e thinking assinado).
  //
  // AUTO-RESUME: o service worker pode MORRER no meio de um turno longo (o
  // MV3 mata o worker por várias razões, mesmo com keepalive; recarregar a
  // extensão também mata) — a porta cai sem "done"/"error". O turno é
  // STATELESS (o payload remonta tudo), então reconectamos e reenviamos
  // sozinhos, até 2 vezes: o prefixo já está no cache de prompt e a
  // repetição custa uma fração. handlers.onReinicio(n) zera a UI do turno
  // (o novo envio re-streama tudo desde o início).
  function stream(messages, handlers, opts, tipo) {
    const MAX_REENVIOS = 2;
    return new Promise((resolve, reject) => {
      let reenvios = 0;

      function abrir() {
        if (!extensaoViva()) return reject(new Error(MSG_CTX_PERDIDO));
        let port;
        try {
          port = chrome.runtime.connect({ name: "claude" });
        } catch {
          avisarContextoPerdido();
          return reject(new Error(MSG_CTX_PERDIDO));
        }
        let finished = false;
        let recuperando = false; // recuperação (watchdog OU onDisconnect) já disparada
        let cao = null; // timer do watchdog
        // Ping periódico: receber mensagem pela porta reseta o timer de
        // ociosidade do service worker (MV3 mata o worker após ~30 s sem
        // eventos — fatal em turnos longos, que ficam muito tempo em silêncio).
        const ping = setInterval(() => {
          try {
            port.postMessage({ type: "ping" });
          } catch {
            clearInterval(ping);
          }
        }, 15000);
        function limpar() {
          clearInterval(ping);
          clearTimeout(cao);
        }
        // Centraliza a reconexão: chamada pelo onDisconnect (o worker fechou a
        // porta) E pelo watchdog (porta aberta, worker zumbi). Como
        // port.disconnect() do NOSSO lado não dispara nosso onDisconnect, o
        // watchdog precisa chamar isto direto. `recuperando` evita disparo duplo.
        function recuperar(motivo) {
          if (finished || recuperando) return;
          recuperando = true;
          limpar();
          // worker morto no meio do turno: reenvia do zero (payload intacto)
          if (reenvios < MAX_REENVIOS && extensaoViva()) {
            reenvios++;
            console.debug(
              "[PJe IA] serviço " +
                (motivo === "watchdog" ? "sem resposta (watchdog)" : "caiu") +
                " no meio do turno — reenviando (" + reenvios + "/" + MAX_REENVIOS + ")"
            );
            if (handlers.onReinicio) handlers.onReinicio(reenvios);
            setTimeout(abrir, 1200); // respiro para o worker renascer
          } else {
            reject(new Error("conexão com o serviço interrompida — tente de novo"));
          }
        }
        // Watchdog do worker ZUMBI: o service worker MV3 pode parar de executar
        // com a porta AINDA aberta — aí nem onMessage nem onDisconnect chegam e o
        // turno ficaria preso para sempre ("processa, mas não navega"). O ping é
        // respondido com "pong" pelo worker VIVO (inclusive no meio de um turno
        // longo e silencioso); se passar WATCHDOG_MS sem NENHUMA mensagem (nem
        // pong, nem delta) tratamos como morto e reconectamos. 40 s dá folga
        // sobre o intervalo de ping de 15 s (2+ pongs perdidos) para não matar
        // um worker vivo porém quieto.
        const WATCHDOG_MS = 40000;
        function rearmarCao() {
          clearTimeout(cao);
          cao = setTimeout(() => {
            try {
              port.disconnect();
            } catch {}
            recuperar("watchdog");
          }, WATCHDOG_MS);
        }
        port.onMessage.addListener((m) => {
          rearmarCao(); // qualquer mensagem do worker = prova de vida
          if (m.type === "pong") return; // heartbeat: já rearmou o watchdog
          if (m.type === "delta") handlers.onDelta(m.text);
          else if (m.type === "thinking") handlers.onThinking(m.text);
          else if (m.type === "citation") handlers.onCitation && handlers.onCitation(m.citation);
          else if (m.type === "tool") handlers.onTool && handlers.onTool(m.name, m.input);
          else if (m.type === "file") handlers.onFile && handlers.onFile(m);
          else if (m.type === "trunc") handlers.onTrunc();
          // "iter": novo request físico do turno (checkpoint do texto na UI);
          // "retry": o worker vai re-tentar o request após erro transitório —
          // descartar o que chegou DEPOIS do último checkpoint (evita duplicar)
          else if (m.type === "iter") handlers.onIter && handlers.onIter();
          else if (m.type === "retry") handlers.onRetry && handlers.onRetry();
          else if (m.type === "done") {
            finished = true;
            limpar();
            port.disconnect();
            resolve({
              content: m.content || [],
              stopReason: m.stopReason || null,
              usage: m.usage || null,
              usageReq: m.usageReq || null,
              custoUsd: m.custoUsd == null ? null : m.custoUsd,
            });
          } else if (m.type === "error") {
            finished = true;
            limpar();
            port.disconnect();
            reject(new Error(m.error));
          }
        });
        port.onDisconnect.addListener(() => {
          if (finished) return limpar();
          recuperar("disconnect");
        });
        rearmarCao(); // arma o watchdog já na conexão
        port.postMessage({
          type: tipo || "chat",
          payload: Object.assign(
            { system: systemPromptAtual(), messages, betas: BETAS_CHAT },
            opts || {}
          ),
        });
      }

      abrir();
    });
  }

  // Dispara o download de um Blob no navegador (âncora com `download`; SEM a
  // permissão "downloads", que mudaria o aviso de instalação da Web Store).
  // Usado pelo markdown do mapa e da minuta e pelo .zip das peças.
  function baixarBlob(filename, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    // A revogação precisa de folga: o Chrome lê o blob DEPOIS do clique, e um
    // .zip de centenas de MB leva um tempo perceptível para ser gravado.
    setTimeout(() => URL.revokeObjectURL(url), 120000);
  }

  function baixarTexto(filename, texto, mime) {
    baixarBlob(filename, new Blob([texto], { type: mime || "text/plain;charset=utf-8" }));
  }

  // Rótulo humano de uma citação da API: "Peça, fl(s). X[–Y]" (fim exclusivo)
  // para PDFs; título do site (com link) para resultados da busca web;
  // para documentos de texto (char_location) não há página — sobra o trecho.
  // O `id` sai como campo PRÓPRIO (não colado no rótulo): é ele que o painel usa
  // para tornar a citação clicável (rola a timeline até a peça). O id vem de
  // graça no document_title, que é o `title` que montarBlocos enviou.
  // Redirecionadores de busca. O Gemini NÃO devolve a URL da fonte: devolve um
  // link opaco do Vertex (vertexaisearch.cloud.google.com/grounding-api-redirect/…)
  // que só resolve no clique. Medido no smoke test real — e ali o `title` traz o
  // domínio verdadeiro ("stj.jus.br"), que é justamente o que o usuário precisa
  // ver antes de clicar. Sem esta correção o rodapé anunciaria "google.com" numa
  // resposta cuja fonte é o STJ, e a etiqueta de nível cairia sempre em "outra".
  const REDIRECIONADORES = ["vertexaisearch.cloud.google.com"];
  function hostDeUrl(u) {
    try {
      return new URL(u).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  }
  function hostDaFonte(c) {
    const h = hostDeUrl(c.url);
    const opaco = !h || REDIRECIONADORES.some((r) => h === r || h.endsWith("." + r));
    if (!opaco) return h;
    // O `title` só pode virar host se ELE for um domínio (caso Gemini). Na
    // Anthropic e na OpenAI o title é a manchete da página ("Bem de família do
    // fiador…") e usá-lo como origem seria inventar um domínio.
    const t = String(c.title || "").trim();
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(t)) return t.replace(/^www\./, "");
    return h;
  }

  function infoCitacao(c) {
    if (c.type === "web_search_result_location") {
      const host = hostDaFonte(c);
      return {
        label: c.title || host || c.url || "fonte na web",
        url: c.url,
        host: host || undefined,
        nivel: host ? nivelFonte(host) : undefined,
      };
    }
    const bruto = String(c.document_title || "");
    const id = (bruto.match(/^(\d{6,})\s*-\s*/) || [])[1] || null;
    const doc = tituloLimpo(bruto) || "peça";
    if (c.type === "page_location") {
      const ini = c.start_page_number;
      const fim = (c.end_page_number || ini + 1) - 1;
      return {
        label: doc + (fim > ini ? ", fls. " + ini + "–" + fim : ", fl. " + ini),
        id,
      };
    }
    // char_location (peça HTML/RTF): a API não devolve página, então a única
    // âncora é o próprio trecho citado.
    const trecho = String(c.cited_text || "").replace(/\s+/g, " ").trim();
    return { label: doc, id, trecho: trecho.slice(0, 300) || undefined };
  }
  function tituloLimpo(t) {
    return String(t || "").replace(/^\d{6,}\s*-\s*/, "");
  }
  function chaveCitacao(c) {
    if (c.type === "web_search_result_location") return "web:" + (c.url || c.title || "");
    return [
      c.type,
      c.document_index,
      c.start_page_number != null ? c.start_page_number : c.start_char_index,
      c.end_page_number != null ? c.end_page_number : c.end_char_index,
    ].join(":");
  }

  // Ferramentas/betas do turno atual: busca web quando o toggle está ligado —
  // e, uma vez usada na conversa, nos turnos seguintes também (histórico com
  // blocos de ferramenta exige as tools declaradas, inclusive no count_tokens).
  function optsDoTurno() {
    const opts = {};
    if ((panel.isSearchOn() || buscaNaConversa) && modelCaps) {
      opts.tools = toolsBusca();
      opts.betas = BETAS_CHAT.concat(
        modelCaps.webFetch === "web_fetch_20250910" ? ["web-fetch-2025-09-10"] : []
      );
    }
    return opts;
  }

  // Baixa em silêncio (sem card de preparo) as peças que faltam no cache, com
  // concorrência 3 (a mesma do envio). Usado pela estimativa dinâmica: o
  // download de agora vira PREFETCH — o envio reaproveita o cache e fica mais
  // rápido. Falha em uma peça não interrompe (ela só fica fora da estimativa;
  // o envio tenta de novo com erro visível). onProgresso(feitas, total) deixa
  // o usuário ver o andamento em seleções grandes.
  async function baixarQuieto(ids, onProgresso) {
    // `precisaBaixar` e não `!has`: peça hidratada da memória com fileId vivo
    // (ou de texto) já está pronta para o request — pedi-la ao PJe gastaria a
    // fila serializada para não mudar nada.
    const fila = ids.filter(precisaBaixar);
    if (!fila.length) return;
    const total = fila.length;
    let feitas = 0;
    async function w() {
      while (fila.length) {
        const id = fila.shift();
        try {
          await garantirBaixada(id);
        } catch (e) {
          console.debug("[PJe IA] estimativa: peça", id, "não baixou:", e && e.message);
        }
        feitas++;
        if (onProgresso) onProgresso(feitas, total);
      }
    }
    await Promise.all([w(), w(), w()]);
  }

  // ---------------------------------------------------------------------------
  // Medidor DINÂMICO de contexto em DUAS camadas — o clique não pode esperar
  // download nem rede:
  //  1) estimativa LOCAL instantânea (0 ms): heurística sobre o que já está em
  //     cache — PDF ≈ páginas × 2000 tokens (texto+imagem), texto ≈ chars/3,5.
  //     Atualiza a barrinha a cada clique e a cada peça baixada.
  //  2) refinamento PRECISO em segundo plano (debounce): baixa o que falta
  //     (prefetch p/ o envio), sobe PDFs à Files API (count e envio ficam
  //     leves, por file_id) e corrige o número com count_tokens (gratuito).
  // Alerta de contexto cheio só pela medição precisa (a local é aproximada).
  // ---------------------------------------------------------------------------
  const TOKENS_POR_PAGINA_PDF = 2000; // ordem de grandeza da API p/ PDF citável
  const CHARS_POR_TOKEN = 3.5;
  // Acima deste nº de peças AINDA NÃO baixadas, a medição em segundo plano não
  // dispara downloads (ex.: "todas" marcadas — o PJe ativa peça a peça de forma
  // serializada, levaria minutos). Fica a estimativa local parcial; a medição
  // completa acontece no envio, com o card de progresso visível.
  const LIMIAR_PREFETCH = 12;

  function estimativaLocalTokens(ids) {
    // system prompt + instruções fixas + instruções personalizadas do usuário
    let t = 900 + Math.ceil(customPrompt.length / CHARS_POR_TOKEN);
    // custo por página varia por provedor: Anthropic ≈ 2000 (texto+imagem
    // citável); Gemini = 258 (documentação oficial) — vem do caps
    const tokensPagina =
      (modelCaps && modelCaps.tokensPagina) || TOKENS_POR_PAGINA_PDF;
    for (const id of ids) {
      const d = entradaDoc(id); // peça (docsCache) ou anexo do input
      // peça ainda não baixada: entra na conta quando o download chegar.
      // Contá-la como 0 seria pior — o gauge afirmaria um tamanho que não é o
      // do envio (por isso o gauge também mostra quantas ficaram sem medir).
      if (!d) continue;
      if (d.kind === "img") {
        t += tokensImagem(d);
      } else if (d.kind === "pdf") {
        t += (d.pages || 1) * tokensPagina;
      } else if (d.text) {
        t += Math.ceil(Math.min(d.text.length, MAX_CHARS_TEXTO) / CHARS_POR_TOKEN);
      }
      // Peça de texto sem `text` é a hidratada cujo conteúdo passou do teto de
      // sanidade do banco: só metadados voltaram. Some da conta como uma peça
      // ainda não baixada — que é o que ela é.
    }
    for (const turn of conversation) {
      if (typeof turn.content === "string") {
        t += Math.ceil(turn.content.length / CHARS_POR_TOKEN);
        continue;
      }
      for (const b of turn.content) {
        if (!b) continue;
        // blocos de peça: já contados acima (marcadas) ou fora do request
        if (b.__pecaId != null || b.type === "document") continue;
        if (b.type === "text") t += Math.ceil((b.text || "").length / CHARS_POR_TOKEN);
        else t += Math.ceil(JSON.stringify(b).length / 4); // thinking/ferramentas
      }
    }
    return t;
  }

  // Depois de um turno bem-sucedido, o usage do ÚLTIMO request físico é a
  // medição EXATA do contexto (entrada + cache + resposta que acabou de entrar
  // no histórico) — atualiza o medidor de graça, sem novo count_tokens.
  function atualizarGaugePosTurno(fim, ids) {
    const u = fim && fim.usageReq;
    if (!u || !modelCaps) return;
    const tokens =
      (u.input_tokens || 0) +
      (u.cache_creation_input_tokens || 0) +
      (u.cache_read_input_tokens || 0) +
      (u.output_tokens || 0);
    if (!tokens) return;
    // Medição EXATA e de graça deste estado. Além do medidor, é o que permite
    // dispensar o count_tokens do próximo turno quando a folga é larga.
    ultimoTotalExato = tokens;
    panel.setContexto({
      tokens,
      ctxTokens: modelCaps.contextTokens,
      paginas: paginasDe(ids),
      maxPaginas: modelCaps.maxPages,
      pecas: ids.length,
    });
    // medição real deste estado: refreshs da timeline não precisam re-medir
    ultimaChaveEst = ids.slice().sort().join(",") + "|" + conversation.length;
  }

  // Fração da janela abaixo da qual o pré-voo não tem o que decidir. 60% deixa
  // 40% de margem para a estimativa local errar — ela erra para MAIS nos PDFs
  // (2000 tokens/página é o teto da ordem de grandeza), que é o lado seguro.
  const LIMIAR_PULAR_PREVOO = 0.6;

  function podePularPreVoo(ids) {
    if (!modelCaps || !modelCaps.contextTokens) return false;
    // sem uma medição EXATA anterior não há base de comparação
    if (!ultimoTotalExato) return false;
    // Peça selecionada sem conteúdo em cache não entra na estimativa local
    // (estimativaLocalTokens a pula de propósito, para não fingir precisão) —
    // e o que não é medido não pode ser dispensado da medição.
    if (ids.some((id) => !docsCache.has(id))) return false;
    // o maior entre o que o request anterior custou de fato e o que este deve
    // custar: a estimativa local sozinha subestimaria thinking e ferramentas
    const base = Math.max(ultimoTotalExato, estimativaLocalTokens(ids));
    return base < modelCaps.contextTokens * LIMIAR_PULAR_PREVOO;
  }

  function mostrarEstimativaLocal(ids) {
    if (!modelCaps) return;
    panel.setContexto({
      tokens: estimativaLocalTokens(ids),
      ctxTokens: modelCaps.contextTokens,
      paginas: paginasDe(ids),
      maxPaginas: modelCaps.maxPages,
      pecas: ids.length,
      // peças ainda sem download não têm medida — o gauge avisa em vez de
      // fingir precisão. Anexos do input já vêm com o conteúdo em mãos, então
      // nunca contam como "sem medir".
      pendentes: ids.filter((id) => !docsCache.has(id) && !anexos.has(id)).length,
    });
  }

  panel.onSelectionChange((ids) => {
    clearTimeout(estTimer);
    // A seleção é trabalho do usuário: marcar 30 peças à mão e perdê-las ao
    // fechar a aba é a mesma perda que a conversa. Vai antes da guarda de
    // `busy` porque `agendarSalvar` já não faz nada durante um turno — e ali
    // quem grava é o `finally`.
    agendarSalvar();
    // Durante um turno o ENVIO é dono do medidor: refreshs da timeline do PJe
    // disparam syncSelection sem mudança real e sobrescreveriam a medição
    // oficial com uma estimativa local defasada.
    if (busy) return;
    if (!ids.length && !conversation.length) {
      estSeq++; // cancela estimativas em voo
      panel.setContexto(null); // nada selecionado e nada conversado: sem medidor
      return;
    }

    // Camada 1: resposta IMEDIATA ao clique, com o que já se sabe localmente.
    if (modelCaps) mostrarEstimativaLocal(ids);
    else garantirCaps().then(() => !busy && mostrarEstimativaLocal(ids));

    // Camada 2: refinamento em segundo plano (downloads + uploads + count).
    estTimer = setTimeout(() => refinarContexto(ids), 900);
  });

  // Camada 2 da medição, disparada pela mudança de seleção (com debounce,
  // Prefetch de seleções grandes, em lotes e cancelável.
  //
  // Ordem: peças de maior relevância primeiro. Se o usuário interromper (ou o
  // envio começar), o que já baixou é justamente o que mais importa — e é o que
  // o envio vai precisar primeiro de qualquer forma.
  const LOTE_PREFETCH = 4;
  async function prefetchProgressivo(ids, faltam, seq) {
    const peso = { essencial: 0, relevante: 1, neutro: 2, ruido: 3 };
    const fila = faltam
      .map((id) => ({ id, p: peso[classificarDoc(metaDe(id))] ?? 1 }))
      .sort((a, b) => a.p - b.p)
      .map((x) => x.id);

    let feitas = 0;
    const total = fila.length;
    while (fila.length) {
      // Cede ANTES de cada lote: `busy` cobre o envio (que passa a ser dono do
      // download) e `estSeq` cobre uma nova seleção. Sem esta guarda o
      // prefetch competiria com o turno pela sessão JSF, que é serializada.
      if (seq !== estSeq || busy || exportando) {
        panel.setStatus("");
        return;
      }
      const lote = fila.splice(0, LOTE_PREFETCH);
      await baixarQuieto(lote);
      feitas += lote.length;
      if (seq !== estSeq || busy || exportando) {
        panel.setStatus("");
        return;
      }
      mostrarEstimativaLocal(ids);
      panel.setStatus(
        fila.length
          ? "Adiantando o download das peças (" + feitas + "/" + total + ") — pode " +
            "escrever a pergunta normalmente."
          : "",
        !!fila.length
      );
    }
    // Baixou tudo: agora a medição exata cabe, e ela é barata (as peças já
    // estão em cache e serão referenciadas por file_id).
    if (seq === estSeq && !busy && !exportando) refinarContexto(ids);
  }

  // acima).
  async function refinarContexto(ids) {
    // `exportando` entra aqui, e não na guarda de cima: a estimativa LOCAL
    // (camada 1) é de graça e pode continuar durante a exportação, mas este
    // refinamento BAIXA peças — e a exportação já está usando a sessão JSF,
    // que é serializada. Duas frentes de download só se atrapalhariam, e as
    // ativações da própria exportação re-disparam este handler o tempo todo.
    if (busy || exportando) return;
    // mesma seleção e mesma conversa da última medição precisa: pula
    const chave = ids.slice().sort().join(",") + "|" + conversation.length;
    if (chave === ultimaChaveEst) return;
    const seq = ++estSeq;
    try {
      await garantirCaps();
      const faltam = ids.filter(precisaBaixar);
      if (faltam.length > LIMIAR_PREFETCH) {
        // SELEÇÃO GRANDE (ex.: "principais" com 40 peças, ou "todas").
        //
        // Medir tudo aqui levaria minutos — o PJe serializa a entrega. Mas
        // parar por completo desperdiçava o tempo mais valioso do fluxo: o
        // usuário leva de meio a um minuto escrevendo a pergunta, e nesse
        // intervalo nada era baixado; o envio pagava a fila inteira do zero.
        //
        // Então baixamos um LOTE por vez, em ordem de relevância, cedendo a
        // qualquer sinal de que o usuário agiu (nova seleção, envio,
        // exportação). O que baixar entra no cache e o envio reaproveita; o
        // que não baixar, o envio busca com o card de progresso visível — o
        // comportamento de antes, nunca pior.
        mostrarEstimativaLocal(ids);
        await prefetchProgressivo(ids, faltam, seq);
        return;
      }
      // baixa o que falta; a barrinha sobe a cada peça que chega
      await baixarQuieto(ids, (feitas, total) => {
        if (seq !== estSeq || busy) return;
        panel.setStatus("Medindo o contexto… baixando peças (" + feitas + "/" + total + ")", true);
        mostrarEstimativaLocal(ids);
      });
      if (seq !== estSeq || busy) return;
      // sobe os PDFs à Files API JÁ na medição: o count_tokens referencia
      // por file_id (payload mínimo) e o envio reaproveita o upload
      await subirPecas(ids);
      if (seq !== estSeq || busy) return;
      panel.setStatus("Calculando o tamanho exato do contexto…", true);

      // request PROSPECTIVO: histórico filtrado + um turno de rascunho com
      // as peças novas (as que ainda não têm blocos no histórico)
      const ativos = new Set(ids);
      // `podeAnexar` e não `has`: uma peça hidratada sem conteúdo utilizável
      // entraria em `montarBlocos` logo abaixo, que a descartaria — e no
      // caminho antigo (b64 ausente) estouraria um TypeError DENTRO deste try,
      // matando a medição em silêncio e deixando o medidor congelado.
      const novas = ids.filter((id) => !pecasNaConversa.has(id) && podeAnexar(id));
      const rascunho = [...conversation];
      if (novas.length) {
        rascunho.push({
          role: "user",
          content: [...montarBlocos(novas), { type: "text", text: "…" }],
        });
      }
      const msgs = prepararEnvio(rascunho, ativos);
      if (!msgs.length) {
        panel.setStatus("");
        panel.setContexto(null);
        return;
      }

      const est = await estimarContexto(msgs, optsDoTurno());
      if (seq !== estSeq || busy) return;
      panel.setStatus("");
      if (est) {
        ultimaChaveEst = chave; // só memoriza medição que deu certo
        panel.setAlerta(null); // coube: alerta anterior se resolve sozinho
        panel.setContexto({
          tokens: est.tokens,
          ctxTokens: est.ctxTokens,
          paginas: paginasDe(ids),
          maxPaginas: modelCaps ? modelCaps.maxPages : 0,
          pecas: ids.length,
        });
      }
    } catch (e) {
      if (seq !== estSeq || busy) return;
      panel.setStatus("");
      if (e && e.ctxCheio) {
        ultimaChaveEst = ""; // com alerta ligado, a próxima mudança SEMPRE re-mede
        panel.setAlerta(ALERTA_CTX_CHEIO);
        alertaTrocaLigado = false; // o alerta visível agora é o de contexto
      } else {
        console.debug("[PJe IA] estimativa dinâmica falhou:", e && e.message);
      }
    }
  }

  // Exportação e turno disputariam a MESMA sessão JSF (o download do PJe é
  // serializado). Em vez de deixar os dois se atrapalharem em silêncio — com o
  // usuário vendo só lentidão —, o segundo é recusado com o motivo.
  function bloqueadoPelaExportacao() {
    if (!exportando) return false;
    panel.setStatus("Exportação em andamento. Aguarde o .zip terminar ou clique em Cancelar.");
    return true;
  }

  panel.onSend(async (text, selectedIdsDoPainel) => {
    if (busy || bloqueadoPelaExportacao()) return;
    // A seleção do turno é a EFETIVA (checkboxes + peças restauradas cuja row a
    // timeline lazy ainda não criou) — ver `selecaoEfetiva`.
    const selectedIds = selecaoEfetiva().length
      ? selecaoEfetiva()
      : selectedIdsDoPainel;
    // Anexos do input que ainda não foram enviados (delta deste turno).
    const anexosNovos = anexosPendentes.slice();
    // A guarda só vale para conversa NOVA e SEM anexo. Com peças já no histórico,
    // perguntar sem marcar nada é legítimo — e numa conversa RETOMADA cujas rows
    // ainda não carregaram era o caso comum: o usuário via a conversa de volta,
    // digitava e levava um "marque ao menos uma peça" sobre um processo que ele
    // acabara de ver analisado. Um anexo no input também basta: dá para trabalhar
    // só com os arquivos anexados, sem marcar peça nenhuma.
    if (selectedIds.length === 0 && !pecasNaConversa.size && !anexosNovos.length) {
      panel.setStatus("Marque uma peça, anexe um arquivo (📎) ou digite @ para citar uma peça.");
      return;
    }
    // Troca de provedor no meio da conversa: bloqueia ANTES de qualquer
    // mudança de estado (o histórico de um provedor não roda no outro).
    // aplicarCapsNaUI já liga o alerta na troca do modelo; esta é a guarda
    // dura para o caso de o envio chegar antes do refresh de caps.
    const provTurno = (modelCaps && modelCaps.provider) || "anthropic";
    if (conversation.length && conversaProvider && provTurno !== conversaProvider) {
      panel.setAlerta(ALERTA_TROCA_PROVEDOR);
      alertaTrocaLigado = true;
      return;
    }
    busy = true;
    clearTimeout(estTimer);
    estSeq++; // o envio faz a estimativa oficial — mata estimativas em voo

    // Anexo INCREMENTAL: só as peças (e anexos) que ainda não estão no histórico
    // entram neste turno. Os já enviados continuam valendo (fazem parte do
    // prefixo cacheado da conversa) — reanexá-los duplicaria páginas e tokens.
    const novas = selectedIds.filter((id) => !pecasNaConversa.has(id));
    const attach = novas.length > 0 || anexosNovos.length > 0;
    // mostra na mensagem o que ENTRA no contexto neste turno — peças e anexos
    const atts = attach
      ? [
          ...novas.map((id) => metaDe(id).titulo),
          ...anexosNovos.map((id) => "📎 " + metaDe(id).titulo),
        ]
      : null;
    panel.addMessage("user", text, atts);
    panel.lockInput(true);
    panel.setStatus("");

    let assistantEl = null;
    let acc = "";
    let truncated = false;
    // Peças que de fato entraram neste turno (o download pode falhar em
    // algumas) e o relatório do que ficou de fora.
    let anexadas = novas;
    let falhasDownload = [];

    try {
      await garantirCaps(); // limites do modelo antes de qualquer validação
      // Conversa retomada da memória: as referências de upload dos turnos
      // ANTERIORES podem ter expirado. Isto roda antes do download das peças
      // novas e, no caminho normal (nada a revalidar), custa uma varredura do
      // histórico e mais nada.
      // Mesmo conjunto que o filtro do histórico usa (ver `selecaoEfetiva`):
      // revalidar por `selectedIds` puro deixaria de fora justamente as peças
      // cujas rows a timeline lazy ainda não trouxe — que são as que o request
      // vai carregar por referência.
      await revalidarPecasDoHistorico(new Set(selecaoEfetiva()));
      let userContent;
      let paginas = 0;
      if (attach && novas.length) {
        const r = await baixarSelecionadas(novas);
        anexadas = r.ok;
        falhasDownload = r.falhas;
      } else {
        anexadas = [];
      }
      // Peça que falha no download NÃO pode travar o próximo turno: ela é tirada
      // da seleção mais abaixo (`desmarcarPecas`), então aqui só decidimos se há
      // algo a analisar. "Nada baixou" só derruba o turno quando não há mais nada
      // — nem histórico, nem anexo —; do contrário seguimos com o que existe e as
      // falhas viram relatório (o usuário não perde a pergunta que já digitou).
      const idsNovosParaBlocos = [...anexadas, ...anexosNovos];
      if (!idsNovosParaBlocos.length && !pecasNaConversa.size) {
        throw new Error(
          falhasDownload.length === 1
            ? 'não foi possível baixar "' + falhasDownload[0].titulo + '" — ' + falhasDownload[0].erro
            : falhasDownload.length
              ? "nenhuma das " + falhasDownload.length + " peças novas pôde ser baixada"
              : "não há peça marcada nem arquivo anexado para analisar"
        );
      }
      if (idsNovosParaBlocos.length) {
        // a guarda conta TUDO que vai no request: peças ativas + todos os anexos
        // do contexto (não só os novos deste turno — os já enviados seguem no
        // request pelo histórico).
        paginas = guardaPaginas([...selectedIds, ...anexos.keys()]);
        await subirPecas(anexadas);
        await subirAnexos(anexosNovos);
        stripOldCacheControl();
        userContent = [...montarBlocos(idsNovosParaBlocos), { type: "text", text }];
      } else {
        // Acompanhamento sem peça/anexo novo (ou todas as novas falharam, mas há
        // histórico): segue com o contexto já anexado.
        paginas = guardaPaginas([...selectedIds, ...anexos.keys()]);
        userContent = text;
      }

      // Busca de jurisprudência (ver optsDoTurno). Nunca combinamos ferramentas
      // web com code_execution no mesmo request (as versões _20260209 já
      // embutem execução para filtragem dinâmica).
      const opts = optsDoTurno();

      // O request de fato: histórico + turno novo, SEM os blocos das peças
      // desmarcadas (prepararEnvio filtra por __pecaId) e sem campos internos.
      //
      // `selecaoEfetiva` e não `selectedIds`, e a diferença é a que separa
      // "desmarcada" de "ainda não apareceu": a timeline do PJe é LAZY, então
      // ao reabrir um processo boa parte das rows não existe no DOM e os
      // checkboxes correspondentes não podem estar marcados. Filtrar por
      // `selectedIds` puro mandaria o histórico da conversa retomada SEM
      // NENHUMA das peças que o usuário havia anexado — a IA responderia sobre
      // um processo vazio, e nada na tela diria isso. As pendentes entram
      // porque o usuário não as desmarcou; desmarcar de verdade continua
      // liberando contexto, porque o id sai do `selPendente` ao ser aplicado.
      // Os anexos do input entram SEMPRE em `ativos`: seus blocos carregam
      // `__pecaId` (o id sintético) para o chip poder liberá-los do contexto
      // como uma peça desmarcada, mas enquanto estão anexados eles não são
      // "peça desmarcada" — sem isto `prepararEnvio` os filtraria do histórico já
      // no segundo turno. Removê-los é ação explícita do usuário (o ✕ do chip
      // tira o id de `anexos`, e aí este filtro passa a valer para eles também).
      const ativos = new Set([...selecaoEfetiva(), ...anexos.keys()]);
      // O inventário entra AQUI, na cópia que vai à API — antes do count_tokens,
      // para o pré-voo medir exatamente o request que será enviado.
      const msgsEnvio = comInventario(
        prepararEnvio(
          [...conversation, { role: "user", content: userContent }],
          ativos
        ),
        selectedIds
      );

      // PRÉ-VOO CONDICIONAL. O count_tokens custa uma ida e volta à API e, num
      // turno sem peça nova (a pergunta de acompanhamento), é o ÚNICO bloqueio
      // antes do stream — ou seja, 100% do tempo que o usuário percebe entre o
      // Enter e o primeiro token.
      //
      // Ele existe para uma coisa: barrar o envio acima de 90% da janela. Quando
      // o turno anterior deixou uma medição EXATA (o usage do último request
      // físico, que já vem de graça) e a estimativa local do que foi acrescido
      // desde então mantém tudo muito abaixo do limite, não há o que barrar — a
      // guarda de 90% e o tratamento de model_context_window_exceeded seguem
      // como rede se a conta estiver errada.
      let est = null;
      // Anexo novo é conteúdo que a medição exata anterior não viu: nunca pular o
      // pré-voo quando há um (o que não foi medido não pode ser dispensado).
      const pulouPreVoo = !anexosNovos.length && podePularPreVoo(selectedIds);
      if (pulouPreVoo) {
        console.debug("[PJe IA] pré-voo pulado: folga larga sobre a medição exata anterior");
      } else {
        panel.setStatus("Estimando o tamanho do contexto…", true);
        est = await estimarContexto(msgsEnvio, opts);
      }
      if (novas.length) panel.endPrep(); // confirma "peças anexadas" após validar limites
      // Relatório do que ficou de fora. Fica NO CHAT (não no .status, que é
      // transitório): o usuário precisa poder ler com calma, ver o motivo de
      // cada peça e tentar de novo depois — sem que a análise que ele pediu
      // tenha sido perdida no caminho.
      //
      // E a peça que falhou é TIRADA DA SELEÇÃO (desmarcada): é o que impede o
      // bug de ela travar o próximo turno. Como ela nunca entrou no histórico,
      // seguir marcada só a faria ser re-tentada a cada envio — e quando fosse a
      // única peça "nova", o turno seguinte abortava inteiro, obrigando o usuário
      // a caçar e desmarcar a peça à mão. Desmarcá-la aqui é fazer por ele o que
      // ele teria de fazer; o aviso diz que ela saiu e como reanexar (marcar de
      // novo = nova tentativa de download).
      if (falhasDownload.length) {
        panel.mostrarFalhasPecas(falhasDownload, {
          dica:
            "Para não travar a conversa, " +
            (falhasDownload.length === 1 ? "a peça foi retirada" : "as peças foram retiradas") +
            " da seleção — a análise seguiu com o restante. Para tentar de novo, " +
            (falhasDownload.length === 1 ? "marque-a" : "marque-as") +
            " outra vez na lista; se persistir, abra a peça uma vez na linha do tempo do PJe antes.",
        });
        panel.desmarcarPecas(falhasDownload.map((f) => f.id));
      }
      // Peças que a memória retomou mas cujo upload não existe mais no
      // provedor, e que não foram rebaixadas a tempo. Grupo próprio porque a
      // causa e a saída são outras: não é "o PJe não entregou", é "o arquivo
      // enviado antes expirou" — e o conserto é reenviar, não desmarcar.
      if (semConteudo.length) {
        panel.mostrarFalhasPecas(semConteudo, {
          titulo: "peça(s) não entraram: o envio anterior expirou",
          dica: "Envie a mensagem de novo — elas serão baixadas e reenviadas.",
        });
      }
      // Peças que entraram CORTADAS. Só as deste turno: as dos turnos
      // anteriores já foram reportadas quando entraram.
      const cortadas = pecasTruncadas(anexadas);
      if (cortadas.length) {
        panel.mostrarFalhasPecas(cortadas, avisoTrunc(cortadas.length));
      }
      let infoCtx = "";
      if (est) {
        infoCtx = " (~" + Math.round(est.tokens / 1000) + " mil tokens, " + est.pct + "% do contexto)";
        panel.setAlerta(null); // coube: qualquer alerta anterior está resolvido
        panel.setContexto({
          tokens: est.tokens,
          ctxTokens: est.ctxTokens,
          paginas,
          maxPaginas: modelCaps ? modelCaps.maxPages : 0,
          pecas: selectedIds.length + anexos.size,
        });
      } else {
        // Dois caminhos chegam aqui: o pré-voo foi PULADO (folga larga) ou ele
        // FALHOU (ex.: 429 após muitos uploads). Nos dois, re-pinta com a
        // estimativa local — o cache agora tem todas as peças baixadas, então o
        // número é decente. Sem isto o medidor ficaria CONGELADO no retrato de
        // quando a seleção foi feita ("N peça(s) sem medir", 0%).
        mostrarEstimativaLocal(selectedIds);
        // Pular só acontece com folga larga sobre a janela — o que significa
        // que qualquer alerta de contexto cheio anterior está resolvido. Falha
        // do count_tokens não diz nada sobre isso, então ali o alerta fica.
        if (pulouPreVoo) panel.setAlerta(null);
      }

      conversation.push({ role: "user", content: userContent });
      // só as que REALMENTE entraram: peça que falhou no download precisa
      // continuar elegível na próxima tentativa
      for (const id of anexadas) pecasNaConversa.add(id);
      if (!conversaProvider) {
        conversaProvider = (modelCaps && modelCaps.provider) || "anthropic";
      }

      panel.setStatus("Analisando…" + infoCtx, true);
      assistantEl = panel.addMessage("assistant", "");
      // Citações deste turno: marcadores [n] entram no texto via placeholders
      // (área de uso privado do Unicode — sobrevivem intactos ao escape do
      // renderizador) e a lista numerada vai no rodapé da mensagem.
      const cites = [];
      let statusFerramenta = false; // há status de busca/ferramenta na tela
      const citeKeys = new Map();
      let thinkAcc = "";
      let ckpt = null; // estado da UI no início do request físico corrente
      const fim = await stream(msgsEnvio, {
        onDelta(delta) {
          // limpa o status inicial e também o de ferramenta (a busca acabou
          // quando o texto volta a fluir)
          if (!acc || statusFerramenta) {
            panel.setStatus("");
            statusFerramenta = false;
          }
          acc += delta;
          panel.updateAssistant(assistantEl, acc, cites);
        },
        onThinking(t) {
          if (t) {
            thinkAcc += t;
            panel.setThinking(assistantEl, thinkAcc);
          }
          if (!acc) panel.setStatus("Raciocinando sobre as peças…", true);
        },
        onCitation(c) {
          const k = chaveCitacao(c);
          let n = citeKeys.get(k);
          if (!n) {
            n = cites.length + 1;
            citeKeys.set(k, n);
            cites.push(infoCitacao(c));
          }
          acc += "\uE000" + n + "\uE001";
          panel.updateAssistant(assistantEl, acc, cites);
        },
        // Mostra a atividade da ferramenta SEMPRE (o modelo costuma escrever
        // "vou pesquisar…" antes de buscar — sem isso o usuário fica sem
        // nenhum sinal durante a busca). Com o input completo, mostra também
        // O QUE está sendo pesquisado/lido.
        onTool(name, input) {
          statusFerramenta = true;
          if (name === "web_search") {
            const q = input && input.query;
            panel.setStatus(
              q ? "Pesquisando jurisprudência: “" + q + "”…" : "Pesquisando jurisprudência na web…",
              true,
              "busca"
            );
          } else if (name === "web_fetch") {
            let fonte = "";
            try {
              fonte = input && input.url ? new URL(input.url).hostname : "";
            } catch {}
            panel.setStatus(
              fonte ? "Lendo fonte: " + fonte + "…" : "Lendo página de fonte jurídica…",
              true,
              "busca"
            );
          } else {
            panel.setStatus("Executando ferramenta…", true);
          }
        },
        onTrunc() {
          truncated = true;
        },
        // Checkpoint por request físico: em re-tentativa transitória do
        // worker, volta ao estado do início da iteração que falhou (o que já
        // chegou dela chegaria DE NOVO e duplicaria texto/citações na tela).
        onIter() {
          ckpt = {
            acc,
            think: thinkAcc,
            nCites: cites.length,
          };
        },
        onRetry() {
          if (ckpt) {
            acc = ckpt.acc;
            thinkAcc = ckpt.think;
            cites.length = ckpt.nCites;
            for (const [k, n] of citeKeys) if (n > ckpt.nCites) citeKeys.delete(k);
          } else {
            acc = "";
          }
          panel.updateAssistant(assistantEl, acc, cites);
          panel.setStatus("Instabilidade momentânea na API — tentando de novo…", true);
        },
        // O serviço da extensão morreu no meio: o turno recomeça DO ZERO
        // (novo stream re-emite tudo) — zera todo o estado acumulado da UI.
        onReinicio() {
          acc = "";
          thinkAcc = "";
          cites.length = 0;
          citeKeys.clear();
          ckpt = null;
          truncated = false;
          statusFerramenta = false;
          panel.updateAssistant(assistantEl, acc, cites);
          panel.setStatus("O serviço da extensão reiniciou — reenviando a análise…", true);
        },
      }, opts);
      registrarCusto(fim);

      if (acc.trim()) {
        // Preserva os blocos completos da resposta (não só o texto): a API
        // exige thinking assinado intacto e blocos de ferramenta/citações no
        // histórico dos turnos seguintes.
        conversation.push({
          role: "assistant",
          content:
            fim.content && fim.content.length
              ? sanearCitacoes(fim.content)
              : [{ type: "text", text: acc.replace(/\uE000\d+\uE001/g, "") }],
        });
        // turno gravado com tools declaradas \u2192 mant\u00EA-las at\u00E9 "Nova conversa"
        if (opts.tools) buscaNaConversa = true;
        // Anexos deste turno passaram a fazer parte do hist\u00F3rico: saem da fila de
        // pendentes (n\u00E3o se reanexam no pr\u00F3ximo envio) e seguem no chip como "no
        // contexto", igual \u00E0s pe\u00E7as enviadas.
        if (anexosNovos.length) {
          for (const id of anexosNovos) {
            const i = anexosPendentes.indexOf(id);
            if (i >= 0) anexosPendentes.splice(i, 1);
          }
          atualizarChipsAnexos();
        }
        atualizarGaugePosTurno(fim, [...selectedIds, ...anexos.keys()]);
        let st = "";
        if (truncated)
          st = "A resposta atingiu o tamanho máximo — peça para continuar, se necessário.";
        if (fim.stopReason === "pause_turn") {
          // o teto de continuações do worker foi atingido com o servidor ainda
          // pausado (busca web muito longa): a resposta pode estar incompleta
          st = "A análise foi interrompida no limite de buscas — peça para continuar, se necessário.";
        }
        if (fim.stopReason === "model_context_window_exceeded") {
          // o modelo estourou a janela no meio da resposta: alerta persistente
          ultimaChaveEst = "";
          panel.setAlerta(ALERTA_CTX_CHEIO);
          alertaTrocaLigado = false; // o alerta visível agora é o de contexto
          st = "A resposta foi cortada: o limite de contexto do modelo foi atingido.";
        }
        panel.setStatus(st);

        // Oferta de editor. Toda resposta longa pode ser editada como
        // documento; quando o pedido foi claramente de uma peça redigida
        // (pareceMinuta), a oferta vira botão em destaque. A heurística NÃO
        // toca no request nem no system prompt — decide só a proeminência.
        const mdResposta = acc.replace(/\uE000\d+\uE001/g, "").trim();
        const destaque = pareceMinuta(text);
        if (destaque || mdResposta.length >= 400) {
          panel.adicionarAcaoEditor(assistantEl, {
            destaque,
            // O pedido deste turno, para a ação "Refazer seguindo seus modelos"
            // reabrir o modo minuta COM ele, em vez da instrução padrão.
            pedido: text,
            onAbrir: async (btn) => {
              if (btn) btn.disabled = true;
              try {
                const url = await guardarMinuta(mdResposta, tituloDaMinuta(mdResposta));
                window.open(url, "_blank", "noopener");
              } catch (err) {
                panel.setStatus(
                  "Não foi possível abrir o editor: " + (err && err.message ? err.message : err)
                );
              } finally {
                if (btn) btn.disabled = false;
              }
            },
          });
        }

        // Peças que a resposta apontou como faltantes viram botões de "adicionar"
        // — o modelo já identifica "o comprovante está na peça 214661494, não
        // anexada"; aqui esse id vira um clique que marca a peça para o próximo
        // envio, sem o usuário ter de procurá-la na lista.
        const faltantes = pecasCitadasFaltantes(mdResposta);
        if (faltantes.length) {
          panel.sugerirPecas(assistantEl, {
            pecas: faltantes,
            onAdd: (ids) => {
              const novos = panel.marcarPecas(ids);
              if (novos && novos.length) {
                panel.setStatus(
                  novos.length === 1
                    ? "Peça adicionada à seleção — ela entra no próximo envio."
                    : novos.length + " peças adicionadas à seleção — entram no próximo envio."
                );
              }
            },
          });
        }
      } else {
        // resposta vazia: não grava turno (evitaria content vazio no próximo request)
        panel.removeMessage(assistantEl);
        conversation.pop(); // remove o turno do usuário correspondente
        for (const id of anexadas) pecasNaConversa.delete(id); // peças saem junto
        // conversa esvaziou: o rótulo de provedor cai junto (senão um turno
        // futuro em OUTRO provedor herdaria o rótulo velho e a guarda de
        // troca deixaria passar um histórico misto)
        if (!conversation.length) conversaProvider = null;
        panel.setStatus("O modelo não retornou texto. Tente novamente.");
      }
    } catch (e) {
      panel.endPrep(true); // remove o card de preparo, se ainda estiver na tela
      // REDE REATIVA da memória de caso: a revalidação preventiva cobre o que
      // dá para prever (expiração, troca de chave), mas o provedor pode apagar
      // um arquivo por conta própria. Aqui o erro já aconteceu — o turno foi
      // desfeito pelo bloco abaixo de qualquer forma —, então o que resta é
      // limpar as referências mortas para que o PRÓXIMO envio re-suba as peças,
      // e dizer isso em vez de repassar o 404 cru da API.
      if (erroDeArquivoSumido(e)) {
        esquecerUploadsDoProvedor();
        panel.setStatus(
          "Os arquivos enviados antes não estão mais disponíveis no provedor. " +
            "Envie a mensagem de novo — as peças serão reenviadas."
        );
      } else {
        panel.setStatus("Erro: " + (e && e.message ? e.message : e));
      }
      // contexto cheio: além do erro no status, liga a barra de alerta
      // persistente — o usuário precisa AGIR (desmarcar peças ou recomeçar)
      if (e && e.ctxCheio) {
        ultimaChaveEst = "";
        panel.setAlerta(ALERTA_CTX_CHEIO);
        alertaTrocaLigado = false; // o alerta visível agora é o de contexto
      }
      // remove a bolha vazia do assistente, se houver
      if (assistantEl && !acc) panel.removeMessage(assistantEl);
      // desfaz o turno do usuário para permitir nova tentativa
      if (conversation.length && conversation[conversation.length - 1].role === "user") {
        conversation.pop();
      }
      for (const id of anexadas) pecasNaConversa.delete(id); // peças do turno desfeito
      // conversa esvaziou: o rótulo de provedor cai junto (ver ramo acima)
      if (!conversation.length) conversaProvider = null;
    } finally {
      busy = false;
      panel.lockInput(false);
      // Um ponto só para os QUATRO caminhos que mexem em `pecasNaConversa`
      // (turno bem-sucedido, resposta vazia, erro e turno desfeito): o finally
      // roda em todos, e espalhar a chamada garantiria esquecer um deles.
      panel.setPecasEnviadas([...pecasNaConversa]);
      // Fim de turno é o momento mais valioso para persistir, e o único em que
      // TODOS os quatro desfechos convergem — inclusive os dois que desfazem o
      // turno, cujo estado revertido também precisa ir ao disco.
      salvarCasoAgora();
    }
  });

  // ---------------------------------------------------------------------------
  // ANEXOS DO INPUT — o usuário solta PDF/TXT/MD na caixa de mensagem para
  // conversar sobre eles junto das peças, ou sozinhos. A UI (botão 📎, campo de
  // arquivo e os chips) vive no painel; aqui está a leitura, o estado e o que
  // vai ao modelo. Regras: leitura pelo MESMO extrator das peças
  // (`PJE.lerAnexo` → `lerCorpo`), nada ao disco (sessão só), e cada anexo entra
  // no request pelo mesmo `montarBlocos` das peças (id sintético + `entradaDoc`).
  // ---------------------------------------------------------------------------

  // Rótulo curto para o chip: tipo + tamanho/páginas.
  function anexoSubLabel(d) {
    if (!d) return "";
    if (d.kind === "pdf") return "PDF · " + (d.pages || 1) + (d.pages === 1 ? " pág." : " págs.");
    if (d.kind === "img") return (d.fmt || "imagem").toUpperCase();
    const kb = Math.max(1, Math.round((d.size || (d.text ? d.text.length : 0)) / 1024));
    return (d.fmt === "html" ? "HTML" : "Texto") + " · " + kb + " KB";
  }

  // Reprojeta os anexos no painel (chips). O painel é só reflexo — a fonte de
  // verdade é a Map `anexos` daqui.
  function atualizarChipsAnexos() {
    if (!panel.setAnexos) return;
    panel.setAnexos(
      [...anexos.values()].map((d) => ({
        id: d.id,
        nome: d.titulo || d.nome,
        sub: anexoSubLabel(d),
        enviado: !anexosPendentes.includes(d.id),
      }))
    );
  }

  // Feedback imediato no medidor ao anexar/remover, incluindo os anexos.
  function reestimarComAnexos() {
    if (busy || !modelCaps) return;
    mostrarEstimativaLocal([...selecaoEfetiva(), ...anexos.keys()]);
  }

  // Teto de sanidade por anexo (antes do teto de b64 compartilhado que
  // `montarBlocos` aplica no conjunto todo). PDFs grandes vão à Files API, mas
  // acima disto o base64 na memória e o pré-voo já ficam pesados demais para uma
  // caixa de mensagem — o usuário anexa a peça pelo próprio PJe nesse caso.
  const ANEXO_BYTES_MAX = 32 * 1024 * 1024; // 32 MB por arquivo
  const ANEXO_MAX_QTD = 10; // por sessão — a caixa de mensagem não é gerenciador de arquivos

  if (panel.onAnexar) {
    panel.onAnexar(async (files) => {
      const lista = [...(files || [])];
      if (!lista.length) return;
      const falhas = [];
      let entrou = 0;
      for (const file of lista) {
        if (anexos.size >= ANEXO_MAX_QTD) {
          falhas.push({ titulo: file.name || "arquivo", erro: "limite de " + ANEXO_MAX_QTD + " anexos por conversa atingido" });
          continue;
        }
        if (file.size > ANEXO_BYTES_MAX) {
          falhas.push({
            titulo: file.name || "arquivo",
            erro: "arquivo grande demais (" + Math.round(file.size / 1e6) + " MB) para anexar aqui",
          });
          continue;
        }
        try {
          const corpo = await PJE.lerAnexo(file);
          const id = "anexo:" + ++anexoSeq;
          const nomeCurto = (file.name || "arquivo").replace(/\.[^.]+$/, "");
          anexos.set(id, Object.assign({}, corpo, { id, nome: file.name, titulo: "Anexo — " + nomeCurto }));
          anexosPendentes.push(id);
          entrou++;
        } catch (e) {
          falhas.push({ titulo: file.name || "arquivo", erro: (e && e.message) || String(e) });
        }
      }
      if (entrou) {
        atualizarChipsAnexos();
        reestimarComAnexos();
      }
      if (falhas.length) {
        panel.mostrarFalhasPecas(falhas, {
          titulo: falhas.length === 1 ? "1 arquivo não pôde ser anexado" : falhas.length + " arquivos não puderam ser anexados",
          dica: "A extensão anexa PDF, TXT e Markdown (.md). Verifique o formato e o tamanho e tente de novo.",
        });
      }
    });
  }

  if (panel.onRemoverAnexo) {
    panel.onRemoverAnexo((id) => {
      if (!anexos.has(id)) return;
      // Sai da Map (é o que faz `prepararEnvio` filtrar os blocos dele do
      // histórico no próximo envio, liberando o contexto — simétrico ao
      // desmarcar de uma peça) e da fila de pendentes.
      anexos.delete(id);
      const i = anexosPendentes.indexOf(id);
      if (i >= 0) anexosPendentes.splice(i, 1);
      atualizarChipsAnexos();
      reestimarComAnexos();
    });
  }

  // ---------------------------------------------------------------------------
  // ESCOLHER COM IA — a camada 2 da seleção de peças.
  //
  // Manda à IA SÓ A LISTA (id, título, tipo e data de juntada) — nenhum byte de
  // conteúdo de peça — e recebe de volta os ids relevantes. É o que a regex da
  // camada 1 não consegue fazer: distinguir, entre sete peças chamadas
  // "Petição", qual é a inicial; entender que a "Manifestação" logo após o
  // laudo é a manifestação sobre o laudo; ler um "Documento 3".
  //
  // É um chat comum e ISOLADO, como a minuta e o mapa: sem tools, sem peças
  // anexadas, sem entrar em `conversation` nem em `pecasNaConversa` — logo,
  // funciona nos três provedores e não altera a conversa em andamento.
  //
  // Barato: ~30 tokens por peça (300 peças ≈ 9 mil tokens de entrada, alguns
  // centavos no pior caso) contra as centenas de milhares que a análise em si
  // consome. Mas o custo aparece no rodapé como qualquer outro turno.
  // ---------------------------------------------------------------------------
  const MAX_LINHAS_IA = 400; // teto de sanidade; acima disso o pedido já não cabe bem
  // Raciocínio BAIXO nesta chamada, qualquer que seja a preferência salva. A
  // triagem é classificação sobre metadados, não análise jurídica: com effort
  // alto o usuário espera dezenas de segundos por uma lista de ids — foi a
  // queixa que originou esta rodada. E o que decide a qualidade aqui não é o
  // tempo de raciocínio, são os SINAIS da lista (ordem cronológica, quem
  // juntou, tipo oficial, a triagem local), que esta rodada multiplicou.
  const EFFORT_TRIAGEM = "low";

  // System PRÓPRIO. O system do chat traz as regras de citação por página, de
  // não-invenção, de busca na web e do inventário de peças — nada disso se
  // aplica a quem não vai ler peça nenhuma, e ainda ocupa ~900 tokens de
  // instrução que o modelo precisa conciliar com a tarefa real. O que importa
  // do contexto é a FICHA do processo (classe, assunto, partes): é ela que diz
  // o que é relevante NESTE caso, e `contextoDoProcesso` já a monta.
  function systemTriagem() {
    return (
      "Você é um assistente de triagem de autos judiciais brasileiros. A partir da LISTA " +
      "de peças de um processo — apenas metadados, você NÃO tem o conteúdo delas —, indica " +
      "quais precisam ser lidas para um objetivo. Responde SEMPRE apenas com o JSON pedido, " +
      "sem preâmbulo e sem cercas de código." +
      contextoDoProcesso()
    );
  }

  // As regras de escolha. Vão no TEXTO do turno (não no system) porque mudam
  // junto com o formato da lista, que é montada aqui.
  const REGRAS_ESCOLHA = [
    "COMO LER A LISTA: uma peça por linha, em ordem CRONOLÓGICA — a nº 1 é a mais ANTIGA " +
      "do processo e a última é a mais RECENTE. Os campos vêm separados por “ | ”: número, " +
      "id, título, tipo oficial, data de juntada, quem juntou e a etiqueta da triagem " +
      "automática desta extensão (essencial, relevante, comum, expediente) — um palpite por " +
      "palavra-chave, que serve de ponto de partida e não de veredito.",
    "COMO ESCOLHER:",
    "• A espinha dorsal do processo quase sempre entra: petição inicial (costuma estar entre " +
      "as PRIMEIRAS linhas), contestação ou defesa, réplica, decisão saneadora, laudos e " +
      "perícias, atas e termos de audiência, alegações finais ou memoriais, sentença, " +
      "recursos e a decisão que os julga.",
    "• Vá além do título: peças de mesmo nome se distinguem pela DATA, por QUEM as juntou e " +
      "pela posição. Uma “Petição” da parte autora no começo é a inicial; uma da parte ré " +
      "logo depois da citação é a contestação.",
    "• Petição de encaminhamento (“Em anexo”, “junta documentos”) não tem conteúdo próprio: " +
      "ao escolher uma, escolha TAMBÉM os documentos juntados na mesma data.",
    "• Deixe de fora o expediente que não decide nada — certidões de intimação, avisos de " +
      "recebimento, comprovantes de publicação, guias, procurações, termos de juntada —, " +
      "salvo quando o objetivo for justamente prazo, intimação ou representação.",
    "• TAMANHO: escolha o MENOR conjunto que resolva o objetivo. Na maioria dos processos " +
      "isso fica entre 8 e 20 peças; num processo pequeno pode ser bem menos, e passar de 40 " +
      "só se o objetivo exigir (“todos os laudos”, “todas as decisões”). Peças demais " +
      "encarecem e diluem a análise; de menos, inviabilizam.",
  ].join("\n");

  const SUFIXO_ESCOLHA = [
    "FORMATO DA RESPOSTA — apenas este objeto JSON, sem preâmbulo, sem comentário e sem " +
      "cercas de código:",
    '{"ids":["123456","123457"],"motivos":{"123456":"petição inicial"},"resumo":"frase curta"}',
    "Em `ids`, os ids das peças escolhidas em ordem cronológica, EXATAMENTE como informados " +
      "— nunca invente um id nem devolva um que não esteja na lista. Em `motivos`, no máximo " +
      "6 palavras por peça dizendo por que ela entrou. Em `resumo`, uma frase com o critério " +
      "que você usou.",
  ].join("\n");

  // Etiqueta da triagem local (camada 1) que vai como DICA em cada linha. Os
  // nomes internos viram palavras que o modelo entende sem glossário.
  const ROTULO_REL = {
    essencial: "essencial",
    relevante: "relevante",
    neutro: "comum",
    ruido: "expediente",
  };

  function linhaDaPeca(d, n) {
    const nome = tituloLimpo(d.titulo) || "(sem título)";
    const campos = ["#" + n, d.id, nome];
    // O tipo oficial só entra quando ACRESCENTA: na maioria das peças ele
    // repete o título ("Contestação | Contestação") e seria token puro.
    if (d.tipo && d.tipo.trim().toLowerCase() !== nome.trim().toLowerCase()) campos.push(d.tipo);
    if (d.juntadoEm) campos.push(String(d.juntadoEm).slice(0, 16));
    if (d.juntadoPor) campos.push(String(d.juntadoPor).slice(0, 40));
    const rel = panel.classificarPeca ? panel.classificarPeca(d).rel : null;
    if (rel && ROTULO_REL[rel]) campos.push(ROTULO_REL[rel]);
    // Páginas só existem para peça já baixada (prefetch, preview, turno
    // anterior) — quando existem, são o melhor sinal de substância que há:
    // uma "Petição" de 2 páginas é encaminhamento, de 40 é a inicial.
    // `docsCache` é um Map: acesso por colchetes devolveria undefined SEMPRE,
    // e a falha seria muda (a linha sairia sem o número de páginas).
    const c = docsCache.get(d.id);
    if (c && c.pages) campos.push(c.pages + " pág.");
    return campos.join(" | ");
  }

  // Ordena cronologicamente (a mesma função da exportação em .zip: data de
  // juntada quando a grid foi lida, senão a inversa da ordem da tela) e, se a
  // lista passar do teto, corta pelo MEIO. Cortar as primeiras jogaria fora a
  // inicial; cortar as últimas, a sentença. O miolo é onde vive o expediente
  // repetitivo, e a omissão vai DITA no texto — sem cap silencioso.
  function listaParaIA(docs) {
    const ord = window.PjeExport
      ? PjeExport.ordenarCronologico(docs)
      : { docs: docs.slice().reverse(), criterio: "inversa da ordem da tela" };
    const emOrdem = ord.docs;
    if (emOrdem.length <= MAX_LINHAS_IA) {
      return { linhas: emOrdem.map((d, i) => linhaDaPeca(d, i + 1)), omitidas: 0, criterio: ord.criterio };
    }
    const metade = Math.floor(MAX_LINHAS_IA / 2);
    const inicio = emOrdem.slice(0, metade).map((d, i) => linhaDaPeca(d, i + 1));
    const desde = emOrdem.length - (MAX_LINHAS_IA - metade);
    const fim = emOrdem.slice(desde).map((d, i) => linhaDaPeca(d, desde + i + 1));
    const omitidas = emOrdem.length - MAX_LINHAS_IA;
    return {
      linhas: inicio.concat(["… " + omitidas + " peças do meio do processo omitidas por limite de tamanho …"], fim),
      omitidas,
      criterio: ord.criterio,
    };
  }

  // Ids já COMPLETOS dentro do array "ids" de um JSON ainda em construção — é o
  // que permite marcar as peças AO VIVO, conforme o modelo as emite, em vez de
  // deixar o usuário olhando para um botão "Escolhendo…" por vários segundos.
  // Só aceita id fechado entre aspas: um id pela metade marcaria a peça errada.
  function idsParciais(texto) {
    const i = texto.indexOf('"ids"');
    if (i < 0) return [];
    const abre = texto.indexOf("[", i);
    if (abre < 0) return [];
    const fecha = texto.indexOf("]", abre);
    const trecho = texto.slice(abre + 1, fecha < 0 ? texto.length : fecha);
    return (trecho.match(/"(\d{3,})"/g) || []).map((s) => s.slice(1, -1));
  }

  // O modelo pode devolver o JSON cercado por ``` ou com um preâmbulo, apesar da
  // instrução. Extrai o primeiro objeto plausível em vez de falhar.
  function lerJsonEscolha(texto) {
    const s = String(texto || "");
    const bruto = s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1);
    if (!bruto) return null;
    try {
      return JSON.parse(bruto);
    } catch {
      return null;
    }
  }

  panel.onEscolherIA(async (docs, objetivo, selAntes) => {
    if (busy || bloqueadoPelaExportacao()) return;
    if (!docs || !docs.length) return;
    busy = true;
    panel.setIaOcupado(true);
    panel.setStatus("Lendo a lista de peças e escolhendo as relevantes…", true);
    // Marcar ao vivo significa mexer na seleção do usuário antes de saber se o
    // turno termina bem: guardamos o estado anterior para poder devolvê-lo.
    const selOriginal = Array.isArray(selAntes) ? selAntes.slice() : null;
    let mexeuNaSelecao = false;
    try {
      await garantirCaps();
      const alvo = objetivo
        ? 'responder a esta pergunta do usuário: "' + objetivo.slice(0, 500) + '"'
        : "entender o processo: quem são as partes, o que se pede, o que a outra " +
          "parte responde, que provas há e como o feito está hoje";
      const lista = listaParaIA(docs);
      const texto =
        "OBJETIVO: escolher, na lista de peças abaixo, quais precisam ser lidas para " +
        alvo + ".\n\n" +
        REGRAS_ESCOLHA + "\n\n" +
        SUFIXO_ESCOLHA + "\n\n" +
        "LISTA DE PEÇAS (" + docs.length + " no total, em ordem cronológica; critério: " +
        lista.criterio + "):\n" +
        lista.linhas.join("\n");

      const validos = new Set(docs.map((d) => d.id));
      let acc = "";
      let marcados = 0;
      // A marcação ao vivo é o antídoto da espera: os `ids` são o PRIMEIRO
      // campo do JSON, então as peças acendem na lista bem antes de o modelo
      // terminar de escrever os motivos e o resumo.
      function marcarParcial() {
        const ids = [...new Set(idsParciais(acc))].filter((id) => validos.has(id));
        if (ids.length <= marcados) return;
        marcados = ids.length;
        mexeuNaSelecao = true;
        panel.aplicarEscolhaIA(ids, null);
        panel.setStatus(
          "Escolhendo… " + marcados + " peça" + (marcados > 1 ? "s" : "") + " até agora",
          true
        );
      }
      const fim = await stream(
        prepararEnvio([{ role: "user", content: [{ type: "text", text: texto }] }], null),
        {
          onDelta(d) {
            acc += d;
            marcarParcial();
          },
          onThinking() {},
          onTool() {},
          onTrunc() {},
          onRetry() {
            acc = "";
            marcados = 0; // a re-tentativa recomeça o JSON do zero
            panel.setStatus("Instabilidade momentânea na API — tentando de novo…", true);
          },
          onReinicio() {
            acc = "";
            marcados = 0;
            panel.setStatus("O serviço da extensão reiniciou — tentando de novo…", true);
          },
        },
        // System próprio e raciocínio baixo: ver EFFORT_TRIAGEM/systemTriagem.
        { system: systemTriagem(), effort: EFFORT_TRIAGEM }
      );
      registrarCusto(fim);

      const r = lerJsonEscolha(acc);
      // Só ids que EXISTEM na lista: um id inventado marcaria nada e faria a
      // contagem mentir. Também dedup, porque o modelo às vezes repete.
      const ids = [...new Set((r && Array.isArray(r.ids) ? r.ids : []).map(String))].filter(
        (id) => validos.has(id)
      );
      if (!ids.length) {
        // Nada aproveitável: a seleção que o usuário tinha volta como estava —
        // a marcação ao vivo não pode deixar a lista num estado que ele não
        // pediu e que só ele saberia desfazer.
        if (mexeuNaSelecao && selOriginal) panel.aplicarEscolhaIA(selOriginal, null);
        panel.setStatus(
          "A IA não conseguiu escolher peças desta lista. Use os atalhos chave/principais."
        );
        return;
      }
      panel.aplicarEscolhaIA(ids, (r && r.motivos) || null);
      panel.setStatus("");
      // O resultado precisa ser AUDITÁVEL: o usuário tem de poder discordar. O
      // critério vai na nota e o motivo de cada peça no title da linha dela.
      panel.setSelNota(
        "✨ A IA marcou " + ids.length + " de " + docs.length + " peças" +
          (r && r.resumo ? " — " + String(r.resumo).slice(0, 160) : "") +
          ". Passe o mouse numa peça para ver o motivo; ajuste à vontade."
      );
    } catch (e) {
      // Erro no meio do stream: desfaz a marcação parcial pelo mesmo motivo do
      // caso "nenhum id" — a seleção era do usuário e o turno não terminou.
      if (mexeuNaSelecao && selOriginal) panel.aplicarEscolhaIA(selOriginal, null);
      const msg = (e && e.message) || String(e);
      panel.setStatus("Não foi possível escolher com IA: " + msg);
      if (e && e.ctxCheio) panel.setAlerta(ALERTA_CTX_CHEIO);
    } finally {
      busy = false;
      panel.setIaOcupado(false);
      // A escolha da IA REESCREVE a seleção de peças, que é parte do registro
      // da conversa. O `selChangeCb` que ela dispara cai na guarda de `busy`
      // do `agendarSalvar` (o turno ainda estava correndo), então sem esta
      // linha a nova seleção só iria ao disco no próximo evento qualquer.
      salvarCasoAgora();
    }
  });

  // ---------------------------------------------------------------------------
  // Minuta: um turno de chat comum cuja resposta é o TEXTO de uma peça
  // (despacho, decisão, sentença…) em markdown. Como o mapa mental, não usa
  // tools, skills nem execução de código — por isso funciona em QUALQUER
  // modelo, Claude ou Gemini. O markdown vira HTML aqui (com o renderMd do
  // painel, que já escapa antes de formatar) e vai para chrome.storage.local,
  // de onde src/editor.html o abre para edição, cópia e exportação.
  // ---------------------------------------------------------------------------
  const INSTRUCAO_MINUTA_PADRAO =
    "Elabore a minuta do ato cabível neste momento do processo, com relatório, " +
    "fundamentação e dispositivo, indicando a origem de cada afirmação.";

  // Prescritivo pelo mesmo motivo do sufixo do mapa: modelos menores seguem
  // instruções ao pé da letra, e aqui o produto é um texto que vai circular
  // FORA da extensão — sem as regras de origem e de não-invenção, a minuta
  // chega ao gabinete sem como ser conferida.
  const SUFIXO_MINUTA =
    " Responda APENAS com o texto da minuta em Markdown, sem preâmbulo, sem comentário" +
    " final e sem blocos de código (sem cercas ```)." +
    " ESTRUTURA: uma única linha começando com # (o nome do ato — SENTENÇA, DECISÃO," +
    " DESPACHO, do que se tratar); depois as seções com ## (na sentença: I – Relatório," +
    " II – Fundamentação, III – Dispositivo; no despacho, texto corrido, sem seções)." +
    " PARÁGRAFOS: texto corrido em linguagem forense brasileira, impessoal e em terceira" +
    " pessoa. SEPARE CADA PARÁGRAFO POR UMA LINHA EM BRANCO — dois parágrafos colados em" +
    " linhas seguidas viram um só. Use **negrito** no dispositivo e no que for decisivo." +
    " TABELAS: quando a informação for tabular (partes e qualificação, linha do tempo dos" +
    " atos, valores, provas), APRESENTE-A EM TABELA Markdown — cabeçalho, a linha de" +
    " separação com hifens (| --- | --- |) e uma coluna final \"Origem\". Use listas" +
    " numeradas (1. 2. 3.) para enumerar pedidos, requisitos ou provas." +
    " ORIGEM OBRIGATÓRIA: toda afirmação sobre os autos leva a referência entre parênteses," +
    " no formato (Título da peça, id 123456, fl. 7) — o id é o número que abre o título de" +
    " cada peça na lista abaixo e a folha é a do PDF daquela peça. Sem folha identificável," +
    " use (Título da peça, id 123456)." +
    " NUNCA invente nome de parte, número de processo, data, valor, dispositivo legal ou" +
    " precedente: se algo necessário não constar das peças anexadas, escreva no lugar" +
    " [COMPLETAR: o que falta], para quem for assinar preencher." +
    " NÃO assine, não date e não crie cabeçalho de tribunal, vara ou comarca — isso o" +
    " sistema do PJe já acrescenta." +
    // O system prompt do chat manda destacar ressalvas com blocos "> [!ALERTA]".
    // Aqui a saída é o texto de um ato processual, que circula fora da extensão:
    // um bloco desses no meio de uma sentença é defeito, não destaque. O canal
    // para o que falta continua sendo o [COMPLETAR: …].
    " NÃO use blocos de aviso do tipo \"> [!ALERTA]\" ou \"> [!ATENÇÃO]\": nada de" +
    " observação ao leitor no corpo do ato — o que não estiver confirmado nas peças vira" +
    " [COMPLETAR: o que falta].";

  // Quando o usuário escolhe uma categoria de modelos (biblioteca MLIB), TODAS
  // as peças-modelo daquela espécie (o painel já aplica o teto) entram no
  // request da minuta como MOLDURA de FORMA — nunca de conteúdo. Vai como bloco
  // de texto e é o PRIMEIRO do content (antes das peças), para ficar no prefixo
  // cacheado. A regra anti-contaminação é dura de propósito: os modelos são de
  // OUTROS processos e trazem nomes, valores e datas que NÃO podem vazar para a
  // minuta. A IA escolhe a base mais adequada e pode aproveitar estrutura e
  // linguajar das outras. XML (não Markdown) porque o conteúdo interno é
  // Markdown — a tag é a única fronteira que o modelo não confunde com a
  // resposta. Tags <modelo…> acidentais no texto do usuário são removidas para
  // não quebrar a moldura.
  function molduraModelos(modelos) {
    if (!Array.isArray(modelos) || !modelos.length) return null;
    const limpar = (t) => String(t).replace(/<\/?modelos?(_de_referencia)?\b[^>]*>/gi, "");
    const partes = modelos.map((m, i) => {
      const cat = m.categoria ? ' categoria="' + String(m.categoria).replace(/"/g, "") + '"' : "";
      const tit = m.titulo ? ' titulo="' + String(m.titulo).replace(/"/g, "'") + '"' : "";
      return '<modelo n="' + (i + 1) + '"' + cat + tit + ">\n" + limpar(m.texto) + "\n</modelo>";
    });
    const varios = modelos.length > 1;
    const intro = varios
      ? "Os " + modelos.length + " blocos <modelo> abaixo são peças-modelo da MESMA " +
        "espécie que o usuário cadastrou. ANALISE todos, escolha como base o que melhor " +
        "se ajusta a este caso e aproveite a ESTRUTURA, a ordem das seções, o fraseado e " +
        "o tom forense — inclusive combinando trechos de LINGUAGEM (fórmulas de praxe, " +
        "conectivos, jargão) de mais de um. Eles são de OUTROS processos.\n"
      : "O bloco <modelo> abaixo é uma peça-modelo que o usuário cadastrou para você " +
        "imitar a FORMA: a estrutura das seções, a ordem, o fraseado e o tom forense. " +
        "Ela é de OUTRO processo.\n";
    return {
      type: "text",
      text:
        "<modelos_de_referencia>\n" +
        intro +
        "REGRA ABSOLUTA: não copie NENHUM fato dos modelos — nomes de partes, números, " +
        "datas, valores, endereços, dispositivos legais, fundamentos ou trechos " +
        "específicos do caso. Aproveite só a forma e a linguagem. Todo o conteúdo da " +
        "minuta sai EXCLUSIVAMENTE das peças deste processo, anexadas em seguida. Se um " +
        "modelo trouxer um dado que não conste dessas peças, use [COMPLETAR: …] no lugar. " +
        "Os modelos são a forma; os autos são o conteúdo.\n" +
        partes.join("\n") +
        "\n</modelos_de_referencia>",
    };
  }

  panel.onMinuta(async (text, selecaoDoPainel, modelos) => {
    if (busy || bloqueadoPelaExportacao()) return;
    // Seleção EFETIVA, pelo mesmo motivo do chat: num processo retomado as rows
    // da timeline lazy podem não existir ainda, e a minuta recusaria peças que
    // o usuário vê marcadas na conversa.
    const selectedIds = selecaoEfetiva().length ? selecaoEfetiva() : selecaoDoPainel;
    if (selectedIds.length === 0) {
      panel.setStatus("Marque as peças que devem embasar a minuta.");
      return;
    }
    busy = true;
    panel.lockInput(true);

    const instrucao = (text && text.trim()) || INSTRUCAO_MINUTA_PADRAO;
    const molduraBloco = molduraModelos(modelos);
    const catModelos =
      molduraBloco && typeof MLIB !== "undefined"
        ? MLIB.rotuloCategoria(modelos[0].categoria)
        : "";
    panel.addMessage(
      "user",
      "📝 Gerar minuta: " +
        instrucao +
        (molduraBloco
          ? "\n\n📚 Seguindo " + modelos.length + " modelo(s) de referência" +
            (catModelos ? " — " + catModelos : "")
          : ""),
      selectedIds.map((id) => metaDe(id).titulo)
    );
    let assistantEl = null;
    let acc = "";
    let ckptMinuta = ""; // texto na UI no início do request físico corrente

    try {
      // Peça que falha no download não derruba a minuta: seguimos com o que
      // baixou e o relatório diz o que ficou de fora (mesma regra do chat).
      const dl = await baixarSelecionadas(selectedIds);
      if (!dl.ok.length) throw new Error("nenhuma das peças marcadas pôde ser baixada");
      guardaPaginas(dl.ok);
      await subirPecas(dl.ok);
      const blocos = montarBlocos(dl.ok);
      panel.endPrep();
      if (dl.falhas.length) panel.mostrarFalhasPecas(dl.falhas);
      const cortadasMinuta = pecasTruncadas(dl.ok);
      if (cortadasMinuta.length) {
        panel.mostrarFalhasPecas(cortadasMinuta, avisoTrunc(cortadasMinuta.length));
      }

      panel.setStatus("Redigindo a minuta a partir das peças marcadas…", true);
      assistantEl = panel.addMessage("assistant", "");

      // Request ISOLADO, como o mapa mental: não entra em conversation nem em
      // pecasNaConversa — gerar uma minuta não altera a conversa em andamento.
      // A moldura do modelo (se houver) é o PRIMEIRO bloco: fica antes das
      // peças, no prefixo cacheado, e o reforço na instrução volta a amarrar
      // "forma do modelo, fatos das peças".
      const reforcoModelo = molduraBloco
        ? " Baseie a FORMA (estrutura, seções, linguagem) nos modelos de referência" +
          " fornecidos no início — escolhendo o mais adequado e aproveitando o linguajar" +
          " dos demais —, mas com os FATOS exclusivamente das peças deste processo."
        : "";
      const messages = prepararEnvio(
        [
          {
            role: "user",
            content: [
              ...(molduraBloco ? [molduraBloco] : []),
              ...blocos,
              {
                type: "text",
                // A lista de peças vai explícita no texto (além do title de
                // cada bloco document) porque o id é OBRIGATÓRIO na origem de
                // cada afirmação: é por ele que se reencontra a peça na
                // timeline do PJe.
                //
                // A lista sai de `dl.ok`, NUNCA de `selectedIds`: peça que
                // falhou no download não tem bloco no request, e anunciá-la
                // como anexada convida o modelo a citar um id que ele não viu
                // — o pior erro possível aqui, porque a citação sai com a
                // mesma cara de uma legítima e só se descobre conferindo os
                // autos.
                text:
                  instrucao +
                  SUFIXO_MINUTA +
                  reforcoModelo +
                  " Peças anexadas, use exatamente estes ids: " +
                  dl.ok.map((id) => metaDe(id).titulo).join("; ") +
                  ".",
              },
            ],
          },
        ],
        null
      );

      const fimMinuta = await stream(messages, {
        onDelta(delta) {
          acc += delta;
          panel.updateAssistant(assistantEl, acc);
        },
        onThinking() {
          if (!acc) panel.setStatus("Planejando a estrutura do ato…", true);
        },
        onTool() {},
        onTrunc() {},
        onIter() {
          ckptMinuta = acc;
        },
        onRetry() {
          acc = ckptMinuta;
          panel.updateAssistant(assistantEl, acc);
          panel.setStatus("Instabilidade momentânea na API — tentando de novo…", true);
        },
        onReinicio(n) {
          acc = "";
          ckptMinuta = "";
          panel.updateAssistant(assistantEl, acc);
          panel.setStatus(
            "O serviço da extensão reiniciou — refazendo a minuta (tentativa " + (n + 1) + ")…",
            true
          );
        },
      });
      registrarCusto(fimMinuta);

      const md = limparMarkdownMinuta(acc);
      if (!md) {
        panel.setStatus("O modelo não devolveu a minuta — tente gerar novamente.");
        if (assistantEl) panel.removeMessage(assistantEl);
        return;
      }

      const url = await guardarMinuta(md, tituloDaMinuta(md));
      const idProc = PJE.getIdProcesso();
      const nomeMd = ("minuta" + (idProc ? "-processo-" + idProc : "") + ".md").replace(
        /[^\w.\-]+/g,
        "-"
      );

      panel.mostrarCardMinuta(assistantEl, {
        md,
        resumo: resumoDaMinuta(md),
        // A aba abre no CLIQUE, não sozinha: a resposta demora e o gesto do
        // usuário no "Gerar" já expirou — abrir aqui cairia no bloqueador de
        // pop-ups. window.open de URL da extensão é navegação de topo, imune à
        // CSP do tribunal (mesmo truque do "Abrir em nova aba" do preview).
        onAbrir: () => window.open(url, "_blank", "noopener"),
        onBaixar: () => baixarTexto(nomeMd, md, "text/markdown;charset=utf-8"),
      });
      panel.setStatus("");
    } catch (e) {
      panel.endPrep(true);
      panel.setStatus("Erro: " + (e && e.message ? e.message : e));
      if (assistantEl && !acc) panel.removeMessage(assistantEl);
    } finally {
      busy = false;
      panel.lockInput(false);
      // A minuta É um registro da conversa: o card fica na tela e o markdown
      // inteiro vive no transcript. Sem esta linha ele só chegava ao disco se
      // algum OUTRO evento disparasse gravação depois — gerar a minuta e
      // fechar a aba perdia o card e, junto, as peças que acabaram de baixar
      // (a fila `pecasSujas` também sai daqui).
      salvarCasoAgora();
    }
  });

  // --- Rascunhos de minuta -----------------------------------------------
  // Ficam em chrome.storage.local — e não em session, como o mapa — porque o
  // ponto do recurso é reabrir a minuta depois, inclusive noutro dia. Isso põe
  // trecho dos autos NO DISCO: a poda dupla (10 mais recentes e nada acima de
  // 7 dias) e o botão "Descartar" do editor existem por causa disso.
  const MAX_MINUTAS = 10;
  const VALIDADE_MINUTA_MS = 7 * 24 * 60 * 60 * 1000;

  function guardarMinuta(md, titulo) {
    return new Promise((resolve, reject) => {
      const id = String(Date.now()) + "-" + Math.random().toString(36).slice(2, 8);
      const chave = "minuta:" + id;
      let processo = "";
      try {
        processo = PJE.getNumeroProcesso() || "";
      } catch (e) {}
      const registro = {
        // Guarda o Markdown CRU: a página do editor (src/editor.html) o converte
        // com o MinutaMd — parser dedicado que faz listas aninhadas, tabelas com
        // alinhamento e parágrafos de verdade (o renderMd do chat achataria).
        // O HTML editado é gravado de volta pelo próprio editor a cada mudança.
        md,
        titulo: titulo || "Minuta",
        processo,
        criadoEm: Date.now(),
        atualizadoEm: Date.now(),
      };
      chrome.storage.local.set({ [chave]: registro }, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        podarMinutas();
        resolve(chrome.runtime.getURL("src/editor.html?id=" + encodeURIComponent(id)));
      });
    });
  }

  function podarMinutas() {
    chrome.storage.local.get(null, (tudo) => {
      if (chrome.runtime.lastError || !tudo) return;
      const limite = Date.now() - VALIDADE_MINUTA_MS;
      const quando = (k) => (tudo[k] && tudo[k].atualizadoEm) || 0;
      const chaves = Object.keys(tudo).filter((k) => k.indexOf("minuta:") === 0);
      const vencidas = chaves.filter((k) => quando(k) < limite);
      const vivas = chaves
        .filter((k) => vencidas.indexOf(k) === -1)
        .sort((a, b) => quando(b) - quando(a));
      const remover = vencidas.concat(vivas.slice(MAX_MINUTAS));
      if (remover.length) chrome.storage.local.remove(remover);
    });
  }

  // Tira a cerca ``` que alguns modelos põem em volta do markdown e o
  // preâmbulo antes do primeiro título. Mesmo papel do limparMarkdownMapa.
  function limparMarkdownMinuta(txt) {
    let t = String(txt || "").trim();
    const cerca = t.match(/^```[a-z]*\s*\n([\s\S]*?)\n?```$/i);
    if (cerca) t = cerca[1].trim();
    const i = t.search(/^#{1,3}\s+/m);
    if (i > 0) t = t.slice(i);
    return t.trim();
  }

  // O nome do ato (linha do #) vira o título do documento e o nome do arquivo.
  function tituloDaMinuta(md) {
    const m = String(md || "").match(/^#\s+(.+)$/m);
    const t = m ? m[1].replace(/[*_`]/g, "").trim() : "";
    return t ? t.slice(0, 80) : "Minuta";
  }

  function resumoDaMinuta(md) {
    const linhas = md.split(/\r?\n/);
    const secoes = linhas.filter((l) => /^##\s+/.test(l)).length;
    const paragrafos = linhas.filter((l) => l.trim() && !/^[#>|\-*\d]/.test(l.trim())).length;
    return (secoes ? secoes + " seção(ões) · " : "") + paragrafos + " parágrafo(s)";
  }

  // Heurística de intenção — a primeira do projeto. É deliberadamente
  // inofensiva: NÃO muda o request nem o system prompt, só decide se a oferta
  // de editor ao fim de uma resposta de chat aparece em destaque. Falso
  // negativo custa um clique a mais; falso positivo, um botão a mais.
  const MINUTA_VERBO =
    /\b(minut\w*|elabor\w*|redij\w*|redig\w*|escrev\w*|prepar\w*|fa[cç]\w*|gere|gerar|produz\w*)\b/i;
  const MINUTA_ESPECIE =
    /\b(despacho|senten[çc]a|decis[ãa]o|voto|ac[óo]rd[ãa]o|of[íi]cio|mandado|alvar[áa]|termo|parecer|promo[çc][ãa]o|cota|minuta|peti[çc][ãa]o|contesta[çc][ãa]o|r[ée]plica|recurso|apela[çc][ãa]o|embargos|agravo|alega[çc][õo]es|relat[óo]rio)\b/i;
  const MINUTA_VETO = /\b(resum\w*|explic\w*|quais|qual|quando|quanto|liste|listar|analis\w*)\b/i;
  function pareceMinuta(t) {
    const s = String(t || "");
    return MINUTA_VERBO.test(s) && MINUTA_ESPECIE.test(s) && !MINUTA_VETO.test(s);
  }

  // ---------------------------------------------------------------------------
  // Mapa mental (markmap): um turno de chat comum cuja resposta é markdown
  // hierárquico. Não usa tools, skills nem code execution — por isso funciona
  // em qualquer modelo, Claude ou Gemini. O markdown vai para o
  // worker (storage.session) e a página src/mapa.html desenha o mapa.
  // ---------------------------------------------------------------------------
  const INSTRUCAO_MAPA_PADRAO =
    "Mapeie o processo: partes e representantes, síntese dos fatos, pedidos, teses de cada " +
    "parte, provas produzidas, decisões proferidas e situação atual do feito.";

  // Prescritivo pelo mesmo motivo do SUFIXO_MINUTA: modelos menores (Haiku)
  // seguem instruções ao pé da letra, e o parser de src/mapa.js só entende
  // títulos e listas — preâmbulo, tabela ou bloco de código estragariam o mapa.
  const SUFIXO_MAPA =
    " Responda APENAS com o mapa em Markdown, sem nenhum texto antes ou depois e sem blocos" +
    " de código." +
    " ESTRUTURA: uma única linha começando com # (o processo e seu número); em seguida as" +
    " seções com ##, sempre NESTA ORDEM da análise processual, incluindo só as que os autos" +
    " permitirem: Partes e representação; Fatos (cronológicos); Pedidos; Teses e defesa;" +
    " Provas; Audiências; Decisões (cronológicas); Recursos; Prazos; Situação atual. Dentro de" +
    " cada seção, itens com \"-\", aninhados por indentação de dois espaços e no máximo três" +
    " níveis. Cada item é um rótulo curto (até cerca de 12 palavras), não uma frase completa." +
    " ORIGEM OBRIGATÓRIA: todo item que afirme algo dos autos TERMINA com a referência entre" +
    " parênteses, no formato (Título da peça, id 123456, fl. 7) — o id é o número que abre o" +
    " título de cada peça na lista abaixo e a folha é a do PDF daquela peça. Sem folha" +
    " identificável, use (Título da peça, id 123456). NUNCA invente id, folha, data ou valor." +
    " RECURSOS: use **negrito** no rótulo do item e ==destaque== no que for decisivo; quando a" +
    " informação for tabular (partes, linha do tempo, valores, prazos), use UMA tabela Markdown" +
    " na seção correspondente, com no máximo 3 colunas e células curtas. NÃO use emojis," +
    " imagens, HTML, fórmulas, numeração de tópicos nem blocos de aviso do tipo" +
    " \"> [!ALERTA]\" (o mapa é feito de nós; um bloco de citação não vira nó).";

  panel.onMapa(async (text, selecaoDoPainel) => {
    if (busy || bloqueadoPelaExportacao()) return;
    const selectedIds = selecaoEfetiva().length ? selecaoEfetiva() : selecaoDoPainel;
    if (selectedIds.length === 0) {
      panel.setStatus("Marque as peças que devem embasar o mapa mental.");
      return;
    }
    busy = true;
    panel.lockInput(true);

    const instrucao = (text && text.trim()) || INSTRUCAO_MAPA_PADRAO;
    panel.addMessage(
      "user",
      "🧠 Gerar mapa mental: " + instrucao,
      selectedIds.map((id) => metaDe(id).titulo)
    );
    let assistantEl = null;
    let acc = "";
    let ckptMapa = ""; // texto na UI no início do request físico corrente

    try {
      // Peça que falha no download não derruba o mapa: seguimos com o que
      // baixou e o relatório diz o que ficou de fora (mesma regra do chat).
      const dl = await baixarSelecionadas(selectedIds);
      if (!dl.ok.length) throw new Error("nenhuma das peças marcadas pôde ser baixada");
      guardaPaginas(dl.ok);
      await subirPecas(dl.ok);
      const blocos = montarBlocos(dl.ok);
      panel.endPrep();
      if (dl.falhas.length) panel.mostrarFalhasPecas(dl.falhas);
      const cortadasMapa = pecasTruncadas(dl.ok);
      if (cortadasMapa.length) {
        panel.mostrarFalhasPecas(cortadasMapa, avisoTrunc(cortadasMapa.length));
      }

      panel.setStatus("Montando o mapa mental a partir das peças marcadas…", true);
      assistantEl = panel.addMessage("assistant", "");

      // Request ISOLADO, como a minuta: não entra em conversation nem em
      // pecasNaConversa — o anexo incremental e o histórico do chat seguem
      // intactos, e gerar um mapa não muda a conversa em andamento.
      const messages = prepararEnvio(
        [
          {
            role: "user",
            content: [
              ...blocos,
              {
                type: "text",
                // A lista de peças vai explícita no texto (além do title de
                // cada bloco document) porque o id é OBRIGATÓRIO na origem de
                // cada tópico: é por ele que o usuário reencontra a peça na
                // timeline do PJe.
                //
                // Sai de `dl.ok`, NUNCA de `selectedIds` — ver a nota igual no
                // caminho da minuta: anunciar uma peça que não baixou faz o
                // modelo citar um id que ele nunca viu.
                text:
                  instrucao +
                  SUFIXO_MAPA +
                  " Peças anexadas, use exatamente estes ids: " +
                  dl.ok.map((id) => metaDe(id).titulo).join("; ") +
                  ".",
              },
            ],
          },
        ],
        null
      );

      const fimMapa = await stream(messages, {
        onDelta(delta) {
          acc += delta;
          panel.updateAssistant(assistantEl, acc);
        },
        onThinking() {
          if (!acc) panel.setStatus("Organizando os eixos do mapa…", true);
        },
        onTool() {},
        onTrunc() {},
        onIter() {
          ckptMapa = acc;
        },
        onRetry() {
          acc = ckptMapa;
          panel.updateAssistant(assistantEl, acc);
          panel.setStatus("Instabilidade momentânea na API — tentando de novo…", true);
        },
        onReinicio(n) {
          acc = "";
          ckptMapa = "";
          panel.updateAssistant(assistantEl, acc);
          panel.setStatus(
            "O serviço da extensão reiniciou — refazendo o mapa (tentativa " + (n + 1) + ")…",
            true
          );
        },
      });
      registrarCusto(fimMapa);

      const md = limparMarkdownMapa(acc);
      if (!md) {
        panel.setStatus("O modelo não devolveu o mapa — tente gerar novamente.");
        if (assistantEl) panel.removeMessage(assistantEl);
        return;
      }

      const idProc = PJE.getIdProcesso();
      const titulo = "Processo" + (idProc ? " " + idProc : "");
      const { id } = await rpc({
        type: "guardarMapa",
        payload: { md, titulo, processo: idProc || "" },
      });
      const url = chrome.runtime.getURL("src/mapa.html?id=" + encodeURIComponent(id));
      const nomeMd = ("mapa-mental" + (idProc ? "-processo-" + idProc : "") + ".md").replace(
        /[^\w.\-]+/g,
        "-"
      );

      panel.mostrarCardMapa(assistantEl, {
        md,
        resumo: resumoDoMapa(md),
        // A aba abre no CLIQUE, não sozinha: a resposta demora e o gesto do
        // usuário no "Gerar" já expirou — abrir aqui cairia no bloqueador de
        // pop-ups. window.open de URL da extensão é navegação de topo, imune à
        // CSP do tribunal (mesmo truque do "Abrir em nova aba" do preview).
        onAbrir: () => window.open(url, "_blank", "noopener"),
        onBaixar: () => baixarTexto(nomeMd, md, "text/markdown;charset=utf-8"),
      });
      panel.setStatus("");
    } catch (e) {
      panel.endPrep(true);
      panel.setStatus("Erro: " + (e && e.message ? e.message : e));
      if (assistantEl && !acc) panel.removeMessage(assistantEl);
    } finally {
      busy = false;
      panel.lockInput(false);
      // Mesma razão da minuta: o card do mapa é parte do registro da conversa,
      // e o download das peças que ele acabou de fazer também.
      salvarCasoAgora();
    }
  });

  // Tira a cerca ``` que alguns modelos colocam em volta do markdown, mesmo
  // instruídos a não fazê-lo, e o preâmbulo antes do primeiro título.
  function limparMarkdownMapa(txt) {
    let t = String(txt || "").trim();
    const cerca = t.match(/^```[a-z]*\s*\n([\s\S]*?)\n?```$/i);
    if (cerca) t = cerca[1].trim();
    const i = t.search(/^#{1,2}\s+/m);
    if (i > 0) t = t.slice(i);
    return t.trim();
  }

  // "5 eixos · 34 tópicos" para o card — contagem barata por regex (o parser
  // de verdade vive na página do mapa).
  function resumoDoMapa(md) {
    const linhas = md.split(/\r?\n/);
    const eixos = linhas.filter((l) => /^##\s+/.test(l)).length;
    const itens = linhas.filter((l) => /^\s*(?:[-*+]|\d+[.)])\s+/.test(l)).length;
    return eixos + " eixo(s) · " + itens + " tópico(s)";
  }

  // ---------------------------------------------------------------------------
  // MEMÓRIA DE CASO — arranque.
  //
  // Roda no FIM de `iniciar()`, e a posição é a decisão: acima disso o arquivo
  // ainda está registrando callbacks e declarando estado, e a hidratação toca
  // exatamente as variáveis que a zona morta temporal pune (ver o comentário
  // longo lá em cima). Aqui tudo já existe.
  //
  // Sem `await`: nada do painel depende dela para funcionar, e um processo cujo
  // banco esteja lento não pode segurar a montagem da lista de peças.
  // ---------------------------------------------------------------------------
  async function iniciarMemoria() {
    if (!memoriaDisponivel) return;
    casoChave = PJE.chaveDoCaso();
    if (!casoChave) return; // página sem idProcesso: memória desligada nesta aba
    try {
      // ESPERAR os caps é obrigatório, e a razão não é óbvia: `fileIdValido`
      // compara `d.fileProvider` com o provedor ATUAL, e sem `modelCaps` esse
      // provedor cai no default "anthropic". Hidratar antes do caps chegar
      // descartaria em silêncio todo fileId do Gemini — que é o provedor
      // PADRÃO da extensão. O recurso pareceria simplesmente não funcionar.
      await garantirCaps();
      const { caso, desligado } = await CASO.ler(casoChave);
      // O usuário desligou a memória nas opções. Não basta deixar de hidratar:
      // sem `memoriaMorta`, cada clique na lista custaria uma ida ao worker só
      // para ser recusada lá.
      // Uma linha de estado SEMPRE, mesmo quando não há nada a retomar: é por
      // ela que se descobre, sem adivinhação, se a memória está ligada, qual
      // processo ela identificou e o que havia gravado. Sem isso o único
      // sintoma de qualquer falha é "não mudou nada na tela".
      console.log(
        "[PJe IA] memória: " + casoChave +
          (desligado
            ? " — DESLIGADA nas opções"
            : !caso
              ? " — nada gravado ainda (esta é a 1ª sessão neste processo)"
              : " — " + (caso.pecas || []).length + " peça(s), " +
                (caso.conversas || []).length + " conversa(s) gravadas")
      );
      if (desligado) memoriaMorta = true;
      else if (caso) {
        hidratarPecas(caso.pecas);
        retomarConversa(caso);
        conversasDoCaso = caso.conversas || [];
        panel.setConversas(conversasDoCaso, convAtual);
      }
      // A trava só cai DEPOIS da leitura: até aqui, qualquer gravação
      // disparada pelo boot escreveria por cima da memória que ainda não foi
      // lida. É o bug nº 1 desta rodada, e a ordem destas duas linhas é a
      // correção inteira.
      casoCarregado = true;
      agendarSalvar();
    } catch (e) {
      console.log("[PJe IA] memória: INDISPONÍVEL —", e && e.message);
      casoCarregado = true; // falha de leitura não impede a extensão de gravar
    }
  }

  // Repõe o estado da CONVERSA e o desenha de volta na tela.
  //
  // O provedor é a primeira coisa conferida: um histórico da Anthropic não roda
  // no Gemini (raciocínio assinado) e vice-versa. Se o usuário trocou de modelo
  // desde a última sessão, retomar a conversa entregaria um histórico que o
  // envio bloquearia de todo jeito, com um alerta que ele não pediu logo ao
  // abrir os autos. Melhor começar limpo: as PEÇAS (que já foram hidratadas e
  // são o caro) continuam valendo.
  // Troca a conversa aberta. É o mesmo caminho da retomada do boot, e por isso
  // reusa `aplicarConversa`: carregar da lista e carregar do disco no arranque
  // são a mesma operação vista de dois lugares.
  async function trocarConversa(convId) {
    if (busy || !casoChave || convId === convAtual) return;
    // O que está na tela precisa ir ao disco ANTES de sair de cena — trocar de
    // conversa não pode custar o último turno da anterior.
    await salvarCasoAgora();
    const conv = await CASO.lerConversa(casoChave, convId);
    if (!conv) {
      panel.setStatus("Essa conversa não está mais guardada.");
      return;
    }
    panel.clearMessages();
    zerarEstadoDaConversa();
    // A identidade da conversa só é assumida se ela REALMENTE abriu. Assumi-la
    // antes era destrutivo: quando `aplicarConversa` recusa (conversa de outro
    // provedor), a tela fica vazia mas `convAtual` continua apontando para o
    // registro cheio — e a primeira gravação seguinte escreveria o vazio por
    // cima dele. O usuário perderia a conversa por ter clicado nela.
    if (!aplicarConversa(conv)) {
      convAtual = null;
      convVersao = 0;
      panel.setStatus(
        "Essa conversa foi feita com outro provedor de IA (Claude, Gemini ou OpenAI) e não " +
          "pode ser reaberta neste modelo — o raciocínio vem assinado pelo provedor. Volte ao " +
          "modelo anterior nas opções para lê-la."
      );
      atualizarListaConversas();
      return;
    }
    convAtual = convId;
    convVersao = conv.atualizadoEm || 0;
    // Grava o ponteiro: é esta conversa que a próxima sessão retoma.
    CASO.salvar(casoChave, { convAtual: convId });
    atualizarListaConversas();
  }

  // Zera só o que pertence a UMA conversa. As peças (`docsCache`) ficam — elas
  // são do processo, custaram download e servem a todas as conversas dele.
  function zerarEstadoDaConversa() {
    conversation = [];
    pecasNaConversa.clear();
    // Anexos são da CONVERSA, não do processo: "Nova conversa" os solta (ao
    // contrário das peças, que servem a todas as conversas do processo).
    anexos.clear();
    anexosPendentes.length = 0;
    custoConversaUsd = 0;
    conversaProvider = null;
    buscaNaConversa = false;
    ultimoTotalExato = 0;
    ultimaChaveEst = "";
    alertaTrocaLigado = false;
    panel.setCusto(null);
    panel.setContexto(null);
    panel.setAlerta(null);
    panel.setPecasEnviadas([]);
    if (panel.setAnexos) panel.setAnexos([]);
  }

  panel.onTrocarConversa((convId) => {
    trocarConversa(convId).catch((e) =>
      panel.setStatus("Não foi possível abrir a conversa: " + (e && e.message))
    );
  });

  panel.onApagarConversa(async (convId) => {
    if (!casoChave) return;
    try {
      await CASO.apagarConversa(casoChave, convId);
      // Apagou a que está na tela: o chat continua aberto (o usuário não pediu
      // para perder o que está fazendo), mas deixa de ter registro no disco —
      // a próxima gravação cria uma conversa nova.
      if (convId === convAtual) {
        convAtual = null;
        convVersao = 0;
      }
      atualizarListaConversas();
    } catch (e) {
      panel.setStatus("Não foi possível excluir a conversa: " + (e && e.message));
    }
  });

  // Repõe a lista de conversas no painel a partir do que está no banco.
  async function atualizarListaConversas() {
    if (!memoriaDisponivel || !casoChave || memoriaMorta) return;
    try {
      const { caso } = await CASO.ler(casoChave);
      conversasDoCaso = (caso && caso.conversas) || [];
      panel.setConversas(conversasDoCaso, convAtual);
    } catch {
      /* a lista é comodidade: falha nela não pode atrapalhar o trabalho */
    }
  }

  function retomarConversa(caso) {
    const conv = caso.conversa;
    if (!conv) return;
    // Conversa SEM `conversation` é legítima e precisa voltar: uma sessão só de
    // minuta e mapa mental não tem histórico de API nenhum (esses turnos são
    // requests isolados), mas tem registro na tela — e era justamente ela que
    // se perdia. O critério é o mesmo da gravação: o que o usuário vê.
    const temHistorico = Array.isArray(conv.conversation) && conv.conversation.length;
    const temTela = Array.isArray(conv.transcript) && conv.transcript.length;
    if (!temHistorico && !temTela) return;
    // A identidade só é assumida se a conversa abriu de fato — ver o comentário
    // em `trocarConversa`: apontar para uma conversa que não foi aplicada faz a
    // próxima gravação apagá-la.
    if (!aplicarConversa(conv)) return;
    convAtual = conv.convId;
    convVersao = conv.atualizadoEm || 0;
  }

  // Põe uma conversa (do disco) no estado vivo e na tela. Devolve `false`
  // quando RECUSA abrir — e o chamador precisa desse retorno para não assumir a
  // identidade de uma conversa que não abriu (ver `trocarConversa`).
  function aplicarConversa(caso) {
    const provAtual = (modelCaps && modelCaps.provider) || "anthropic";
    if (caso.conversaProvider && caso.conversaProvider !== provAtual) {
      console.log(
        "[PJe IA] memória de caso: conversa anterior era do provedor " +
          caso.conversaProvider + " e o atual é " + provAtual + " — só as peças foram retomadas"
      );
      return false;
    }
    // `|| []` obrigatório: uma conversa só de minuta/mapa não tem histórico de
    // API, e `conversation = undefined` derrubaria o próximo `.length` — que é
    // lido em quase todo caminho do envio.
    conversation = Array.isArray(caso.conversation) ? caso.conversation : [];
    // Anexos do input são de SESSÃO: seus bytes não vão ao disco, então numa
    // conversa retomada os blocos deles apontariam para uploads que não voltam
    // (e o base64, se fosse o caso, nem foi guardado). Tira-os do histórico aqui
    // — senão o `file_id` morto daria 400 no primeiro envio — e avisa, para o
    // usuário saber que pode reanexá-los. Peças do PJe continuam intactas: elas
    // se re-baixam e `revalidarPecasDoHistorico` cuida dos uploads vencidos.
    let anexosRetomados = 0;
    for (const turno of conversation) {
      if (!Array.isArray(turno.content)) continue;
      const antes = turno.content.length;
      turno.content = turno.content.filter(
        (b) => !(b && typeof b.__pecaId === "string" && b.__pecaId.indexOf("anexo:") === 0)
      );
      anexosRetomados += antes - turno.content.length;
    }
    pecasNaConversa = new Set(caso.pecasNaConversa || []);
    custoConversaUsd = caso.custoConversaUsd || 0;
    conversaProvider = caso.conversaProvider || null;
    buscaNaConversa = !!caso.buscaNaConversa;
    ultimoTotalExato = caso.ultimoTotalExato || 0;

    const n = panel.restaurarConversa(caso.transcript || []);
    panel.setPecasEnviadas([...pecasNaConversa]);
    if (caso.selecao && caso.selecao.length) panel.restaurarSelecao(caso.selecao);
    panel.mostrarRetomada({
      quando: dataAmigavel(caso.atualizadoEm),
      nMsgs: n,
      onEsquecer: esquecerEsteProcesso,
    });
    if (custoConversaUsd > 0) {
      // Só o acumulado da conversa: não houve turno nesta sessão, e mostrar um
      // "nesta resposta" seria afirmar um custo que não aconteceu agora.
      panel.setCusto({ conversaUsd: custoConversaUsd });
    }
    if (anexosRetomados) {
      panel.setStatus(
        "Os arquivos anexados nesta conversa não são guardados entre sessões — " +
          "anexe-os de novo (📎) se precisar retomá-los."
      );
    }
    // ABRIU. Sem este `true` a conversa aparece na tela mas o chamador não
    // assume a identidade dela — e a gravação seguinte cria uma DUPLICATA em
    // vez de continuar a conversa retomada (pego pelo teste de retomada).
    return true;
  }

  // "3 de agosto" / "ontem" / "hoje". O usuário pensa a distância em dias, não
  // em data absoluta — e a data completa não cabe na faixa no painel estreito.
  const MESES = ["janeiro","fevereiro","março","abril","maio","junho","julho",
    "agosto","setembro","outubro","novembro","dezembro"];
  function dataAmigavel(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    const hoje = new Date();
    const dias = Math.floor((hoje.setHours(0,0,0,0) - new Date(ts).setHours(0,0,0,0)) / 86400000);
    if (dias <= 0) return "hoje";
    if (dias === 1) return "ontem";
    if (dias < 7) return dias + " dias atrás";
    return d.getDate() + " de " + MESES[d.getMonth()];
  }

  // Apaga a memória DESTE processo. Não mexe na conversa em andamento nem no
  // docsCache: o usuário pediu para não guardar mais, não para perder o que
  // está fazendo agora. `memoriaMorta` impede que o próximo `agendarSalvar`
  // regrave tudo em seguida — sem isso o botão pareceria não funcionar.
  async function esquecerEsteProcesso() {
    if (!memoriaDisponivel || !casoChave) return;
    clearTimeout(salvarTimer);
    memoriaMorta = true;
    pecasSujas.clear();
    try {
      await CASO.esquecer(casoChave);
      // A segunda frase não é enfeite: `memoriaMorta` desliga a gravação até o
      // fim desta sessão, de propósito (senão a conversa em andamento seria
      // regravada segundos depois e o botão pareceria não ter funcionado). Sem
      // dizer isso, o usuário continuaria trabalhando achando que está sendo
      // guardado — e não estaria.
      panel.setStatus(
        "A memória deste processo foi apagada deste computador. Nada será guardado " +
          "até você recarregar a página."
      );
    } catch (e) {
      panel.setStatus("Não foi possível apagar a memória: " + (e && e.message));
    }
  }

  // Repõe no docsCache o que o banco guardou. As entradas voltam PARCIAIS —
  // sem `b64` — e é a marca `semBytes` que avisa os predicados disso. Toda a
  // economia do recurso mora nesta função: uma peça de texto volta completa, e
  // uma peça PDF com fileId vivo volta pronta para o request sem nenhum byte
  // ter atravessado a rede.
  function hidratarPecas(pecas) {
    if (!Array.isArray(pecas)) return;
    let comFile = 0;
    let texto = 0;
    for (const p of pecas) {
      if (!p || !p.id) continue;
      // Nunca sobrescrever o que esta sessão já baixou: o disco é o retrato
      // antigo, e o cache vivo tem os bytes.
      if (docsCache.has(p.id)) continue;
      const d = { kind: p.kind, fmt: p.fmt, size: p.size, semBytes: true };
      if (p.kind === "pdf") d.pages = p.pages;
      if (p.kind === "img") {
        d.mime = p.mime;
        d.w = p.w;
        d.h = p.h;
      }
      if (p.text) d.text = p.text;
      if (p.fileId) {
        d.fileId = p.fileId;
        d.fileProvider = p.fileProvider || "anthropic";
        if (p.fileExp) d.fileExp = p.fileExp;
        if (p.chaveHash) d.chaveHash = p.chaveHash;
      }
      // Entrada sem NADA de aproveitável (peça binária cujo upload venceu e
      // cujos bytes não guardamos) fica de fora: no cache ela só serviria para
      // fazer `precisaBaixar` responder o mesmo que responderia sem ela, e
      // atrapalharia o gauge, que conta `docsCache.has` como "medida".
      if (!d.text && !fileIdValido(d)) continue;
      docsCache.set(p.id, d);
      if (d.text) texto++;
      else comFile++;
    }
    if (texto + comFile) {
      console.log(
        "[PJe IA] memória: " + (texto + comFile) + " peça(s) retomadas do disco (" +
          texto + " de texto, " + comFile + " por referência de upload) — sem novo download"
      );
    }
  }
  iniciarMemoria();

  // Rede de segurança: o usuário troca de aba ou fecha a janela sem ter mexido
  // em nada desde o último debounce. É best-effort de propósito — em `pagehide`
  // o sendMessage pode não chegar, e por isso os `finally` dos turnos continuam
  // sendo o caminho principal, não este.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") salvarCasoAgora();
  });

  } // fim de iniciar()

  // Bootstrap: monta o painel só em telas de autos do PJe. Em apps de página
  // única (frontend novo do PJe) a timeline pode surgir bem depois do load —
  // o observer fica atento até ela aparecer (custo desprezível: um
  // querySelector por lote de mutações).
  if (document.querySelector("#divTimeLine")) {
    iniciar();
  } else {
    const boot = new MutationObserver(() => {
      if (document.querySelector("#divTimeLine")) {
        boot.disconnect();
        iniciar();
      }
    });
    boot.observe(document.documentElement, { childList: true, subtree: true });
  }
})();
