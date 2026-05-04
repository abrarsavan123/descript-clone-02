// ─── Video Controls & Playback Loop ────────────────────────────────
import { state } from '../state.js';
import { fmtTime } from '../utils.js';
import { highlightActiveWord } from './transcript.js';
import { updatePlayhead } from './timeline.js';

let rafId = null;

// Fast seek helper — uses fastSeek() when available
export function seekTo(time) {
  const video = document.getElementById('video');
  if (!video) return;
  if (video.fastSeek) video.fastSeek(time);
  else video.currentTime = time;
  updateUI();
}

export function initVideoControls() {
  const video = document.getElementById('video');
  const playBtn = document.getElementById('play-btn');
  const playIcon = document.getElementById('play-icon');
  const pauseIcon = document.getElementById('pause-icon');
  const seekBar = document.getElementById('seek-bar');
  const volumeSlider = document.getElementById('volume');

  playBtn.onclick = () => video.paused ? video.play() : video.pause();
  video.onplay = () => {
    playIcon.style.display = 'none';
    pauseIcon.style.display = 'block';
    state.isPlaying = true;
    startRAFLoop();
  };
  video.onpause = () => {
    playIcon.style.display = 'block';
    pauseIcon.style.display = 'none';
    state.isPlaying = false;
  };
  volumeSlider.oninput = () => { video.volume = volumeSlider.value; };

  seekBar.onclick = (e) => {
    const rect = seekBar.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    seekTo(pct * video.duration);
  };

  // Fallback listeners
  video.ontimeupdate = () => updateUI();
  video.onseeked = () => updateUI();

  if (!video.paused) startRAFLoop();
}

// 60fps render loop
function startRAFLoop() {
  if (rafId) return;
  function tick() {
    updateUI();
    rafId = requestAnimationFrame(tick);
  }
  rafId = requestAnimationFrame(tick);
}

function updateUI() {
  const video = document.getElementById('video');
  if (!video || !video.duration) return;

  const pct = (video.currentTime / video.duration) * 100;
  const seekFill = document.getElementById('seek-fill');
  const timeDisplay = document.getElementById('time-display');
  if (seekFill) seekFill.style.width = pct + '%';
  if (timeDisplay) timeDisplay.textContent = `${fmtTime(video.currentTime)} / ${fmtTime(video.duration)}`;

  highlightActiveWord();
  updatePlayhead();
  enforceCuts();
}

function enforceCuts() {
  const video = document.getElementById('video');
  if (!video) return;
  for (const cut of state.cuts) {
    if (video.currentTime >= cut.start && video.currentTime < cut.end - 0.05) {
      video.currentTime = cut.end;
      break;
    }
  }
}
