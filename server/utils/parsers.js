// ─── Noise Filtering ──────────────────────────────────────────────

const NOISE_PATTERNS = /^\[.*\]$|^>>$|^♪+$|^-+$/;

export function isNoise(text) {
  return NOISE_PATTERNS.test(text.trim());
}

export function countSpeechWords(words) {
  return words.filter(w => !isNoise(w.text)).length;
}

export function filterNoiseWords(result) {
  const filteredWords = result.words.filter(w => !isNoise(w.text));
  if (filteredWords.length === 0) return result;
  const filteredText = filteredWords.map(w => w.text).join(' ');
  const segments = [];
  let segWords = [];
  for (let i = 0; i < filteredWords.length; i++) {
    segWords.push(filteredWords[i]);
    const gap = i < filteredWords.length - 1 ? filteredWords[i + 1].start - filteredWords[i].end : 999;
    if (gap > 2 || i === filteredWords.length - 1) {
      segments.push({
        text: segWords.map(w => w.text).join(' '),
        start: segWords[0].start,
        end: segWords[segWords.length - 1].end,
      });
      segWords = [];
    }
  }
  return { text: filteredText, words: filteredWords, segments, duration: result.duration };
}

// ─── srv3 Parser ──────────────────────────────────────────────────
// Format A (auto-generated): <p t="baseMs" d="durationMs"><s>word</s><s t="offsetMs">word2</s></p>
// Format B (manual/fallback): <p t="baseMs" d="durationMs">phrase text</p>

export function parseSrv3(xmlContent) {
  const words = [];
  const segments = [];
  let fullText = '';

  const pRegex = /<p\s+([^>]*)>((?:.|\n)*?)<\/p>/g;
  let pMatch;

  while ((pMatch = pRegex.exec(xmlContent)) !== null) {
    const attrs = pMatch[1];
    const content = pMatch[2];

    const tMatch = attrs.match(/\bt="(\d+)"/);
    const dMatch = attrs.match(/\bd="(\d+)"/);
    if (!tMatch) continue;

    const baseTimeMs = parseInt(tMatch[1]);
    const durationMs = dMatch ? parseInt(dMatch[1]) : 3000;

    const trimmed = content.replace(/\n/g, ' ').trim();
    if (!trimmed) continue;

    const hasSwordTags = /<s[\s>]/.test(content);
    const lineWords = [];

    if (hasSwordTags) {
      const sRegex = /<s(?:\s+t="(\d+)")?>(.*?)<\/s>/g;
      let sMatch;
      while ((sMatch = sRegex.exec(content)) !== null) {
        const offsetMs = sMatch[1] ? parseInt(sMatch[1]) : 0;
        let text = sMatch[2].trim();
        text = decodeEntities(text);
        if (!text) continue;

        const wordStartMs = baseTimeMs + offsetMs;
        lineWords.push({
          text,
          start: Math.round(wordStartMs / 10) / 100,
          end: 0,
        });
      }
    } else {
      let text = trimmed;
      text = decodeEntities(text);
      const wordList = text.split(/\s+/).filter(w => w.length > 0);
      const wordDur = durationMs / Math.max(wordList.length, 1);
      for (let j = 0; j < wordList.length; j++) {
        const wordStartMs = baseTimeMs + j * wordDur;
        lineWords.push({
          text: wordList[j],
          start: Math.round(wordStartMs / 10) / 100,
          end: 0,
        });
      }
    }

    for (let i = 0; i < lineWords.length; i++) {
      if (i < lineWords.length - 1) {
        lineWords[i].end = lineWords[i + 1].start;
      } else {
        lineWords[i].end = Math.round((baseTimeMs + durationMs) / 10) / 100;
      }
    }

    if (lineWords.length > 0) {
      words.push(...lineWords);
      const segText = lineWords.map(w => w.text).join(' ');
      fullText += segText + ' ';
      segments.push({
        text: segText,
        start: lineWords[0].start,
        end: lineWords[lineWords.length - 1].end,
      });
    }
  }

  for (let i = 0; i < words.length - 1; i++) {
    if (words[i + 1].start > words[i].start && words[i + 1].start < words[i].end + 2) {
      words[i].end = words[i + 1].start;
    }
  }

  const duration = words.length > 0 ? words[words.length - 1].end : 0;
  return { text: fullText.trim(), words, segments, duration };
}

