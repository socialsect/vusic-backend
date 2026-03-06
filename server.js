const express = require("express")
const cors = require("cors")
const fs = require("fs")
const path = require("path")
const os = require("os")
const { v4: uuidv4 } = require("uuid")
const YoutubeSearchApi = require("youtube-search-api")
const { spawn, execSync } = require("child_process")

// =========================
// CACHE SETUP
// =========================
const CACHE_DIR = path.join(os.tmpdir(), "vusic_cache")
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true })

function getCachedFile(id) {
  const exts = ["m4a", "webm", "opus", "mp3", "ogg"]
  for (const ext of exts) {
    const f = path.join(CACHE_DIR, `${id}.${ext}`)
    if (fs.existsSync(f)) return f
  }
  return null
}

const inProgress = new Map()

async function downloadAndCache(id, quality = "medium") {
  const cached = getCachedFile(id)
  if (cached) return cached

  if (inProgress.has(id)) return inProgress.get(id)

  const formatMap = {
    high:   "251/140/bestaudio[acodec=opus]/bestaudio",
    medium: "140/139/bestaudio[ext=m4a]/bestaudio",
    low:    "139/140/worstaudio",
  }
  const format = formatMap[quality] || formatMap.medium
  const url = `https://www.youtube.com/watch?v=${id}`
  const tmpTemplate = path.join(CACHE_DIR, `${id}.%(ext)s`)

  const promise = new Promise((resolve, reject) => {
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
      inProgress.delete(id)
      if (code !== 0) return reject(new Error(`yt-dlp failed (code ${code}): ${stderrLog}`))
      const file = getCachedFile(id)
      if (!file) return reject(new Error("Downloaded file not found after yt-dlp"))
      resolve(file)
    })

    yt.on("error", err => {
      inProgress.delete(id)
      reject(err)
    })
  })

  inProgress.set(id, promise)
  return promise
}

function serveFile(filePath, req, res) {
  const stat = fs.statSync(filePath)
  const fileSize = stat.size
  const ext = path.extname(filePath).slice(1)
  const mimeMap = {
    m4a:  "audio/mp4",
    webm: "audio/webm; codecs=opus",
    opus: "audio/ogg; codecs=opus",
    mp3:  "audio/mpeg",
    ogg:  "audio/ogg",
  }
  const mimeType = mimeMap[ext] || "audio/mp4"
  const range = req.headers.range

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-")
    const start = parseInt(parts[0], 10)
    const end = parts[1] && parts[1] !== "" ? parseInt(parts[1], 10) : fileSize - 1
    const chunkSize = end - start + 1
    res.writeHead(206, {
      "Content-Range":  `bytes ${start}-${end}/${fileSize}`,
      "Accept-Ranges":  "bytes",
      "Content-Length": chunkSize,
      "Content-Type":   mimeType,
    })
    const stream = fs.createReadStream(filePath, { start, end })
    stream.pipe(res)
    stream.on("error", () => res.end())
  } else {
    res.writeHead(200, {
      "Content-Length": fileSize,
      "Content-Type":   mimeType,
      "Accept-Ranges":  "bytes",
    })
    const stream = fs.createReadStream(filePath)
    stream.pipe(res)
    stream.on("error", () => res.end())
  }
}

function cleanupCache() {
  try {
    const files = fs.readdirSync(CACHE_DIR).map(f => {
      const full = path.join(CACHE_DIR, f)
      return { path: full, size: fs.statSync(full).size, mtime: fs.statSync(full).mtimeMs }
    })
    const totalBytes = files.reduce((sum, f) => sum + f.size, 0)
    const limitBytes = 500 * 1024 * 1024

    if (totalBytes > limitBytes) {
      files.sort((a, b) => a.mtime - b.mtime)
      let freed = 0
      const toFree = totalBytes - limitBytes
      for (const file of files) {
        fs.unlinkSync(file.path)
        freed += file.size
        console.log(`[cache] deleted ${file.path} (${(file.size/1024/1024).toFixed(1)}MB)`)
        if (freed >= toFree) break
      }
    }
  } catch (err) {
    console.error("[cache] cleanup error:", err.message)
  }
}

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
// STREAM AUDIO — cache-first + range support (iOS compatible)
// =========================
app.get("/api/stream/:id", async (req, res) => {
  const id = req.params.id
  const quality = req.query.quality || "medium"

  try {
    const cached = getCachedFile(id)
    if (cached) {
      console.log(`[cache] HIT ${id}`)
      return serveFile(cached, req, res)
    }

    console.log(`[cache] MISS ${id} — downloading...`)
    const filePath = await downloadAndCache(id, quality)
    cleanupCache()
    serveFile(filePath, req, res)

  } catch (err) {
    console.error("Stream error:", err.message)
    if (!res.headersSent) res.status(500).json({ error: err.message })
  }
})

// =========================
// PREFETCH — respond immediately, download in background
// =========================
app.get("/api/prefetch/:id", async (req, res) => {
  const id = req.params.id
  const quality = req.query.quality || "medium"

  res.json({ status: "queued", id })

  const cached = getCachedFile(id)
  if (cached) {
    console.log(`[prefetch] already cached: ${id}`)
    return
  }

  console.log(`[prefetch] background download: ${id}`)
  downloadAndCache(id, quality)
    .then(() => console.log(`[prefetch] done: ${id}`))
    .catch(err => console.error(`[prefetch] failed ${id}:`, err.message))
})

// =========================
// CACHE STATS
// =========================
app.get("/api/cache/stats", (req, res) => {
  try {
    const files = fs.readdirSync(CACHE_DIR)
    const details = files.map(f => {
      const full = path.join(CACHE_DIR, f)
      const stat = fs.statSync(full)
      return { id: f, sizeMB: (stat.size / 1024 / 1024).toFixed(2), mtime: stat.mtimeMs }
    })
    const totalMB = details.reduce((sum, f) => sum + parseFloat(f.sizeMB), 0)
    res.json({
      files: files.length,
      totalSizeMB: totalMB.toFixed(2),
      limitMB: 500,
      cachedIds: details
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
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
