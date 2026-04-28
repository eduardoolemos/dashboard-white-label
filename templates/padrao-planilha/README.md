# Padrao de Planilha (White-Label)

Use este padrao para reduzir configuracoes manuais no dashboard.

## Abas recomendadas

1. `CONVERSOES` (gid livre)
2. `EXTRACAO GERENCIADOR` (gid livre)
3. Etapas comerciais (uma aba por etapa):
   - `Leads`
   - `Reuniao Agendada`
   - `Call Confirmada`
   - `No-Show`
   - `Call Feita`

## Colunas minimas por aba

### CONVERSOES
- `Data`
- `utm_campaign`
- `utm_content`
- `utm_term`
- `Contagem` (valor esperado: `Lead`)
- `Qualificacao` (valor esperado: `Qualificado`)

### EXTRACAO GERENCIADOR
- `Date`
- `Campaign Name`
- `Adset Name`
- `Ad Name`
- `Spend (Cost, Amount Spent)`
- `Impressions`
- `Action Link Clicks`
- `Action Landing Page View`

### Etapas comerciais (Leads, Reuniao Agendada, etc.)
- `Data`
- `utm_campaign`
- `utm_content`
- `utm_term`
- `Contagem` (ou coluna equivalente de status da etapa)

## Fluxo recomendado no dashboard

1. Clique em **Aplicar padrao da planilha**.
2. Clique em **Buscar GIDs automatico**.
3. Abra **Configurar regras** e ajuste apenas o que variar por cliente.

