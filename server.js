const express = require("express")
const fs = require("fs")
const path = require("path")
const bodyParser = require("body-parser")
const session = require("express-session")
const axios = require("axios")

const app = express()

app.use(bodyParser.urlencoded({ extended: true }))
app.use(express.json())

app.use(session({
  secret: "astryx-secret",
  resave: false,
  saveUninitialized: false
}))

/*
  FOLDER STRUCTURE:
  /public     → static assets only (logo.png, founder.jpg)
  /views      → HTML files (NOT served as static, only through routes below)
  users.json  → user data
*/

/* STATIC ASSETS ONLY — put logo.png and founder.jpg inside /public folder */
app.use(express.static(path.join(__dirname, "public")))

const USERS_FILE = path.join(__dirname, "users.json")

/* ─── PAGE ROUTES ─────────────────────────────────────── */

/* LANDING */
app.get("/", (req, res) => {
  if (req.session.user) return res.redirect("/chat")
  res.sendFile(path.join(__dirname, "views", "landing.html"))
})

/* LOGIN PAGE */
app.get("/login", (req, res) => {
  if (req.session.user) return res.redirect("/chat")
  res.sendFile(path.join(__dirname, "views", "login.html"))
})

/* SIGNUP PAGE */
app.get("/signup", (req, res) => {
  if (req.session.user) return res.redirect("/chat")
  res.sendFile(path.join(__dirname, "views", "signup.html"))
})

/* CHAT PAGE — protected */
app.get("/chat", (req, res) => {
  if (!req.session.user) return res.redirect("/")
  res.sendFile(path.join(__dirname, "views", "index.html"))
})

/* ─── AUTH ROUTES ─────────────────────────────────────── */

/* SIGNUP POST */
app.post("/signup", (req, res) => {
  const { name, email, password } = req.body
  let users = JSON.parse(fs.readFileSync(USERS_FILE))
  const existing = users.find(u => u.email === email)
  if (existing) return res.redirect("/signup?error=userexists")
  users.push({ name, email, password })
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2))
  res.redirect("/login")
})

/* LOGIN POST */
app.post("/login", (req, res) => {
  const { email, password } = req.body
  let users = JSON.parse(fs.readFileSync(USERS_FILE))
  const user = users.find(u => u.email === email && u.password === password)
  if (!user) return res.redirect("/login?error=invalid")
  req.session.user = user
  res.redirect("/chat")
})

/* LOGOUT */
app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/")
  })
})

/* ─── AI API ──────────────────────────────────────────── */

app.post("/ask", async (req, res) => {
  if (!req.session.user) return res.status(401).json({ reply: "Not authenticated." })
  const question = req.body.question
  try {
    const response = await axios.post(
      "http://127.0.0.1:11434/api/generate",
      { model: "llama3", prompt: question, stream: false }
    )
    res.json({ reply: response.data.response })
  } catch (err) {
    console.log(err.message)
    res.json({ reply: "AI engine not running or connection failed." })
  }
})

/* ─── 404 — block any direct .html access attempts ───── */
app.use((req, res) => {
  res.redirect("/")
})

app.listen(3000, () => {
  console.log("Server running on http://localhost:3000")
})