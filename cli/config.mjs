// Onde o CLI guarda o que precisa sobreviver entre execuções.
//
// TUDO FORA DO REPOSITÓRIO, em `%LOCALAPPDATA%\tecjustica-pje\` (ou
// `~/.tecjustica-pje` fora do Windows). São três coisas de naturezas bem
// diferentes, e é por isso que ficam em arquivos separados:
//
//   config.json   preferências (base, destino, concorrência). Inócuo.
//   sessao.json   CREDENCIAL AO PORTADOR. Quem a tiver entra no PJe como o
//                 usuário. Some quando a sessão expira; `pje logout` apaga.
//   perfil/       o perfil do Chrome dedicado — um LOGIN PERSISTENTE em disco.
//
// Guardar credencial dentro do repositório seria pedir para ela ir num commit
// por acidente; o `.gitignore` protege, mas depender só dele é frágil demais
// para o que está em jogo.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Fora do Windows é `~/.tecjustica-pje`, e NÃO o XDG (`~/.local/state/...`):
// a pasta guarda uma credencial e um perfil de navegador, e um caminho único e
// óbvio é o que faz `pje logout` — e o apagar à mão — serem confiáveis. Uma
// versão anterior calculava `XDG_STATE_HOME` e descartava o resultado, o que
// não mudava nada em runtime mas prometia ao leitor um suporte inexistente.
export function pastaBase() {
  return process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "tecjustica-pje")
    : path.join(os.homedir(), ".tecjustica-pje");
}

export const CAMINHOS = {
  get base() {
    return pastaBase();
  },
  get config() {
    return path.join(pastaBase(), "config.json");
  },
  get sessao() {
    return path.join(pastaBase(), "sessao.json");
  },
  get perfil() {
    return path.join(pastaBase(), "perfil");
  },
};

function garantirPasta() {
  fs.mkdirSync(pastaBase(), { recursive: true });
}

function lerJson(arquivo) {
  try {
    return JSON.parse(fs.readFileSync(arquivo, "utf8"));
  } catch {
    // Arquivo ausente e arquivo corrompido caem no MESMO ramo de propósito: em
    // ambos não há nada confiável para usar, e tratar o segundo como erro faria
    // um JSON truncado (queda de energia no meio da gravação) travar o CLI num
    // estado que só se resolve apagando arquivo à mão.
    return null;
  }
}

function gravarJson(arquivo, valor) {
  garantirPasta();
  // Grava em temporário e renomeia: `rename` é atômico no mesmo volume, então
  // uma interrupção no meio nunca deixa um JSON pela metade no lugar do bom.
  const tmp = arquivo + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(valor, null, 2), "utf8");
  fs.renameSync(tmp, arquivo);
}

// O destino padrão é ABSOLUTO, e isso não é detalhe.
//
// Com um caminho relativo (`autos`), rodar `pje baixar` de pastas diferentes
// espalha pacotes por todo lado — e, pior, o `pje atualizar` e o cache
// incremental passam a enxergar conjuntos diferentes conforme o diretório em
// que você está. O comando parece esquecer o que já baixou.
//
// Um lugar único e previsível resolve os três. Quem quiser na pasta atual pede
// explicitamente: `--destino .`
const PADROES = {
  base: null,
  destino: path.join(os.homedir(), "autos-pje"),
  concorrencia: 3,
  chrome: null,
};

export function lerConfig() {
  return { ...PADROES, ...(lerJson(CAMINHOS.config) || {}) };
}

export function gravarConfig(parcial) {
  const atual = lerJson(CAMINHOS.config) || {};
  gravarJson(CAMINHOS.config, { ...atual, ...parcial });
}

// A sessão é gravada com `mode` restrito onde o sistema respeita (POSIX). No
// Windows o `mode` é praticamente ignorado — a proteção real ali é o arquivo
// morar no perfil do usuário, sob a ACL da conta.
export function lerSessaoSalva() {
  return lerJson(CAMINHOS.sessao);
}

export function gravarSessaoSalva(sessao) {
  garantirPasta();
  const tmp = CAMINHOS.sessao + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(sessao, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, CAMINHOS.sessao);
}

export function apagarSessaoSalva() {
  try {
    fs.unlinkSync(CAMINHOS.sessao);
    return true;
  } catch {
    return false;
  }
}

export function apagarPerfil() {
  try {
    fs.rmSync(CAMINHOS.perfil, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
