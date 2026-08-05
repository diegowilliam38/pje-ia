const apiKeyEl = document.getElementById("apiKey");
const geminiKeyEl = document.getElementById("geminiApiKey");
const openaiKeyEl = document.getElementById("openaiApiKey");
const modelEl = document.getElementById("model");
const effortEl = document.getElementById("effort");
const customEl = document.getElementById("customPrompt");
const saveBtn = document.getElementById("save");
const saveStatus = document.getElementById("saveStatus");
const chip = document.getElementById("chip");
const chipText = document.getElementById("chipText");
const togglePw = document.getElementById("togglePw");
const togglePwG = document.getElementById("togglePwG");
const togglePwO = document.getElementById("togglePwO");
// Elementos só do layout novo — este script é COMPARTILHADO por popup.html e
// options.html, então tudo o que uma página tem e a outra não é opcional.
const kstateA = document.getElementById("kstateA");
const kstateG = document.getElementById("kstateG");
const kstateO = document.getElementById("kstateO");
const firstRun = document.getElementById("firstRun");
const abrirOpcoes = document.getElementById("abrirOpcoes");
// Layout "provedor em primeiro plano"
const provCount = document.getElementById("provCount");
const testKey = document.getElementById("testKey");
const effortHint = document.getElementById("effortHint");
const provs = [...document.querySelectorAll(".prov")];
const keySecs = [...document.querySelectorAll(".pc-sec[data-prov]")];
const personas = [...document.querySelectorAll(".persona")];

const PROVS = ["anthropic", "gemini", "openai"];
const NOME_PROVEDOR = { anthropic: "Anthropic", gemini: "Google", openai: "OpenAI" };
// Primeiro modelo de cada provedor = o recomendado. Clicar num cartão troca
// para ele; o provedor NÃO é gravado no storage — continua derivado do `model`.
const PADRAO = { anthropic: "claude-haiku-4-5", gemini: "gemini-3.6-flash", openai: "gpt-5.6-luna" };
// Modelo usado quando NADA foi salvo ainda. Precisa ser byte a byte o default
// do `getCfg` em background.js: sem `model` no storage o worker chama o Gemini
// 3.6 Flash, mas o <select> mostrava o PRIMEIRO <option> do HTML (o Haiku) —
// então, na primeira instalação, o popup pedia a chave da Anthropic para uma
// extensão que ia falar com o Google, e o selo do painel contradizia a tela de
// configuração. Não dá para importar a constante do worker (este script é
// clássico e aquele é ES module), então a duplicação é deliberada e anotada
// nos dois lados.
const MODELO_PADRAO = "gemini-3.6-flash";

// O chip reflete a chave do PROVEDOR do modelo selecionado: escolher um modelo
// de um provedor sem a chave dele avisa na hora, antes mesmo de salvar. O
// provedor sai do prefixo do id (mesma regra do background.js/content.js).
function provedorDoModelo() {
  const m = String(modelEl.value || "");
  if (m.startsWith("gemini-")) return "gemini";
  if (m.startsWith("gpt-")) return "openai";
  return "anthropic";
}
function campoDoProvedor(p) {
  return p === "gemini" ? geminiKeyEl : p === "openai" ? openaiKeyEl : apiKeyEl;
}
// Nome curto do modelo escolhido ("Claude Haiku 4.5"), tirado do próprio
// <option> — sem duplicar aqui a tabela de nomes que já está no HTML.
function nomeDoModelo() {
  const op = modelEl.selectedOptions && modelEl.selectedOptions[0];
  return op ? op.textContent.split(" (")[0].trim() : modelEl.value;
}
function temChaveDigitada(el) {
  return !!(el && el.value.trim());
}

