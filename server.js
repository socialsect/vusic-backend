const express = require("express")
const cors = require("cors")
const ytsr = require("ytsr")
const { spawn } = require("child_process")

const app = express()
app.use(cors())
app.use(express.json())

const PORT = process.env.PORT || 5000

// =========================
// HEALTH CHECK
// =========================
app.get("/", (req, res) => {
  res.send("Vusic backend running")
})

// =========================
// SEARCH YOUTUBE
// =========================
app.get("/api/search", async (req, res) => {
  const q = req.query.q
  if (!q) return res.json({ items: [] })

  try {
    const results = await ytsr(q, { limit: 20 })
    const items = results.items
      .filter(i => i.type === "video")
      .map(v => ({
        id: v.id,
        videoId: v.id,
        title: v.title,
        channel: v.author?.name || "Unknown",
        thumbnail: v.bestThumbnail?.url,
        duration: v.duration,
        source: "YouTube"
      }))
    res.json({ items })
  } catch (err) {
    console.error("Search error:", err)
    res.status(500).json({ items: [] })
  }
})

// =========================
// STREAM AUDIO
// =========================
app.get("/api/stream/:id", (req, res) => {
  const id = req.params.id
  const url = `https://www.youtube.com/watch?v=${id}`

  const yt = spawn("yt-dlp", [
    "-f", "bestaudio[acodec=opus]/bestaudio[acodec=vorbis]/bestaudio",
    "--extract-audio",
    "--audio-format", "mp3",
    "--audio-quality", "5",
    "--no-playlist",
    "-o", "-",
    "--quiet",
    url
  ])

  res.setHeader("Content-Type", "audio/mpeg")
  res.setHeader("Transfer-Encoding", "chunked")
  res.setHeader("Cache-Control", "no-cache")

  yt.stdout.pipe(res)

  yt.stderr.on("data", d => console.error("[yt-dlp]", d.toString()))

  yt.on("error", err => {
    console.error("spawn error:", err)
    if (!res.headersSent) res.status(500).end()
  })

  yt.on("close", code => {
    console.log("yt-dlp exited with code:", code)
    res.end()
  })

  req.on("close", () => yt.kill("SIGKILL"))
})

// =========================
// START SERVER
// =========================
app.listen(PORT, () => {
  console.log(`Vusic server running on port ${PORT}`)
})