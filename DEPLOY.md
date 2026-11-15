# Subir o servidor do Novelo

Para o agente (ou a pessoa) do servidor onde isto roda. Do começo ao fim leva uns 10 minutos.
Nenhum segredo vem no repositório: eles são criados **aí**, no `.env`.

## 1. Requisitos

- Node **22.13 ou mais novo** (`node -v`). Não tem `npm install`: o servidor só usa o que vem no Node.
- Um jeito de publicar `http://127.0.0.1:8787` em HTTPS (Cloudflare Tunnel, nginx, Caddy).

## 2. Código e segredos

```bash
git clone git@github.com:Villamediana/novelo-server.git ~/novelo-server
cd ~/novelo-server
cp .env.example .env && chmod 600 .env
```

No `.env`:

| Variável | O que pôr |
|---|---|
| `ADMIN_PASSWORD` | uma senha longa pro painel. Sem ela o painel não sobe |
| `OPENROUTER_API_KEY` | a chave da OpenRouter (ou deixe vazio e cole pelo painel, que grava aqui) |
| `TRUST_PROXY` | `cloudflare` atrás da Cloudflare · `xff` atrás de nginx/Caddy · `none` direto |
| `HOST` | `127.0.0.1` se o túnel/proxy roda nesta máquina; `0.0.0.0` se roda em outra |
| `SERVER_SECRET` | deixe vazio: o servidor cria e grava sozinho |

Na OpenRouter, crie a chave **com limite de crédito**: é um segundo teto, além do teto do painel.

Conferir antes de subir (25 testes, ~8 s, sem internet e sem gastar nada):

```bash
npm test
```

## 3. Serviço

```bash
mkdir -p ~/.config/systemd/user
cp deploy/novelo-server.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now novelo-server
loginctl enable-linger "$USER"
journalctl --user -u novelo-server -n 20     # deve mostrar "api: http://…:8787" e "painel: http://…:8788"
curl -s http://127.0.0.1:8787/health         # {"ok":true,…}
```

## 4. Publicar

Só a porta **8787** vai pra internet, em `https://novelo.simplyonegoal.com` (ou o nome escolhido).

- **Cloudflare Tunnel:** hostname → `http://127.0.0.1:8787`. Nada mais a ajustar.
- **nginx:** dentro do `location /`:
  `proxy_pass http://127.0.0.1:8787; proxy_buffering off; proxy_read_timeout 200s; client_max_body_size 8m; proxy_set_header X-Forwarded-For $remote_addr;`

Pedidos demoram (o servidor segura na fila até 150 s e manda um espaço a cada 10 s): o proxy
não pode guardar a resposta em buffer nem cortar antes de 180 s.

```bash
curl -s https://novelo.simplyonegoal.com/health
```

## 5. Painel

A porta **8788 não é publicada**. Dois jeitos de abrir:

- do seu computador: `ssh -L 8788:127.0.0.1:8788 <servidor>` e abrir `http://localhost:8788`;
- ou um hostname próprio (ex.: `novelo-painel.…`) apontando pra `http://127.0.0.1:8788`
  **atrás do Cloudflare Access** (só o seu e-mail). A senha do `.env` continua valendo.

No painel, nesta ordem:

1. **APIs** → conferir "Chave ····xxxx" na OpenRouter (ou colar a chave).
2. **Modelos** → em *Ouvir*, *Ver* e *Pensar*: **+ Modelo**, escolher na lista (o preço vem junto), **Testar**.
   O primeiro da lista atende; os de baixo entram quando o de cima falha ou lota.
   - *Ouvir* precisa de um modelo que aceite áudio; *Ver*, imagem (a lista já vem filtrada).
3. **Custos e limites** → teto por dia e por mês; em **Planos**, o que um aparelho novo recebe
   (hoje Novelo+ pra todos; depois, Teste de N dias).
4. **Segurança** → deixar em **Observar**. Quando o seu celular aparecer em *Aparelhos* como
   **Verificado**, trocar pra **Exigir**.

## 6. Atualizar

```bash
cd ~/novelo-server && git pull && systemctl --user restart novelo-server
```

O reinício espera até 20 s os pedidos em andamento; o app repete sozinho o que cair.
Configuração e dados ficam em `data/novelo.db` e não são tocados pelo `git pull`.

## 7. Cópia de segurança

Três coisas: `data/novelo.db` (configuração, aparelhos, planos e números de uso), a pasta
`data/backups/` (os backups na nuvem das pessoas, já cifrados pelo celular) e o `.env`. O banco não
tem texto de ninguém nem chave de API.

```bash
sqlite3 data/novelo.db ".backup 'novelo-$(date +%F).db'"
rsync -a data/backups/ /outro/disco/novelo-backups/     # é o backup das pessoas: copie pra outro lugar
```

A pasta `data/backups/` cresce com o uso (painel › Custos e limites › Backup na nuvem: espaço por
pessoa e teto de tudo). Com menos de 512 MB livres no disco o servidor recusa envios novos e avisa
em **Visão › Avisos**.

## 8. Capacidade

Um processo só. Ele quase não gasta CPU (espera a resposta dos modelos), então aguenta milhares de
pedidos abertos ao mesmo tempo; o gargalo é o limite das APIs, e é disso que a fila cuida.
Ajustes no `.env`, se precisar: `MAX_OPEN` (pedidos abertos, padrão 20000) e `MAX_HELD_MB`
(memória pros pedidos na fila, padrão 1024).

Se algo não responder: `journalctl --user -u novelo-server -f` e a aba **Visão › Avisos**.
