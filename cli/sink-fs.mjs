// Um "escritor de ZIP" que na verdade escreve numa PASTA.
//
// A ideia inteira do CLI está aqui. `montarZip` (src/exportar.js:386) recebe
// `opts.zip` INJETÁVEL (src/exportar.js:397) e usa exatamente três métodos:
//
//   criar({data})                        -> escritor
//   add(nome, dados, {comprimir})        -> nomeReal (pode ter sido deduplicado)
//   fechar()                             -> o artefato final
//
// Isto é um contrato de SUMIDOURO, não de formato. Um sistema de arquivos o
// satisfaz. Passando este módulo como `opts.zip`, `montarZip` roda BYTE A BYTE
// como roda na extensão e produz uma pasta em vez de um `.zip` — herdando de
// graça a numeração cronológica, os nomes de arquivo, o `LEIA-ME.md`, o
// `indice.txt`, o `indice.json`, o buraco na numeração das peças que falharam e
// o teto de 600 MB.
//
// O ganho não é economizar código: é que a extensão e o CLI passam a produzir
// resultados COMPARÁVEIS. Rodar os dois sobre o mesmo processo e comparar vira
// um oráculo de teste de verdade, porque qualquer divergência só pode ter vindo
// do que é diferente entre eles (o `obter` e a ficha), nunca da montagem.
//
// `src/exportar.js` e `src/zip.js` continuam INTOCADOS.

import fs from "node:fs";
import path from "node:path";

// Espelha `nomeUnico` de src/zip.js:104, incluindo o começo em 2 e o formato
// `base(2).ext`. Não é preciosismo: `montarZip` faz
// `nomeReal.slice("pecas/".length)` para escrever o nome no índice, então se o
// sink deduplicar de outro jeito o índice passa a citar um arquivo que não
// existe na pasta — e ninguém percebe até tentar abrir.
//
// Dois documentos com o mesmo título acontecem de verdade no PJe ("Documentos
// diversos", "Petição"), então este caminho é exercitado, não teórico.
function criarNomeador() {
  const nomes = new Set();
  return function nomeUnico(nome) {
    if (!nomes.has(nome)) {
      nomes.add(nome);
      return nome;
    }
    const ponto = nome.lastIndexOf(".");
    const base = ponto > 0 ? nome.slice(0, ponto) : nome;
    const ext = ponto > 0 ? nome.slice(ponto) : "";
    for (let i = 2; ; i++) {
      const tentativa = base + "(" + i + ")" + ext;
      if (!nomes.has(tentativa)) {
        nomes.add(tentativa);
        return tentativa;
      }
    }
  };
}

// `destino` é a pasta do processo. Ela é criada aqui, e não antes: uma pasta que
// nasce e fica vazia porque a sessão expirou no primeiro documento é pior que
// nenhuma pasta — parece um processo sem peças.
export function sinkPasta(destino) {
  return {
    criar() {
      const nomeUnico = criarNomeador();
      const escritos = [];
      let fechado = false;
      let bytes = 0;

      return {
        async add(nome, dados) {
          if (fechado) throw new Error("sink já fechado");
          const real = nomeUnico(nome);
          const alvo = path.join(destino, real);
          fs.mkdirSync(path.dirname(alvo), { recursive: true });
          // String vira UTF-8; Uint8Array vai como está. É a mesma bifurcação do
          // `add` do ZipW, e é o que faz o `.md`/`.txt`/`.json` sair legível e o
          // PDF sair íntegro.
          const conteudo = typeof dados === "string" ? Buffer.from(dados, "utf8") : Buffer.from(dados);
          fs.writeFileSync(alvo, conteudo);
          bytes += conteudo.length;
          escritos.push(real);
          return real;
        },

        // `montarZip` põe o retorno em `{blob}`, que o CLI ignora. Devolver algo
        // com forma de resumo é mais útil que devolver null, e nada no caminho
        // do `exportar.js` inspeciona este valor.
        fechar() {
          fechado = true;
          return { pasta: destino, arquivos: escritos.slice(), bytes };
        },

        get entradas() {
          return escritos.length;
        },
        get bytes() {
          return bytes;
        },
      };
    },
  };
}
