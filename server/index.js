import express from 'express';
import cors from 'cors';
import { PORT, MEDIA_DIR, checkDependencies } from './config.js';

// Route modules
import downloadRouter from './routes/download.js';
import transcribeRouter from './routes/transcribe.js';
import scenesRouter from './routes/scenes.js';
import waveformRouter from './routes/waveform.js';
import exportRouter from './routes/export.js';

const app = express();

app.use(cors());
app.use(express.json());

// Serve downloaded media files
app.use('/api/media', express.static(MEDIA_DIR));

// Mount routes
app.use('/api/download', downloadRouter);
app.use('/api/transcribe', transcribeRouter);
app.use('/api/scene-cuts', scenesRouter);
app.use('/api/waveform', waveformRouter);
app.use('/api/export', exportRouter);

// Health check
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
