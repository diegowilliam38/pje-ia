# Instalador do `pje` para Windows (PowerShell).
#
#   irm https://raw.githubusercontent.com/marcosmarf27/pje-ia/main/instalar.ps1 | iex
#
# Ou, de dentro de um clone do repositorio:
#
#   .\instalar.ps1
#
# O QUE ELE FAZ, e nada alem disso:
#   1. confere o Node 22+
#   2. clona (ou atualiza) o repositorio em %LOCALAPPDATA%\tecjustica-pje\app
#   3. cria um ATALHO `pje.cmd` e o poe no PATH do USUARIO
#
# POR QUE UM ATALHO, E NAO `npm i -g`: o CLI reusa `src/exportar.js` da extensao,
# e e esse reuso que garante que o pacote saia identico ao do painel. Um pacote
# npm solto copiaria so a pasta `cli/` e o `require("../src/exportar.js")`
# quebraria — ou obrigaria a duplicar o arquivo, e a copia divergiria sem
# ninguem ver. Com o atalho, o repositorio continua sendo a fonte unica e
# atualizar e `git pull`.
#
# NADA e instalado fora do perfil do usuario: sem privilegio de administrador,
# sem mexer no PATH da maquina, sem servico.
#
# SEM HERE-STRINGS (@" ... "@) DE PROPOSITO: elas exigem o terminador na coluna
# zero e quebram quando o arquivo chega com quebras de linha LF — que e o que
# acontece a um script editado fora do Windows ou baixado do GitHub. Arrays de
# linha nao tem esse problema.

$ErrorActionPreference = "Stop"

$REPO = "https://github.com/marcosmarf27/pje-ia.git"
$BASE = Join-Path $env:LOCALAPPDATA "tecjustica-pje"
$APP  = Join-Path $BASE "app"
$BIN  = Join-Path $BASE "bin"
$NL   = [Environment]::NewLine

function Passo($t) { Write-Host ""; Write-Host "=> $t" -ForegroundColor Cyan }
function Ok($t)    { Write-Host "   $t" -ForegroundColor Green }
function Aviso($t) { Write-Host "   $t" -ForegroundColor Yellow }
function Falhar($linhas) { $linhas | ForEach-Object { Write-Host "   $_" -ForegroundColor Red }; exit 1 }

Write-Host "Instalador do pje (TecJustica PJe - CLI de autos)"

# --- 1. Node ---------------------------------------------------------------
Passo "Conferindo o Node.js"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Falhar @(
    "Node.js nao encontrado.",
    "",
    "Instale a versao 22 ou mais nova e rode este instalador de novo:",
    "  winget install OpenJS.NodeJS.LTS",
    "ou baixe em https://nodejs.org"
  )
}
# O CLI usa `fetch` (Node 18+) e o `WebSocket` global, estavel so a partir da
# 22.4 — e e o WebSocket que sustenta o `pje login`.
$versao = (& node -e "process.stdout.write(process.versions.node)")
if ([int](($versao -split '\.')[0]) -lt 22) {
  Falhar @("Node $versao e antigo demais. O 'pje login' precisa da 22+.",
           "  winget install OpenJS.NodeJS.LTS")
}
Ok "Node $versao"

# --- 2. Codigo -------------------------------------------------------------
Passo "Localizando o codigo"
New-Item -ItemType Directory -Force -Path $BASE | Out-Null

# Rodando de dentro de um clone existente, usa ELE — assim o usuario nao acaba
# com duas copias e editando a que nao esta instalada.
$aqui = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
if (Test-Path (Join-Path $aqui "cli\pje.mjs")) {
  $APP = $aqui
  Ok "Usando o repositorio deste diretorio:"
  Ok "  $APP"
} elseif (Get-Command git -ErrorAction SilentlyContinue) {
  if (Test-Path (Join-Path $APP ".git")) {
    & git -C $APP pull --ff-only 2>&1 | Out-Null
    Ok "Repositorio atualizado em $APP"
  } else {
    & git clone --depth 1 $REPO $APP 2>&1 | Out-Null
    Ok "Repositorio clonado em $APP"
  }
} else {
  # Sem git: baixa o zip do branch. Funciona, mas atualizar depois exige rodar
  # o instalador de novo em vez de um `git pull`.
  Aviso "git nao encontrado - baixando o .zip do repositorio"
  $zip = Join-Path $env:TEMP "pje-ia.zip"
  $tmp = Join-Path $env:TEMP "pje-ia-extract"
  Invoke-WebRequest (($REPO -replace '\.git$','') + "/archive/refs/heads/main.zip") -OutFile $zip
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  Expand-Archive $zip $tmp -Force
  Remove-Item -Recurse -Force $APP -ErrorAction SilentlyContinue
  Move-Item (Get-ChildItem $tmp -Directory | Select-Object -First 1).FullName $APP
  Remove-Item $zip -Force -ErrorAction SilentlyContinue
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  Ok "Codigo em $APP"
}

