# Padrao de Planilha Unica (White-Label)

Use este padrao para reduzir configuracoes manuais no dashboard.

Importante: este padrao foi pensado para **uma unica planilha Google** com varias abas.
Use o arquivo `PADRAO_PLANILHA_UNICA.xlsx`, que ja vem com todas as abas no mesmo workbook.
Depois, importe esse arquivo no Google Sheets e ajuste os dados reais.

## Abas recomendadas

1. `CONVERSOES` (gid livre)
2. `EXTRACAO GERENCIADOR` (gid livre)
3. `Leads` (gid livre)
4. `Reuniao Agendada` (gid livre)
5. `Call Confirmada` (gid livre)
6. `No-Show` (gid livre)
7. `Call Feita` (gid livre)

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

### Etapas comerciais (Leads, Reuniao Agendada, Call Confirmada, No-Show, Call Feita)
- `Data`
- `utm_campaign`
- `utm_content`
- `utm_term`
- `Contagem` (ou coluna equivalente de status da etapa)

## Fluxo recomendado no dashboard

1. Clique em **Aplicar padrao (planilha unica com abas)**.
2. Clique em **Buscar GIDs automatico**.
3. Abra **Configurar regras** e ajuste apenas o que variar por cliente.

