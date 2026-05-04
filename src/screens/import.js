// ─── Import Screen ─────────────────────────────────────────────────
import { state } from '../state.js';
import { renderEditor } from './editor.js';

export function renderImportScreen() {
  document.querySelector('#app').innerHTML = `
    <div class="import-screen">
      <div class="import-logo">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
        DescriptClone
      </div>
      <p class="import-subtitle">Text-based video editing — paste a YouTube link to start</p>
      <div class="import-card">
        <h2>Import from YouTube</h2>
        <div class="url-input-group">
          <input type="text" class="url-input" id="url-input" placeholder="https://www.youtube.com/watch?v=..." autocomplete="off" />
          <button class="import-btn" id="import-btn">Import</button>
        </div>
        <div class="import-progress" id="import-progress">
          <div class="progress-step" id="step-download"><span class="step-icon">1</span> Downloading video...</div>
          <div class="progress-bar-track"><div class="progress-bar-fill" id="dl-progress"></div></div>
          <div class="progress-step" id="step-transcribe"><span class="step-icon">2</span> Transcribing audio...</div>
          <div class="progress-bar-track"><div class="progress-bar-fill" id="tr-progress"></div></div>
          <div class="progress-step" id="step-scenes"><span class="step-icon">3</span> Detecting scene cuts...</div>
          <div class="progress-bar-track"><div class="progress-bar-fill" id="sc-progress"></div></div>
          <div class="progress-step" id="step-waveform"><span class="step-icon">4</span> Extracting waveform...</div>
          <div class="progress-bar-track"><div class="progress-bar-fill" id="wf-progress"></div></div>
        </div>
        <div class="import-error" id="import-error"></div>
      </div>
    </div>`;
  document.getElementById('import-btn').addEventListener('click', handleImport);
  document.getElementById('url-input').addEventListener('keydown', e => { if (e.key === 'Enter') handleImport(); });
}

// ─── Import Flow ───────────────────────────────────────────────────
async function handleImport() {
  const url = document.getElementById('url-input').value.trim();
  if (!url) return;

  const btn = document.getElementById('import-btn');
  const progress = document.getElementById('import-progress');
  const errDiv = document.getElementById('import-error');
  btn.disabled = true;
  errDiv.classList.remove('visible');
  errDiv.textContent = '';
  progress.classList.add('visible');

  const stepDl = document.getElementById('step-download');
  const stepTr = document.getElementById('step-transcribe');
  const dlBar = document.getElementById('dl-progress');
  const trBar = document.getElementById('tr-progress');

  try {
    // Step 1: Download
    stepDl.classList.add('active');
    const dlResult = await downloadVideo(url, dlBar);

    stepDl.classList.remove('active');
    stepDl.classList.add('done');
    dlBar.style.width = '100%';

    state.videoId = dlResult.videoId;
    state.filename = dlResult.filename;
    state.title = dlResult.title;
    state.duration = dlResult.duration;
    state.url = url;

    // Step 2: Transcribe
    stepTr.classList.add('active');
    trBar.style.width = '30%';

    const trResp = await fetch('/api/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId: state.videoId, url: state.url }),
    });
    if (!trResp.ok) throw new Error((await trResp.json()).error || 'Transcription failed');

    trBar.style.width = '100%';
    state.transcript = await trResp.json();
    stepTr.classList.remove('active');
    stepTr.classList.add('done');

    // Step 3: Scene cuts
    const stepSc = document.getElementById('step-scenes');
    const scBar = document.getElementById('sc-progress');
    stepSc.classList.add('active');
    scBar.style.width = '50%';

    try {
      const scResp = await fetch('/api/scene-cuts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoId: state.videoId }),
      });
      if (scResp.ok) state.sceneCuts = (await scResp.json()).cuts || [];
    } catch (e) {
      console.warn('Scene detection failed, continuing without:', e);
    }
    scBar.style.width = '100%';
    stepSc.classList.remove('active');
    stepSc.classList.add('done');

    // Step 4: Waveform
    const stepWf = document.getElementById('step-waveform');
    const wfBar = document.getElementById('wf-progress');
    stepWf.classList.add('active');
    wfBar.style.width = '50%';

    try {
      const wfResp = await fetch('/api/waveform', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoId: state.videoId }),
      });
      if (wfResp.ok) state.waveformData = await wfResp.json();
    } catch (e) {
      console.warn('Waveform extraction failed, continuing without:', e);
    }
    wfBar.style.width = '100%';
    stepWf.classList.remove('active');
    stepWf.classList.add('done');

    // Transition to editor
    setTimeout(() => renderEditor(), 400);
  } catch (err) {
    errDiv.textContent = err.message;
    errDiv.classList.add('visible');
    btn.disabled = false;
    stepDl.classList.remove('active');
    stepTr.classList.remove('active');
  }
}

async function downloadVideo(url, progressBar) {
  const resp = await fetch('/api/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });

  const contentType = resp.headers.get('content-type') || '';

  if (contentType.includes('application/json')) {
    const data = await resp.json();
    if (data.error) throw new Error(data.error);
    progressBar.style.width = '100%';
    return data;
  }

  // SSE stream
  return new Promise((resolve, reject) => {
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    function pump() {
      reader.read().then(({ done, value }) => {
        if (done) { reject(new Error('Download stream ended without completion')); return; }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const evt = JSON.parse(line.slice(6));
              if (evt.type === 'progress') progressBar.style.width = evt.percent + '%';
              if (evt.type === 'complete') { resolve(evt); return; }
              if (evt.type === 'error') { reject(new Error(evt.message)); return; }
            } catch {}
          }
        }
        pump();
      }).catch(reject);
    }
    pump();
  });
}
