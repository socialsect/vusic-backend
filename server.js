const express = require("express")
const cors = require("cors")
const YoutubeSearchApi = require("youtube-search-api")
const { spawn, execSync } = require("child_process")

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
// DEBUG - check yt-dlp + ffmpeg versions
// Visit: /api/debug/PSJzUYbpHX0
// =========================
app.get("/api/debug/:id", (req, res) => {
  const id = req.params.id
  const url = `https://www.youtube.com/watch?v=${id}`

  let ytdlpVersion = "unknown"
  let ffmpegVersion = "unknown"

  try { ytdlpVersion = execSync("yt-dlp --version").toString().trim() } catch(e) { ytdlpVersion = "NOT FOUND: " + e.message }
  try { ffmpegVersion = execSync("ffmpeg -version").toString().split("\n")[0] } catch(e) { ffmpegVersion = "NOT FOUND: " + e.message }

  const yt = spawn("yt-dlp", ["-J", "--no-playlist", url])
  let stdout = ""
  let stderr = ""

  yt.stdout.on("data", d => stdout += d.toString())
  yt.stderr.on("data", d => stderr += d.toString())

  yt.on("close", code => {
    let audioFormats = []
    try {
      const info = JSON.parse(stdout)
      audioFormats = (info.formats || [])
        .filter(f => f.acodec && f.acodec !== "none")
        .map(f => ({
          format_id: f.format_id,
          ext: f.ext,
          acodec: f.acodec,
          vcodec: f.vcodec,
          abr: f.abr,
          audioOnly: f.vcodec === "none"
        }))
    } catch(e) {}

    res.json({ ytdlpVersion, ffmpegVersion, ytdlpExitCode: code, stderr: stderr.slice(0, 1000), audioFormats })
  })
})

// =========================
// SEARCH YOUTUBE
// =========================
app.get("/api/search", async (req, res) => {
  const q = req.query.q
  if (!q) return res.json({ items: [] })

  try {

    const query = `"${q}"`

    const data = await YoutubeSearchApi.GetListByKeyword(
      query,
      false,
      20,
      [{ type: "video" }]
    )

    const items = (data.items || []).map(v => ({
      id: v.id,
      videoId: v.id,
      title: v.title,
      channel: v.channelTitle || "Unknown",
      thumbnail: v.thumbnail?.thumbnails?.slice(-1)[0]?.url || "",
      duration: v.length?.simpleText || "",
      source: "YouTube"
    }))

    res.json({ items })

  } catch (err) {
    console.error("Search error:", err)
    res.status(500).json({ items: [], error: err.message })
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