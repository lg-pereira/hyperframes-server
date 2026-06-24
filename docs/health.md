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
  "uptime": 3742.51
}
```

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `status` | `string` | Sempre `"ok"` quando o servidor está saudável |
| `uptime` | `number` | Tempo em segundos desde que o processo Node.js iniciou |

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
- Não verifica o estado de jobs em andamento — apenas confirma que o processo está rodando
- Útil para integrar com ferramentas de monitoramento como UptimeRobot, Coolify, ou Kubernetes liveness probes
