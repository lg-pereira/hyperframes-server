# Preview

Endpoints para criar e gerenciar previews ao vivo de composições HyperFrames. Ao contrário do `/render`, o preview é **instantâneo** — salva o HTML e serve uma página com o `<hyperframes-player>` embutido, sem rodar Chromium ou FFmpeg.

**Armazenamento:** `/tmp/hf-previews/`  
**TTL:** os previews expiram automaticamente em **2 horas**.

---

## POST /preview

Salva a composição e retorna uma URL para abrir no browser.

### Request

**Method:** `POST`  
**Path:** `/preview`  
**Content-Type:** `application/json`

#### Body

| Campo | Tipo | Obrigatório | Padrão | Descrição |
|-------|------|-------------|--------|-----------|
| `html` | `string` | Sim | — | Conteúdo do `index.html` da composição HyperFrames |
| `assets` | `array` | Não | `[]` | Arquivos adicionais (áudio, imagens) em base64 |
| `assets[].filename` | `string` | Sim* | — | Nome do arquivo, ex: `narration.mp3` |
| `assets[].base64` | `string` | Sim* | — | Conteúdo do arquivo codificado em base64 |
| `title` | `string` | Não | `"Preview"` | Título exibido na página de preview |

*Obrigatório quando `assets` está presente.

#### Exemplo de body

```json
{
  "html": "<div data-width=\"1920\" data-height=\"1080\"><h1 data-duration=\"3\">Olá!</h1></div>",
  "title": "Minha Composição"
}
```

#### Com assets

```json
{
  "html": "<div data-width=\"1920\" data-height=\"1080\"><audio src=\"narration.mp3\" data-duration=\"10\"/></div>",
  "assets": [
    {
      "filename": "narration.mp3",
      "base64": "//uQxAAAAAAAAAAAAAAAAAAAAAAA..."
    }
  ],
  "title": "Vídeo com Narração"
}
```

### Response

#### 201 Created

```json
{
  "preview_id": "550e8400-e29b-41d4-a716-446655440000",
  "preview_url": "/preview/550e8400-e29b-41d4-a716-446655440000",
  "expires_in": "2 horas"
}
```

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `preview_id` | `string` | UUID único do preview |
| `preview_url` | `string` | Caminho para abrir no browser |
| `expires_in` | `string` | Tempo até o preview expirar |

### Exemplo cURL

```bash
curl -s -X POST http://localhost:3030/preview \
  -H "Content-Type: application/json" \
  -d '{
    "html": "<div data-width=\"1920\" data-height=\"1080\"><h1 data-duration=\"3\">Olá!</h1></div>",
    "title": "Minha Composição"
  }'
```

#### Extrair URL e abrir no browser (macOS)

```bash
URL=$(curl -s -X POST http://localhost:3030/preview \
  -H "Content-Type: application/json" \
  -d '{"html":"<div data-width=\"1920\" data-height=\"1080\"><h1 data-duration=\"3\">Teste</h1></div>"}' \
  | jq -r '.preview_url')

open "http://localhost:3030$URL"
```

---

## GET /preview/:previewId

Abre a página de preview no browser. Retorna um HTML completo com o `<hyperframes-player>` carregando a composição.

### Request

**Method:** `GET`  
**Path:** `/preview/:previewId`

#### Path Parameters

| Parâmetro | Tipo | Descrição |
|-----------|------|-----------|
| `previewId` | `string` | UUID retornado pelo `POST /preview` |

### Response

#### 200 OK

Retorna a página HTML do player. Abra diretamente no browser.

**Content-Type:** `text/html; charset=utf-8`

#### 404 Not Found

```json
{ "error": "Preview não encontrado ou expirado" }
```

### Exemplo

```bash
# Abrir diretamente no browser (macOS)
open "http://localhost:3030/preview/550e8400-e29b-41d4-a716-446655440000"
```

---

## DELETE /preview/:previewId

Remove um preview manualmente antes do TTL expirar.

### Request

**Method:** `DELETE`  
**Path:** `/preview/:previewId`

#### Path Parameters

| Parâmetro | Tipo | Descrição |
|-----------|------|-----------|
| `previewId` | `string` | UUID do preview a remover |

### Response

#### 200 OK

```json
{ "deleted": true }
```

#### 404 Not Found

```json
{ "error": "Preview não encontrado" }
```

### Exemplo cURL

```bash
curl -X DELETE http://localhost:3030/preview/550e8400-e29b-41d4-a716-446655440000
```

---

## Assets estáticos

Os arquivos enviados via `assets` são servidos automaticamente em:

```
GET /preview/assets/:previewId/:filename
```

Os caminhos dentro do HTML são reescritos pelo servidor para apontar para esta URL — você não precisa fazer nada manualmente.

---

## Notas

- **Instantâneo:** nenhuma renderização ocorre — o `<hyperframes-player>` processa a composição no browser do usuário
- **TTL:** previews expiram em **2 horas** e são removidos automaticamente
- **Uso típico:** visualizar e ajustar a composição antes de chamar `POST /render` para gerar o MP4 final
- **Sem autenticação:** qualquer um com a URL pode acessar o preview enquanto ele existir
