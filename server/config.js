import 'dotenv/config';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PORT = process.env.PORT || 3001;
export const MEDIA_DIR = path.join(__dirname, '..', 'media');

// Binary paths (resolved at startup)
export let FFMPEG_PATH = 'ffmpeg';
export let YTDLP_PATH = 'yt-dlp';

// Ensure media directory exists
if (!fs.existsSync(MEDIA_DIR)) {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
}

function findBinary(name) {
  try {
    const result = execSync(`where ${name}`, { encoding: 'utf-8' }).trim();
    return result.split(/\r?\n/)[0].trim();
  } catch {
    return null;
  }
}

export async function checkDependencies() {
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
