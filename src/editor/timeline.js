// ─── Timeline & Waveform Rendering ─────────────────────────────────
import { state, isWordDeleted } from '../state.js';
import { fmtTime, escHtml } from '../utils.js';

export function renderTimeline() {
  const video = document.getElementById('video');
  const dur = state.duration || (video ? video.duration : 60) || 60;
  const pxPerSec = 8 * state.zoom;
  const totalWidth = dur * pxPerSec;
  const track = document.getElementById('timeline-track');
  const ruler = document.getElementById('time-ruler');
  const canvas = document.getElementById('waveform-canvas');

  if (!track || !ruler) return;

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

  // Waveform canvas
  const trackHeight = track.clientHeight || 70;
  canvas.width = totalWidth;
  canvas.height = trackHeight;
  canvas.style.width = totalWidth + 'px';
  canvas.style.height = trackHeight + 'px';

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (state.waveformData && state.waveformData.peaks.length > 0) {
    const peaks = state.waveformData.peaks;
    const peaksPerSec = state.waveformData.sampleRate;
    const midY = trackHeight / 2;

    // Draw waveform peaks
    for (let px = 0; px < totalWidth; px++) {
      const timeSec = px / pxPerSec;
      const peakIdx = Math.floor(timeSec * peaksPerSec);
      if (peakIdx >= peaks.length) break;

      const amplitude = peaks[peakIdx];
      const barH = Math.max(amplitude * midY * 0.9, 0.5);

      const isInCut = state.cuts.some(c => timeSec >= c.start && timeSec < c.end);

      if (isInCut) {
        ctx.fillStyle = 'rgba(255, 107, 107, 0.25)';
      } else {
        const alpha = 0.3 + amplitude * 0.5;
        ctx.fillStyle = `rgba(108, 92, 231, ${alpha})`;
      }

      ctx.fillRect(px, midY - barH, 1, barH * 2);
    }

    // Center line
    ctx.strokeStyle = 'rgba(139, 146, 168, 0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(totalWidth, midY);
    ctx.stroke();

    // Scene cut markers
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

    // Word text labels (when zoomed in)
    if (pxPerSec > 12) {
      ctx.font = '9px Inter, sans-serif';
      ctx.textBaseline = 'bottom';
      state.transcript.words.forEach((w, i) => {
        const x = w.start * pxPerSec;
        const width = (w.end - w.start) * pxPerSec;
        if (width > 18) {
          ctx.fillStyle = isWordDeleted(i) ? 'rgba(255, 107, 107, 0.35)' : 'rgba(232, 234, 240, 0.6)';
          ctx.fillText(w.text, x + 2, trackHeight - 3, width - 4);
        }
      });
    }
  } else {
    // Fallback: draw word clips
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

export function updatePlayhead() {
  const video = document.getElementById('video');
  if (!video) return;

  const dur = state.duration || video.duration || 60;
  const pxPerSec = 8 * state.zoom;
  const ph = document.getElementById('playhead');
  if (ph) ph.style.left = (16 + video.currentTime * pxPerSec) + 'px';

  // Auto scroll timeline
  const body = document.getElementById('timeline-body');
  if (body) {
    const phPos = video.currentTime * pxPerSec;
    if (phPos > body.scrollLeft + body.clientWidth * 0.8) {
      body.scrollLeft = phPos - body.clientWidth * 0.3;
    }
  }
}
