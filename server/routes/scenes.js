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
  const cachePath = path.join(MEDIA_DIR, `${videoId}_scenes.json`);

  if (!fs.existsSync(videoPath)) {
    return res.status(404).json({ error: 'Video not found' });
  }

  // Return cached result
  if (fs.existsSync(cachePath)) {
    return res.json(JSON.parse(fs.readFileSync(cachePath, 'utf-8')));
  }

  try {
    let cuts = [0];
    let method = 'ffmpeg';

    console.log('Detecting scene cuts with ffmpeg...');

    try {
      const { stderr } = await execFileAsync(FFMPEG_PATH, [
        '-i', videoPath,
        '-filter:v', "select='gt(scene,0.3)',showinfo",
        '-f', 'null', '-',
      ], { maxBuffer: 50 * 1024 * 1024, timeout: 120000 }).catch(e => ({ stderr: e.stderr || '' }));

      const regex = /pts_time:([\d.]+)/g;
      let match;
      while ((match = regex.exec(stderr)) !== null) {
        const time = parseFloat(match[1]);
        if (time - cuts[cuts.length - 1] > 1) {
          cuts.push(Math.round(time * 100) / 100);
        }
      }
      console.log(`  ffmpeg found ${cuts.length - 1} scene cuts`);
    } catch (e) {
      console.warn('  ffmpeg scene detection failed:', e.message?.substring(0, 200));
    }

    const result = { cuts, count: cuts.length, method };
    fs.writeFileSync(cachePath, JSON.stringify(result, null, 2));
    console.log(`Scene detection complete (${method}): ${cuts.length} cuts found`);

    res.json(result);
  } catch (err) {
    console.error('Scene detection error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