// O nível de raciocínio é um SEGMENTED nas duas páginas (os <input type=radio>
// vivem fora da tela e continuam sendo a fonte de verdade). Não há mais o
// caminho de <select> que existia enquanto options.html tinha layout próprio.
function getEffort() {
  if (!effortEl) return "high";
  const m = effortEl.querySelector("input:checked");
  return m ? m.value : "high";
}
function setEffort(v) {
  if (!effortEl || !v) return;
  const alvo = effortEl.querySelector('input[value="' + v + '"]');
  if (alvo) alvo.checked = true;
}
const EFFORT_TXT = {
  low: "Baixo — mais rápido e barato",
  medium: "Médio — equilíbrio",
  high: "Alto (recomendado)",
};
function setChip() {
  const prov = provedorDoModelo();
  const temChave = temChaveDigitada(campoDoProvedor(prov));
  chip.className = "status-chip " + (temChave ? "ok" : "warn");
  chipText.textContent = temChave
    ? "Pronto para usar — " + nomeDoModelo()
    : "Falta a chave da " + NOME_PROVEDOR[prov] + " para este modelo";
  // estado de cada chave, independente do modelo ativo
  marcarChave(kstateA, apiKeyEl.value);
  marcarChave(kstateG, geminiKeyEl.value);
  marcarChave(kstateO, openaiKeyEl && openaiKeyEl.value);
  if (provCount) {
    const n = PROVS.filter((p) => temChaveDigitada(campoDoProvedor(p))).length;
    provCount.textContent = n + " de 3 configurados";
  }
  if (effortHint) effortHint.textContent = EFFORT_TXT[getEffort()] || "";
  pintarProvedores(prov);
}
function marcarChave(el, valor) {
  if (!el) return;
  const tem = !!String(valor || "").trim();
  el.className = "kstate" + (tem ? " on" : "");
  el.textContent = tem ? "configurada" : "não configurada";
}

// Só a chave do provedor ATIVO fica visível, e o <select> de modelo mostra só
// os modelos dele. É o que troca três acordeões concorrentes por uma escolha.
function pintarProvedores(prov) {
  provs.forEach((b) => b.setAttribute("aria-selected", String(b.dataset.prov === prov)));
  keySecs.forEach((s) => (s.hidden = s.dataset.prov !== prov));
  if (modelEl && provs.length) {
    for (const g of modelEl.querySelectorAll("optgroup")) {
      const pg = g.dataset.prov || "";
      if (pg) g.hidden = pg !== prov;
    }
  }
}

// Chave já salva vira linha mascarada: a chave inteira nunca volta à tela.
function mascarar(v) {
  const s = String(v || "").trim();
  if (s.length <= 10) return "••••••••";
  return s.slice(0, 4) + "••••••••••••" + s.slice(-4);
}
function pintarMascara(sec, valor) {
  if (!sec) return;
  const mask = sec.querySelector(".keymask");
  const row = sec.querySelector(".pw-row");
  const hint = sec.querySelector(".hint");
  const trocar = sec.querySelector(".pc-trocar");
  const tem = !!String(valor || "").trim();
  if (!mask || !row) return;
  mask.hidden = !tem;
  row.hidden = tem;
  if (hint) hint.hidden = tem;
  if (trocar) trocar.hidden = !tem;
  if (tem) mask.querySelector(".km-v").textContent = mascarar(valor);
}
function pintarMascaras() {
  pintarMascara(document.getElementById("keyA"), apiKeyEl.value);
  pintarMascara(document.getElementById("keyG"), geminiKeyEl.value);
  pintarMascara(document.getElementById("keyO"), openaiKeyEl && openaiKeyEl.value);
}

// A função `abrirChaveQueFalta` foi removida com o layout de acordeão: ela abria
// os `<details>` boxA/boxG/boxO, que não existem mais em nenhuma das duas telas.
// Como todos os acessos eram guardados por `if (box…)`, ela já era um no-op
// chamado a cada troca de modelo — e o comentário dela descrevia um layout
// inexistente. Quem mostra a chave do provedor ativo agora é `pintarProvedores`.

chrome.storage.local.get(
  ["apiKey", "geminiApiKey", "openaiApiKey", "model", "effort", "customPrompt"],
  (v) => {
    if (v.apiKey) apiKeyEl.value = v.apiKey;
    if (v.geminiApiKey) geminiKeyEl.value = v.geminiApiKey;
    if (openaiKeyEl && v.openaiApiKey) openaiKeyEl.value = v.openaiApiKey;
    modelEl.value = v.model || MODELO_PADRAO;
    // `select.value` com um id que não existe entre os <option> deixa o campo
    // SEM seleção (value vira ""), e daí o chip cairia no provedor errado e um
    // "Salvar" gravaria modelo vazio. Acontece com config de uma versão que
    // oferecia outro modelo — o padrão atual é a saída correta.
    if (!modelEl.value) modelEl.value = MODELO_PADRAO;
    if (v.effort) setEffort(v.effort);
    if (customEl && v.customPrompt) customEl.value = v.customPrompt;
    pintarMascaras();
    setChip();
    // Os passos "Como usar" só existem enquanto NENHUMA chave foi salva: é
    // quando eles servem, e é o que faz o popup caber sem rolagem depois.
    // O critério é o que está SALVO (não o que está sendo digitado) — sumir no
    // meio da digitação seria um salto de layout no meio da tarefa.
    if (firstRun && (v.apiKey || v.geminiApiKey || v.openaiApiKey)) firstRun.hidden = true;
  }
);

