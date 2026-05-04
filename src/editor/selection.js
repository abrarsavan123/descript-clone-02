// ─── Selection, Drag-to-Select, Context Popup ──────────────────────
import { state, isWordDeleted, mergeCuts } from '../state.js';
import { escHtml, showToast } from '../utils.js';
import { renderTranscript } from './transcript.js';
import { renderTimeline } from './timeline.js';
import { seekTo } from './video.js';

let isDragging = false;
let dragAnchorIdx = -1;

export function initSelection() {
  const transcriptEl = document.getElementById('transcript');

  transcriptEl.addEventListener('mousedown', (e) => {
    const wordEl = e.target.closest('.word');
    if (!wordEl) return;
    const idx = parseInt(wordEl.dataset.idx);

    // Click deleted word → restore it
    if (isWordDeleted(idx) && !e.shiftKey) {
      restoreWord(idx);
      return;
    }

    e.preventDefault();

    if (e.shiftKey && state.selectionStart >= 0) {
      state.selectionEnd = idx;
      if (state.selectionEnd < state.selectionStart) {
        [state.selectionStart, state.selectionEnd] = [state.selectionEnd, state.selectionStart];
      }
      updateSelectionUI();
      showContextPopup();
    } else {
      isDragging = true;
      dragAnchorIdx = idx;
      state.selectionStart = idx;
      state.selectionEnd = idx;
      hideContextPopup();
      seekTo(state.transcript.words[idx].start);
      updateSelectionUI();
    }
  });

  transcriptEl.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const wordEl = e.target.closest('.word');
    if (!wordEl) return;
    const idx = parseInt(wordEl.dataset.idx);
    state.selectionStart = Math.min(dragAnchorIdx, idx);
    state.selectionEnd = Math.max(dragAnchorIdx, idx);
    updateSelectionUI();
  });

  document.addEventListener('mouseup', () => {
    if (!isDragging) return;
    isDragging = false;
    if (state.selectionStart >= 0 && state.selectionEnd >= 0) {
      showContextPopup();
    }
  });
}

// ── Context Popup ──

export function showContextPopup() {
  const popup = document.getElementById('context-popup');
  const transcriptEl = document.getElementById('transcript');
  if (!popup || !transcriptEl || state.selectionStart < 0 || state.selectionEnd < 0) return;

  const lastWordEl = transcriptEl.querySelector(`.word[data-idx="${state.selectionEnd}"]`);
  if (!lastWordEl) return;

  const wordRect = lastWordEl.getBoundingClientRect();
  const containerRect = document.querySelector('.editor').getBoundingClientRect();

  popup.style.top = (wordRect.bottom - containerRect.top + 8) + 'px';
  popup.style.left = (wordRect.left - containerRect.left) + 'px';

  const count = state.selectionEnd - state.selectionStart + 1;
  document.getElementById('popup-info').textContent = `${count} word${count > 1 ? 's' : ''}`;

  let hasDeleted = false, hasActive = false;
  for (let i = state.selectionStart; i <= state.selectionEnd; i++) {
    if (isWordDeleted(i)) hasDeleted = true;
    else hasActive = true;
  }
  document.getElementById('popup-delete-btn').style.display = hasActive ? '' : 'none';
  document.getElementById('popup-restore-btn').style.display = hasDeleted ? '' : 'none';

  popup.classList.add('visible');
}

export function hideContextPopup() {
  const popup = document.getElementById('context-popup');
  if (popup) popup.classList.remove('visible');
}

// ── Delete / Restore ──

export function deleteSelection() {
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
  rerender();
  if (count > 0) showToast(`Deleted ${count} word${count > 1 ? 's' : ''}`);
}

export function restoreWord(idx) {
  const w = state.transcript.words[idx];
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
  rerender();
  showToast(`Restored "${w.text}"`);
}

export function restoreSelection() {
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
  rerender();
  if (count > 0) showToast(`Restored ${count} word${count > 1 ? 's' : ''}`);
}

export function restoreAll() {
  if (state.cuts.length === 0) return;
  state.cuts = [];
  clearSelection();
  rerender();
  showToast('All words restored');
}

export function clearSelection() {
  state.selectionStart = -1;
  state.selectionEnd = -1;
  document.getElementById('selection-bar')?.classList.remove('visible');
  hideContextPopup();
  const transcriptEl = document.getElementById('transcript');
  if (transcriptEl) {
    const scrollTop = transcriptEl.scrollTop;
    renderTranscript();
    transcriptEl.scrollTop = scrollTop;
  }
}

export function updateSelectionUI() {
  const transcriptEl = document.getElementById('transcript');
  if (!transcriptEl) return;

  const scrollTop = transcriptEl.scrollTop;
  renderTranscript();
  transcriptEl.scrollTop = scrollTop;

  const bar = document.getElementById('selection-bar');
  const info = document.getElementById('selection-info');
  const deleteBtn = document.getElementById('delete-selection-btn');
  const restoreBtn = document.getElementById('restore-selection-btn');

  if (state.selectionStart >= 0 && state.selectionEnd >= 0) {
    const count = state.selectionEnd - state.selectionStart + 1;
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

export function copyTranscript() {
  const words = state.transcript.words;
  const text = words.filter((_, i) => !isWordDeleted(i)).map(w => w.text).join(' ');
  navigator.clipboard.writeText(text).then(() => {
    showToast('Transcript copied to clipboard');
  }).catch(() => {
    showToast('Failed to copy — try again');
  });
}

// Re-render both transcript and timeline (preserves scroll)
function rerender() {
  const transcriptEl = document.getElementById('transcript');
  if (transcriptEl) {
    const scrollTop = transcriptEl.scrollTop;
    renderTranscript();
    transcriptEl.scrollTop = scrollTop;
  }
  renderTimeline();
}
