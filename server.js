import dotenv from "dotenv"
import express from "express"
import { google } from "googleapis"
import bcrypt from "bcryptjs"
import jwt from "jsonwebtoken"
import path from "node:path"
import pg from "pg"
import { fileURLToPath } from "node:url"
import axios from "axios"

dotenv.config()

const app = express()
const port = process.env.PORT || 3000
const jwtSecret = process.env.JWT_SECRET || "dev-only-change-this-secret"
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const { Pool } = pg
const databaseUrl = process.env.DATABASE_URL || ""
const pool = databaseUrl
  ? new Pool({
      connectionString: databaseUrl,
      ssl: databaseUrl.includes("localhost")
        ? false
        : { rejectUnauthorized: false },
    })
  : null

app.use(express.json())

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

function signToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      role: user.role,
      email: user.email,
      mustChangePassword: Boolean(user.must_change_password),
    },
    jwtSecret,
    { expiresIn: "7d" }
  )
}

function getDefaultInvitePassword() {
  const fromEnv = String(process.env.DEFAULT_USER_PASSWORD || "").trim()
  if (fromEnv) return fromEnv
  return "MudarSenha_Arven_2026!"
}

function getTokenFromRequest(req) {
  const auth = String(req.headers.authorization || "")
  if (auth.startsWith("Bearer ")) {
    return auth.slice("Bearer ".length).trim()
  }
  return ""
}

function requireAuth(req, res, next) {
  try {
    const token = getTokenFromRequest(req)
    if (!token) {
      return res.status(401).json({ error: "Token de autenticação ausente." })
    }
    const payload = jwt.verify(token, jwtSecret)
    req.user = payload
    next()
  } catch {
    res.status(401).json({ error: "Token inválido ou expirado." })
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== "super_admin") {
    return res.status(403).json({ error: "Acesso permitido apenas para admin." })
  }
  next()
}

async function canAccessDashboard(userId, role, dashboardId) {
  if (!pool) return false
  if (role === "super_admin") return true

  const check = await pool.query(
    `SELECT 1
     FROM dashboard_access
     WHERE dashboard_id = $1 AND user_id = $2
     LIMIT 1`,
    [dashboardId, userId]
  )
  return check.rowCount > 0
}