$alvo = Join-Path $APP "cli\pje.mjs"
if (-not (Test-Path $alvo)) { Falhar @("Nao achei cli\pje.mjs em $APP - instalacao abortada.") }

# --- 3. Atalho -------------------------------------------------------------
Passo "Criando o comando pje"
New-Item -ItemType Directory -Force -Path $BIN | Out-Null

# UM atalho so, em .cmd. Ele funciona no cmd.exe E no PowerShell, e propaga o
# codigo de saida do node (o codigo de um .bat e o do ultimo comando).
#
# NAO criar tambem um `pje.ps1`: com os dois no PATH, o PowerShell prefere o
# .ps1 — entao um defeito nele nao seria contornado pelo .cmd correto, seria
# escondido por ele. Menos um arquivo e menos um modo de falha.
#
# `-Value` recebe um ARRAY, e o Set-Content escreve um elemento por linha. Nao
# montar a string com `-join`: `'texto' + $x + 'mais', 'outra linha'` faz o `+`
# ligar ANTES da virgula, o resto vira array, e `string + array` no PowerShell
# junta com `$OFS` — um ESPACO. As duas linhas viram uma, e os argumentos da
# linha seguinte passam a ser argumentos do comando. Ja aconteceu aqui.
#
# ASCII porque o .cmd e lido pelo interpretador de lote, que nao entende BOM.
Set-Content -Path (Join-Path $BIN "pje.cmd") -Encoding ASCII -Value @(
  "@echo off",
  ('node "' + $alvo + '" %*')
)
# Remove um `pje.ps1` de instalacao anterior, que teria precedencia sobre o .cmd.
Remove-Item (Join-Path $BIN "pje.ps1") -ErrorAction SilentlyContinue
Ok "Atalho em $BIN"

# --- 4. PATH ---------------------------------------------------------------
Passo "Registrando no PATH do usuario"
$atual = [Environment]::GetEnvironmentVariable("Path", "User")
if (($atual -split ';') -contains $BIN) {
  Ok "Ja estava no PATH"
} else {
  # PATH do USUARIO, nunca o da maquina: dispensa administrador e nao afeta
  # outras contas da mesma maquina.
  [Environment]::SetEnvironmentVariable("Path", ($atual.TrimEnd(';') + ";" + $BIN), "User")
  Ok "Adicionado ao PATH do usuario"
  Aviso "Abra um terminal NOVO para o comando 'pje' passar a existir."
}
$env:Path = $env:Path + ";" + $BIN

# --- 5. Fim ----------------------------------------------------------------
Write-Host ""
@(
  "Pronto.",
  "",
  "  1. pje login --sessao-atual",
  "     (com o PJe aberto e logado no seu navegador; ele guia o passo manual",
  "      e aproveita a sessao que ja existe, sem criar uma segunda)",
  "",
  "     Se voce NAO estiver logado no PJe:",
  "       pje login https://pje.SEUTRIBUNAL.jus.br/pje1grau",
  "       (abre o Chrome num perfil dedicado; faca o login normalmente)",
  "",
  "  2. pje baixar 0000000-00.0000.0.00.0000",
  "     (rodar de novo no mesmo processo busca so o que apareceu depois)",
  "",
  "  pje ajuda    para o resto",
  "",
  "Atualizar depois:  git -C `"$APP`" pull",
  "Desinstalar:       pje logout   e apague $BASE"
) | ForEach-Object { Write-Host $_ }
