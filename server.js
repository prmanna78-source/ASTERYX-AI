const express = require("express")
const fs = require("fs")
const path = require("path")
const bodyParser = require("body-parser")
const session = require("express-session")
const axios = require("axios")
const crypto = require("crypto")

const app = express()

/* ─── MIDDLEWARE ─────────────────────────────────────────── */

app.use(bodyParser.urlencoded({ extended: true }))
app.use(express.json())

app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 1000 * 60 * 60 * 24 // 24 hours
  }
}))

/* ─── RATE LIMITING ──────────────────────────────────────── */

const loginAttempts = {}

function rateLimit(ip) {
  const now = Date.now()
  if (!loginAttempts[ip]) loginAttempts[ip] = []
  loginAttempts[ip] = loginAttempts[ip].filter(t => now - t < 15 * 60 * 1000)
  if (loginAttempts[ip].length >= 10) return true
  loginAttempts[ip].push(now)
  return false
}

/* ─── PASSWORD HASHING ───────────────────────────────────── */

function hashPassword(password) {
  return crypto.createHash("sha256").update(password + "asteryx-salt-2026").digest("hex")
}

/* ─── USER STORAGE ───────────────────────────────────────── */

const USERS_FILE = path.join(__dirname, "users.json")

function readUsers() {
  try {
    if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, "[]")
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"))
  } catch {
    return []
  }
}

function writeUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2))
}

/* ─── AI ENGINE ──────────────────────────────────────────── */

const GROQ_API_KEY = process.env.GROQ_API_KEY
const USE_GROQ = !!GROQ_API_KEY

console.log(`\n╔══════════════════════════════════════╗`)
console.log(`║         ASTERYX AI SERVER            ║`)
console.log(`╠══════════════════════════════════════╣`)
console.log(`║  AI Engine : ${USE_GROQ ? "Groq API (cloud)     " : "Ollama (local)       "}║`)
console.log(`║  Model     : ${USE_GROQ ? "llama3-8b-8192       " : "llama3               "}║`)
console.log(`╚══════════════════════════════════════╝\n`)

/* ─── STATIC FILES ───────────────────────────────────────── */

app.use(express.static(__dirname))

/* ─── ROUTES ─────────────────────────────────────────────── */

// Landing page
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "landing.html"))
})
// Chat page (protected)
app.get("/chat", (req, res) => {
  if (!req.session.user) return res.redirect("/login.html")
  res.sendFile(path.join(__dirname, "index.html"))
})

// Get current user info
app.get("/me", (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: "Not logged in" })
  res.json({ name: req.session.user.name, email: req.session.user.email })
})

// Logout
app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"))
})

/* ─── SIGNUP ─────────────────────────────────────────────── */

app.post("/signup", (req, res) => {
  const { name, email, password } = req.body

  if (!name || !email || !password)
    return res.redirect("/signup.html?error=missing")

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  if (!emailRegex.test(email))
    return res.redirect("/signup.html?error=invalidemail")

  if (password.length < 6)
    return res.redirect("/signup.html?error=shortpassword")

  if (name.trim().length < 2)
    return res.redirect("/signup.html?error=shortname")

  let users = readUsers()
  const existing = users.find(u => u.email.toLowerCase() === email.toLowerCase())

  if (existing) return res.redirect("/signup.html?error=userexists")

  users.push({
    id: crypto.randomUUID(),
    name: name.trim(),
    email: email.toLowerCase().trim(),
    password: hashPassword(password),
    createdAt: new Date().toISOString()
  })

  writeUsers(users)
  res.redirect("/login.html?success=registered")
})

/* ─── LOGIN ──────────────────────────────────────────────── */

app.post("/login", (req, res) => {
  const ip = req.ip || req.connection.remoteAddress

  if (rateLimit(ip))
    return res.redirect("/login.html?error=ratelimit")

  const { email, password } = req.body

  if (!email || !password)
    return res.redirect("/login.html?error=missing")

  let users = readUsers()

  // Check hashed password
  let user = users.find(u =>
    u.email.toLowerCase() === email.toLowerCase() &&
    u.password === hashPassword(password)
  )

  // Migrate legacy plain-text passwords
  if (!user) {
    const legacy = users.find(u =>
      u.email.toLowerCase() === email.toLowerCase() &&
      u.password === password
    )
    if (legacy) {
      legacy.password = hashPassword(password)
      writeUsers(users)
      user = legacy
    }
  }

  if (!user) return res.redirect("/login.html?error=invalid")

  req.session.user = {
    id: user.id,
    name: user.name,
    email: user.email
  }

  res.redirect("/chat")
})

/* ─── AI CHAT ────────────────────────────────────────────── */

app.post("/ask", async (req, res) => {
  if (!req.session.user)
    return res.status(401).json({ reply: "Please log in first." })

  const question = req.body.question?.trim()
  if (!question)
    return res.status(400).json({ reply: "Please enter a question." })

  res.setHeader("Content-Type", "text/plain; charset=utf-8")
  res.setHeader("Transfer-Encoding", "chunked")
  res.setHeader("X-Accel-Buffering", "no")

  try {
    if (USE_GROQ) {
      /* ── GROQ CLOUD API (streaming) ── */
      const response = await axios.post(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          model: "llama3-8b-8192",
          messages: [
            {
              role: "system",
              content: "You are ASTERYX, a highly intelligent AI assistant specializing in robotics, coding, and software development. You give clear, accurate, and helpful answers. Format code in markdown code blocks."
            },
            { role: "user", content: question }
          ],
          stream: true,
          max_tokens: 2048,
          temperature: 0.7
        },
        {
          headers: {
            "Authorization": `Bearer ${GROQ_API_KEY}`,
            "Content-Type": "application/json"
          },
          responseType: "stream",
          timeout: 30000
        }
      )

      response.data.on("data", chunk => {
        const lines = chunk.toString().split("\n").filter(l => l.startsWith("data:"))
        for (const line of lines) {
          const data = line.replace(/^data:\s*/, "").trim()
          if (data === "[DONE]") return
          try {
            const json = JSON.parse(data)
            const token = json.choices?.[0]?.delta?.content
            if (token) res.write(token)
          } catch {}
        }
      })

      response.data.on("end", () => res.end())
      response.data.on("error", () => res.end())

    } else {
      /* ── OLLAMA LOCAL (streaming) ── */
      const response = await axios.post(
        "http://127.0.0.1:11434/api/generate",
        {
          model: "llama3",
          prompt: question,
          stream: true,
          system: "You are ASTERYX, a highly intelligent AI assistant specializing in robotics, coding, and software development."
        },
        {
          responseType: "stream",
          timeout: 60000
        }
      )

      response.data.on("data", chunk => {
        try {
          const lines = chunk.toString().split("\n").filter(l => l.trim())
          for (const line of lines) {
            const json = JSON.parse(line)
            if (json.response) res.write(json.response)
            if (json.done) res.end()
          }
        } catch {}
      })

      response.data.on("end", () => res.end())
      response.data.on("error", () => res.end())
    }

  } catch (err) {
    console.error("AI Error:", err.message)
    if (USE_GROQ) {
      res.write("⚠️ Groq API error. Please check your GROQ_API_KEY environment variable.")
    } else {
      res.write("⚠️ Ollama is not running. Start it with: ollama run llama3")
    }
    res.end()
  }
})

/* ─── START SERVER ───────────────────────────────────────── */

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}\n`)
})