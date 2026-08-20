# Publicação na Chrome Web Store — guia passo a passo

> **Status: PUBLICADA.** Versão no ar: **0.47.0** (confirmada em 20/08/2026).
> ID da extensão: `imgfakkieoijdhdpafjjlefcckbmbppm` — é ele que monta a
> [ficha](https://chromewebstore.google.com/detail/imgfakkieoijdhdpafjjlefcckbmbppm)
> e as [avaliações](https://chromewebstore.google.com/detail/imgfakkieoijdhdpafjjlefcckbmbppm/reviews).
>
> Os itens 0 a 7 descrevem a PRIMEIRA publicação e ficam como registro. Para subir
> uma nova versão, o que vale é o **item 8** — e, se o painel recusar o upload, o
> **item 8.1** provavelmente já responde.

Estado da extensão frente às políticas (avaliado em 21/07/2026, já contra as regras
novas que entram em vigor em **01/08/2026**): **apta a publicar**. Sem código remoto,
sem `eval`, sem ofuscação, sem servidor intermediário, permissões mínimas (`storage` +
3 hosts), propósito único claro e divulgação de envio de dados já presente na UI
(popup, opções, ajuda) com link para a [política de privacidade](../PRIVACY.md).

O único ponto que alonga a revisão é o host permission amplo `https://*.jus.br/*` —
esperado e justificável (ver texto pronto abaixo). Revisões com permissão ampla podem
levar de alguns dias a algumas semanas.

---

## 0. Pré-requisitos da conta

1. Acesse <https://chrome.google.com/webstore/devconsole> com a conta Google.
2. Se ainda não pagou, pague a **taxa única de US$ 5** de registro de desenvolvedor.
3. Na aba **Conta** (Account) do painel:
   - **Verifique o e-mail de contato** (campo "Contact email" — chega um link de
     confirmação; sem isso o envio fica bloqueado, causa comum de falha em tentativa
     anterior).
   - Ative a **verificação em duas etapas** na conta Google (obrigatória).
   - Preencha a declaração de **comerciante/não comerciante** (DSA): para extensão
     gratuita publicada por pessoa física, marque **"Não sou comerciante"**
     (non-trader).

## 1. Gerar o pacote

```powershell
pwsh ./empacotar.ps1
```

Gera **dois** arquivos na raiz, ambos ignorados pelo git (`*.zip`):

- `tecjustica-pje-v<versão>.zip` — **é este que sobe na loja.** Leva só o que a
  extensão precisa em runtime: `manifest.json`, `src/`, `icons/` e `vendor/` (d3 +
  markmap-view, usados pela página do mapa mental).
- `pje-ia.zip` — cópia de nome FIXO, para o release do GitHub. O botão
  "⬇️ Baixar a extensão" do README aponta para
  `releases/latest/download/pje-ia.zip`, endereço que só continua valendo se o asset
  tiver sempre o mesmo nome. Anexe **os dois** ao release:
  `gh release create <tag> tecjustica-pje-v*.zip pje-ia.zip`.

O script roda `node --check` em todos os `src/*.js` antes de empacotar e ABORTA se
algum falhar. Lembre que `node --check` valida só a SINTAXE: variável inexistente
passa por ele e derruba a função inteira em runtime (ver a nota do `no-undef` no
`CLAUDE.md`).

**`empacotar.ps1` copia `src/` inteira e sem filtro.** Arquivo de laboratório deixado
ali entra no pacote publicado — inclusive os `*.local.html`, que o `.gitignore`
esconde do `git status` e que, por isso, iriam calados para a loja. Laboratório mora
no scratchpad ou na raiz, nunca em `src/`.

## 2. Criar o item e enviar o pacote

Painel → **+ Novo item** → arraste o ZIP. Depois preencha as abas a seguir.

## 3. Aba "Detalhes do item" (Store listing)

- **Idioma**: Português (Brasil).
- **Título**: `TecJustiça PJe — Análise de Processos`
- **Resumo**: preenchido automaticamente com a `description` do manifest (limite de
  **132 caracteres** — validado no upload; a atual tem 130).
- **Descrição** (colar):

  ```
  TecJustiça PJe adiciona um assistente de IA à tela de autos digitais do PJe (Processo
  Judicial Eletrônico) — em qualquer tribunal que use o sistema (TJs, TRFs, TRTs).

  Você marca as peças do processo, pergunta em linguagem natural e o modelo — Claude
  (Anthropic) ou Gemini (Google), à sua escolha — responde com base no conteúdo real
  dos documentos: resumos, linhas do tempo, partes, pedidos, provas, relatórios em
  .docx, tudo direto na página do processo.

  COMO FUNCIONA
  • Traga sua própria chave de API (Anthropic ou Google) — a extensão não tem servidor
    próprio: os documentos vão direto do seu navegador para a API do provedor que VOCÊ
    escolheu, autenticados pela SUA chave.
  • Nada é enviado sem ação sua: você seleciona as peças (checkboxes ou digitando @) e
    envia a pergunta. A resposta usa somente os documentos marcados.
  • Citações com número de página, busca de jurisprudência em fontes oficiais (STF,
    STJ, Planalto…), geração de relatório em Word, medidor de contexto e custo por
    resposta no rodapé.

  PRIVACIDADE
  • Sem telemetria, sem analytics, sem servidor do desenvolvedor.
  • Chaves e preferências ficam somente no armazenamento local do navegador.
  • Atenção: autos judiciais podem conter dados sigilosos — use conforme as normas do
    seu tribunal. Política de privacidade:
    https://github.com/marcosmarf27/pje-ia/blob/main/PRIVACY.md

  REQUISITOS
  • Acesso ao PJe (login no tribunal) e uma chave de API da Anthropic (console.anthropic.com)
    ou do Google (aistudio.google.com). O uso da API é pago pelo provedor — a página de
    ajuda da extensão mostra a tabela de preços e ensina a criar a chave.

  Código aberto (MIT): https://github.com/marcosmarf27/pje-ia
  Não afiliado ao CNJ, à Anthropic nem ao Google.
  ```

- **Categoria**: Ferramentas (Tools) — alternativa: Produtividade/Fluxo de trabalho.
- **Ícone da loja**: `icons/icon128.png` (já no ZIP; o painel pede upload separado do
  128×128 — usar o mesmo arquivo).
- **Screenshots** (1280×800): `docs/store/screenshot-1-painel-1280x800.png` e
  `docs/store/screenshot-2-mencao-1280x800.png`.
- **Tile promocional pequeno** (440×280, opcional mas recomendado):
  `docs/store/promo-tile-440x280.png`.
- **Site oficial / URL de suporte**: `https://github.com/marcosmarf27/pje-ia`
  (suporte: `https://github.com/marcosmarf27/pje-ia/issues`).

## 4. Aba "Práticas de privacidade" (Privacy practices) — a mais importante

- **Propósito único** (colar):
  > Permitir que o usuário analise, com o modelo de IA que ele próprio configurou (Claude ou Gemini), as peças que ele selecionar dos autos digitais abertos no PJe — chat, resumos, citações e relatórios sobre esses documentos.

- **Justificativa de `storage`**:
  > Guardar localmente as chaves de API fornecidas pelo usuário, o modelo escolhido e preferências de interface (chrome.storage.local), e caches temporários de sessão (chrome.storage.session). Nada é sincronizado nem enviado a servidores do desenvolvedor.

- **Justificativa dos host permissions** (campo único):
  > https://*.jus.br/* — o PJe (Processo Judicial Eletrônico, sistema oficial do Judiciário brasileiro) roda em dezenas de domínios distintos, um por tribunal (pje.tjce.jus.br, pje1g.trf5.jus.br, pje.trt7.jus.br…), todos sob o TLD restrito .jus.br, exclusivo de órgãos da Justiça. Não existe lista fixa de tribunais; o padrão amplo é necessário para a extensão funcionar em qualquer tribunal sem configuração. O content script só constrói interface quando detecta a tela de autos digitais do PJe (elemento #divTimeLine); em qualquer outra página .jus.br ele termina imediatamente sem tocar no DOM. O acesso é usado exclusivamente para listar e baixar, pela sessão já autenticada do próprio usuário, as peças processuais que ele marcar.
  > https://api.anthropic.com/* e https://generativelanguage.googleapis.com/* — chamadas diretas às APIs de IA (Anthropic e Google) feitas pelo service worker com a chave de API do próprio usuário; nenhum servidor intermediário.

- **Código remoto**: marcar **"Não, não uso código remoto"** (não há build, bundler,
  CDN nem scripts externos — todo o código está no pacote).

- **Uso de dados** (checkboxes de coleta): marcar
  - ☑ **Conteúdo do site** (Website content) — as peças processuais que o usuário
    seleciona e as mensagens do chat, transmitidas à API do provedor de IA escolhido
    por ele.
  - ☑ **Informações de autenticação** (Authentication information) — as chaves de API
    do próprio usuário, armazenadas localmente e enviadas apenas ao respectivo
    provedor para autenticar as chamadas.
  - Nenhuma das demais categorias (localização, histórico, atividade, saúde,
    financeiro, comunicações pessoais, PII) é coletada pela extensão.

- **Certificações** (as três, todas verdadeiras aqui): não vendo dados; uso/transfiro
  dados apenas para o propósito único; não uso dados para crédito ou empréstimos.

- **URL da política de privacidade**:
  `https://github.com/marcosmarf27/pje-ia/blob/main/PRIVACY.md`

## 5. Aba "Distribuição"

- **Visibilidade**: Pública (ou "Não listada" se quiser um soft-launch — instalável só
  por quem tem o link; dá para tornar pública depois sem nova revisão).
- **Países**: pode restringir ao Brasil (o público é 100% brasileiro) ou deixar todos.
- **Preço**: gratuito.

## 6. Enviar para revisão

Botão **Enviar para revisão**. Marque a opção de **publicação automática após
aprovação** ou publique manualmente depois. Prazos típicos: 1–3 dias; com permissão
ampla de host pode levar mais (revisão aprofundada — o painel avisa "may require an
in-depth review"). Acompanhe o status no painel e o e-mail de contato.

## 7. Se vier rejeição

Motivos prováveis e resposta:

- **"Permissão ampla demais"** → responder com a justificativa do item 4 (não há como
  enumerar os tribunais; TLD .jus.br é restrito ao Judiciário). Se o revisor insistir,
  alternativa técnica: migrar `*.jus.br` para `optional_host_permissions` com pedido
  em runtime — custa fricção ao usuário, implementar só se exigido.
- **"Metadados insuficientes/enganosos"** → conferir se a descrição bate com o que a
  extensão faz (bate) e se as screenshots mostram a extensão real (mostram).
- **"Divulgação de dados"** → apontar os avisos no popup/opções/ajuda + PRIVACY.md.

Cada reenvio reinicia a fila de revisão; responder pelo próprio painel (há campo de
apelação/observações do desenvolvedor).

## 8. Atualizações futuras — o caminho de toda nova versão

Ordem, sem pular passos:

1. **Confira qual versão já está publicada** (painel → *Pacote*, ou a própria ficha).
   É o passo que quase ninguém faz, e é ele que evita o 8.1.
2. **Suba a `version` no `manifest.json`** — estritamente maior que a publicada.
3. **Meça a `description`** (limite de 132; ver 8.2):

   ```powershell
   node -e "const m=require('./manifest.json');console.log(m.version, m.description.length)"
   ```

4. `pwsh ./empacotar.ps1` (item 1).
5. Painel → **Pacote** → **Enviar novo pacote** → arraste o
   `tecjustica-pje-v<versão>.zip` → **Enviar para revisão**. Atualizações costumam
   ser mais rápidas que a primeira análise.
6. Release no GitHub com os DOIS zips (item 1).

As respostas das abas de privacidade ficam salvas — só precisam mudar se as práticas
de dados mudarem (e, pela política de 08/2026, mudança de prática exige divulgação
proativa aos usuários: atualizar `PRIVACY.md` + notas de versão).

### 8.1 "Número de versão inválido no manifesto: X" é CONFIRMAÇÃO, não erro

Mensagem do painel, na íntegra:

> Ocorreu um problema ao fazer upload do seu arquivo.
> Número de versão inválido no manifesto: **X**. Certifique-se de que o último pacote
> enviado tenha uma versão maior no manifest.json do que o pacote publicado: **X**.

A Store exige versão **estritamente crescente** e não olha o conteúdo do `.zip`: a
única identidade de um pacote é o número da versão. Logo, essa frase só aparece
quando aquele pacote **já subiu e já está publicado** — repare que ela NOMEIA a
versão publicada, e a versão publicada é a sua.

O que engana é a moldura: o painel envolve a recusa num banner genérico ("Ocorreu um
problema ao fazer upload do seu arquivo"), que se lê como queda de rede e convida a
tentar de novo — ou a bumpar a versão para "destravar".

**Antes de bumpar, confirme que existe algo novo para subir:**

```bash
git status            # limpo?
git log -1 --oneline  # é o commit daquela versão?
```

Árvore limpa em cima do commit da versão publicada significa que o que está no ar é
byte a byte o que está no disco: **não há o que subir**. Bumpar ali publica um pacote
idêntico — queima um número de versão, põe a extensão numa fila de revisão à toa e
dispara, na base instalada, um `onInstalled` de update que não corresponde a mudança
nenhuma.

Ocorrido em 20/08/2026 com a 0.47.0, que havia sido publicada no dia anterior.

### 8.2 `description` do manifest acima de 132 caracteres

Já barrou o upload DUAS vezes (v0.9.9: 136→130; v0.14.0: 146→118). É o campo
`description` do `manifest.json`, que vira o **Resumo** da ficha — não confundir com
a descrição longa da loja (~16 mil caracteres, item 3). Medir sempre no passo 3.

### 8.3 A loja não tem fila de versões

Subir a mais recente entrega todas as anteriores de uma vez — não é preciso publicar
0.44, depois 0.45, depois 0.46. Salto acumulado é o normal aqui; o que precisa cobrir
o intervalo inteiro são as **notas de versão** (conferir `gh release list` antes de
escrever, porque a distância entre o `main` e o último release costuma ser de várias
versões).

### 8.4 Não existe push para quem já instalou

A Store não tem canal de aviso para a base instalada. Os únicos mecanismos são a
própria ATUALIZAÇÃO (`chrome.runtime.onInstalled` com `reason === "update"` e
`details.previousVersion`), o badge do ícone e as telas satélites da extensão — é o
que a v0.47.0 passou a usar. Buscar avisos num servidor exigiria `host_permissions`
novo e mudaria a história de privacidade da extensão; descartado.