async function initDatabase() {
  if (!pool) {
    console.warn("DATABASE_URL ausente: recursos de login/banco desativados.")
    return
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_users (
      id BIGSERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      role TEXT NOT NULL DEFAULT 'user',
      must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `)

  await pool.query(`
    ALTER TABLE app_users
    ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS dashboards (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      tenant_slug TEXT NOT NULL UNIQUE,
      spreadsheet_id TEXT,
      config JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_by BIGINT REFERENCES app_users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS dashboard_access (
      id BIGSERIAL PRIMARY KEY,
      dashboard_id BIGINT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
      user_id BIGINT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      access_role TEXT NOT NULL DEFAULT 'viewer',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (dashboard_id, user_id)
    );
  `)

  const adminEmail = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase()
  const adminPassword = String(process.env.ADMIN_PASSWORD || "")
  if (!adminEmail || !adminPassword) return

  const existing = await pool.query(
    "SELECT id FROM app_users WHERE email = $1 LIMIT 1",
    [adminEmail]
  )
  if (existing.rowCount === 0) {
    const hash = await bcrypt.hash(adminPassword, 10)
    await pool.query(
      "INSERT INTO app_users (email, password_hash, role) VALUES ($1, $2, 'super_admin')",
      [adminEmail, hash]
    )
    console.log(`Admin inicial criado: ${adminEmail}`)
  }
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, db: Boolean(pool) })
})

app.post("/api/auth/login", async (req, res) => {
  try {
    if (!pool) {
      return res
        .status(503)
        .json({ error: "Banco não configurado. Defina DATABASE_URL." })
    }

    const email = String(req.body?.email || "")
      .trim()
      .toLowerCase()
    const password = String(req.body?.password || "")
    if (!email || !password) {
      return res.status(400).json({ error: "email e password são obrigatórios." })
    }

    const userRes = await pool.query(
      "SELECT id, email, password_hash, role, must_change_password FROM app_users WHERE email = $1 LIMIT 1",
      [email]
    )
    const user = userRes.rows[0]
    if (!user?.password_hash) {
      return res.status(401).json({ error: "Credenciais inválidas." })
    }

    const valid = await bcrypt.compare(password, user.password_hash)
    if (!valid) {
      return res.status(401).json({ error: "Credenciais inválidas." })
    }

    const token = signToken(user)
    res.json({
      token,
      mustChangePassword: Boolean(user.must_change_password),
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        mustChangePassword: Boolean(user.must_change_password),
      },
    })
  } catch (error) {
    res.status(500).json({
      error: "Falha no login.",
      details: error?.message || String(error),
    })
  }
})

app.get("/api/auth/me", requireAuth, async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: "Banco não configurado." })
    const id = Number(req.user?.sub)
    if (!id) return res.status(400).json({ error: "Sessão inválida." })

    const userRes = await pool.query(
      "SELECT id, email, role, must_change_password FROM app_users WHERE id = $1 LIMIT 1",
      [id]
    )
    const row = userRes.rows[0]
    if (!row) return res.status(404).json({ error: "Usuário não encontrado." })

    res.json({
      user: {
        id: row.id,
        email: row.email,
        role: row.role,
        mustChangePassword: Boolean(row.must_change_password),
      },
    })
  } catch (error) {
    res.status(500).json({
      error: "Falha ao carregar usuário.",
      details: error?.message || String(error),
    })
  }
})

app.put("/api/auth/password", requireAuth, async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: "Banco não configurado." })

    const id = Number(req.user?.sub)
    const currentPassword = String(req.body?.currentPassword || "")
    const newPassword = String(req.body?.newPassword || "")
    if (!id || !currentPassword || !newPassword) {
      return res.status(400).json({
        error: "currentPassword e newPassword são obrigatórios.",
      })
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: "Nova senha deve ter pelo menos 8 caracteres." })
    }

    const userRes = await pool.query(
      "SELECT id, email, role, password_hash, must_change_password FROM app_users WHERE id = $1 LIMIT 1",
      [id]
    )
    const row = userRes.rows[0]
    if (!row?.password_hash) {
      return res.status(400).json({ error: "Usuário sem senha configurada." })
    }

    const validCurrent = await bcrypt.compare(currentPassword, row.password_hash)
    if (!validCurrent) {
      return res.status(401).json({ error: "Senha atual incorreta." })
    }

    const newHash = await bcrypt.hash(newPassword, 10)
    const updated = await pool.query(
      `UPDATE app_users
       SET password_hash = $1,
           must_change_password = FALSE
       WHERE id = $2
       RETURNING id, email, role, must_change_password`,
      [newHash, id]
    )

    const user = updated.rows[0]
    const token = signToken(user)
    res.json({
      token,
      mustChangePassword: false,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        mustChangePassword: false,
      },
    })
  } catch (error) {
    res.status(500).json({
      error: "Falha ao atualizar senha.",
      details: error?.message || String(error),
    })
  }
})

app.post("/api/admin/users", requireAuth, requireAdmin, async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: "Banco não configurado." })

    const email = String(req.body?.email || "")
      .trim()
      .toLowerCase()
    const password = String(req.body?.password || "")
    const role = req.body?.role === "super_admin" ? "super_admin" : "user"

    if (!email || !password) {
      return res.status(400).json({ error: "email e password são obrigatórios." })
    }

    const hash = await bcrypt.hash(password, 10)
    const created = await pool.query(
      `INSERT INTO app_users (email, password_hash, role, must_change_password)
       VALUES ($1, $2, $3, FALSE)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role, must_change_password = FALSE
       RETURNING id, email, role`,
      [email, hash, role]
    )
    res.status(201).json({ user: created.rows[0] })
  } catch (error) {
    res.status(500).json({
      error: "Falha ao criar usuário.",
      details: error?.message || String(error),
    })
  }
})

app.get("/api/dashboards", requireAuth, async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: "Banco não configurado." })

    if (req.user.role === "super_admin") {
      const list = await pool.query(
        "SELECT id, name, tenant_slug, spreadsheet_id, config, created_at, updated_at FROM dashboards ORDER BY id DESC"
      )
      return res.json({ dashboards: list.rows })
    }

    const list = await pool.query(
      `SELECT d.id, d.name, d.tenant_slug, d.spreadsheet_id, d.config, d.created_at, d.updated_at
       FROM dashboards d
       JOIN dashboard_access a ON a.dashboard_id = d.id
       WHERE a.user_id = $1
       ORDER BY d.id DESC`,
      [req.user.sub]
    )
    res.json({ dashboards: list.rows })
  } catch (error) {
    res.status(500).json({
      error: "Falha ao listar dashboards.",
      details: error?.message || String(error),
    })
  }
})

app.post("/api/dashboards", requireAuth, requireAdmin, async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: "Banco não configurado." })
    const name = String(req.body?.name || "").trim()
    const tenantSlug = String(req.body?.tenantSlug || "").trim()
    const spreadsheetId = String(req.body?.spreadsheetId || "").trim()
    const config = req.body?.config && typeof req.body.config === "object" ? req.body.config : {}

    if (!name || !tenantSlug) {
      return res.status(400).json({ error: "name e tenantSlug são obrigatórios." })
    }

    const created = await pool.query(
      `INSERT INTO dashboards (name, tenant_slug, spreadsheet_id, config, created_by)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       RETURNING id, name, tenant_slug, spreadsheet_id, config, created_at, updated_at`,
      [name, tenantSlug, spreadsheetId || null, JSON.stringify(config), req.user.sub]
    )
    res.status(201).json({ dashboard: created.rows[0] })
  } catch (error) {
    res.status(500).json({
      error: "Falha ao criar dashboard.",
      details: error?.message || String(error),
    })
  }
})

app.get("/api/admin/dashboards/:id/users", requireAuth, requireAdmin, async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: "Banco não configurado." })
    const id = Number(req.params.id)
    if (!id) return res.status(400).json({ error: "ID inválido." })

    const result = await pool.query(
      `SELECT u.id, u.email, u.role, a.access_role, u.must_change_password
       FROM dashboard_access a
       JOIN app_users u ON u.id = a.user_id
       WHERE a.dashboard_id = $1
       ORDER BY u.email ASC`,
      [id]
    )
    res.json({ users: result.rows })
  } catch (error) {
    res.status(500).json({
      error: "Falha ao listar usuários do dashboard.",
      details: error?.message || String(error),
    })
  }
})

app.put("/api/dashboards/:id", requireAuth, async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: "Banco não configurado." })
    const id = Number(req.params.id)
    if (!id) return res.status(400).json({ error: "ID inválido." })

    const hasAccess = await canAccessDashboard(req.user.sub, req.user.role, id)
    if (!hasAccess) return res.status(403).json({ error: "Sem permissão para este dashboard." })

    const name = String(req.body?.name || "").trim()
    const spreadsheetId = String(req.body?.spreadsheetId || "").trim()
    const hasConfig = req.body?.config !== undefined && typeof req.body.config === "object"
    const config = hasConfig ? req.body.config : null

    const updated = await pool.query(
      `UPDATE dashboards
       SET name = COALESCE(NULLIF($1, ''), name),
           spreadsheet_id = COALESCE(NULLIF($2, ''), spreadsheet_id),
           config = CASE WHEN $3::jsonb IS NOT NULL THEN $3::jsonb ELSE config END,
           updated_at = NOW()
       WHERE id = $4
       RETURNING id, name, tenant_slug, spreadsheet_id, config, created_at, updated_at`,
      [name, spreadsheetId, config !== null ? JSON.stringify(config) : null, id]
    )
    if (updated.rowCount === 0) {
      return res.status(404).json({ error: "Dashboard não encontrado." })
    }

    res.json({ dashboard: updated.rows[0] })
  } catch (error) {
    res.status(500).json({
      error: "Falha ao atualizar dashboard.",
      details: error?.message || String(error),
    })
  }
})

app.put("/api/admin/dashboards/:dashboardId/users/:userId", requireAuth, requireAdmin, async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: "Banco não configurado." })
    const dashboardId = Number(req.params.dashboardId)
    const userId = Number(req.params.userId)
    if (!dashboardId || !userId) return res.status(400).json({ error: "IDs inválidos." })

    const accessRole = req.body?.accessRole
    const systemRole = req.body?.systemRole

    if (accessRole !== undefined) {
      const role = accessRole === "editor" ? "editor" : "viewer"
      await pool.query(
        `UPDATE dashboard_access SET access_role = $1 WHERE dashboard_id = $2 AND user_id = $3`,
        [role, dashboardId, userId]
      )
    }

    if (systemRole !== undefined) {
      const role = systemRole === "super_admin" ? "super_admin" : "user"
      await pool.query(`UPDATE app_users SET role = $1 WHERE id = $2`, [role, userId])
    }

    res.json({ ok: true })
  } catch (error) {
    res.status(500).json({ error: "Falha ao atualizar permissão.", details: error?.message || String(error) })
  }
})

app.post("/api/dashboards/:id/access", requireAuth, requireAdmin, async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: "Banco não configurado." })

    const dashboardId = Number(req.params.id)
    const email = String(req.body?.email || "")
      .trim()
      .toLowerCase()
    const accessRole = req.body?.accessRole === "editor" ? "editor" : "viewer"
    if (!dashboardId || !email) {
      return res.status(400).json({ error: "id do dashboard e email são obrigatórios." })
    }

    let user = await pool.query(
      "SELECT id, email, role, password_hash, must_change_password FROM app_users WHERE email = $1 LIMIT 1",
      [email]
    )
    let appliedDefaultPassword = false
    if (user.rowCount === 0) {
      const defaultPw = getDefaultInvitePassword()
      const hash = await bcrypt.hash(defaultPw, 10)
      user = await pool.query(
        `INSERT INTO app_users (email, password_hash, role, must_change_password)
         VALUES ($1, $2, 'user', TRUE)
         RETURNING id, email, role, password_hash, must_change_password`,
        [email, hash]
      )
      appliedDefaultPassword = true
    } else if (!user.rows[0]?.password_hash) {
      const defaultPw = getDefaultInvitePassword()
      const hash = await bcrypt.hash(defaultPw, 10)
      user = await pool.query(
        `UPDATE app_users
         SET password_hash = $2,
             must_change_password = TRUE
         WHERE email = $1
         RETURNING id, email, role, password_hash, must_change_password`,
        [email, hash]
      )
      appliedDefaultPassword = true
    }

    await pool.query(
      `INSERT INTO dashboard_access (dashboard_id, user_id, access_role)
       VALUES ($1, $2, $3)
       ON CONFLICT (dashboard_id, user_id)
       DO UPDATE SET access_role = EXCLUDED.access_role`,
      [dashboardId, user.rows[0].id, accessRole]
    )

    res.status(201).json({
      granted: true,
      dashboardId,
      user: {
        id: user.rows[0].id,
        email: user.rows[0].email,
        role: user.rows[0].role,
      },
      accessRole,
      appliedDefaultPassword,
      defaultPassword: appliedDefaultPassword ? getDefaultInvitePassword() : null,
      hint:
        appliedDefaultPassword
          ? "Senha padrão aplicada: o usuário deve trocar no primeiro login."
          : "Usuário já possuía senha; apenas permissões atualizadas.",
    })
  } catch (error) {
    res.status(500).json({
      error: "Falha ao conceder acesso.",
      details: error?.message || String(error),
    })
  }
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

// ─── GOOGLE AUTH HELPER ──────────────────────────────────────────────────────

function getGoogleCredentials() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY não configurado")
  try {
    return JSON.parse(raw)
  } catch {
    // tenta base64
    try {
      return JSON.parse(Buffer.from(raw, "base64").toString("utf8"))
    } catch {
      throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY inválido (esperado JSON ou base64)")
    }
  }
}

function getGoogleAuth(scopes) {
  const credentials = getGoogleCredentials()
  return new google.auth.GoogleAuth({ credentials, scopes })
}

// ─── INTEGRAÇÃO KOMMO ────────────────────────────────────────────────────────

app.post("/api/kommo/pipelines", async (req, res) => {
  const { domain, token } = req.body
  try {
    const { data } = await axios.get(
      `https://${domain}/api/v4/leads/pipelines?limit=50`,
      { headers: { Authorization: `Bearer ${token}` } }
    )
    res.json(data._embedded?.pipelines || [])
  } catch (e) {
    res.status(400).json({ error: e.response?.data || e.message })
  }
})

