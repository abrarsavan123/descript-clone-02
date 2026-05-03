import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { execFile, spawn, execSync } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3001;
const MEDIA_DIR = path.join(__dirname, 'media');

// Binary paths (resolved at startup)
let FFMPEG_PATH = 'ffmpeg';
let YTDLP_PATH = 'yt-dlp';

// Ensure media directory exists
if (!fs.existsSync(MEDIA_DIR)) {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
}

app.use(cors());
app.use(express.json());

// Serve downloaded media files
app.use('/api/media', express.static(MEDIA_DIR));

// ─── Startup Checks ───────────────────────────────────────────────

function findBinary(name) {
  try {
    const result = execSync(`where ${name}`, { encoding: 'utf-8' }).trim();
    return result.split(/\r?\n/)[0].trim();
  } catch {
    return null;
  }
}

async function checkDependencies() {
  const ffmpegFound = findBinary('ffmpeg');
  const ytdlpFound = findBinary('yt-dlp');

  if (ffmpegFound) {
    FFMPEG_PATH = ffmpegFound;
    console.log(`  ✓ ffmpeg found: ${FFMPEG_PATH}`);
  } else {
    console.error('  ✗ ffmpeg NOT FOUND — please install it and add to PATH');
    process.exit(1);
  }

  if (ytdlpFound) {
    YTDLP_PATH = ytdlpFound;
    console.log(`  ✓ yt-dlp found: ${YTDLP_PATH}`);
  } else {
    console.error('  ✗ yt-dlp NOT FOUND — please install it and add to PATH');
    process.exit(1);
  }
}

// ─── POST /api/download ───────────────────────────────────────────

