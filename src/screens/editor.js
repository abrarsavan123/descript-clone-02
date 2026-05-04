// ─── Editor Screen ─────────────────────────────────────────────────
import { state, isWordDeleted } from '../state.js';
import { escHtml, showToast } from '../utils.js';
import { renderImportScreen } from './import.js';
import { renderTranscript, setFollowPlayback, getFollowPlayback } from '../editor/transcript.js';
import { renderTimeline } from '../editor/timeline.js';
import { initVideoControls, seekTo } from '../editor/video.js';
import { initSelection, deleteSelection, restoreSelection, restoreAll, clearSelection, updateSelectionUI, showContextPopup, hideContextPopup, copyTranscript } from '../editor/selection.js';
import { handleExport } from '../editor/export.js';

export function renderEditor() {
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
      <div class="context-popup" id="context-popup">
        <span id="popup-info"></span>
        <button id="popup-delete-btn">🗑 Delete</button>
        <button id="popup-restore-btn">↩ Restore</button>
        <button id="popup-copy-btn">📋 Copy</button>
        <button id="popup-close-btn">✕</button>
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
              <button id="follow-btn" class="follow-btn">Follow ▸</button>
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

  initEditorBindings();
}

function initEditorBindings() {
  const video = document.getElementById('video');

  // Initialize sub-modules
  renderTranscript();
  renderTimeline();
  initVideoControls();
  initSelection();

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
    if (e.key === 'j') video.currentTime = Math.max(0, video.currentTime - 5);
    if (e.key === 'l') video.currentTime = Math.min(video.duration, video.currentTime + 5);
  });

  // ── Button handlers ──
  document.getElementById('delete-selection-btn').onclick = () => { deleteSelection(); hideContextPopup(); };
  document.getElementById('restore-selection-btn').onclick = () => { restoreSelection(); hideContextPopup(); };
  document.getElementById('clear-selection-btn').onclick = () => { clearSelection(); hideContextPopup(); };
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
    showContextPopup();
  };
  document.getElementById('copy-transcript-btn').onclick = copyTranscript;
  document.getElementById('follow-btn').onclick = () => {
    const newVal = !getFollowPlayback();
    setFollowPlayback(newVal);
    const btn = document.getElementById('follow-btn');
    btn.classList.toggle('active', newVal);
    btn.textContent = newVal ? 'Follow ◼' : 'Follow ▸';
    showToast(newVal ? 'Auto-follow ON' : 'Auto-follow OFF');
  };

  // ── Context popup buttons ──
  document.getElementById('popup-delete-btn').onclick = () => { deleteSelection(); hideContextPopup(); };
  document.getElementById('popup-restore-btn').onclick = () => { restoreSelection(); hideContextPopup(); };
  document.getElementById('popup-copy-btn').onclick = () => {
    if (state.selectionStart < 0) return;
    const words = state.transcript.words;
    const text = [];
    for (let i = state.selectionStart; i <= state.selectionEnd; i++) {
      if (!isWordDeleted(i)) text.push(words[i].text);
    }
    navigator.clipboard.writeText(text.join(' ')).then(() => showToast('Copied!')).catch(() => {});
    hideContextPopup();
  };
  document.getElementById('popup-close-btn').onclick = () => { clearSelection(); hideContextPopup(); };

  // ── Timeline zoom ──
  document.getElementById('zoom-in').onclick = () => { state.zoom = Math.min(state.zoom * 1.5, 10); renderTimeline(); };
  document.getElementById('zoom-out').onclick = () => { state.zoom = Math.max(state.zoom / 1.5, 0.3); renderTimeline(); };

  // ── Timeline click to seek ──
  document.getElementById('timeline-body').addEventListener('click', (e) => {
    const body = document.getElementById('timeline-body');
    const rect = body.getBoundingClientRect();
    const x = e.clientX - rect.left + body.scrollLeft - 16;
    const pxPerSec = 8 * state.zoom;
    const time = x / pxPerSec;
    if (time >= 0 && time <= video.duration) seekTo(time);
  });
}
