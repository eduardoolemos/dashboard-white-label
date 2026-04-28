# dashboard-white-label

Dashboard white-label com leitura de Google Sheets por cliente (tenant).

## Objetivo

Permitir conectar planilhas **privadas** sem expor dados publicamente.

## Como funciona

- Front (`index.html`) continua com a interface e métricas.
- Backend (`server.js`) faz leitura autenticada da Google Sheets API.
- Endpoints:
  - `GET /api/sheets/tabs?spreadsheetId=...`
  - `GET /api/sheets/csv?spreadsheetId=...&gid=...`
- Configuração é isolada por tenant via `?tenant=slug`.

## Setup

1. Instale dependências:
   - `npm install`
2. Copie `.env.example` para `.env` e preencha:
   - `GOOGLE_SERVICE_ACCOUNT_EMAIL`
   - `GOOGLE_PRIVATE_KEY` (com `\n` escapado)
3. Compartilhe a planilha com o e-mail da Service Account (leitor).
4. Rode:
   - `npm run dev`
5. Abra:
   - `http://localhost:3000`

## Uso

- Cole o link normal da planilha (`https://docs.google.com/spreadsheets/d/<id>/...`).
- Clique em **Buscar GIDs automático**.
- Clique em **Carregar Dashboard**.

## Padrao de planilha

- Modelo recomendado em `templates/padrao-planilha/`.
- Dentro do dashboard, use o botao **Aplicar padrao da planilha** antes de mapear GIDs.
- Esse fluxo reduz divergencias entre clientes e facilita reaproveitar regras.

## Observações

- Links publicados ainda funcionam como fallback.
- Para produção, hospede esse servidor em ambiente seguro e mantenha as variáveis de ambiente fora do front-end.
