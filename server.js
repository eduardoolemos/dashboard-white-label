import dotenv from "dotenv"
import express from "express"
import { google } from "googleapis"
import path from "node:path"
import { fileURLToPath } from "node:url"

dotenv.config()

const app = express()
const port = process.env.PORT || 3000
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

function getServiceAccountConfig() {
  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || ""
  const privateKeyRaw = process.env.GOOGLE_PRIVATE_KEY || ""
  const privateKey = privateKeyRaw.replace(/\\n/g, "\n")
  const projectId = process.env.GOOGLE_PROJECT_ID || ""

  if (!clientEmail || !privateKey) {
    throw new Error(
      "Credenciais ausentes. Configure GOOGLE_SERVICE_ACCOUNT_EMAIL e GOOGLE_PRIVATE_KEY no .env."
    )
  }

  return { clientEmail, privateKey, projectId }
}

function getSheetsClient() {
  const { clientEmail, privateKey } = getServiceAccountConfig()
  const auth = new google.auth.JWT({
    email: clientEmail,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  })
  return google.sheets({ version: "v4", auth })
}

function toCsv(rows = []) {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          const str = String(cell ?? "")
          if (/[",\n\r]/.test(str)) {
            return `"${str.replace(/"/g, '""')}"`
          }
          return str
        })
        .join(",")
    )
    .join("\n")
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true })
})

app.get("/api/sheets/tabs", async (req, res) => {
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
    res.json({ tabs })
  } catch (error) {
    res.status(500).json({
      error:
        "Falha ao ler abas da planilha. Verifique compartilhamento com a Service Account.",
      details: error?.message || String(error),
    })
  }
})

app.get("/api/sheets/csv", async (req, res) => {
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
    res.send(csv)
  } catch (error) {
    res.status(500).json({
      error:
        "Falha ao ler dados da aba. Verifique compartilhamento e permissões.",
      details: error?.message || String(error),
    })
  }
})

app.use(express.static(__dirname))

app.listen(port, () => {
  console.log(`Dashboard white-label em http://localhost:${port}`)
})
