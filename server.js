const express = require("express")
const cors = require("cors")
const ytsr = require("ytsr")
const { spawn } = require("child_process")

const app = express()
app.use(cors())

const PORT = process.env.PORT || 5000

// SEARCH
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
    console.error(err)
    res.status(500).json({ items: [] })
  }
})


// STREAM AUDIO
app.get("/api/stream/:id", (req, res) => {

  const id = req.params.id
  const url = `https://www.youtube.com/watch?v=${id}`

  const yt = spawn("yt-dlp", [
    "-f",
    "bestaudio",
    "-o",
    "-",
    url
  ])

  res.setHeader("Content-Type", "audio/mpeg")

  yt.stdout.pipe(res)

  yt.stderr.on("data", data => {
    console.error(data.toString())
  })

  yt.on("close", code => {
    if (code !== 0) {
      res.end()
    }
  })
})

app.listen(PORT, () => {
  console.log("Backend running on port", PORT)
})