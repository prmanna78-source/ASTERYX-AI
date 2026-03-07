const express = require("express")
const path = require("path")
const bodyParser = require("body-parser")
const session = require("express-session")
const axios = require("axios")
const crypto = require("crypto")

const app = express()

app.use(bodyParser.urlencoded({ extended: true }))
app.use(express.json())

app.use(session({
  secret: "asteryx-fixed-secret-2026",
  resave: true,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: false,
    sameSite: "lax",
    maxAge: 1000 * 60 * 60 * 24 * 7
  }
}))

const loginAttempts = {}
function rateLimit(ip) {
  const now = Date.now()
  if (!loginAttempts[ip]) loginAttempts[ip] = []
  loginAttempts[ip] = loginAttempts[ip].filter(t => now - t < 15 * 60 * 1000)
  if (loginAttempts[ip].length >= 10) return true
  loginAttempts[ip].push(now)
  return false
}

function hashPassword(password) {
  return crypto.createHash("sha256").update(password + "asteryx-salt-2026").digest("hex")
}

// In-memory user store — works perfectly on Railway
let USERS = []

const GROQ_API_KEY = process.env.GROQ_API_KEY
const USE_GROQ = !!GROQ_API_KEY

console.log("\n╔══════════════════════════════════════╗")
console.log("║         ASTERYX AI SERVER            ║")
console.log("╠══════════════════════════════════════╣")
console.log(`║  Groq API : ${USE_GROQ ? "CONNECTED ✅              " : "NOT SET ❌ add to Railway  "}║`)
console.log("╚══════════════════════════════════════╝\n")

app.use(express.static(__dirname))

// ── LANDING PAGE — always show, no redirects ──
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "landing.html"))
})

// ── CHAT PAGE — protected ──
app.get("/chat", (req, res) => {
  if (!req.session.user) return res.redirect("/login.html")
  res.sendFile(path.join(__dirname, "index.html"))
})

// ── USER INFO ──
app.get("/me", (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: "Not logged in" })
  res.json({ name: req.session.user.name, email: req.session.user.email })
})

// ── LOGOUT ──
app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid")
    res.redirect("/")
  })
})

// ── SIGNUP ──
app.post("/signup", (req, res) => {
  const { name, email, password } = req.body
  if (!name || !email || !password) return res.redirect("/signup.html?error=missing")

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  if (!emailRegex.test(email)) return res.redirect("/signup.html?error=invalidemail")
  if (password.length < 6) return res.redirect("/signup.html?error=shortpassword")
  if (name.trim().length < 2) return res.redirect("/signup.html?error=shortname")

  const existing = USERS.find(u => u.email.toLowerCase() === email.toLowerCase())
  if (existing) return res.redirect("/signup.html?error=userexists")

  USERS.push({
    id: crypto.randomUUID(),
    name: name.trim(),
    email: email.toLowerCase().trim(),
    password: hashPassword(password),
    createdAt: new Date().toISOString()
  })

  console.log(`✅ New user signed up: ${name} | Total users: ${USERS.length}`)
  res.redirect("/login.html?success=registered")
})

// ── LOGIN ──
app.post("/login", (req, res) => {
  const ip = req.ip || "unknown"
  if (rateLimit(ip)) return res.redirect("/login.html?error=ratelimit")

  const { email, password } = req.body
  if (!email || !password) return res.redirect("/login.html?error=missing")

  const user = USERS.find(u =>
    u.email.toLowerCase() === email.toLowerCase() &&
    u.password === hashPassword(password)
  )

  if (!user) {
    console.log(`❌ Failed login: ${email}`)
    return res.redirect("/login.html?error=invalid")
  }

  req.session.user = { id: user.id, name: user.name, email: user.email }
  req.session.save(() => {
    console.log(`✅ Logged in: ${user.name}`)
    res.redirect("/chat")
  })
})

// ── AI CHAT ──
app.post("/ask", async (req, res) => {
  res.setHeader("Content-Type", "text/plain; charset=utf-8")
  res.setHeader("Transfer-Encoding", "chunked")
  res.setHeader("X-Accel-Buffering", "no")
  res.setHeader("Cache-Control", "no-cache")

  if (!req.session.user) {
    res.write("Session expired. Please log out and log in again.")
    return res.end()
  }

  const question = req.body.question?.trim()
  if (!question) {
    res.write("Please enter a question.")
    return res.end()
  }

  if (!USE_GROQ) {
    res.write("⚠️ GROQ_API_KEY is not set.\n\nGo to Railway → your project → asteryx-ai service → Variables tab → add GROQ_API_KEY with your Groq key.")
    return res.end()
  }

  try {
    const response = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: "llama3-8b-8192",
        messages: [
          {
            role: "system",
            content: "You are ASTERYX, a highly intelligent AI assistant specializing in robotics, coding, and software development. Give clear, helpful, and accurate answers. Use markdown code blocks for code."
          },
          {
            role: "user",
            content: question
          }
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
      const lines = chunk.toString().split("\n")
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith("data:")) continue
        const data = trimmed.replace(/^data:\s*/, "")
        if (data === "[DONE]") continue
        try {
          const json = JSON.parse(data)
          const token = json.choices?.[0]?.delta?.content
          if (token) res.write(token)
        } catch {}
      }
    })

    response.data.on("end", () => {
      console.log(`💬 ${req.session.user.name}: "${question.substring(0, 60)}"`)
      res.end()
    })

    response.data.on("error", err => {
      console.error("Stream error:", err.message)
      res.end()
    })

  } catch (err) {
    console.error("Groq Error:", err.response?.status, err.message)
    if (err.response?.status === 401) {
      res.write("⚠️ Invalid GROQ_API_KEY. Go to Railway → Variables and check your key.")
    } else if (err.response?.status === 429) {
      res.write("⚠️ Rate limit reached. Please wait a moment and try again.")
    } else {
      res.write("⚠️ AI error. Please try again in a moment.")
    }
    res.end()
  }
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`)
  console.log(`🔑 Groq: ${USE_GROQ ? "Connected ✅" : "NOT SET — add GROQ_API_KEY in Railway Variables ❌"}`)
})
