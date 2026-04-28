import { google } from "googleapis"

function getServiceAccountConfig() {
  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || ""
  const privateKeyRaw = process.env.GOOGLE_PRIVATE_KEY || ""
  const privateKey = privateKeyRaw.replace(/\\n/g, "\n")

  if (!clientEmail || !privateKey) {
    throw new Error(
      "Credenciais ausentes. Configure GOOGLE_SERVICE_ACCOUNT_EMAIL e GOOGLE_PRIVATE_KEY."
    )
  }

  return { clientEmail, privateKey }
}

export function getSheetsClient() {
  const { clientEmail, privateKey } = getServiceAccountConfig()
  const auth = new google.auth.JWT({
    email: clientEmail,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  })

  return google.sheets({ version: "v4", auth })
}

export function toCsv(rows = []) {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          const str = String(cell ?? "")
          if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`
          return str
        })
        .join(",")
    )
    .join("\n")
}
