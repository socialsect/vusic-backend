const express = require("express")
const cors = require("cors")
const ytsr = require("ytsr")
const { spawn } = require("child_process")

const app = express()

app.use(cors())
app.use(express.json())

const PORT = process.env.PORT || 5000


// =========================
// SEARCH YOUTUBE
// =========================
app.get("/api/search", async (req, res) => {

  const q = req.query.q

  if (!q) {
    return res.json({ items: [] })
  }

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

  try {

    const yt = spawn("yt-dlp", [
      "-f",
      "bestaudio",
      "-o",
      "-",
      url
    ])

    // correct headers for streaming
    res.setHeader("Content-Type", "audio/webm")
    res.setHeader("Transfer-Encoding", "chunked")

    yt.stdout.pipe(res)

    yt.stderr.on("data", (data) => {
      console.log(data.toString())
    })

    yt.on("error", (err) => {
      console.error("yt-dlp error:", err)
      if (!res.headersSent) res.status(500).end()
    })

    yt.on("close", () => {
      res.end()
    })

  } catch (err) {

    console.error("Stream error:", err)
    res.status(500).send("Streaming failed")

  }

})


// =========================
// HEALTH CHECK
// =========================
app.get("/", (req, res) => {
  res.send("Vusic backend running")
})


// =========================
// START SERVER
// =========================
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})