function ligarToggle(btn, input) {
  if (!btn || !input) return;
  btn.addEventListener("click", () => {
    const showing = input.type === "text";
    input.type = showing ? "password" : "text";
    btn.textContent = showing ? "mostrar" : "ocultar";
  });
}
ligarToggle(togglePw, apiKeyEl);
ligarToggle(togglePwG, geminiKeyEl);
ligarToggle(togglePwO, openaiKeyEl);

// Clicar num cartão de provedor troca o modelo para o recomendado dele. Não
// grava nada: o provedor segue derivado do `model` no próximo carregamento.
provs.forEach((b) => {
  b.addEventListener("click", () => {
    const p = b.dataset.prov;
    if (provedorDoModelo() !== p) modelEl.value = PADRAO[p];
    setChip();
  });
});
// "Trocar": devolve o campo editável e limpa o valor — quem troca digita
// outra chave, não edita a atual (que nunca é exibida por inteiro).
document.querySelectorAll(".pc-trocar").forEach((b) => {
  b.addEventListener("click", () => {
    const alvo = document.getElementById(b.dataset.alvo);
    if (!alvo) return;
    alvo.value = "";
    pintarMascaras();
    setChip();
    alvo.focus();
  });
});
personas.forEach((b) => {
  b.addEventListener("click", () => {
    if (!customEl) return;
    const t = b.dataset.txt || "";
    customEl.value = customEl.value.trim() ? customEl.value.trim() + "\n" + t : t;
    customEl.focus();
  });
});

modelEl.addEventListener("change", () => {
  // setChip → pintarProvedores já revela a chave do provedor recém-escolhido.
  setChip();
});
apiKeyEl.addEventListener("input", setChip);
geminiKeyEl.addEventListener("input", setChip);
if (openaiKeyEl) openaiKeyEl.addEventListener("input", setChip);
if (effortEl) effortEl.addEventListener("change", setChip);

// "Testar chave": lista os modelos do provedor (GET), que valida a credencial
// SEM consumir tokens. Roda no worker, que já sabe escolher a chave por
// provedor — e assim a chave não passa por mais um contexto do que precisa.
if (testKey) {
  testKey.addEventListener("click", () => {
    const prov = provedorDoModelo();
    const chave = campoDoProvedor(prov).value.trim();
    if (!chave) {
      saveStatus.textContent = "Digite a chave da " + NOME_PROVEDOR[prov] + " primeiro.";
      setTimeout(() => (saveStatus.textContent = ""), 2500);
      return;
    }
    testKey.disabled = true;
    saveStatus.textContent = "Testando…";
    chrome.runtime.sendMessage({ type: "testarChave", provider: prov, key: chave }, (r) => {
      testKey.disabled = false;
      saveStatus.textContent = chrome.runtime.lastError
        ? "Não foi possível testar agora."
        : r && r.ok
          ? "Chave válida."
          : "Chave recusada: " + ((r && r.erro) || "verifique e tente de novo.");
      setTimeout(() => (saveStatus.textContent = ""), 4000);
    });
  });
}

// "Configuração completa" (só no popup): a página de opções tem as mesmas
// preferências com as explicações longas e espaço para escrever as instruções
// personalizadas com calma.
if (abrirOpcoes) {
  abrirOpcoes.addEventListener("click", (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
    window.close(); // o popup fecharia sozinho ao perder o foco; fechar aqui evita a piscada
  });
}

saveBtn.addEventListener("click", () => {
  const apiKey = apiKeyEl.value.trim();
  const geminiApiKey = geminiKeyEl.value.trim();
  const openaiApiKey = openaiKeyEl ? openaiKeyEl.value.trim() : "";
  const cfg = { apiKey, geminiApiKey, openaiApiKey, model: modelEl.value };
  if (effortEl) cfg.effort = getEffort();
  if (customEl) cfg.customPrompt = customEl.value.trim();
  chrome.storage.local.set(cfg, () => {
    pintarMascaras();
    setChip();
    // salvou a primeira chave: os passos de primeiro uso cumpriram seu papel
    if (firstRun && (apiKey || geminiApiKey || openaiApiKey)) firstRun.hidden = true;
    const temChaveDoModelo = temChaveDigitada(campoDoProvedor(provedorDoModelo()));
    saveStatus.textContent = temChaveDoModelo
      ? "Configuração salva ✓"
      : "Salvo — falta a chave do provedor do modelo escolhido.";
    setTimeout(() => (saveStatus.textContent = ""), 2500);
  });
});
