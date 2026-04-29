# dashboard-white-label

Dashboard white-label com leitura de Google Sheets por cliente (tenant).

## Objetivo

Permitir conectar planilhas **privadas** sem expor dados publicamente.

## Como funciona

- Front (`index.html`) continua com a interface e métricas.
- Backend (`server.js`) faz leitura autenticada da Google Sheets API.
- Endpoints:
  - `POST /api/auth/login`
  - `GET /api/auth/me`
  - `POST /api/admin/users`
  - `GET /api/dashboards`
  - `POST /api/dashboards`
  - `PUT /api/dashboards/:id`
  - `POST /api/dashboards/:id/access`
  - `GET /api/sheets/tabs?spreadsheetId=...`
  - `GET /api/sheets/csv?spreadsheetId=...&gid=...`
- Configuração é isolada por tenant via `?tenant=slug`.

## Setup

1. Instale dependências:
   - `npm install`
2. Copie `.env.example` para `.env` e preencha:
   - `JWT_SECRET`
   - `ADMIN_EMAIL`
   - `ADMIN_PASSWORD`
   - `DATABASE_URL`
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

## Login e dashboards por acesso

- Faça login na aba **Config** com o usuário admin (`ADMIN_EMAIL`/`ADMIN_PASSWORD`).
- Crie dashboards com `nome` e `tenant slug`.
- Libere acesso por e-mail para cada dashboard.
- Usuários comuns veem apenas dashboards autorizados.
- Alterações de configuração são persistidas no banco automaticamente.

## Padrao de planilha (unica)

- O padrao e **uma unica planilha Google** com varias abas (paginas), cada uma com seu GID.
- Modelo recomendado em `templates/padrao-planilha/`.
- Arquivo pronto: `templates/padrao-planilha/PADRAO_PLANILHA_UNICA.xlsx`.
- Dentro do dashboard, use o botao **Aplicar padrao (planilha unica com abas)** antes de mapear GIDs.
- Esse fluxo reduz divergencias entre clientes e facilita reaproveitar regras.

## Observações

- Links publicados ainda funcionam como fallback.
- Para produção, hospede esse servidor em ambiente seguro e mantenha as variáveis de ambiente fora do front-end.
