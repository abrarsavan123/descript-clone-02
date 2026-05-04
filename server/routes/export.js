import { Router } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { MEDIA_DIR, FFMPEG_PATH } from '../config.js';

const execFileAsync = promisify(execFile);
const router = Router();

router.post('/', async (req, res) => {
  const { videoId, cuts } = req.body;
  if (!videoId) return res.status(400).json({ error: 'videoId is required' });

  const videoPath = path.join(MEDIA_DIR, `${videoId}.mp4`);
  const outputPath = path.join(MEDIA_DIR, `${videoId}_edited.mp4`);

  if (!fs.existsSync(videoPath)) {
    return res.status(404).json({ error: 'Video not found' });
  }

  if (!cuts || cuts.length === 0) {
    return res.json({ filename: `${videoId}.mp4` });
  }

  try {
    // Get video duration
    const { stdout: probeOut } = await execFileAsync(FFMPEG_PATH, [
      '-i', videoPath, '-f', 'null', '-',
    ]).catch((e) => ({ stdout: e.stderr || '' }));

    const durationMatch = (probeOut || '').match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
    let totalDuration = 0;
    if (durationMatch) {
      totalDuration =
        parseInt(durationMatch[1]) * 3600 +
        parseInt(durationMatch[2]) * 60 +
        parseInt(durationMatch[3]) +
        parseInt(durationMatch[4]) / 100;
    }

    // Sort and merge cuts
    const sortedCuts = [...cuts].sort((a, b) => a.start - b.start);
    const mergedCuts = [];
    for (const cut of sortedCuts) {
      if (mergedCuts.length > 0 && cut.start <= mergedCuts[mergedCuts.length - 1].end) {
        mergedCuts[mergedCuts.length - 1].end = Math.max(mergedCuts[mergedCuts.length - 1].end, cut.end);
      } else {
        mergedCuts.push({ ...cut });
      }
    }

    // Build keep segments
    const keepSegments = [];
    let cursor = 0;
    for (const cut of mergedCuts) {
      if (cursor < cut.start) keepSegments.push({ start: cursor, end: cut.start });
      cursor = cut.end;
    }
    if (cursor < totalDuration) keepSegments.push({ start: cursor, end: totalDuration });

    if (keepSegments.length === 0) return res.status(400).json({ error: 'Nothing left after cuts!' });

    // Build ffmpeg filter
    let filterComplex = '';
    keepSegments.forEach((seg, i) => {
      filterComplex += `[0:v]trim=start=${seg.start}:end=${seg.end},setpts=PTS-STARTPTS[v${i}];`;
      filterComplex += `[0:a]atrim=start=${seg.start}:end=${seg.end},asetpts=PTS-STARTPTS[a${i}];`;
    });
    const vStreams = keepSegments.map((_, i) => `[v${i}]`).join('');
    const aStreams = keepSegments.map((_, i) => `[a${i}]`).join('');
    filterComplex += `${vStreams}${aStreams}concat=n=${keepSegments.length}:v=1:a=1[outv][outa]`;

    console.log('Exporting with', keepSegments.length, 'segments...');

    await execFileAsync(FFMPEG_PATH, [
      '-i', videoPath,
      '-filter_complex', filterComplex,
      '-map', '[outv]', '-map', '[outa]',
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
      '-c:a', 'aac', '-b:a', '128k',
      '-y', outputPath,
    ], { maxBuffer: 50 * 1024 * 1024 });

    console.log('Export complete!');
    res.json({ filename: `${videoId}_edited.mp4` });
  } catch (err) {
    console.error('Export error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