app.post('/api/download', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const ytRegex = /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|shorts\/)|youtu\.be\/)/;
  if (!ytRegex.test(url)) {
    return res.status(400).json({ error: 'Please provide a valid YouTube URL' });
  }

  try {
    // Get video info first
    const { stdout: infoJson } = await execFileAsync(YTDLP_PATH, [
      '--dump-json',
      '--no-playlist',
      url,
    ], { maxBuffer: 10 * 1024 * 1024 });
    const info = JSON.parse(infoJson);
    const videoId = info.id;
    const filename = `${videoId}.mp4`;
    const filepath = path.join(MEDIA_DIR, filename);

    // Check if already downloaded
    if (fs.existsSync(filepath)) {
      console.log(`Video ${videoId} already downloaded, skipping...`);
      return res.json({
        videoId,
        filename,
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

    const sendEvent = (data) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    sendEvent({ type: 'status', message: 'Starting download...' });

    // Download directly to target path (yt-dlp uses .part files for partial downloads)
    const dl = spawn(YTDLP_PATH, [
      '-f', 'bestvideo[height<=1080][vcodec^=avc1]+bestaudio[ext=m4a]/bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080]',
      '--merge-output-format', 'mp4',
      '--no-playlist',
      '--newline',
      '--progress',
      '--ffmpeg-location', FFMPEG_PATH,
      '-o', filepath,
      url,
    ]);

    dl.stdout.on('data', (data) => {
      const line = data.toString().trim();
      const match = line.match(/(\d+\.?\d*)%/);
      if (match) {
        sendEvent({ type: 'progress', percent: parseFloat(match[1]) });
      }
    });

    dl.stderr.on('data', (data) => {
      console.error('yt-dlp stderr:', data.toString().trim());
    });

    dl.on('close', (code) => {
      if (code === 0) {
        sendEvent({
          type: 'complete',
          videoId,
          filename,
          title: info.title,
          duration: info.duration,
          thumbnail: info.thumbnail,
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
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

// ─── POST /api/transcribe ─────────────────────────────────────────
// Downloads BOTH manual and auto-generated YouTube captions, picks the best one.
// Manual subs = creator-uploaded (accurate text, no word-level timing)
// Auto subs   = YouTube AI (word-level timing via <s> tags, but can be noisy)

// Noise patterns to filter from transcripts (case-insensitive)
const NOISE_PATTERNS = /^\[.*\]$|^>>$|^♪+$|^-+$/;
function isNoise(text) { return NOISE_PATTERNS.test(text.trim()); }
function countSpeechWords(words) { return words.filter(w => !isNoise(w.text)).length; }

app.post('/api/transcribe', async (req, res) => {
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

    // ── Step 1: Download BOTH manual + auto-generated subs ──
    // Manual subs (--write-sub) = what YouTube shows in its transcript panel
    // Auto subs (--write-auto-sub) = YouTube's AI captions with word-level timing
    console.log('Downloading YouTube captions (manual + auto-generated)...');

    // Download auto-generated subs (srv3 for word-level timing)
    let autoResult = null;
    try {
      await execFileAsync(YTDLP_PATH, [
        '--write-auto-sub',
        '--sub-lang', 'en',
        '--sub-format', 'srv3',
        '--skip-download',
        '--no-playlist',
        '-o', subPath + '_auto',
        videoUrl,
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

    // Download manual subs (srv3 or vtt)
    let manualResult = null;
    try {
      await execFileAsync(YTDLP_PATH, [
        '--write-sub',
        '--no-write-auto-sub',
        '--sub-lang', 'en',
        '--sub-format', 'srv3/vtt/srt',
        '--skip-download',
        '--no-playlist',
        '-o', subPath + '_manual',
        videoUrl,
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

    // ── Step 2: Pick the best transcript ──
    // Prefer whichever has more actual speech words (not [music], etc.)
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

    // Fallback: try json3 if neither worked well
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

    // ── Step 3: Filter noise markers from the result ──
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

// Filter out noise-only words like [music], [applause], >>, etc.
function filterNoiseWords(result) {
  const filteredWords = result.words.filter(w => !isNoise(w.text));
  if (filteredWords.length === 0) return result; // Don't filter if it would remove everything
  const filteredText = filteredWords.map(w => w.text).join(' ');
  // Rebuild segments from filtered words
  const segments = [];
  let segWords = [];
  for (let i = 0; i < filteredWords.length; i++) {
    segWords.push(filteredWords[i]);
    const gap = i < filteredWords.length - 1 ? filteredWords[i + 1].start - filteredWords[i].end : 999;
    if (gap > 2 || i === filteredWords.length - 1) {
      segments.push({
        text: segWords.map(w => w.text).join(' '),
        start: segWords[0].start,
        end: segWords[segWords.length - 1].end,
      });
      segWords = [];
    }
  }
  return { text: filteredText, words: filteredWords, segments, duration: result.duration };
}

// ─── POST /api/scene-cuts ─────────────────────────────────────────
// Detect visual scene changes using PySceneDetect (ContentDetector) for
// pinpoint accuracy. Falls back to ffmpeg if PySceneDetect is not installed.

app.post('/api/scene-cuts', async (req, res) => {
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
    let cuts = [0]; // Always start with time 0
    let method = 'unknown';

    // ── Try PySceneDetect first (much more accurate) ──
    const pySceneDetectAvailable = (() => {
      try { execSync('scenedetect version', { encoding: 'utf-8', stdio: 'pipe' }); return true; }
      catch { return false; }
    })();

    if (pySceneDetectAvailable) {
      console.log('Detecting scene cuts with PySceneDetect (ContentDetector)...');
      method = 'pyscenedetect';

      try {
        // PySceneDetect with ContentDetector — uses HSV color analysis for accurate cuts
        // threshold=27 is default; lower = more sensitive
        const csvPath = path.join(MEDIA_DIR, `${videoId}_scenes_temp.csv`);
        const { stdout, stderr } = await execFileAsync('scenedetect', [
          '-i', videoPath,
          '--output', MEDIA_DIR,
          'detect-content',
          '-t', '27',
          'list-scenes',
          '-f', csvPath,
          '-q',
        ], { maxBuffer: 50 * 1024 * 1024, timeout: 300000 });

        // Parse CSV output — columns: Scene Number, Start Frame, Start Timecode, Start Time (seconds), ...
        if (fs.existsSync(csvPath)) {
          const csvContent = fs.readFileSync(csvPath, 'utf-8');
          const lines = csvContent.split('\n');
          // Skip header lines (first 2 rows are headers)
          for (let i = 2; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            const cols = line.split(',');
            // Column index 3 is "Start Time (seconds)" in standard PySceneDetect output
            const timeStr = cols[3]?.trim();
            if (timeStr) {
              const time = parseFloat(timeStr);
              if (!isNaN(time) && time > 0 && time - cuts[cuts.length - 1] > 0.3) {
                cuts.push(Math.round(time * 100) / 100);
              }
            }
          }
          // Clean up temp CSV
          try { fs.unlinkSync(csvPath); } catch {}
        }

        // Also try parsing stdout/stderr for timecodes if CSV didn't work
        if (cuts.length <= 1) {
          const output = (stdout || '') + (stderr || '');
          // Match timecodes like "00:00:18.750"
          const tcRegex = /(\d+:\d+:\d+\.\d+)/g;
          let tcMatch;
          const timecodes = [];
          while ((tcMatch = tcRegex.exec(output)) !== null) {
            const tc = tcMatch[1];
            const parts = tc.split(':');
            const secs = parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2]);
            if (secs > 0 && !timecodes.includes(secs)) timecodes.push(secs);
          }
          // Take every other timecode (start of each scene)
          for (let i = 0; i < timecodes.length; i += 2) {
            const time = Math.round(timecodes[i] * 100) / 100;
            if (time > 0 && time - cuts[cuts.length - 1] > 0.3) {
              cuts.push(time);
            }
          }
        }

        console.log(`  PySceneDetect found ${cuts.length - 1} scene cuts`);
      } catch (e) {
        console.warn('  PySceneDetect failed, falling back to ffmpeg:', e.message?.substring(0, 200));
        method = 'ffmpeg-fallback';
        cuts = [0]; // Reset for fallback
      }
    }

    // ── Fallback: ffmpeg scene detection ──
    if (cuts.length <= 1 && method !== 'pyscenedetect') {
      console.log('Detecting scene cuts with ffmpeg (fallback)...');
      method = 'ffmpeg';

      const { stderr } = await execFileAsync(FFMPEG_PATH, [
        '-i', videoPath,
        '-filter:v', "select='gt(scene,0.3)',showinfo",
        '-f', 'null', '-',
      ], { maxBuffer: 50 * 1024 * 1024 }).catch(e => ({ stderr: e.stderr || '' }));

      const regex = /pts_time:([\d.]+)/g;
      let match;
      while ((match = regex.exec(stderr)) !== null) {
        const time = parseFloat(match[1]);
        if (time - cuts[cuts.length - 1] > 1) {
          cuts.push(Math.round(time * 100) / 100);
        }
      }
    }

    // Also run ffmpeg fallback if PySceneDetect produced no results
    if (cuts.length <= 1) {
      console.log('No cuts from PySceneDetect, trying ffmpeg fallback...');
      method = 'ffmpeg-fallback';

      const { stderr } = await execFileAsync(FFMPEG_PATH, [
        '-i', videoPath,
        '-filter:v', "select='gt(scene,0.3)',showinfo",
        '-f', 'null', '-',
      ], { maxBuffer: 50 * 1024 * 1024 }).catch(e => ({ stderr: e.stderr || '' }));

      const regex = /pts_time:([\d.]+)/g;
      let match;
      while ((match = regex.exec(stderr)) !== null) {
        const time = parseFloat(match[1]);
        if (time - cuts[cuts.length - 1] > 1) {
          cuts.push(Math.round(time * 100) / 100);
        }
      }
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

// ─── POST /api/waveform ───────────────────────────────────────────
// Extract audio waveform peak data using ffmpeg for visualization.
// Returns an array of amplitude peaks (0-1) at ~100 samples/second.

app.post('/api/waveform', async (req, res) => {
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

    // Use ffmpeg to extract raw PCM audio at 8kHz mono, then compute peaks
    const rawPath = path.join(MEDIA_DIR, `${videoId}_audio_raw.pcm`);

    await execFileAsync(FFMPEG_PATH, [
      '-i', videoPath,
      '-ac', '1',           // mono
      '-ar', '8000',        // 8kHz sample rate
      '-f', 's16le',        // signed 16-bit little-endian PCM
      '-acodec', 'pcm_s16le',
      '-y',
      rawPath,
    ], { maxBuffer: 50 * 1024 * 1024 });

    // Read raw PCM and compute peaks
    const rawBuffer = fs.readFileSync(rawPath);
    const samples = new Int16Array(rawBuffer.buffer, rawBuffer.byteOffset, rawBuffer.length / 2);

    // Downsample to ~100 peaks per second (8000 samples/sec -> every 80 samples = 100 peaks/sec)
    const samplesPerPeak = 80;
    const peaks = [];
    for (let i = 0; i < samples.length; i += samplesPerPeak) {
      let max = 0;
      const end = Math.min(i + samplesPerPeak, samples.length);
      for (let j = i; j < end; j++) {
        const abs = Math.abs(samples[j]);
        if (abs > max) max = abs;
      }
      peaks.push(Math.round((max / 32768) * 1000) / 1000); // normalize to 0-1
    }

    // Clean up temp file
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

// Parse YouTube srv3 format — extracts TRUE word-by-word timestamps
// Format A (auto-generated): <p t="baseMs" d="durationMs"><s>word</s><s t="offsetMs">word2</s></p>
// Format B (manual/fallback): <p t="baseMs" d="durationMs">phrase text</p>
function parseSrv3(xmlContent) {
  const words = [];
  const segments = [];
  let fullText = '';

  // Match all <p> elements with their attributes and content
  const pRegex = /<p\s+([^>]*)>((?:.|\n)*?)<\/p>/g;
  let pMatch;

  while ((pMatch = pRegex.exec(xmlContent)) !== null) {
    const attrs = pMatch[1];
    const content = pMatch[2];

    // Get base time and duration from <p> attributes
    const tMatch = attrs.match(/\bt="(\d+)"/);
    const dMatch = attrs.match(/\bd="(\d+)"/);
    if (!tMatch) continue;

    const baseTimeMs = parseInt(tMatch[1]);
    const durationMs = dMatch ? parseInt(dMatch[1]) : 3000;

    // Skip empty <p> elements
    const trimmed = content.replace(/\n/g, ' ').trim();
    if (!trimmed) continue;

    // Check if this <p> has <s> tags (word-level timing)
    const hasSwordTags = /<s[\s>]/.test(content);
    const lineWords = [];

    if (hasSwordTags) {
      // Format A: extract individual <s> word elements
      const sRegex = /<s(?:\s+t="(\d+)")?>([^<]*)<\/s>/g;
      let sMatch;
      while ((sMatch = sRegex.exec(content)) !== null) {
        const offsetMs = sMatch[1] ? parseInt(sMatch[1]) : 0;
        let text = sMatch[2].trim();
        text = decodeEntities(text);
        if (!text) continue;

        const wordStartMs = baseTimeMs + offsetMs;
        lineWords.push({
          text,
          start: Math.round(wordStartMs / 10) / 100,
          end: 0,
        });
      }
    } else {
      // Format B: split plain text into words with estimated timing
      let text = trimmed;
      text = decodeEntities(text);
      const wordList = text.split(/\s+/).filter(w => w.length > 0);
      const wordDur = durationMs / Math.max(wordList.length, 1);
      for (let j = 0; j < wordList.length; j++) {
        const wordStartMs = baseTimeMs + j * wordDur;
        lineWords.push({
          text: wordList[j],
          start: Math.round(wordStartMs / 10) / 100,
          end: 0,
        });
      }
    }

    // Set word end times
    for (let i = 0; i < lineWords.length; i++) {
      if (i < lineWords.length - 1) {
        lineWords[i].end = lineWords[i + 1].start;
      } else {
        lineWords[i].end = Math.round((baseTimeMs + durationMs) / 10) / 100;
      }
    }

    if (lineWords.length > 0) {
      words.push(...lineWords);
      const segText = lineWords.map(w => w.text).join(' ');
      fullText += segText + ' ';
      segments.push({
        text: segText,
        start: lineWords[0].start,
        end: lineWords[lineWords.length - 1].end,
      });
    }
  }

  // Fix word end times across segments
  for (let i = 0; i < words.length - 1; i++) {
    if (words[i + 1].start > words[i].start && words[i + 1].start < words[i].end + 2) {
      words[i].end = words[i + 1].start;
    }
  }

  const duration = words.length > 0 ? words[words.length - 1].end : 0;
  return { text: fullText.trim(), words, segments, duration };
}

function decodeEntities(text) {
  return text.replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
}

// Fallback: Parse json3 format
function parseJson3(data) {
  const words = [];
  const segments = [];
  let fullText = '';

  if (!data.events) return { text: '', words: [], segments: [], duration: 0 };

  for (const event of data.events) {
    if (!event.segs) continue;
    const eventStart = (event.tStartMs || 0) / 1000;
    let segText = '';
    for (const seg of event.segs) {
      const text = seg.utf8?.trim();
      if (!text || text === '\n') continue;
      // Split multi-word segments into individual words
      const segWords = text.split(/\s+/).filter(w => w.length > 0);
      const segStartSec = eventStart + (seg.tOffsetMs || 0) / 1000;
      const wordDur = 0.3;
      segWords.forEach((w, j) => {
        words.push({
          text: w,
          start: Math.round((segStartSec + j * wordDur) * 100) / 100,
          end: Math.round((segStartSec + (j + 1) * wordDur) * 100) / 100,
        });
      });
      segText += text + ' ';
      fullText += text + ' ';
    }
    if (segText.trim()) {
      const segEnd = eventStart + (event.dDurationMs || 3000) / 1000;
      segments.push({ text: segText.trim(), start: eventStart, end: segEnd });
    }
  }

  for (let i = 0; i < words.length - 1; i++) {
    if (words[i + 1].start > words[i].start) words[i].end = words[i + 1].start;
  }

  const duration = words.length > 0 ? words[words.length - 1].end : 0;
  return { text: fullText.trim(), words, segments, duration };
}

// Parse VTT subtitle format as fallback
function parseVTT(vttContent) {
  const words = [];
  const segments = [];
  let fullText = '';

  const lines = vttContent.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();

    // Look for timestamp lines: "00:00:01.000 --> 00:00:04.000"
    const tsMatch = line.match(/(\d+:\d+:\d+\.\d+)\s*-->\s*(\d+:\d+:\d+\.\d+)/);
    if (tsMatch) {
      const start = parseVTTTime(tsMatch[1]);
      const end = parseVTTTime(tsMatch[2]);
      i++;

      // Collect text lines until blank line
      let text = '';
      while (i < lines.length && lines[i].trim() !== '') {
        text += lines[i].trim() + ' ';
        i++;
      }

      // Remove VTT tags and clean up
      text = text.replace(/<[^>]*>/g, '').trim();
      if (!text) continue;

      // Split into words with estimated timing
      const wordList = text.split(/\s+/).filter(w => w.length > 0);
      const wordDur = (end - start) / Math.max(wordList.length, 1);

      for (let j = 0; j < wordList.length; j++) {
        const wStart = start + j * wordDur;
        const wEnd = start + (j + 1) * wordDur;
        words.push({
          text: wordList[j],
          start: Math.round(wStart * 100) / 100,
          end: Math.round(wEnd * 100) / 100,
        });
      }

      segments.push({ text, start, end });
      fullText += text + ' ';
    }

    i++;
  }

  // Deduplicate words (VTT often has overlapping cues)
  const deduped = [];
  for (const w of words) {
    const last = deduped[deduped.length - 1];
    if (!last || w.start >= last.end - 0.05 || w.text !== last.text) {
      deduped.push(w);
    }
  }

  const duration = deduped.length > 0 ? deduped[deduped.length - 1].end : 0;
  return { text: fullText.trim(), words: deduped, segments, duration };
}

function parseVTTTime(str) {
  const parts = str.split(':');
  const h = parseInt(parts[0]);
  const m = parseInt(parts[1]);
  const s = parseFloat(parts[2]);
  return h * 3600 + m * 60 + s;
}

// ─── POST /api/export ─────────────────────────────────────────────

app.post('/api/export', async (req, res) => {
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
      '-i', videoPath,
      '-f', 'null', '-',
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
      '-map', '[outv]',
      '-map', '[outa]',
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '23',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-y',
      outputPath,
    ], { maxBuffer: 50 * 1024 * 1024 });

    console.log('Export complete!');
    res.json({ filename: `${videoId}_edited.mp4` });
  } catch (err) {
    console.error('Export error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/status ──────────────────────────────────────────────

app.get('/api/status', (req, res) => {
  res.json({ status: 'ok' });
});

// ─── Start ────────────────────────────────────────────────────────

async function start() {
  console.log('\n🎬 Descript Clone — Server (Free Edition)');
  console.log('──────────────────────────────────────────');
  console.log('Checking dependencies...');
  await checkDependencies();
  console.log('Transcription: YouTube auto-captions (FREE — no API key needed)');
  console.log('──────────────────────────────────────────\n');

  app.listen(PORT, () => {
    console.log(`🚀 Server running at http://localhost:${PORT}`);
  });
}

start();
