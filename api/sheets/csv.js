import { getSheetsClient, toCsv } from "../_lib/google.js"

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed." })
  }

  try {
    const spreadsheetId = String(req.query.spreadsheetId || "").trim()
    const gid = String(req.query.gid || "").trim()
    if (!spreadsheetId || !gid) {
      return res
        .status(400)
        .json({ error: "spreadsheetId e gid são obrigatórios." })
    }

    const sheets = getSheetsClient()
    const meta = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: "sheets(properties(sheetId,title))",
    })

    const sheet = (meta.data.sheets || []).find(
      (s) => String(s.properties?.sheetId ?? "") === gid
    )
    if (!sheet?.properties?.title) {
      return res.status(404).json({ error: "Aba não encontrada para o GID." })
    }

    const values = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${sheet.properties.title.replace(/'/g, "''")}'`,
      majorDimension: "ROWS",
    })

    const csv = toCsv(values.data.values || [])
    res.setHeader("Content-Type", "text/csv; charset=utf-8")
    return res.status(200).send(csv)
  } catch (error) {
    return res.status(500).json({
      error:
        "Falha ao ler dados da aba. Verifique compartilhamento e permissões.",
      details: error?.message || String(error),
    })
  }
}
