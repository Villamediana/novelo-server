# novelo-server

A inteligência embutida do Novelo. O app manda o pedido pronto (instruções, fala, foto, som); o
servidor confere o aparelho, põe na fila, chama um modelo e devolve. É de propósito uma ponte fina:
a lógica do Novelo continua no app.

- **Fila que não devolve erro à toa.** Modelo ocupado (429), fora do ar ou lento: o pedido espera
  aqui, troca de modelo e volta, até responder ou a espera máxima acabar. Cada modelo tem limite de
  pedidos simultâneos e por minuto, e depois de um 429 volta devagar.
- **Último recurso.** Com todos os modelos configurados fora (ou o teto de gasto batido), entra o
  rodízio de modelos grátis da OpenRouter, igual ao que o app fazia sozinho.
- **Sem login.** Cada instalação cria uma chave no hardware seguro do celular; o Android atesta que
  é um aparelho real rodando o app assinado, e todo pedido vem assinado. Sem assinatura, não custa nada.
- **Plano no servidor.** Teste de N dias e Novelo+ são decididos aqui; o celular só pergunta.
  Terminado o teste, o app segue com a inteligência própria (no celular ou API).
- **Backup na nuvem (Novelo+).** O celular cifra e manda em pedaços; o servidor guarda arquivos
  que não consegue abrir, com versões, cota por pessoa e apagar de verdade.
- **Custo sob controle.** Teto por dia e por mês, teto e limites por aparelho, bloqueio.
- **Telemetria sem conteúdo.** Números de cada pedido (modelo, tempo, tokens, custo). Nunca o que
  a pessoa disse, nem a resposta.
- **Painel** em outra porta, só local: modelos por pedido, chaves, custos, aparelhos, segurança.

Node 22.13+, SQLite embutido, zero dependências.

```bash
cp .env.example .env && chmod 600 .env   # ADMIN_PASSWORD e a chave da API
npm start                                # api em :8787, painel em :8788
npm test
```

| | |
|---|---|
| [DEPLOY.md](DEPLOY.md) | subir em produção, passo a passo |
| [docs/PROTOCOLO.md](docs/PROTOCOLO.md) | o que o app envia e recebe |

O `.env` pode ser um atalho (link) para outro arquivo, por exemplo `data/.env` numa caixa de areia que só
escreve em `data/`: o servidor (e o painel, ao guardar uma chave) escreve no arquivo de verdade e o atalho fica.

## Por dentro

| Arquivo | O que faz |
|---|---|
| `server.js` | liga tudo e escuta as duas portas |
| `src/api.js` | registro, pedidos, pedido repetido responde uma vez só, espera longa |
| `src/devices.js` · `src/attest.js` · `src/der.js` | chave do aparelho, assinatura, atestado do Android |
| `src/router.js` · `src/lanes.js` | fila, retentativa, troca de modelo |
| `src/free.js` | rodízio dos modelos grátis |
| `src/limits.js` | limites por aparelho e teto de gasto |
| `src/plans.js` | teste e Novelo+ |
| `src/vaults.js` | cofre dos backups na nuvem |
| `src/telemetry.js` | números por pedido e por hora |
| `src/admin.js` · `admin/` | painel |
| `src/config.js` | `.env`: o único lugar onde mora segredo |

`certs/android-roots.json` são as raízes públicas de atestado do Google
(`https://android.googleapis.com/attestation/root`). A cadeia de teste em `test/fixtures` vem do
projeto `google/android-key-attestation` (Apache 2.0).