// ─── json3 Parser ─────────────────────────────────────────────────

export function parseJson3(data) {
  const words = [];
  const segments = [];
  let fullText = '';

  if (!data.events) return { text: '', words: [], segments: [], duration: 0 };

  for (const event of data.events) {
    if (!event.segs) continue;
    const eventStart = (event.tStartMs || 0) / 1000;
    let segText = '';
    for (const seg of event.segs) {
      const text = seg.utf8?.trim();
      if (!text || text === '\n') continue;
      const segWords = text.split(/\s+/).filter(w => w.length > 0);
      const segStartSec = eventStart + (seg.tOffsetMs || 0) / 1000;
      const wordDur = 0.3;
      segWords.forEach((w, j) => {
        words.push({
          text: w,
          start: Math.round((segStartSec + j * wordDur) * 100) / 100,
          end: Math.round((segStartSec + (j + 1) * wordDur) * 100) / 100,
        });
      });
      segText += text + ' ';
      fullText += text + ' ';
    }
    if (segText.trim()) {
      const segEnd = eventStart + (event.dDurationMs || 3000) / 1000;
      segments.push({ text: segText.trim(), start: eventStart, end: segEnd });
    }
  }

  for (let i = 0; i < words.length - 1; i++) {
    if (words[i + 1].start > words[i].start) words[i].end = words[i + 1].start;
  }

  const duration = words.length > 0 ? words[words.length - 1].end : 0;
  return { text: fullText.trim(), words, segments, duration };
}

// ─── VTT Parser ───────────────────────────────────────────────────

export function parseVTT(vttContent) {
  const words = [];
  const segments = [];
  let fullText = '';

  const lines = vttContent.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();

    const tsMatch = line.match(/(\d+:\d+:\d+\.\d+)\s*-->\s*(\d+:\d+:\d+\.\d+)/);
    if (tsMatch) {
      const start = parseVTTTime(tsMatch[1]);
      const end = parseVTTTime(tsMatch[2]);
      i++;

      let text = '';
      while (i < lines.length && lines[i].trim() !== '') {
        text += lines[i].trim() + ' ';
        i++;
      }

      text = text.replace(/<[^>]*>/g, '').trim();
      if (!text) continue;

      const wordList = text.split(/\s+/).filter(w => w.length > 0);
      const wordDur = (end - start) / Math.max(wordList.length, 1);

      for (let j = 0; j < wordList.length; j++) {
        const wStart = start + j * wordDur;
        const wEnd = start + (j + 1) * wordDur;
        words.push({
          text: wordList[j],
          start: Math.round(wStart * 100) / 100,
          end: Math.round(wEnd * 100) / 100,
        });
      }

      segments.push({ text, start, end });
      fullText += text + ' ';
    }

    i++;
  }

  // Deduplicate words (VTT often has overlapping cues)
  const deduped = [];
  for (const w of words) {
    const last = deduped[deduped.length - 1];
    if (!last || w.start >= last.end - 0.05 || w.text !== last.text) {
      deduped.push(w);
    }
  }

  const duration = deduped.length > 0 ? deduped[deduped.length - 1].end : 0;
  return { text: fullText.trim(), words: deduped, segments, duration };
}

// ─── Helpers ──────────────────────────────────────────────────────

function parseVTTTime(str) {
  const parts = str.split(':');
  const h = parseInt(parts[0]);
  const m = parseInt(parts[1]);
  const s = parseFloat(parts[2]);
  return h * 3600 + m * 60 + s;
}

function decodeEntities(text) {
  return text.replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
}
