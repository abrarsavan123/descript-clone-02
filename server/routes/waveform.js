import { Router } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { MEDIA_DIR, FFMPEG_PATH } from '../config.js';

const execFileAsync = promisify(execFile);
const router = Router();

router.post('/', async (req, res) => {
  const { videoId } = req.body;
  if (!videoId) return res.status(400).json({ error: 'videoId is required' });

  const videoPath = path.join(MEDIA_DIR, `${videoId}.mp4`);
  const cachePath = path.join(MEDIA_DIR, `${videoId}_waveform.json`);

  if (!fs.existsSync(videoPath)) {
    return res.status(404).json({ error: 'Video not found' });
  }

  // Return cached result
  if (fs.existsSync(cachePath)) {
    return res.json(JSON.parse(fs.readFileSync(cachePath, 'utf-8')));
  }

  try {
    console.log('Extracting waveform data...');

    const rawPath = path.join(MEDIA_DIR, `${videoId}_audio_raw.pcm`);

    await execFileAsync(FFMPEG_PATH, [
      '-i', videoPath,
      '-ac', '1', '-ar', '8000',
      '-f', 's16le', '-acodec', 'pcm_s16le',
      '-y', rawPath,
    ], { maxBuffer: 50 * 1024 * 1024 });

    const rawBuffer = fs.readFileSync(rawPath);
    const samples = new Int16Array(rawBuffer.buffer, rawBuffer.byteOffset, rawBuffer.length / 2);

    // Downsample to ~100 peaks per second
    const samplesPerPeak = 80;
    const peaks = [];
    for (let i = 0; i < samples.length; i += samplesPerPeak) {
      let max = 0;
      const end = Math.min(i + samplesPerPeak, samples.length);
      for (let j = i; j < end; j++) {
        const abs = Math.abs(samples[j]);
        if (abs > max) max = abs;
      }
      peaks.push(Math.round((max / 32768) * 1000) / 1000);
    }

    try { fs.unlinkSync(rawPath); } catch {}

    const duration = samples.length / 8000;
    const result = { peaks, duration, sampleRate: 100 };
    fs.writeFileSync(cachePath, JSON.stringify(result));
    console.log(`Waveform extracted: ${peaks.length} peaks over ${Math.round(duration)}s`);

    res.json(result);
  } catch (err) {
    console.error('Waveform extraction error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
