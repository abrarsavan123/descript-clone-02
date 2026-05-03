import './style.css';

// ─── State ─────────────────────────────────────────────────
const state = {
  videoId: null,
  filename: null,
  title: '',
  duration: 0,
  url: '',
  transcript: null,   // { text, words: [{text,start,end}], segments }
  sceneCuts: [],       // [0, 18.7, 24.4, ...] timestamps of visual cuts
  waveformData: null,  // { peaks: [0-1], duration, sampleRate }
  cuts: [],            // [{start, end}] deleted time ranges
  selectionStart: -1,
  selectionEnd: -1,
  isPlaying: false,
  zoom: 1,
};

// ─── Render Import Screen ──────────────────────────────────
function renderImportScreen() {
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

// ─── Import Flow ───────────────────────────────────────────
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
    // Step 1: Download — server returns JSON if cached, SSE if downloading
    stepDl.classList.add('active');
    const dlResult = await downloadVideo(url, dlBar);
    
    async function downloadVideo(url, progressBar) {
      const resp = await fetch('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });

      const contentType = resp.headers.get('content-type') || '';

      // If server returned JSON directly (video already cached)
      if (contentType.includes('application/json')) {
        const data = await resp.json();
        if (data.error) throw new Error(data.error);
        progressBar.style.width = '100%';
        return data;
      }

      // Otherwise it's SSE stream (downloading)
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

    if (!trResp.ok) {
      const err = await trResp.json();
      throw new Error(err.error || 'Transcription failed');
    }

    trBar.style.width = '100%';
    state.transcript = await trResp.json();
    stepTr.classList.remove('active');
    stepTr.classList.add('done');

    // Step 3: Detect scene cuts
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
      if (scResp.ok) {
        const scData = await scResp.json();
        state.sceneCuts = scData.cuts || [];
      }
    } catch (e) {
      console.warn('Scene detection failed, continuing without:', e);
    }
    scBar.style.width = '100%';
    stepSc.classList.remove('active');
    stepSc.classList.add('done');

    // Step 4: Extract waveform
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
      if (wfResp.ok) {
        state.waveformData = await wfResp.json();
      }
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

// SSE fetch helper (POST with streaming)
async function fetchSSE(url, body, onEvent) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try { onEvent(JSON.parse(line.slice(6))); } catch {}
      }
    }
  }
}

// ─── Render Editor ─────────────────────────────────────────
function renderEditor() {
  document.querySelector('#app').innerHTML = `
    <div class="editor visible">
      <div class="editor-header">
        <div class="header-left">
          <div class="header-logo">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
            DescriptClone
          </div>
          <input type="text" class="project-title" id="project-title" value="${escHtml(state.title)}" />
        </div>
        <div class="header-actions">
          <button class="btn-secondary" id="restore-all-btn">↩ Restore All</button>
          <button class="btn-secondary" id="new-btn">+ New</button>
          <button class="btn-primary" id="export-btn">Export Video</button>
        </div>
      </div>
      <div class="selection-bar" id="selection-bar">
        <span id="selection-info"></span>
        <button id="delete-selection-btn">🗑 Delete</button>
        <button id="restore-selection-btn" style="display:none">↩ Restore</button>
        <button id="clear-selection-btn">✕ Clear</button>
      </div>
      <div class="workspace">
        <div class="video-pane">
          <div class="video-container">
            <video id="video" src="/api/media/${state.filename}" preload="auto"></video>
          </div>
          <div class="video-controls">
            <button class="play-btn" id="play-btn">
              <svg id="play-icon" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              <svg id="pause-icon" viewBox="0 0 24 24" style="display:none"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
            </button>
            <div class="seek-bar-container" id="seek-bar">
              <div class="seek-bar-fill" id="seek-fill"></div>
            </div>
            <span class="time-display" id="time-display">00:00 / 00:00</span>
            <div class="volume-control">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07"/></svg>
              <input type="range" class="volume-slider" id="volume" min="0" max="1" step="0.05" value="1" />
            </div>
          </div>
        </div>
        <div class="transcript-pane">
          <div class="transcript-header">
            <span>Transcript</span>
            <div class="transcript-tools">
              <button id="copy-transcript-btn">📋 Copy</button>
              <button id="select-all-btn">Select All</button>
            </div>
          </div>
          <div class="transcript-content" id="transcript"></div>
        </div>
      </div>
      <div class="timeline">
        <div class="timeline-header">
          <span>Timeline</span>
          <div class="timeline-zoom">
            <button id="zoom-out">−</button>
            <button id="zoom-in">+</button>
          </div>
        </div>
        <div class="timeline-body" id="timeline-body">
          <div class="time-ruler" id="time-ruler"></div>
          <div class="timeline-track" id="timeline-track">
            <canvas id="waveform-canvas" class="waveform-canvas"></canvas>
          </div>
          <div class="playhead" id="playhead"></div>
        </div>
      </div>
    </div>
    <div class="modal-overlay" id="export-modal">
      <div class="modal-card">
        <h3 id="modal-title">Exporting Video...</h3>
        <div class="progress-bar-track"><div class="progress-bar-fill" id="export-progress"></div></div>
        <div id="export-result" style="display:none">
          <p style="margin:1rem 0;color:var(--success)">✓ Export complete!</p>
          <a id="download-link" class="btn-primary" style="display:inline-block;padding:10px 24px;text-decoration:none;border-radius:8px" download>Download MP4</a>
          <br/><button class="btn-secondary" id="close-modal" style="margin-top:12px">Close</button>
        </div>
      </div>
    </div>
    <div class="shortcuts-hint">
      <kbd>Space</kbd> Play/Pause &nbsp; <kbd>Del</kbd> Delete &nbsp; <kbd>R</kbd> Restore &nbsp; <kbd>Esc</kbd> Clear &nbsp; <kbd>C</kbd> Copy
    </div>
    <div class="toast" id="toast"></div>`;

  initEditor();
}

