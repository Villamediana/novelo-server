# Novelo Web: o Novelo no computador

No computador o Novelo é pra **escrever** (no celular é pra falar). Mesmo desenho, as mesmas coisas
(Hoje, Tarefas, Notas, Diário, Remédios, Galeria, busca), tudo junto com o celular nos dois sentidos.
No celular, a página só diz pra instalar o app.

Endereço: `https://novelo.simplyonegoal.com/web/` (as páginas são servidas pelo próprio servidor do
Novelo, `src/web.js`, a partir de `web/`).

## A regra: o servidor guarda o que não consegue ler

Tudo o que o celular guarda vai pro servidor **cifrado no celular**, com uma chave que só o celular e os
computadores que ele ligou têm. O servidor guarda bytes, números de versão e tamanhos; não sabe o que é
nem de quê é cada registro. O que o computador escreve é organizado **no próprio navegador** (a mesma
lógica do app, em JS: `web/js/brain.js`, `keeper.js`, `recall.js`), com o pedido ao modelo indo pelo
servidor do Novelo em nome do celular (o plano e os limites são dele).

## Ligar um computador (QR code)

1. O computador cria um par de chaves ECDH P-256 (a privada nunca sai do navegador) e pede um código:
   `POST /v1/link {key: <pública, 65 bytes raw, base64url>, name: "Chrome no Windows"}` →
   `{id, poll, expires_in}`.
2. Mostra o QR code de `https://novelo.simplyonegoal.com/web/link#<id>.<pública>` e espera:
   `GET /v1/link/<id>?poll=<poll>&wait=25` (espera longa; `pending` até o celular ler).
3. No celular (Ajustes › Computador › Ligar, ou a câmera comum: o endereço abre o app — App Link
   verificado por `/.well-known/assetlinks.json`), o app lê o código, cria um par ECDH só pra essa
   resposta e manda a chave do espaço cifrada pra pública do computador:
   `POST /v1/link/<id>/approve {wrapped: {pub, iv, ct}, owner: "Pixel da Ana"}` (assinado pelo celular).
4. O computador recebe, **uma vez**, `{status: "linked", token, space, wrapped, owner}`, abre a chave e
   guarda (não extraível) no navegador. O `token` é a entrada dele no servidor (`Authorization: Bearer`).

O código vale 10 minutos. O servidor nunca vê a chave do espaço: a chave pública do computador vai
pelo QR code (que o servidor não troca), e a resposta só abre com a privada dele.

Desligar: no celular, `DELETE /v1/links/<id>` (a lista: `GET /v1/links`); no computador, `DELETE /v1/link`.
Desligado, o token dá `401 unlinked` e a página apaga o que tinha.

## Cifra (a mesma no Kotlin e no JS)

- **Chave do espaço**: 32 bytes aleatórios, feitos no celular (guardados cifrados pelo AndroidKeyStore).
- Derivadas (HKDF-SHA256, salt `novelo-sync-v1`, info): `enc` (AES-256-GCM dos registros), `key`
  (HMAC-SHA256: o nome dos registros), `blob` (AES-256-GCM dos arquivos), `check` (16 bytes, base64url:
  diz em que chave o espaço está, sem ser ela).
- **Nome de um registro**: base64url(HMAC(`key`, `"<tabela>:<id>"`)) — 43 letras.
- **Bytes de um registro**: base64(IV 12 bytes ‖ AES-GCM(`enc`, JSON, AAD = o nome)).
- **Arquivo**: IV ‖ AES-GCM(`blob`, bytes, AAD = o id do arquivo). Id = 18 bytes aleatórios, base64url.
- **Ligação**: segredo = ECDH(privada de um, pública do outro); chave = HKDF-SHA256(segredo, salt =
  o id do código, info `novelo-link-v1`) → AES-256-GCM, AAD = o id do código. Texto: JSON
  `{space, key: base64url(32 bytes), owner}`.

## Registros

Um registro = uma linha do banco do celular: `{"t": "<tabela>", "id": <id>, "r": {<as colunas>}}`.
Tabelas: `entries`, `captures` (sem os caminhos de arquivo do celular: no lugar, `media`), `entities`,
`entry_topics` (id `"<entryId>:<topicId>"`), `links` (`"<a>:<b>"`), `progress`, `meds`,
`med_taken` (`"<medId>:<at>"`).

**Ids**: os do celular são os dele (1, 2, 3…); o computador cria os seus num espaço alto e aleatório
(2^45 a 2^50): os mesmos ids valem dos dois lados, e as referências (tarefa→tópico, dose→remédio,
item→captura, os resultados guardados numa captura) não precisam ser traduzidas.

**Arquivos de uma captura** (`media`): `{"image": {"id", "size", "mime"}, "thumb": {…}, "audio": {…},
"file": {…}}`. A foto vai inteira e numa miniatura (lado maior 480 px) pra Galeria abrir leve.

### O protocolo

- `POST /v1/sync/space {key_check, reset?}` (só o celular) → `{space, seq, fresh}`. Outra chave:
  `409 key_mismatch`; com `reset: true` o espaço recomeça vazio (os computadores ligados caem).
- `GET /v1/sync/changes?since=<seq>&limit=500&wait=25` → `{changes: [{k, s, d | null}], seq, more, head}`.
  `d` nulo = apagado. Com `wait`, espera até ter novidade (até 25 s).
- `POST /v1/sync/push {items: [{k, base, d | null}]}` → `{results: [{k, ok, s, d?}], head}`. `base` é a
  versão (`s`) do registro que quem escreve viu por último (0 = novo). Se alguém escreveu depois, não
  grava: volta `ok: false` com o que está lá (`s`, `d`), e quem escreveu **junta campo a campo** (o que
  ele mudou desde `base` fica dele, o resto fica do outro) e manda de novo.
- `PUT /v1/sync/blob/<id>` (bytes cifrados, até 40 MB), `GET /v1/sync/blob/<id>`,
  `POST /v1/sync/blobs/have {ids}` → `{have}`, `POST /v1/sync/blobs/keep {ids}` (só o celular: o resto
  vai embora, menos o que chegou nas últimas 6 h).
- `GET /v1/web/me` (computador) → `{plan, link, name}`. `POST /v1/web/ask/<think|see>` (computador,
  com `X-Novelo-Request`): o mesmo pedido do app, em nome do celular.

Celular: pedidos assinados como os outros (só o caminho é assinado; `?since=` não). Computador: token.

Teto por espaço: 256 MB de registros, 8 GB de arquivos (`SYNC_RECORDS_MB`, `SYNC_FILES_MB`), 40 MB por
arquivo (`SYNC_FILE_MB`), 10 computadores, 600 pedidos por minuto.
