// ─── Export Modal Handler ──────────────────────────────────────────
import { state } from '../state.js';

export async function handleExport() {
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
