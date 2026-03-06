const express = require("express")
const cors = require("cors")
const fs = require("fs")
const path = require("path")
const os = require("os")
const { v4: uuidv4 } = require("uuid")
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

    // force exact phrase to stop YouTube auto-correction
    const query = `"${q}" music`

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
    res.status(500).json({ items: [] })
  }
})

// =========================
// Extend timeout for stream route (Railway 30s default)
// =========================
app.use("/api/stream", (req, res, next) => {
  req.setTimeout(300000)
  res.setTimeout(300000)
  next()
})

// =========================
// STREAM AUDIO — temp file + range support (iOS compatible)
// quality: low (9), medium (5), high (0)
// =========================
// Replace ONLY the /api/stream/:id route in server.js with this:

app.get("/api/stream/:id", async (req, res) => {
  const id = req.params.id
  const quality = req.query.quality || "medium"
  const url = `https://www.youtube.com/watch?v=${id}`

  // Format selection based on quality:
  // high   → 251 (opus webm ~144kbps) or 140 (m4a ~128kbps)
  // medium → 140 (m4a ~128kbps) — best iOS compatible format
  // low    → 139 (m4a ~48kbps)
  const formatMap = {
    high:   "251/140/bestaudio[acodec=opus]/bestaudio",
    medium: "140/139/bestaudio[ext=m4a]/bestaudio",
    low:    "139/140/worstaudio",
  }
  const format = formatMap[quality] || formatMap.medium

  const tmpBase = path.join(os.tmpdir(), `vusic_${id}_${uuidv4()}`)
  // Let yt-dlp pick the extension by using %(ext)s
  const tmpTemplate = `${tmpBase}.%(ext)s`

  try {
    // Step 1: download to temp file (no conversion = much faster)
    const actualFile = await new Promise((resolve, reject) => {
      const yt = spawn("yt-dlp", [
        "-f", format,
        "--no-playlist",
        "--no-part",
        "--no-warnings",
        "-o", tmpTemplate,
        "--quiet",
        url
      ])

      let stderrLog = ""
      yt.stderr.on("data", d => {
        stderrLog += d.toString()
        console.error("[yt-dlp]", d.toString())
      })

      yt.on("close", code => {
        if (code !== 0) {
          return reject(new Error(`yt-dlp failed (code ${code}): ${stderrLog}`))
        }
        // Find the actual downloaded file (could be .m4a or .webm)
        const exts = ["m4a", "webm", "opus", "mp3", "ogg"]
        for (const ext of exts) {
          const candidate = `${tmpBase}.${ext}`
          if (fs.existsSync(candidate)) return resolve(candidate)
        }
        reject(new Error("Downloaded file not found"))
      })

      yt.on("error", reject)
    })

    // Step 2: verify file
    const stat = fs.statSync(actualFile)
    if (stat.size === 0) throw new Error("Downloaded file is empty")

    // Step 3: determine correct MIME type
    const ext = path.extname(actualFile).slice(1)
    const mimeMap = {
      m4a:  "audio/mp4",
      webm: "audio/webm; codecs=opus",
      opus: "audio/ogg; codecs=opus",
      mp3:  "audio/mpeg",
      ogg:  "audio/ogg",
    }
    const mimeType = mimeMap[ext] || "audio/mp4"

    // Step 4: serve with range support
    const fileSize = stat.size
    const range = req.headers.range

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-")
      const start = parseInt(parts[0], 10)
      const end = parts[1] && parts[1] !== ""
        ? parseInt(parts[1], 10)
        : fileSize - 1
      const chunkSize = end - start + 1

      res.writeHead(206, {
        "Content-Range":  `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges":  "bytes",
        "Content-Length": chunkSize,
        "Content-Type":   mimeType,
      })
      const stream = fs.createReadStream(actualFile, { start, end })
      stream.pipe(res)
      stream.on("error", () => res.end())
    } else {
      res.writeHead(200, {
        "Content-Length": fileSize,
        "Content-Type":   mimeType,
        "Accept-Ranges":  "bytes",
      })
      const stream = fs.createReadStream(actualFile)
      stream.pipe(res)
      stream.on("error", () => res.end())
    }

    // Step 5: cleanup
    const cleanup = () => fs.unlink(actualFile, () => {})
    res.on("finish", cleanup)
    res.on("close", cleanup)

  } catch (err) {
    console.error("Stream error:", err.message)
    if (!res.headersSent) res.status(500).json({ error: err.message })
  }
})

// =========================
// START SERVER
// =========================
const server = app.listen(PORT, () => {
  console.log(`Vusic server running on port ${PORT}`)
})
server.timeout = 300000
server.keepAliveTimeout = 300000