app.post("/api/kommo/n8n/workflows", async (req, res) => {
  const { n8nUrl, n8nApiKey } = req.body
  try {
    const { data } = await axios.get(`${n8nUrl}/api/v1/workflows`, {
      headers: { "X-N8N-API-KEY": n8nApiKey },
    })
    res.json(data.data || [])
  } catch (e) {
    res.status(400).json({ error: e.response?.data || e.message })
  }
})

app.post("/api/kommo/n8n/create-workflow", async (req, res) => {
  const { n8nUrl, n8nApiKey, workflowName, stages, kommo, sheets } = req.body
  const backendPublicUrl = (process.env.BACKEND_PUBLIC_URL || `http://134.195.90.244:${process.env.PORT || 3000}`).replace(/\/+$/, "")
  const stageNodeName = (prefix, s) => `${prefix}: ${s.name} [${s.status_id}]`

  // webhook path único por cliente baseado no subdomínio do Kommo
  const kommoSubdomain = String(kommo?.domain || "").split(".")[0].toLowerCase().replace(/[^a-z0-9-]/g, "") || "cliente"
  const webhookPath = `${kommoSubdomain}-n8n-kommo-arven`

  const triggerNode = {
    id: "trigger-1", name: "Kommo Webhook Trigger", type: "n8n-nodes-base.webhook",
    typeVersion: 2, position: [240, 300], webhookId: crypto.randomUUID(),
    parameters: { httpMethod: "POST", path: webhookPath, responseMode: "onReceived", responseData: "allEntries" },
  }

  const enrichNode = {
    id: "enrich-1", name: "Enriquecer Lead", type: "n8n-nodes-base.code",
    typeVersion: 2, position: [480, 300],
    parameters: {
      jsCode: `
const body = $input.first().json.body || {};
const lead_id = body['leads[status][0][id]'];
const status_id = body['leads[status][0][status_id]'];
const old_status_id = body['leads[status][0][old_status_id]'];
const pipeline_id = body['leads[status][0][pipeline_id]'];
const price = body['leads[status][0][price]'];
const responsible = body['leads[status][0][responsible_user_id]'];
const account_sub = body['account[subdomain]'];
const account_id = body['account[id]'];
const tags = [];
let t = 0;
while (body[\`leads[status][0][tags][\${t}][name]\`]) { tags.push(body[\`leads[status][0][tags][\${t}][name]\`]); t++; }
const kommoToken = '${kommo?.token || ""}';
const kommoDomain = '${kommo?.domain || ""}';
const leadRes = await this.helpers.httpRequest({ method: 'GET', url: \`https://\${kommoDomain}/api/v4/leads/\${lead_id}?with=contacts,tags,custom_fields_values\`, headers: { Authorization: \`Bearer \${kommoToken}\` } });
function parseCustomFields(arr) { const obj = {}; if (!Array.isArray(arr)) return obj; for (const cf of arr) { const key = cf.field_name || String(cf.field_id); obj[key] = cf.values?.[0]?.value ?? null; } return obj; }
const leadCustomFields = parseCustomFields(leadRes.custom_fields_values);
const contacts = leadRes._embedded?.contacts || [];
let contactCustomFields = {}, contactName = '', contactPhone = '', contactEmail = '';
if (contacts.length > 0) {
  const mainContact = contacts.find(c => c.is_main) || contacts[0];
  const contactRes = await this.helpers.httpRequest({ method: 'GET', url: \`https://\${kommoDomain}/api/v4/contacts/\${mainContact.id}?with=custom_fields_values\`, headers: { Authorization: \`Bearer \${kommoToken}\` } });
  contactName = contactRes.name || '';
  contactCustomFields = parseCustomFields(contactRes.custom_fields_values);
  for (const cf of (contactRes.custom_fields_values || [])) { if (cf.field_code === 'PHONE') contactPhone = cf.values?.[0]?.value || ''; if (cf.field_code === 'EMAIL') contactEmail = cf.values?.[0]?.value || ''; }
}
const FIXED_KEYS = new Set(['Phone','Email','etapa_atual_id','etapa_anterior_id','pipeline_id','account_subdomain','account_id','lead_id','lead_name','lead_price','responsible_user_id','tags','contato_nome','contato_telefone','contato_email','utm_campaign','utm_source','utm_medium','utm_content','utm_term','fbclid']);
const allCustom = { ...leadCustomFields, ...contactCustomFields };
const dynamicFields = {};
for (const [k, v] of Object.entries(allCustom)) { if (!FIXED_KEYS.has(k)) dynamicFields[k] = v; }
return [{ json: { etapa_atual_id: status_id, etapa_anterior_id: old_status_id, pipeline_id, account_subdomain: account_sub, account_id, lead_id, lead_name: leadRes.name || '', lead_price: price, responsible_user_id: responsible, tags, contato_nome: contactName, contato_telefone: contactPhone, contato_email: contactEmail, utm_campaign: allCustom['utm_campaign'] ?? null, utm_source: allCustom['utm_source'] ?? null, utm_medium: allCustom['utm_medium'] ?? null, utm_content: allCustom['utm_content'] ?? null, utm_term: allCustom['utm_term'] ?? null, fbclid: allCustom['fbclid'] ?? null, _dynamic: dynamicFields } }];
`    },
  }

  const sheetsNodes = stages.map((s, i) => ({
    id: `sheets-${i}`, name: stageNodeName("Planilha", s), type: "n8n-nodes-base.code",
    typeVersion: 2, position: [1240, 100 + i * 200],
    parameters: { jsCode: `const d = $input.first().json; const backendUrl = '${backendPublicUrl}'; const rawSheet = '${sheets?.spreadsheetId || ""}'; const sheetId = rawSheet.includes('/d/') ? (rawSheet.match(/\\/d\\/([a-zA-Z0-9-_]+)/)?.[1] || rawSheet) : rawSheet; const tabName = '${s.name}'; const dynamic = d._dynamic || {}; const dynamicValues = Object.values(dynamic); const dynamicHeaders = Object.keys(dynamic); const now = new Date(); const data = [now.toLocaleDateString('pt-BR'), d.contato_nome || d.lead_name || '', d.contato_telefone || '', d.contato_email || '', d.utm_campaign || '', d.utm_source || '', d.utm_medium || '', d.utm_content || '', d.utm_term || '', d.fbclid || '', ...dynamicValues, 1]; const headers = ['Data','Nome','Telefone','Email','utm_campaign','utm_source','utm_medium','utm_content','utm_term','fbclid',...dynamicHeaders,'Contagem']; await this.helpers.httpRequest({ method: 'POST', url: \`\${backendUrl}/api/kommo/sheets/append\`, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sheetId, tabName, headers, row: data }) }); return [$input.first()];` },
  }))

  const ifNodes = stages.map((s, i) => ({
    id: `if-${i}`, name: stageNodeName("Checar", s), type: "n8n-nodes-base.if",
    typeVersion: 2, position: [760, 100 + i * 200],
    parameters: { conditions: { options: { caseSensitive: true, leftValue: "", typeValidation: "strict" }, combinator: "and", conditions: [{ id: `cond-${i}`, leftValue: "={{ $json.etapa_atual_id }}", rightValue: String(s.status_id), operator: { type: "string", operation: "equals" } }] } },
  }))

  const setNodes = stages.map((s, i) => ({
    id: `set-${i}`, name: stageNodeName("Etapa", s), type: "n8n-nodes-base.set",
    typeVersion: 3, position: [1000, 100 + i * 200],
    parameters: { mode: "raw", jsonOutput: `{"etapa_nome":"${s.name}","pipeline_nome":"${s.pipeline}"}`, includeOtherFields: true },
  }))

  const fallbackNode = { id: "fallback-1", name: "Etapa não mapeada", type: "n8n-nodes-base.noOp", typeVersion: 1, position: [1000, 100 + stages.length * 200], parameters: {} }

  const connections = {
    [triggerNode.name]: { main: [[{ node: enrichNode.name, type: "main", index: 0 }]] },
    [enrichNode.name]: { main: [[{ node: ifNodes[0].name, type: "main", index: 0 }]] },
  }
  ifNodes.forEach((ifNode, i) => {
    connections[ifNode.name] = { main: [[{ node: setNodes[i].name, type: "main", index: 0 }], i < ifNodes.length - 1 ? [{ node: ifNodes[i + 1].name, type: "main", index: 0 }] : [{ node: fallbackNode.name, type: "main", index: 0 }]] }
    connections[setNodes[i].name] = { main: [[{ node: sheetsNodes[i].name, type: "main", index: 0 }]] }
  })

  const workflow = { name: workflowName || "Kommo Stage Router", nodes: [triggerNode, enrichNode, ...ifNodes, ...setNodes, ...sheetsNodes, fallbackNode], connections, settings: { executionOrder: "v1" } }

  try {
    const { data } = await axios.post(`${n8nUrl}/api/v1/workflows`, workflow, { headers: { "X-N8N-API-KEY": n8nApiKey, "Content-Type": "application/json" } })
    await axios.post(`${n8nUrl}/api/v1/workflows/${data.id}/activate`, {}, { headers: { "X-N8N-API-KEY": n8nApiKey } })
    const webhookUrl = `${n8nUrl}/webhook/${webhookPath}`
    if (kommo?.domain && kommo?.token) {
      await axios.post(`https://${kommo.domain}/api/v4/webhooks`, { destination: webhookUrl, settings: ["status_lead"] }, { headers: { Authorization: `Bearer ${kommo.token}` } })
    }
    res.json({ workflowId: data.id, workflowUrl: `${n8nUrl}/workflow/${data.id}`, webhookUrl })
  } catch (e) {
    res.status(400).json({ error: e.response?.data || e.message })
  }
})

