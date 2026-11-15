# Protocolo (o que o app fala com o servidor)

O app monta o pedido inteiro (instruções, o que a pessoa disse, a foto ou o som) no formato de
*chat completions* da OpenAI, **sem modelo**. O servidor confere quem pede, põe na fila, escolhe o
modelo, chama e devolve o texto. Nada do conteúdo é gravado.

Base: `https://<servidor>` · tudo JSON · UTF-8.

## 1. Registrar o aparelho (uma vez por instalação)

1. O app cria um par de chaves **EC P-256** no AndroidKeyStore (`PURPOSE_SIGN`, `SHA256withECDSA`),
   de preferência com `setAttestationChallenge(<desafio>)`.
2. `POST /v1/devices/challenge` → `{ "challenge": "<base64url>", "expires_in": 300 }`
   O desafio do atestado são os **bytes** desse base64url (40 bytes).
3. `POST /v1/devices`

```json
{
  "challenge": "<o mesmo texto>",
  "public_key": "<SPKI DER da chave pública, base64>",
  "proof": "<SHA256withECDSA de \"novelo-device-v1\\n<challenge>\", DER, base64>",
  "attestation": ["<certificado folha, DER base64>", "<intermediário>", "…", "<raiz>"],
  "app": { "version": "1.73.0", "package": "com.villamediana.novelo" }
}
```

→ `{ "device": "<24 caracteres>", "verified": true }`

`attestation` é a cadeia de `KeyStore.getCertificateChain(alias)`. O servidor confere: cadeia até a
raiz do Google, revogação, chave no hardware (TEE/StrongBox), desafio, pacote e certificado que
assina o app. Modo do servidor (painel › Segurança): **observar** registra mesmo sem atestado
válido; **exigir** devolve `403 attestation`.

Registrar de novo com a mesma chave é inofensivo (mesmo `device`).

## 2. Pedir

`POST /v1/ask/<pedido>` com `<pedido>` = `hear` (ouvir), `see` (ver) ou `think` (pensar).

| Cabeçalho | Valor |
|---|---|
| `X-Novelo-Device` | o `device` do registro |
| `X-Novelo-Time` | relógio do aparelho, em ms (tolerância: 5 min) |
| `X-Novelo-Request` | um id novo por pedido (UUID). **Na retentativa do mesmo pedido, o mesmo id** |
| `X-Novelo-Signature` | `SHA256withECDSA` (DER, base64) do texto abaixo |
| `X-Novelo-App` | versão do app (opcional) |
| `X-Novelo-Not` | opcional: `route` de respostas que não serviram (ver 4) |

Texto assinado (linhas separadas por `\n`, sem `\n` no fim):

```
v1
POST
/v1/ask/think
<X-Novelo-Time>
<X-Novelo-Request>
<sha256 do corpo, hex minúsculo>
```

Corpo: `messages` e, se quiser, `response_format`, `reasoning_effort` (ou `reasoning.effort`),
`temperature`, `top_p`, `seed`, `stop`, `max_tokens`. O resto é descartado (`model`, `tools`,
`plugins`, `stream`…). Cada pedido aceita só o seu tipo de conteúdo:

```jsonc
// think: só texto
{ "messages": [ { "role": "system", "content": "…" }, { "role": "user", "content": "…" } ],
  "response_format": { "type": "json_object" }, "reasoning_effort": "low" }

// see: texto + imagem dentro do pedido (JPEG, PNG ou WebP em data:)
{ "messages": [ { "role": "system", "content": "…" },
  { "role": "user", "content": [ { "type": "text", "text": "…" },
    { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,…", "detail": "low" } } ] } ] }

// hear: texto + som (wav, mp3, m4a, aac, ogg, flac ou webm, em base64)
{ "messages": [ { "role": "system", "content": "Transcreva…" },
  { "role": "user", "content": [ { "type": "input_audio", "input_audio": { "data": "…", "format": "wav" } } ] } ] }
```

Resposta boa (`200`):

```json
{ "id": "<X-Novelo-Request>",
  "choices": [ { "index": 0, "message": { "role": "assistant", "content": "…" }, "finish_reason": "stop" } ],
  "novelo": { "route": "r3", "free": false } }
```

## 3. Espera, fila e retentativa

- O servidor **segura o pedido** enquanto os modelos estão ocupados (429, erro, lotado), troca de
  modelo e tenta de novo, até a espera máxima do pedido (padrão 150 s).
- Passando de 10 s sem resposta, ele começa a responder `200` e manda **um espaço a cada 10 s**
  (JSON ignora espaço no começo) pra nenhum proxy derrubar a conexão. Então:
  **o resultado é sempre o JSON do corpo; se tiver `error`, falhou, mesmo com status 200.**
- No app: *read timeout* ≥ 30 s e *call timeout* ≥ 180 s.
- Caiu a conexão? Mande de novo **com o mesmo `X-Novelo-Request`** (e assinatura nova, com a hora
  nova): se o pedido ainda está andando, você entra nele; se já terminou (até 10 min), recebe a
  mesma resposta. Não é cobrado nem contado duas vezes.

## 4. Resposta que não serviu

Se o app não conseguir usar a resposta (não é o plano esperado), pede de novo com um
`X-Novelo-Request` **novo** e `X-Novelo-Not: <novelo.route>` (vários separados por vírgula). O
servidor pula aquele modelo nesse pedido e conta a resposta ruim na telemetria.

## 5. Erros

Sempre `{ "error": { "code": "…", "message": "…", "retry_after": <s>? } }`.

| Status | `code` | O app faz |
|---|---|---|
| 401 | `unknown_device` | registra de novo (passo 1) e repete |
| 401 | `bad_signature` | bug de assinatura; não repetir às cegas |
| 401 | `stale_time` | vem `now` (ms do servidor): corrige a diferença de relógio e repete |
| 403 | `blocked` | para; aparelho bloqueado |
| 403 | `attestation` | (no registro) aparelho não verificado |
| 404 | `not_found` | pedido desconhecido |
| 413 | `too_large` | corta o pedido (som em pedaços menores, foto menor) |
| 422 | `bad_request` / `refused` | não repetir igual |
| 429 | `rate_limited` | espera `retry_after` |
| 429 | `quota` | limite do dia do aparelho; `retry_after` até a virada |
| 503 | `busy` | guarda e manda depois (`retry_after`), mesmo id |
| 503 | `budget` / `paused` / `not_configured` | guarda e manda depois |

Pedido sem resposta **não conta** no limite do dia.

## 6. O que o servidor guarda

De cada pedido: hora, aparelho (código), pedido, modelo, se respondeu, tentativas, tempos, tokens,
custo e tamanhos. **Nunca** o texto, a foto, o som ou a resposta. Do aparelho: a chave pública,
versão do app, resultado da verificação, primeira e última vez. O endereço IP não é gravado.
