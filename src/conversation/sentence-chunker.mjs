const ABBREVIATIONS = new Set(['dr.', 'mr.', 'mrs.', 'ms.', 'prof.', 'sr.', 'jr.', 'vs.', 'etc.', 'e.g.', 'i.e.']);

export function createSentenceChunker({ maxChars = 220 } = {}) {
  if (!Number.isInteger(maxChars) || maxChars < 1) throw new Error('maxChars must be a positive integer');
  let buffer = '';

  return { push, flush, reset };

  function push(delta) {
    if (typeof delta !== 'string' || !delta) return [];
    buffer += delta;
    return drain(false);
  }

  function flush() {
    return drain(true);
  }

  function reset() {
    buffer = '';
  }

  function drain(includeRemainder) {
    const chunks = [];
    while (buffer.trim()) {
      const sentenceEnd = findSentenceEnd(buffer);
      if (sentenceEnd > 0) {
        chunks.push(buffer.slice(0, sentenceEnd).trim());
        buffer = buffer.slice(sentenceEnd).replace(/^\s+/, '');
        continue;
      }

      if (buffer.length > maxChars) {
        const cut = findWordBoundary(buffer, maxChars);
        if (cut > 0) {
          chunks.push(buffer.slice(0, cut).trim());
          buffer = buffer.slice(cut).replace(/^\s+/, '');
          continue;
        }
      }
      break;
    }
    if (includeRemainder && buffer.trim()) {
      chunks.push(buffer.trim());
      buffer = '';
    }
    return chunks;
  }
}

function findSentenceEnd(text) {
  for (let index = 0; index < text.length; index += 1) {
    if (!'.!?'.includes(text[index])) continue;
    if (text[index] === '.' && isAbbreviation(text, index)) continue;
    const next = text[index + 1];
    if (!next || /\s/.test(next)) return index + 1;
  }
  return -1;
}

function isAbbreviation(text, periodIndex) {
  const word = text.slice(0, periodIndex + 1).trim().split(/\s+/).at(-1)?.toLowerCase();
  return ABBREVIATIONS.has(word) || (word?.length === 2 && /^[a-z]\.$/.test(word));
}

function findWordBoundary(text, maxChars) {
  const beforeLimit = text.lastIndexOf(' ', maxChars);
  return beforeLimit > 0 ? beforeLimit : text.indexOf(' ', maxChars);
}
