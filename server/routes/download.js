import { Router } from 'express';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { MEDIA_DIR, YTDLP_PATH, FFMPEG_PATH } from '../config.js';

const execFileAsync = promisify(execFile);
const router = Router();

router.post('/', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const ytRegex = /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|shorts\/)|youtu\.be\/)/;
  if (!ytRegex.test(url)) {
    return res.status(400).json({ error: 'Please provide a valid YouTube URL' });
  }

  try {
    const { stdout: infoJson } = await execFileAsync(YTDLP_PATH, [
      '--dump-json', '--no-playlist', url,
    ], { maxBuffer: 10 * 1024 * 1024 });
    const info = JSON.parse(infoJson);
    const videoId = info.id;
    const filename = `${videoId}.mp4`;
    const filepath = path.join(MEDIA_DIR, filename);

    // Check if already downloaded
    if (fs.existsSync(filepath)) {
      console.log(`Video ${videoId} already downloaded, skipping...`);
      return res.json({
        videoId, filename,
        title: info.title,
        duration: info.duration,
        thumbnail: info.thumbnail,
      });
    }

    // Set up SSE for progress
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const sendEvent = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    sendEvent({ type: 'status', message: 'Starting download...' });

    const dl = spawn(YTDLP_PATH, [
      '-f', 'bestvideo[height<=1080][vcodec^=avc1]+bestaudio[ext=m4a]/bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080]',
      '--merge-output-format', 'mp4',
      '--no-playlist', '--newline', '--progress',
      '--ffmpeg-location', FFMPEG_PATH,
      '-o', filepath, url,
    ]);

    dl.stdout.on('data', (data) => {
      const line = data.toString().trim();
      const match = line.match(/(\d+\.?\d*)%/);
      if (match) sendEvent({ type: 'progress', percent: parseFloat(match[1]) });
    });

    dl.stderr.on('data', (data) => {
      console.error('yt-dlp stderr:', data.toString().trim());
    });

    dl.on('close', (code) => {
      if (code === 0) {
        sendEvent({
          type: 'complete', videoId, filename,
          title: info.title, duration: info.duration, thumbnail: info.thumbnail,
        });
      } else {
        sendEvent({ type: 'error', message: `Download failed with code ${code}` });
      }
      res.end();
    });

    dl.on('error', (err) => {
      sendEvent({ type: 'error', message: err.message });
      res.end();
    });
  } catch (err) {
    console.error('Download error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

export default router;
