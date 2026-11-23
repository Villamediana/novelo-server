# Amigos e o que se compartilha (app 1.84)

Pedido do Miguel: amigos como no FreeSong, mas por **link** (sem buscar ninguém): um copia o link, o outro abre
no Novelo, e viram amigos; cada um pode encerrar quando quiser. Entre amigos dá pra compartilhar notas, diários e
tarefas, e **escrever ao mesmo tempo** — cada um vê onde o outro está, até o cursor.

## A regra de sempre: o servidor guarda o que não consegue ler

O servidor sabe só que dois celulares (`install`) são amigos, com ids opacos, e guarda bytes cifrados nos
celulares. Nomes, cores, o texto das coisas, onde cada um está escrevendo: tudo cifrado, com chaves que só os
celulares têm. Código: `src/social.js`; rotas em `src/api.js` (`socialRoute`); tudo assinado pelo celular
(como `/v1/me`), nada pro computador.

## Convite por link

1. Quem convida tem um par ECDH P-256 só pros amigos (a privada selada pelo AndroidKeyStore) e cria um
   **segredo** (16 bytes). Manda ao servidor `POST /v1/friends/invite {pub, card}` → `{code, expires_in}`: o
   `card` é `{name, pub, hue}` cifrado com HKDF(segredo, "novelo-friend-v1", "invite") — o segredo **não**
   vai. O link é `https://novelo.simplyonegoal.com/web/amigo#<code>.<segredo base64url>` (o que vem depois
   do `#` nunca sai do aparelho de quem abre). O app abre o link (App Link verificado; o site, num computador
   ou num celular sem o app, mostra onde baixar).
2. Quem abre vê quem convidou: `GET /v1/friends/invite/<code>` → `{pub, card, mine}`; o cartão abre com o
   segredo do link e **diz a própria chave pública**: se o servidor trocasse a chave pela dele, teria que fazer
   um cartão, e pra isso precisa do segredo.
3. Aceitar: `POST /v1/friends/invite/<code>/accept {pub, card}` (o cartão de quem aceita, cifrado do mesmo
   jeito) → `{friend: {id, pub, card, invite, inviter, since}, already}`. O convite some (vale uma vez); já
   amigos, é a mesma amizade (`already: true`). O próprio convite: `409 own_invite`.
4. Os dois passam a ter uma chave em comum: HKDF(ECDH ‖ segredo, salt = o código,
   "novelo-friend-pair-v1"). Com ela, o cartão de cada um se atualiza (`PUT /v1/friends/<id>/card`, um nome
   novo; começa com "2") e a chave de cada coisa compartilhada é entregue.

`GET /v1/friends` → `{friends: [{id, pub, card, invite, inviter, since}], invites: [{code, created}], seq}`.
Quem convidou acha o segredo pelo `invite` (o código) e abre o cartão de quem aceitou. `DELETE
/v1/friends/invite/<code>` desfaz um convite. Convites valem 7 dias (`FRIEND_INVITE_DAYS`); no máximo 20
abertos por celular, 500 amigos (`MAX_FRIENDS`).

**Encerrar** (`DELETE /v1/friends/<id>`, qualquer um dos dois): some pros dois, e com ela o que um tinha
compartilhado com o outro — cada um continua com o seu (no celular a entrada fica, só não é mais compartilhada).

## O que se compartilha (docs)

Cada coisa compartilhada é um **doc**: id e chave (32 bytes) feitos no celular de quem compartilha.

- `POST /v1/docs {id, members: [{friend, key}]}` → `{doc, me}`: `key` é a chave do doc cifrada com a chave do
  par (dono ↔ aquele amigo), AAD `novelo-doc-key\n<doc>`. Só com amigos (`404` pra outra amizade).
- `GET /v1/docs` → `{docs: [{id, owner, via, key, head, me, friends?, count}], seq}`: `via` é a amizade por
  onde veio (pra abrir a `key`); o dono vê as amizades com quem está compartilhado, os outros só quantos são.
- `PUT /v1/docs/<id>/members {add: [{friend, key}], remove: [friend]}` (só o dono). `DELETE /v1/docs/<id>`:
  o dono termina pra todos, os outros saem. **Ninguém além do dono**: o doc deixa de existir (amizade
  encerrada, o último saiu ou foi tirado).
- `POST /v1/docs/<id>/ops {ops: [base64…]}` → `{seq}`: mudanças, cada uma AES-GCM(chave do doc, JSON, AAD
  `novelo-doc\n<doc>\nop`), até 64 KB, até 200 por pedido; a ordem do servidor é a mesma pra todos.
- `GET /v1/docs/<id>/ops?since=<seq>&hv=<n>&wait=<s>` → `{ops: [{s, d}], head, more, snap?, here: [{m, d}], hv,
  me}`. Com `wait` (até 25 s), espera uma mudança — ou, com `hv`, alguém se mexer.
- `PUT /v1/docs/<id>/here {d | null}`: onde a pessoa está (cifrado, AAD `…\nhere`: nome, cor, campo, cursor
  como ids de letras), só na memória, some em 30 s; acorda quem espera. Ninguém recebe o próprio.
- `POST /v1/docs/<id>/snapshot {upTo, d}`: um retrato do doc inteiro até `upTo`; as mudanças até ali saem, e
  quem chega depois começa dele (`snap`). Teto de 16 MB por doc (`SHARED_DOC_MB`; `507 doc_full`).
- `me`/`m`: o nome de cada um dentro do doc (hash do doc e do install): igual pra todos, nada fora dele.

`GET /v1/social?since=<seq>&wait=<s>` → `{seq}`: um número por celular que anda quando algo dele mudou (um
amigo, um doc, uma mudança num doc); é a espera longa do app aberto. Só na memória (outro depois de reiniciar,
e aí o app olha tudo de novo).

## Como os celulares escrevem juntos (no app)

`social/Crdt.kt` (`SharedDoc`): os textos (título, texto) são sequências de letras, cada uma com um id que não
muda (número de Lamport + o site do celular naquele doc), postas "depois de" outra (RGA); apagada vira marca.
Duas mudanças no mesmo lugar ao mesmo tempo ficam na mesma ordem em todo celular, qualquer que seja a ordem em
que chegam; um cursor é "depois desta letra" e fica no lugar enquanto os outros escrevem. As etapas são uma
sequência do mesmo jeito (o texto e o ✓ de cada uma: o último escrito); o resto (tipo, feita, prazo, os pontos)
é o último escrito. Cada mudança aplicada duas vezes não faz nada a mais; a que chega antes do lugar dela espera.

`social/Shares.kt` liga o doc à entrada: o que a entrada ganha de qualquer outro jeito (o modelo juntando
notícia, um ✓ no Hoje, o computador) vira mudança (comparando com o que foi escrito nela da última vez, com os
ids das letras); o que vem dos outros é escrito nela. O que é de cada um fica de cada um: lembrete, repetição,
categoria, sensível, a ordem nas listas. Testes: `test/social.test.js` aqui; no app, `SharedDocTest` e
`FriendsTest` (dois celulares neste servidor de verdade).
