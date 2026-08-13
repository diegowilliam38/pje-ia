# Empacota a extensão para a Chrome Web Store.
# Uso: pwsh ./empacotar.ps1  →  gera tecjustica-pje-v<versão>.zip na raiz (ignorado pelo git).
# O ZIP contém APENAS o que a extensão precisa em runtime: manifest.json, src/, icons/, vendor/.

$ErrorActionPreference = "Stop"
$raiz = $PSScriptRoot

$manifest = Get-Content (Join-Path $raiz "manifest.json") -Raw | ConvertFrom-Json
$versao = $manifest.version
$zip = Join-Path $raiz "tecjustica-pje-v$versao.zip"

# Valida a sintaxe dos scripts antes de empacotar (não há build step)
Get-ChildItem (Join-Path $raiz "src\*.js") | ForEach-Object {
  node --check $_.FullName
  if ($LASTEXITCODE -ne 0) { throw "Erro de sintaxe em $($_.Name) — pacote NÃO gerado." }
}

$staging = Join-Path ([System.IO.Path]::GetTempPath()) "tecjustica-pje-pack-$versao"
if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
New-Item -ItemType Directory -Path $staging | Out-Null

Copy-Item (Join-Path $raiz "manifest.json") $staging
Copy-Item (Join-Path $raiz "src") (Join-Path $staging "src") -Recurse
Copy-Item (Join-Path $raiz "icons") (Join-Path $staging "icons") -Recurse
# vendor/: d3 + markmap-view, usados pela página do mapa mental (src/mapa.html)
Copy-Item (Join-Path $raiz "vendor") (Join-Path $staging "vendor") -Recurse

if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $staging "*") -DestinationPath $zip
Remove-Item $staging -Recurse -Force

# Cópia com nome FIXO, para o release. O botão "⬇️ Baixar a extensão" do
# README aponta para .../releases/latest/download/pje-ia.zip — um endereço que
# só continua valendo se o asset tiver sempre o mesmo nome. Enquanto o release
# levava apenas o zip versionado, esse link respondia 404: quem chegava pelo
# GitHub não conseguia baixar a extensão, e nada na página dizia o porquê.
# Anexe OS DOIS ao release (`gh release create <tag> tecjustica-pje-v*.zip pje-ia.zip`).
$fixo = Join-Path $raiz "pje-ia.zip"
if (Test-Path $fixo) { Remove-Item $fixo -Force }
Copy-Item $zip $fixo

$tam = "{0:N0} KB" -f ((Get-Item $zip).Length / 1KB)
Write-Host "✔ Pacote gerado: $zip ($tam)" -ForegroundColor Green
Write-Host "  Cópia para o release: $fixo (nome fixo — é o link do README)"
Write-Host "  Envie o versionado na aba 'Pacote' do painel do desenvolvedor da Chrome Web Store."
