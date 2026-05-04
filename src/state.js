// ─── Shared Application State ──────────────────────────────────────
export const state = {
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

// ─── State Helpers ─────────────────────────────────────────────────

export function isWordDeleted(idx) {
  const w = state.transcript.words[idx];
  return state.cuts.some(c => w.start >= c.start && w.end <= c.end);
}

export function mergeCuts() {
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