app.post("/api/kommo/sheets/append", async (req, res) => {
  const { sheetId, tabName, headers, row } = req.body
  try {
    const auth = getGoogleAuth(["https://www.googleapis.com/auth/drive", "https://www.googleapis.com/auth/spreadsheets"])
    const sheets = google.sheets({ version: "v4", auth })
    const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId })
    const existing = meta.data.sheets.map(s => s.properties.title)
    if (!existing.includes(tabName)) {
      await sheets.spreadsheets.batchUpdate({ spreadsheetId: sheetId, requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] } })
      await sheets.spreadsheets.values.append({ spreadsheetId: sheetId, range: `${tabName}!A1`, valueInputOption: "USER_ENTERED", requestBody: { values: [headers] } })
    }
    await sheets.spreadsheets.values.append({ spreadsheetId: sheetId, range: `${tabName}!A1`, valueInputOption: "USER_ENTERED", requestBody: { values: [row] } })
    res.json({ ok: true })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

app.post("/api/kommo/sheets/create", async (req, res) => {
  const { folderId, sheetName } = req.body
  try {
    const auth = getGoogleAuth(["https://www.googleapis.com/auth/drive", "https://www.googleapis.com/auth/spreadsheets"])
    const drive = google.drive({ version: "v3", auth })
    const { data } = await drive.files.create({ requestBody: { name: sheetName, mimeType: "application/vnd.google-apps.spreadsheet", parents: [folderId] }, fields: "id, name, webViewLink", supportsAllDrives: true })
    res.json({ id: data.id, name: data.name, url: data.webViewLink })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

app.post("/api/kommo/drive/folders", async (req, res) => {
  const { folderId } = req.body
  try {
    const auth = getGoogleAuth(["https://www.googleapis.com/auth/drive"])
    const drive = google.drive({ version: "v3", auth })
    const parent = folderId === "root" ? "root" : folderId
    const { data } = await drive.files.list({ q: `'${parent}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`, fields: "files(id, name)", orderBy: "name", pageSize: 100, includeItemsFromAllDrives: true, supportsAllDrives: true })
    res.json(data.files || [])
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

app.get("/api/kommo/defaults", (req, res) => {
  res.json({
    n8nUrl: process.env.N8N_URL || "",
    n8nApiKey: process.env.N8N_API_KEY || "",
    sheetName: process.env.GOOGLE_SHEET_NAME || "",
    folderId: process.env.GOOGLE_DRIVE_FOLDER_ID || "",
  })
})

// ─── KOMMO: serve frontend estático ──────────────────────────────────────────
app.use("/admin/integracao-kommo", express.static(path.join(__dirname, "kommo-dist")))
app.get("/admin/integracao-kommo/*", (req, res) => {
  res.sendFile(path.join(__dirname, "kommo-dist", "index.html"))
})

// ─────────────────────────────────────────────────────────────────────────────

app.use(express.static(__dirname))

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"))
})

initDatabase()
  .then(() => {
    app.listen(port, () => {
      console.log(`Dashboard white-label em http://localhost:${port}`)
    })
  })
  .catch((error) => {
    console.error("Falha ao iniciar aplicação:", error?.message || error)
    process.exit(1)
  })
