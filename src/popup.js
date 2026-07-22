const apiKeyEl = document.getElementById("apiKey");
const geminiKeyEl = document.getElementById("geminiApiKey");
const modelEl = document.getElementById("model");
const effortEl = document.getElementById("effort");
const customEl = document.getElementById("customPrompt");
const saveBtn = document.getElementById("save");
const saveStatus = document.getElementById("saveStatus");
const chip = document.getElementById("chip");
const chipText = document.getElementById("chipText");
const togglePw = document.getElementById("togglePw");
const togglePwG = document.getElementById("togglePwG");
// Elementos só do layout novo — este script é COMPARTILHADO por popup.html e
// options.html, então tudo o que uma página tem e a outra não é opcional.
const kstateA = document.getElementById("kstateA");
const kstateG = document.getElementById("kstateG");
const firstRun = document.getElementById("firstRun");
const abrirOpcoes = document.getElementById("abrirOpcoes");
const boxA = document.getElementById("boxA");
const boxG = document.getElementById("boxG");

// O chip reflete a chave do PROVEDOR do modelo selecionado: escolher um
// modelo Gemini sem chave do Google (ou Claude sem chave Anthropic) avisa
// na hora, antes mesmo de salvar.
function ehGemini() {
  return String(modelEl.value || "").startsWith("gemini-");
}
// Nome curto do modelo escolhido ("Claude Haiku 4.5"), tirado do próprio
// <option> — sem duplicar aqui a tabela de nomes que já está no HTML.
function nomeDoModelo() {
  const op = modelEl.selectedOptions && modelEl.selectedOptions[0];
  return op ? op.textContent.split(" (")[0].trim() : modelEl.value;
}
function setChip() {
  const gemini = ehGemini();
  const temChave = gemini ? !!geminiKeyEl.value.trim() : !!apiKeyEl.value.trim();
  chip.className = "status-chip " + (temChave ? "ok" : "warn");
  chipText.textContent = temChave
    ? "Pronto para usar — " + nomeDoModelo()
    : gemini
      ? "Falta a chave do Google para este modelo"
      : "Falta a chave da Anthropic para este modelo";
  // estado de cada chave, independente do modelo ativo
  marcarChave(kstateA, apiKeyEl.value);
  marcarChave(kstateG, geminiKeyEl.value);
}
function marcarChave(el, valor) {
  if (!el) return;
  const tem = !!String(valor || "").trim();
  el.className = "kstate" + (tem ? " on" : "");
  el.textContent = tem ? "configurada" : "não configurada";
}

// Abre a chave que FALTA para o modelo ativo — no carregamento E a cada troca
// de modelo: sem isto, escolher um modelo Gemini sem chave do Google mostrava
// o aviso com o campo recolhido, e a linha fechada não parece clicável para
// quem nunca a abriu. Só ABRE (as chaves nascem fechadas no HTML): fechar o
// que o usuário abriu na mão seria hostil.
function abrirChaveQueFalta() {
  const gemini = ehGemini();
  const faltaA = !apiKeyEl.value.trim();
  const faltaG = !geminiKeyEl.value.trim();
  const primeiroUso = faltaA && faltaG;
  if (boxA && faltaA && (primeiroUso || !gemini)) boxA.open = true;
  if (boxG && faltaG && (primeiroUso || gemini)) boxG.open = true;
}

chrome.storage.local.get(
  ["apiKey", "geminiApiKey", "model", "effort", "customPrompt"],
  (v) => {
    if (v.apiKey) apiKeyEl.value = v.apiKey;
    if (v.geminiApiKey) geminiKeyEl.value = v.geminiApiKey;
    if (v.model) modelEl.value = v.model;
    if (effortEl && v.effort) effortEl.value = v.effort;
    if (customEl && v.customPrompt) customEl.value = v.customPrompt;
    setChip();
    // Os passos "Como usar" só existem enquanto NENHUMA chave foi salva: é
    // quando eles servem, e é o que faz o popup caber sem rolagem depois.
    // O critério é o que está SALVO (não o que está sendo digitado) — sumir no
    // meio da digitação seria um salto de layout no meio da tarefa.
    if (firstRun && (v.apiKey || v.geminiApiKey)) firstRun.hidden = true;
    abrirChaveQueFalta();
  }
);

function ligarToggle(btn, input) {
  btn.addEventListener("click", () => {
    const showing = input.type === "text";
    input.type = showing ? "password" : "text";
    btn.textContent = showing ? "mostrar" : "ocultar";
  });
}
ligarToggle(togglePw, apiKeyEl);
ligarToggle(togglePwG, geminiKeyEl);

modelEl.addEventListener("change", () => {
  setChip();
  abrirChaveQueFalta(); // trocou para um provedor sem chave: mostra o campo
});
apiKeyEl.addEventListener("input", setChip);
geminiKeyEl.addEventListener("input", setChip);

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
  const cfg = { apiKey, geminiApiKey, model: modelEl.value };
  if (effortEl) cfg.effort = effortEl.value;
  if (customEl) cfg.customPrompt = customEl.value.trim();
  chrome.storage.local.set(cfg, () => {
    setChip();
    // salvou a primeira chave: os passos de primeiro uso cumpriram seu papel
    if (firstRun && (apiKey || geminiApiKey)) firstRun.hidden = true;
    const temChaveDoModelo = ehGemini() ? !!geminiApiKey : !!apiKey;
    saveStatus.textContent = temChaveDoModelo
      ? "Configuração salva ✓"
      : "Salvo — falta a chave do provedor do modelo escolhido.";
    setTimeout(() => (saveStatus.textContent = ""), 2500);
  });
});
