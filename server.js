const express = require("express");
const path = require("path");
const axios = require("axios");
const { exec } = require("child_process");
const fs = require("fs");
const archiver = require("archiver");
require("dotenv").config();

const app = express();
const PORT = 3000;

let accessToken = "";

// Serve UI
app.use(express.static(path.join(__dirname, "public")));

// Get Spotify access token
async function getSpotifyAccessToken() {
    const res = await axios.post(
        "https://accounts.spotify.com/api/token",
        new URLSearchParams({ grant_type: "client_credentials" }),
        {
            headers: {
                Authorization:
                    "Basic " +
                    Buffer.from(
                        `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
                    ).toString("base64"),
                "Content-Type": "application/x-www-form-urlencoded",
            },
        }
    );
    accessToken = res.data.access_token;
}

// Fetch playlist info
app.get("/playlist/:id", async (req, res) => {
    try {
        if (!accessToken) await getSpotifyAccessToken();
        const { id } = req.params;
        const response = await axios.get(
            `https://api.spotify.com/v1/playlists/${id}`,
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                },
            }
        );

        const tracks = response.data.tracks.items.map((item) => ({
            title: item.track.name,
            artist: item.track.artists.map((a) => a.name).join(", "),
        }));

        res.json(tracks);
    } catch (err) {
        console.error(err.message);
        res.status(500).send("Something went wrong");
    }
});

// Download a single song
function searchAndDownload(title, artist, res) {
    return new Promise((resolve) => {
        const query = `${title} ${artist}`;
        const searchCmd = `yt-dlp "ytsearch1:${query}" --get-id --no-warnings --force-ipv4`;

        exec(searchCmd, (err, stdout) => {
            if (err || !stdout.trim()) {
                console.error(`❌ No video found for ${query}`);
                res.write(`❌ No video found for ${query}\n`);
                return resolve(null);
            }

            const videoId = stdout.trim();
            const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
            const safeTitle = `${title}-${artist}`.replace(/[^\w\s-]/gi, "").replace(/\s+/g, "_");

            const outputPath = `downloads/${safeTitle}.mp3`;
            const downloadCmd = `yt-dlp -x --audio-format mp3 -o "${outputPath}" "${videoUrl}"`;

            console.log(`⬇️ Downloading: ${title}`);

            exec(downloadCmd, (err) => {
                if (err) {
                    console.error(`❌ Failed: ${title}`);
                    res.write(`❌ Failed: ${title}\n`);
                    resolve(null);
                } else {
                    console.log(`✅ Done: ${title}`);
                    res.write(`✅ Done: ${title}\n`);
                    resolve(outputPath);
                }
            });
        });
    });
}

// SSE stream endpoint for downloading progress
app.get("/playlist/:id/download/stream", async (req, res) => {
    try {
        if (!accessToken) await getSpotifyAccessToken();
        const { id } = req.params;

        // Fetch the playlist
        const response = await axios.get(
            `https://api.spotify.com/v1/playlists/${id}`,
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                },
            }
        );

        const tracks = response.data.tracks.items.map((item) => ({
            title: item.track.name,
            artist: item.track.artists.map((a) => a.name).join(", "),
        }));

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        let totalFiles = tracks.length;
        let currentFile = 0;

        for (const track of tracks) {
            const filePath = await searchAndDownload(track.title, track.artist, res);

            if (filePath) {
                currentFile++;
                // Send download progress as JSON
                res.write(`data: ${JSON.stringify({
                    status: "DOWNLOADING",
                    current: currentFile,
                    total: totalFiles
                })}\n\n`);
            } else {
                // Send error message
                res.write(`data: ${JSON.stringify({ status: "ERROR" })}\n\n`);
            }
        }

        res.write("data: {\"status\": \"DONE\"}\n\n");
        res.end();
    } catch (err) {
        console.error(err.message);
        res.status(500).send("Something went wrong");
    }
});

// Download ZIP endpoint (you can still keep this)
app.get("/playlist/:id/zip", async (req, res) => {
    const zipPath = path.join(__dirname, "downloads", "playlist.zip");

    const output = fs.createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", () => {
        // Send ZIP file to user
        res.download(zipPath, "playlist.zip", (err) => {
            if (err) {
                console.error("❌ Error sending ZIP:", err);
                return;
            }

            // 🧹 Cleanup .mp3 and .zip files after download
            const dir = path.join(__dirname, "downloads");
            fs.readdirSync(dir).forEach(file => {
                if (file.endsWith(".mp3") || file === "playlist.zip") {
                    fs.unlink(path.join(dir, file), err => {
                        if (err) console.error("❌ Cleanup error:", err);
                    });
                }
            });
        });
    });

    archive.on("error", (err) => {
        console.error("Archive error:", err);
        res.status(500).send("Error creating ZIP");
    });

    archive.pipe(output);

    const files = fs.readdirSync(path.join(__dirname, "downloads"))
        .filter(file => file.endsWith(".mp3"));

    for (const file of files) {
        archive.file(path.join(__dirname, "downloads", file), { name: file });
    }

    archive.finalize();
});

app.listen(PORT, () => {
    console.log(`🎧 Server running at http://localhost:${PORT}`);
});