// ─── Editor Logic ──────────────────────────────────────────
function initEditor() {
  const video = document.getElementById('video');
  const playBtn = document.getElementById('play-btn');
  const playIcon = document.getElementById('play-icon');
  const pauseIcon = document.getElementById('pause-icon');
  const seekBar = document.getElementById('seek-bar');
  const seekFill = document.getElementById('seek-fill');
  const timeDisplay = document.getElementById('time-display');
  const volumeSlider = document.getElementById('volume');
  const transcriptEl = document.getElementById('transcript');
  const selectionBar = document.getElementById('selection-bar');
  const selectionInfo = document.getElementById('selection-info');

  // Track previous active word index to avoid redundant DOM thrashing
  let prevActiveIdx = -1;
  let rafId = null;
  let userClickedWord = false; // Suppress auto-scroll when user clicks a word

  // Render transcript
  renderTranscript();
  renderTimeline();

  // ── Video Controls ──
  playBtn.onclick = () => video.paused ? video.play() : video.pause();
  video.onplay = () => { playIcon.style.display = 'none'; pauseIcon.style.display = 'block'; state.isPlaying = true; startRAFLoop(); };
  video.onpause = () => { playIcon.style.display = 'block'; pauseIcon.style.display = 'none'; state.isPlaying = false; };
  volumeSlider.oninput = () => { video.volume = volumeSlider.value; };

  // Seek bar click
  seekBar.onclick = (e) => {
    const rect = seekBar.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    seekTo(pct * video.duration);
  };

  // Fast seek helper — uses fastSeek() when available for instant response
  function seekTo(time) {
    if (video.fastSeek) {
      video.fastSeek(time);
    } else {
      video.currentTime = time;
    }
    // Immediate UI update (don't wait for next RAF tick)
    updateUI();
  }

  // 60fps render loop — replaces the choppy ~4Hz ontimeupdate
  function startRAFLoop() {
    if (rafId) return;
    function tick() {
      updateUI();
      rafId = requestAnimationFrame(tick);
    }
    rafId = requestAnimationFrame(tick);
  }

  // Also listen to timeupdate as fallback (fires during pause + seek)
  video.ontimeupdate = () => updateUI();
  // Listen for seeked to immediately snap UI
  video.onseeked = () => updateUI();

  function updateUI() {
    if (!video.duration) return;
    const pct = (video.currentTime / video.duration) * 100;
    seekFill.style.width = pct + '%';
    timeDisplay.textContent = `${fmtTime(video.currentTime)} / ${fmtTime(video.duration)}`;
    highlightActiveWord();
    updatePlayhead();
    enforceCuts();
  }

  // Start RAF loop on initial load if video is already playing
  if (!video.paused) startRAFLoop();

  // ── Transcript word click / selection ──
  transcriptEl.addEventListener('click', (e) => {
    const wordEl = e.target.closest('.word');
    if (!wordEl) return;
    const idx = parseInt(wordEl.dataset.idx);

    // If clicking a deleted word (without shift), restore it immediately
    if (isWordDeleted(idx) && !e.shiftKey) {
      restoreWord(idx);
      return;
    }

    if (e.shiftKey && state.selectionStart >= 0) {
      state.selectionEnd = idx;
      if (state.selectionEnd < state.selectionStart) {
        [state.selectionStart, state.selectionEnd] = [state.selectionEnd, state.selectionStart];
      }
    } else {
      state.selectionStart = idx;
      state.selectionEnd = idx;
      // Seek video to word start — pin-point, no lag
      userClickedWord = true;
      seekTo(state.transcript.words[idx].start);
      setTimeout(() => { userClickedWord = false; }, 500);
    }
    updateSelectionUI();
  });

  // ── Keyboard shortcuts ──
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.code === 'Space') { e.preventDefault(); video.paused ? video.play() : video.pause(); }
    if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectionStart >= 0) {
      e.preventDefault();
      deleteSelection();
    }
    if (e.key === 'r' && state.selectionStart >= 0) { e.preventDefault(); restoreSelection(); }
    if (e.key === 'c' && !e.ctrlKey && !e.metaKey) { copyTranscript(); }
    if (e.key === 'Escape') { clearSelection(); }
    // J/K/L seek
    if (e.key === 'j') video.currentTime = Math.max(0, video.currentTime - 5);
    if (e.key === 'l') video.currentTime = Math.min(video.duration, video.currentTime + 5);
  });

  // ── Buttons ──
  document.getElementById('delete-selection-btn').onclick = deleteSelection;
  document.getElementById('restore-selection-btn').onclick = restoreSelection;
  document.getElementById('clear-selection-btn').onclick = clearSelection;
  document.getElementById('restore-all-btn').onclick = restoreAll;
  document.getElementById('export-btn').onclick = handleExport;
  document.getElementById('close-modal').onclick = () => {
    document.getElementById('export-modal').classList.remove('visible');
  };
  document.getElementById('new-btn').onclick = () => {
    state.videoId = null; state.transcript = null; state.cuts = [];
    renderImportScreen();
  };
  document.getElementById('select-all-btn').onclick = () => {
    state.selectionStart = 0;
    state.selectionEnd = state.transcript.words.length - 1;
    updateSelectionUI();
  };
  document.getElementById('copy-transcript-btn').onclick = copyTranscript;
  document.getElementById('zoom-in').onclick = () => { state.zoom = Math.min(state.zoom * 1.5, 10); renderTimeline(); };
  document.getElementById('zoom-out').onclick = () => { state.zoom = Math.max(state.zoom / 1.5, 0.3); renderTimeline(); };

  // ── Render helpers ──
  // Determine which scene a word belongs to (returns scene index for alternating colors)
  function getSceneIndex(wordStart) {
    if (!state.sceneCuts || state.sceneCuts.length <= 1) return 0;
    let sceneIdx = 0;
    for (let i = 1; i < state.sceneCuts.length; i++) {
      if (wordStart >= state.sceneCuts[i]) sceneIdx = i;
      else break;
    }
    return sceneIdx;
  }

  function renderTranscript() {
    const words = state.transcript.words;
    let html = '';
    let inParagraph = false;

    words.forEach((w, i) => {
      // Start a new paragraph on gaps > 2 seconds or at the very start
      const prevEnd = i > 0 ? words[i - 1].end : 0;
      const gap = w.start - prevEnd;

      if (!inParagraph || gap > 2) {
        if (inParagraph) html += '</p>';
        html += '<p class="transcript-paragraph">';
        inParagraph = true;
      }

      const isDeleted = isWordDeleted(i);
      const isSelected = i >= state.selectionStart && i <= state.selectionEnd && state.selectionStart >= 0;
      const sceneIdx = getSceneIndex(w.start);
      const sceneClass = sceneIdx % 2 === 0 ? 'scene-a' : 'scene-b';

      let cls = `word ${sceneClass}`;
      if (isDeleted) cls += ' deleted';
      if (isSelected) cls += ' selected';

      html += `<span class="${cls}" data-idx="${i}" data-start="${w.start}" data-end="${w.end}">${escHtml(w.text)} </span>`;
    });
    if (inParagraph) html += '</p>';
    transcriptEl.innerHTML = html;
  }

  function renderTimeline() {
    const dur = state.duration || video.duration || 60;
    const pxPerSec = 8 * state.zoom;
    const totalWidth = dur * pxPerSec;
    const track = document.getElementById('timeline-track');
    const ruler = document.getElementById('time-ruler');
    const body = document.getElementById('timeline-body');
    const canvas = document.getElementById('waveform-canvas');

    track.style.width = totalWidth + 'px';
    ruler.style.width = totalWidth + 'px';

    // Ruler marks
    const interval = state.zoom < 0.8 ? 30 : state.zoom < 2 ? 10 : 5;
    let rulerHtml = '';
    for (let t = 0; t <= dur; t += interval) {
      const x = t * pxPerSec;
      rulerHtml += `<span class="time-ruler-mark" style="left:${x}px">${fmtTime(t)}</span>`;
    }
    ruler.innerHTML = rulerHtml;

    // ── Waveform canvas ──
    const trackHeight = track.clientHeight || 70;
    canvas.width = totalWidth;
    canvas.height = trackHeight;
    canvas.style.width = totalWidth + 'px';
    canvas.style.height = trackHeight + 'px';

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (state.waveformData && state.waveformData.peaks.length > 0) {
      const peaks = state.waveformData.peaks;
      const wfDuration = state.waveformData.duration;
      const peaksPerSec = state.waveformData.sampleRate; // 100 peaks/sec
      const midY = trackHeight / 2;

      // Draw waveform peaks
      for (let px = 0; px < totalWidth; px++) {
        const timeSec = px / pxPerSec;
        const peakIdx = Math.floor(timeSec * peaksPerSec);
        if (peakIdx >= peaks.length) break;

        const amplitude = peaks[peakIdx];
        const barH = Math.max(amplitude * midY * 0.9, 0.5);

        // Check if this pixel falls within a deleted cut
        const isInCut = state.cuts.some(c => timeSec >= c.start && timeSec < c.end);

        if (isInCut) {
          ctx.fillStyle = 'rgba(255, 107, 107, 0.25)';
        } else {
          // Gradient color based on amplitude
          const alpha = 0.3 + amplitude * 0.5;
          ctx.fillStyle = `rgba(108, 92, 231, ${alpha})`;
        }

        ctx.fillRect(px, midY - barH, 1, barH * 2);
      }

      // Draw center line
      ctx.strokeStyle = 'rgba(139, 146, 168, 0.15)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, midY);
      ctx.lineTo(totalWidth, midY);
      ctx.stroke();

      // Overlay scene cut markers
      if (state.sceneCuts.length > 1) {
        ctx.strokeStyle = 'rgba(253, 203, 110, 0.5)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        for (let i = 1; i < state.sceneCuts.length; i++) {
          const x = state.sceneCuts[i] * pxPerSec;
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, trackHeight);
          ctx.stroke();
        }
        ctx.setLineDash([]);
      }

      // Overlay word text labels (only when zoomed in enough)
      if (pxPerSec > 12) {
        ctx.font = '9px Inter, sans-serif';
        ctx.fillStyle = 'rgba(232, 234, 240, 0.6)';
        ctx.textBaseline = 'bottom';
        state.transcript.words.forEach((w, i) => {
          const x = w.start * pxPerSec;
          const width = (w.end - w.start) * pxPerSec;
          if (width > 18) {
            const isDeleted = isWordDeleted(i);
            ctx.fillStyle = isDeleted ? 'rgba(255, 107, 107, 0.35)' : 'rgba(232, 234, 240, 0.6)';
            ctx.fillText(w.text, x + 2, trackHeight - 3, width - 4);
          }
        });
      }
    } else {
      // Fallback: draw word clips like before (no waveform data)
      let trackHtml = '';
      state.transcript.words.forEach((w, i) => {
        const left = w.start * pxPerSec;
        const width = Math.max((w.end - w.start) * pxPerSec, 2);
        const del = isWordDeleted(i) ? ' deleted' : '';
        trackHtml += `<div class="timeline-clip${del}" style="left:${left}px;width:${width}px" title="${escHtml(w.text)}">${width > 20 ? escHtml(w.text) : ''}</div>`;
      });
      track.innerHTML = '<canvas id="waveform-canvas" class="waveform-canvas"></canvas>' + trackHtml;
    }
  }

  // Binary search to find the active word index — O(log n) instead of O(n)
  function findActiveWordIndex(time) {
    const words = state.transcript.words;
    let lo = 0, hi = words.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (words[mid].end <= time) lo = mid + 1;
      else if (words[mid].start > time) hi = mid - 1;
      else return mid;
    }
    return -1;
  }

  function highlightActiveWord() {
    const time = video.currentTime;
    const idx = findActiveWordIndex(time);

    // Skip if same word as last frame (avoid DOM thrashing at 60fps)
    if (idx === prevActiveIdx) return;

    // Remove old highlight
    if (prevActiveIdx >= 0) {
      const oldEl = transcriptEl.querySelector(`.word[data-idx="${prevActiveIdx}"]`);
      if (oldEl) oldEl.classList.remove('active');
    }

    // Add new highlight
    if (idx >= 0 && !isWordDeleted(idx)) {
      const el = transcriptEl.querySelector(`.word[data-idx="${idx}"]`);
      if (el) {
        el.classList.add('active');
        // Auto scroll — only during playback, not when user clicked a word
        if (!userClickedWord) {
          const top = el.offsetTop;
          if (top > transcriptEl.scrollTop + transcriptEl.clientHeight - 60 || top < transcriptEl.scrollTop) {
            transcriptEl.scrollTo({ top: top - transcriptEl.clientHeight / 3, behavior: 'smooth' });
          }
        }
      }
    }

    prevActiveIdx = idx;
  }

  function updatePlayhead() {
    const dur = state.duration || video.duration || 60;
    const pxPerSec = 8 * state.zoom;
    const ph = document.getElementById('playhead');
    ph.style.left = (16 + video.currentTime * pxPerSec) + 'px';
    // Auto scroll timeline
    const body = document.getElementById('timeline-body');
    const phPos = video.currentTime * pxPerSec;
    if (phPos > body.scrollLeft + body.clientWidth * 0.8) {
      body.scrollLeft = phPos - body.clientWidth * 0.3;
    }
  }

  function enforceCuts() {
    for (const cut of state.cuts) {
      if (video.currentTime >= cut.start && video.currentTime < cut.end - 0.05) {
        video.currentTime = cut.end;
        break;
      }
    }
  }

  function updateSelectionUI() {
    // Preserve scroll position across re-render
    const scrollTop = transcriptEl.scrollTop;
    renderTranscript();
    transcriptEl.scrollTop = scrollTop;

    const bar = document.getElementById('selection-bar');
    const info = document.getElementById('selection-info');
    const deleteBtn = document.getElementById('delete-selection-btn');
    const restoreBtn = document.getElementById('restore-selection-btn');
    if (state.selectionStart >= 0 && state.selectionEnd >= 0) {
      const count = state.selectionEnd - state.selectionStart + 1;
      // Check if any selected words are deleted (to show restore) or active (to show delete)
      let hasDeleted = false, hasActive = false;
      for (let i = state.selectionStart; i <= state.selectionEnd; i++) {
        if (isWordDeleted(i)) hasDeleted = true;
        else hasActive = true;
      }
      info.textContent = `${count} word${count > 1 ? 's' : ''} selected`;
      deleteBtn.style.display = hasActive ? '' : 'none';
      restoreBtn.style.display = hasDeleted ? '' : 'none';
      bar.classList.add('visible');
    } else {
      bar.classList.remove('visible');
    }
  }

  function deleteSelection() {
    if (state.selectionStart < 0) return;
    const words = state.transcript.words;
    let count = 0;
    for (let i = state.selectionStart; i <= state.selectionEnd; i++) {
      if (!isWordDeleted(i)) {
        state.cuts.push({ start: words[i].start, end: words[i].end });
        count++;
      }
    }
    mergeCuts();
    clearSelection();
    const scrollTop = transcriptEl.scrollTop;
    renderTranscript();
    transcriptEl.scrollTop = scrollTop;
    renderTimeline();
    if (count > 0) showToast(`Deleted ${count} word${count > 1 ? 's' : ''}`);
  }

  function restoreWord(idx) {
    const w = state.transcript.words[idx];
    // Find the cut containing this word and split it around the word
    const newCuts = [];
    for (const c of state.cuts) {
      if (w.start >= c.start && w.end <= c.end) {
        // This cut contains the word — split into before/after pieces
        if (c.start < w.start) newCuts.push({ start: c.start, end: w.start });
        if (w.end < c.end) newCuts.push({ start: w.end, end: c.end });
        // Word's range is excluded (restored)
      } else {
        newCuts.push(c);
      }
    }
    state.cuts = newCuts;
    const scrollTop = transcriptEl.scrollTop;
    renderTranscript();
    transcriptEl.scrollTop = scrollTop;
    renderTimeline();
    showToast(`Restored "${w.text}"`);
  }

  function restoreSelection() {
    if (state.selectionStart < 0) return;
    let count = 0;
    for (let i = state.selectionStart; i <= state.selectionEnd; i++) {
      if (isWordDeleted(i)) {
        const w = state.transcript.words[i];
        const newCuts = [];
        for (const c of state.cuts) {
          if (w.start >= c.start && w.end <= c.end) {
            if (c.start < w.start) newCuts.push({ start: c.start, end: w.start });
            if (w.end < c.end) newCuts.push({ start: w.end, end: c.end });
          } else {
            newCuts.push(c);
          }
        }
        state.cuts = newCuts;
        count++;
      }
    }
    clearSelection();
    const scrollTop = transcriptEl.scrollTop;
    renderTranscript();
    transcriptEl.scrollTop = scrollTop;
    renderTimeline();
    if (count > 0) showToast(`Restored ${count} word${count > 1 ? 's' : ''}`);
  }

  function restoreAll() {
    if (state.cuts.length === 0) return;
    state.cuts = [];
    clearSelection();
    const scrollTop = transcriptEl.scrollTop;
    renderTranscript();
    transcriptEl.scrollTop = scrollTop;
    renderTimeline();
    showToast('All words restored');
  }

  function clearSelection() {
    state.selectionStart = -1;
    state.selectionEnd = -1;
    document.getElementById('selection-bar').classList.remove('visible');
    const scrollTop = transcriptEl.scrollTop;
    renderTranscript();
    transcriptEl.scrollTop = scrollTop;
  }

  // Copy transcript (non-deleted words) to clipboard
  function copyTranscript() {
    const words = state.transcript.words;
    const text = words.filter((_, i) => !isWordDeleted(i)).map(w => w.text).join(' ');
    navigator.clipboard.writeText(text).then(() => {
      showToast('Transcript copied to clipboard');
    }).catch(() => {
      showToast('Failed to copy — try again');
    });
  }

  // Timeline body click to seek
  document.getElementById('timeline-body').addEventListener('click', (e) => {
    const body = document.getElementById('timeline-body');
    const rect = body.getBoundingClientRect();
    const x = e.clientX - rect.left + body.scrollLeft - 16;
    const pxPerSec = 8 * state.zoom;
    const time = x / pxPerSec;
    if (time >= 0 && time <= video.duration) video.currentTime = time;
  });

  // Export
  async function handleExport() {
    const modal = document.getElementById('export-modal');
    const bar = document.getElementById('export-progress');
    const result = document.getElementById('export-result');
    modal.classList.add('visible');
    result.style.display = 'none';
    bar.style.width = '20%';

    try {
      bar.style.width = '50%';
      const resp = await fetch('/api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoId: state.videoId, cuts: state.cuts }),
      });
      bar.style.width = '90%';
      if (!resp.ok) throw new Error((await resp.json()).error);
      const data = await resp.json();
      bar.style.width = '100%';
      document.getElementById('modal-title').textContent = 'Export Complete!';
      document.getElementById('download-link').href = `/api/media/${data.filename}`;
      result.style.display = 'block';
    } catch (err) {
      document.getElementById('modal-title').textContent = 'Export Failed: ' + err.message;
    }
  }
}

// ─── Utilities ─────────────────────────────────────────────
function isWordDeleted(idx) {
  const w = state.transcript.words[idx];
  return state.cuts.some(c => w.start >= c.start && w.end <= c.end);
}

function mergeCuts() {
  state.cuts.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const c of state.cuts) {
    if (merged.length && c.start <= merged[merged.length - 1].end + 0.01) {
      merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, c.end);
    } else {
      merged.push({ ...c });
    }
  }
  state.cuts = merged;
}

function fmtTime(s) {
  if (!s || isNaN(s)) return '00:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
}

function escHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function showToast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('visible');
  setTimeout(() => t.classList.remove('visible'), 2000);
}

// ─── Boot ──────────────────────────────────────────────────
renderImportScreen();
