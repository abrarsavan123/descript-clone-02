// ─── Transcript Rendering & Highlighting ───────────────────────────
import { state, isWordDeleted } from '../state.js';
import { escHtml } from '../utils.js';

let prevActiveIdx = -1;
let followPlayback = false;

export function setFollowPlayback(val) { followPlayback = val; }
export function getFollowPlayback() { return followPlayback; }

export function getSceneIndex(wordStart) {
  if (!state.sceneCuts || state.sceneCuts.length <= 1) return 0;
  let sceneIdx = 0;
  for (let i = 1; i < state.sceneCuts.length; i++) {
    if (wordStart >= state.sceneCuts[i]) sceneIdx = i;
    else break;
  }
  return sceneIdx;
}

export function renderTranscript() {
  const transcriptEl = document.getElementById('transcript');
  if (!transcriptEl) return;

  const words = state.transcript.words;
  let html = '';
  let inParagraph = false;

  words.forEach((w, i) => {
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

export function highlightActiveWord() {
  const video = document.getElementById('video');
  const transcriptEl = document.getElementById('transcript');
  if (!video || !transcriptEl) return;

  const time = video.currentTime;
  const idx = findActiveWordIndex(time);

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

      if (state.isPlaying) {
        const elTop = el.offsetTop;
        const viewBottom = transcriptEl.scrollTop + transcriptEl.clientHeight;

        // Teleprompter: only scroll forward when word reaches bottom edge
        if (elTop > viewBottom - 80) {
          transcriptEl.scrollTo({ top: elTop - transcriptEl.clientHeight + 120, behavior: 'smooth' });
        }

        // Follow mode: also scroll up if word is above the visible area
        if (followPlayback && elTop < transcriptEl.scrollTop) {
          transcriptEl.scrollTo({ top: elTop - 40, behavior: 'smooth' });
        }
      }
    }
  }

  prevActiveIdx = idx;
}

// Binary search — O(log n)
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
