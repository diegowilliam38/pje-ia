/* Botão "Copiar código PIX" das telas satélites (ajuda, novidades, opções).
 *
 * Vive num arquivo próprio, e não num <script> no HTML, porque a CSP da
 * extensão é `script-src 'self'` — inline não executa e a falha é silenciosa.
 *
 * O que se copia é o payload BR Code inteiro (o "PIX Copia e Cola"), não a
 * chave: ele já carrega chave, nome, moeda e CRC, então cola direto no campo
 * de Copia e Cola de qualquer banco. A chave crua continua VISÍVEL ao lado,
 * para quem prefere digitar — são três caminhos (ler o QR de outro aparelho,
 * colar o código, digitar a chave) e nenhum deles exige o outro.
 */
(function () {
  "use strict";
  const botoes = document.querySelectorAll("[data-pix]");
  if (!botoes.length) return;

  // Rótulo vai no <span> interno, nunca no botão: `btn.textContent` apagaria o
  // <svg> — e de forma permanente, porque o valor "anterior" que o timer
  // restaura já viria sem o ícone (DESIGN.md §5).
  function rotulo(btn, texto) {
    const s = btn.querySelector(".lbl");
    if (s) s.textContent = texto;
    else btn.textContent = texto;
  }

  // Fallback para quando a Clipboard API não estiver disponível (contexto sem
  // gesto reconhecido, permissão negada). Mesma técnica do editor de minutas.
  function copiarNaMarra(txt) {
    const ta = document.createElement("textarea");
    ta.value = txt;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }

  for (const btn of botoes) {
    const codigo = btn.getAttribute("data-pix") || "";
    let timer = 0;
    btn.addEventListener("click", async () => {
      let ok = false;
      try {
        await navigator.clipboard.writeText(codigo);
        ok = true;
      } catch {
        ok = copiarNaMarra(codigo);
      }
      // Falha também é resposta: um botão que não diz nada deixa o usuário
      // colando um clipboard vazio no aplicativo do banco. E a saída oferecida
      // tem de ser algo que ESTEJA na tela — o QR ao lado —, não "o código
      // abaixo", que não existe em lugar nenhum da página.
      rotulo(btn, ok ? "Copiado!" : "Não deu — use o QR");
      btn.classList.toggle("feito", ok);
      if (!ok) btn.title = codigo; // último recurso: dá para selecionar à mão
      clearTimeout(timer);
      timer = setTimeout(() => {
        rotulo(btn, "Copiar código PIX");
        btn.classList.remove("feito");
      }, 2200);
    });
  }
})();
