import dotenv from "dotenv"
import express from "express"
import { google } from "googleapis"
import bcrypt from "bcryptjs"
import jwt from "jsonwebtoken"
import path from "node:path"
import pg from "pg"
import { fileURLToPath } from "node:url"

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
    const config = req.body?.config && typeof req.body.config === "object" ? req.body.config : {}

    const updated = await pool.query(
      `UPDATE dashboards
       SET name = COALESCE(NULLIF($1, ''), name),
           spreadsheet_id = COALESCE(NULLIF($2, ''), spreadsheet_id),
           config = $3::jsonb,
           updated_at = NOW()
       WHERE id = $4
       RETURNING id, name, tenant_slug, spreadsheet_id, config, created_at, updated_at`,
      [name, spreadsheetId, JSON.stringify(config), id]
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

app.use(express.static(__dirname))

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
