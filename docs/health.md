# GET /health

Retorna o status atual do servidor. Usado para monitoramento, health checks de load balancer e verificação de disponibilidade.

## Request

**Method:** `GET`  
**Path:** `/health`

Sem parâmetros, headers obrigatórios ou body.

## Response

### 200 OK

```json
{
  "status": "ok",
  "uptime": 3742.51,
  "renders_in_flight": 0,
  "max_concurrent_renders": 1
}
```

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `status` | `string` | Sempre `"ok"` quando o servidor está saudável |
| `uptime` | `number` | Tempo em segundos desde que o processo Node.js iniciou |
| `renders_in_flight` | `integer` | Renders em execução neste momento |
| `max_concurrent_renders` | `integer` | Teto de renders simultâneos (`MAX_CONCURRENT_RENDERS`). `0` = sem teto |

## Exemplo cURL

```bash
curl http://localhost:3030/health
```

### Verificar se o servidor está online (script)

```bash
if curl -sf http://localhost:3030/health > /dev/null; then
  echo "Servidor online"
else
  echo "Servidor offline"
  exit 1
fi
```

## Notas

- Este endpoint é configurado como health check no `docker-compose.yml` com intervalo de 30s
- `renders_in_flight` é o estado da guarda de concorrência do [POST /render](./render.md): quando ele
  atinge `max_concurrent_renders`, novos renders recebem `429`. É o que permite distinguir um 429
  legítimo de um slot vazado — se ele ficar preso em 1 sem nenhum render rodando, é bug
- Fora isso, não inspeciona jobs: confirma apenas que o processo está rodando
- Útil para integrar com ferramentas de monitoramento como UptimeRobot, Coolify, ou Kubernetes liveness probes
