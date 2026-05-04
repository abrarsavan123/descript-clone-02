import { Router } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { MEDIA_DIR, YTDLP_PATH } from '../config.js';
import { parseSrv3, parseJson3, parseVTT, countSpeechWords, filterNoiseWords } from '../utils/parsers.js';

const execFileAsync = promisify(execFile);
const router = Router();

router.post('/', async (req, res) => {
  const { videoId, url } = req.body;
  if (!videoId) return res.status(400).json({ error: 'videoId is required' });

  const transcriptPath = path.join(MEDIA_DIR, `${videoId}_transcript.json`);

  // Return cached transcript if exists
  if (fs.existsSync(transcriptPath)) {
    const cached = JSON.parse(fs.readFileSync(transcriptPath, 'utf-8'));
    return res.json(cached);
  }

  try {
    const subPath = path.join(MEDIA_DIR, videoId);
    const videoUrl = url || `https://www.youtube.com/watch?v=${videoId}`;

    console.log('Downloading YouTube captions (manual + auto-generated)...');

    // Download auto-generated subs (srv3 for word-level timing)
    let autoResult = null;
    try {
      await execFileAsync(YTDLP_PATH, [
        '--write-auto-sub', '--sub-lang', 'en', '--sub-format', 'srv3',
        '--skip-download', '--no-playlist', '-o', subPath + '_auto', videoUrl,
      ], { maxBuffer: 10 * 1024 * 1024 });

      const files = fs.readdirSync(MEDIA_DIR);
      const autoFile = files.find(f => f.startsWith(videoId + '_auto') && f.endsWith('.srv3'));
      if (autoFile) {
        const srv3Content = fs.readFileSync(path.join(MEDIA_DIR, autoFile), 'utf-8');
        autoResult = parseSrv3(srv3Content);
        console.log(`  Auto-generated: ${autoResult.words.length} total, ${countSpeechWords(autoResult.words)} speech words`);
      }
    } catch (e) {
      console.log('  Auto-generated subs not available:', e.message?.substring(0, 100));
    }

    // Download manual subs
    let manualResult = null;
    try {
      await execFileAsync(YTDLP_PATH, [
        '--write-sub', '--no-write-auto-sub', '--sub-lang', 'en',
        '--sub-format', 'srv3/vtt/srt', '--skip-download', '--no-playlist',
        '-o', subPath + '_manual', videoUrl,
      ], { maxBuffer: 10 * 1024 * 1024 });

      const files = fs.readdirSync(MEDIA_DIR);
      const manualSrv3 = files.find(f => f.startsWith(videoId + '_manual') && f.endsWith('.srv3'));
      const manualVtt = files.find(f => f.startsWith(videoId + '_manual') && (f.endsWith('.vtt') || f.endsWith('.srt')));

      if (manualSrv3) {
        const srv3Content = fs.readFileSync(path.join(MEDIA_DIR, manualSrv3), 'utf-8');
        manualResult = parseSrv3(srv3Content);
        console.log(`  Manual (srv3): ${manualResult.words.length} total, ${countSpeechWords(manualResult.words)} speech words`);
      } else if (manualVtt) {
        const vttContent = fs.readFileSync(path.join(MEDIA_DIR, manualVtt), 'utf-8');
        manualResult = parseVTT(vttContent);
        console.log(`  Manual (vtt): ${manualResult.words.length} total, ${countSpeechWords(manualResult.words)} speech words`);
      }
    } catch (e) {
      console.log('  Manual subs not available:', e.message?.substring(0, 100));
    }

    // Pick the best transcript
    let result = null;
    const autoSpeech = autoResult ? countSpeechWords(autoResult.words) : 0;
    const manualSpeech = manualResult ? countSpeechWords(manualResult.words) : 0;

    if (autoSpeech >= manualSpeech && autoResult) {
      console.log(`  → Using auto-generated captions (${autoSpeech} speech words vs ${manualSpeech} manual)`);
      result = autoResult;
    } else if (manualResult) {
      console.log(`  → Using manual captions (${manualSpeech} speech words vs ${autoSpeech} auto)`);
      result = manualResult;
    }

    // Fallback: try json3
    if (!result || countSpeechWords(result.words) === 0) {
      console.log('  Trying json3 fallback...');
      try {
        await execFileAsync(YTDLP_PATH, [
          '--write-auto-sub', '--write-sub', '--sub-lang', 'en',
          '--sub-format', 'json3', '--skip-download', '--no-playlist',
          '-o', subPath, videoUrl,
        ], { maxBuffer: 10 * 1024 * 1024 });

        const files = fs.readdirSync(MEDIA_DIR);
        const json3File = files.find(f => f.startsWith(videoId) && f.endsWith('.json3'));
        if (json3File) {
          const json3Data = JSON.parse(fs.readFileSync(path.join(MEDIA_DIR, json3File), 'utf-8'));
          result = parseJson3(json3Data);
          console.log(`  json3 fallback: ${result.words.length} words`);
        }
      } catch (e) {
        console.log('  json3 fallback failed:', e.message?.substring(0, 100));
      }
    }

    if (!result || result.words.length === 0) {
      return res.status(404).json({ error: 'No captions available for this video.' });
    }

    // Filter noise markers
    result = filterNoiseWords(result);

    fs.writeFileSync(transcriptPath, JSON.stringify(result, null, 2));
    console.log(`Transcription complete: ${result.words.length} words`);

    // Clean up temp subtitle files
    try {
      const files = fs.readdirSync(MEDIA_DIR);
      for (const f of files) {
        if (f.startsWith(videoId) && (f.endsWith('.srv3') || f.endsWith('.vtt') || f.endsWith('.srt') || f.endsWith('.json3'))) {
          fs.unlinkSync(path.join(MEDIA_DIR, f));
        }
      }
    } catch {}

    return res.json(result);
  } catch (err) {
    console.error('Transcription error:', err);
    res.status(500).json({ error: 'Failed to get captions: ' + err.message });
  }
});

export default router;
