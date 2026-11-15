# Subir o servidor do Novelo

Para o agente (ou a pessoa) do servidor onde isto roda. Leva uns 10 minutos. Nenhum segredo vem no
repositório: eles são criados **aí**, no `.env`.

O resultado final é este:

| | Onde | Quem acessa |
|---|---|---|
| API (o app fala com ela) | `https://novelo.<domínio>` → `127.0.0.1:<PORT>` | a internet |
| Painel | `https://novelo-painel.<domínio>` → `127.0.0.1:<ADMIN_PORT>` | só o dono, pelo Cloudflare Access + senha |

## 1. Requisitos

- Node **22.13 ou mais novo** (`node -v`). Não tem `npm install`: o servidor só usa o que vem no Node.
- Duas portas livres nesta máquina (padrão 8787 e 8788; use outras se estiverem ocupadas).
- O túnel da Cloudflare (ou nginx/Caddy) pra publicar as duas em HTTPS.

## 2. Código e segredos

O repositório é privado: pra clonar, peça ao dono um acesso ao GitHub (um token serve).

```bash
git clone https://github.com/Villamediana/novelo-server.git ~/novelo-server
cd ~/novelo-server
cp .env.example .env && chmod 600 .env
```

No `.env`:

| Variável | O que pôr |
|---|---|
| `ADMIN_PASSWORD` | uma senha longa pro painel (sem ela o painel não sobe). Passe pro dono |
| `OPENROUTER_API_KEY` | deixe vazio: o dono cola a chave pelo painel, que grava aqui |
| `PORT` / `ADMIN_PORT` | as portas da API e do painel |
| `TRUST_PROXY` | `cloudflare` atrás da Cloudflare · `xff` atrás de nginx/Caddy · `none` direto |
| `HOST` / `ADMIN_HOST` | `127.0.0.1` (o túnel roda nesta máquina) |
| `SERVER_SECRET` | deixe vazio: o servidor cria e grava sozinho |

O `.env` pode ser um atalho (link) pra outro arquivo, por exemplo `data/.env` quando o processo
roda numa caixa de areia que só escreve em `data/`: o servidor escreve no arquivo de verdade.
Ele escreve em `data/` (banco e uma lista do Google) e no `.env`; não abre subprocesso.

Conferir antes de subir (sem internet e sem gastar nada):

```bash
npm test
```

## 3. Deixar rodando

O comando é `node --disable-warning=ExperimentalWarning server.js`, na pasta do repositório. Ele
precisa voltar sozinho se cair e ao ligar a máquina.

- **systemd:** `deploy/novelo-server.service` (copiar pra `~/.config/systemd/user/`,
  `systemctl --user enable --now novelo-server`, `loginctl enable-linger "$USER"`).
- **pm2:** `pm2 start server.js --name novelo-server --node-args="--disable-warning=ExperimentalWarning" --cwd ~/novelo-server && pm2 save`.
- Ao parar (SIGTERM), ele espera até 20 s os pedidos em andamento; dê esse tempo ao gerenciador.

```bash
curl -s http://127.0.0.1:<PORT>/health      # {"ok":true,…,"ready":{…}}
```

## 4. Publicar

- **API:** `novelo.<domínio>` → `http://127.0.0.1:<PORT>`. Nada mais a ajustar no túnel.
  (nginx: `proxy_buffering off; proxy_read_timeout 200s; client_max_body_size 8m;`.)
  Pedidos demoram (o servidor segura na fila até 150 s e manda um espaço a cada 10 s): o proxy não
  pode guardar a resposta em buffer nem cortar antes de 180 s.
- **Painel:** `novelo-painel.<domínio>` → `http://127.0.0.1:<ADMIN_PORT>`, **atrás do Cloudflare Access**
  com uma política que deixa entrar só o e-mail do dono. Assim ele abre no celular. O painel nunca
  vai pra internet sem o Access na frente.
- Na Cloudflare, ligar **Always Use HTTPS** no domínio (o servidor recusa `http://` puro de qualquer jeito).

```bash
curl -s https://novelo.<domínio>/health
```

## 5. Entregar pro dono

Mande só isto:

1. o endereço do painel (`https://novelo-painel.<domínio>`) e a senha do painel;
2. o endereço da API (`https://novelo.<domínio>`), que vai no app.

No painel, ele faz: **APIs** → cola a chave da OpenRouter; **Modelos** → um modelo em *Ouvir*,
*Ver* e *Pensar*, e **Testar**. Pronto quando `https://novelo.<domínio>/health` mostrar
`"ready":{"hear":true,"see":true,"think":true}`.

## 6. Atualizar

```bash
cd ~/novelo-server && git pull && <reiniciar: systemctl --user restart novelo-server | pm2 restart novelo-server>
```

Configuração e dados ficam em `data/novelo.db` e não são tocados pelo `git pull`. Vale copiar
`data/novelo.db` e o `.env` pra outro lugar de vez em quando (`sqlite3 data/novelo.db ".backup 'copia.db'"`).
O banco não tem texto de ninguém nem chave de API.

## 7. Pedido de apagar dados

Quando alguém pedir pra apagar o que o servidor guarda dela: a pessoa informa o **código do
aparelho** (no app, Ajustes, embaixo da versão); no painel, **Aparelhos** → buscar → **Apagar**.

Se algo não responder: o log do processo e a aba **Visão › Avisos** do painel.
