import { getSheetsClient } from "../_lib/google.js"

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed." })
  }

  try {
    const spreadsheetId = String(req.query.spreadsheetId || "").trim()
    if (!spreadsheetId) {
      return res.status(400).json({ error: "spreadsheetId é obrigatório." })
    }

    const sheets = getSheetsClient()
    const meta = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: "sheets(properties(sheetId,title))",
    })

    const tabs = (meta.data.sheets || []).map((s) => ({
      gid: String(s.properties?.sheetId ?? ""),
      title: String(s.properties?.title ?? ""),
    }))

    return res.status(200).json({ tabs })
  } catch (error) {
    return res.status(500).json({
      error:
        "Falha ao ler abas da planilha. Verifique compartilhamento com a Service Account.",
      details: error?.message || String(error),
    })
  }
}
