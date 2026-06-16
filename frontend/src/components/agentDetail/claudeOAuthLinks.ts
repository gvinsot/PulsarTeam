/**
 * Claude Code CLI OAuth link reconstruction.
 *
 * The CLI prints its /login authorization URL wrapped across multiple
 * terminal lines, so a naive linkifier only captures the first fragment.
 * Two deliberately separate flavors live here side by side:
 *
 *   • xterm-buffer flavor (createClaudeOAuthLinkProvider /
 *     reconstructClaudeOAuthUrlFromBuffer): gates on the https-only
 *     CLAUDE_OAUTH_PREFIX and caps continuation at
 *     CLAUDE_OAUTH_MAX_CONTINUATION_LINES.
 *
 *   • plain-text flavor (reconstructWrappedOAuthUrlsInText, used by
 *     ChatMessage): matches an `https?` regex with no prefix gate and
 *     consumes lines until a blank line/EOF — it also rewraps http:// URLs
 *     the xterm flavor ignores. Do NOT unify the two, and do not derive the
 *     regexes from CLAUDE_OAUTH_PREFIX (the constant is https-only).
 */
import type { Terminal as XTerminal, ILink, ILinkProvider } from '@xterm/xterm';

export const CLAUDE_OAUTH_PREFIX = 'https://claude.com/cai/oauth/authorize?code=';
// The interactive `claude` CLI prints a *claude.ai* authorize URL (different
// host + query shape than the claude.com/cai variant above). Both wrap across
// terminal lines and need reconstruction, so gate the buffer-flavor helpers on
// either marker. CLAUDE_OAUTH_PREFIX stays the canonical https-only constant.
export const CLAUDE_OAUTH_PREFIXES = [
  CLAUDE_OAUTH_PREFIX,
  'https://claude.ai/oauth/authorize?',
];
// Start of either authorize-URL flavor (http or https) plus its non-whitespace
// remainder — used to grab the first wrapped fragment off the buffer line.
const CLAUDE_OAUTH_URL_RE = /^https?:\/\/(?:claude\.com\/cai\/oauth\/authorize\?code=|claude\.ai\/oauth\/authorize\?)\S*/;
const CLAUDE_OAUTH_MAX_CONTINUATION_LINES = 32;
const CLAUDE_OAUTH_FALLBACK_SEARCH_LINES = 500;

// Index of the earliest OAuth marker (either flavor) on a line, or -1.
function oauthMarkerIndex(line: string): number {
  let best = -1;
  for (const prefix of CLAUDE_OAUTH_PREFIXES) {
    const idx = line.indexOf(prefix);
    if (idx >= 0 && (best < 0 || idx < best)) best = idx;
  }
  return best;
}

export function openExternalLink(uri: string) {
  const opened = window.open('');
  if (opened) {
    try { opened.opener = null; } catch { /* noop */ }
    opened.location.href = uri;
  } else {
    console.warn('Opening link blocked as opener could not be cleared');
  }
}

function getTerminalLine(term: XTerminal, y: number) {
  return term.buffer.active.getLine(y)?.translateToString(true) ?? '';
}

function firstNonWhitespaceIndex(line: string) {
  return line.search(/\S/);
}

function buildClaudeOAuthLink(term: XTerminal, startLine: number, firstLine = getTerminalLine(term, startLine)): ILink | undefined {
  const markerIndex = oauthMarkerIndex(firstLine);
  if (markerIndex < 0) return undefined;

  const initialMatch = firstLine.slice(markerIndex).match(CLAUDE_OAUTH_URL_RE);
  if (!initialMatch) return undefined;

  let url = initialMatch[0];
  let endLine = startLine;
  let endColumn = markerIndex + initialMatch[0].length;

  for (
    let y = startLine + 1, consumed = 0;
    y < term.buffer.active.length && consumed < CLAUDE_OAUTH_MAX_CONTINUATION_LINES;
    y += 1, consumed += 1
  ) {
    const line = getTerminalLine(term, y);
    const trimmed = line.trim();
    if (!trimmed) break;
    const textStart = firstNonWhitespaceIndex(line);
    url += trimmed;
    endLine = y;
    endColumn = textStart + trimmed.length;
  }

  return {
    range: {
      start: { x: markerIndex + 1, y: startLine + 1 },
      end: { x: Math.max(1, endColumn + 1), y: endLine + 1 },
    },
    text: url,
    activate: (event, text) => {
      event.preventDefault();
      openExternalLink(text);
    },
  };
}

export function createClaudeOAuthLinkProvider(term: XTerminal): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      const startLine = bufferLineNumber - 1;
      const line = getTerminalLine(term, startLine);
      const link = oauthMarkerIndex(line) >= 0
        ? buildClaudeOAuthLink(term, startLine, line)
        : undefined;
      callback(link ? [link] : undefined);
    },
  };
}

export function reconstructClaudeOAuthUrlFromBuffer(term: XTerminal, uri: string) {
  if (!CLAUDE_OAUTH_PREFIXES.some((p) => uri.startsWith(p))) return uri;
  const buffer = term.buffer.active;
  const earliestLine = Math.max(0, buffer.length - CLAUDE_OAUTH_FALLBACK_SEARCH_LINES);
  for (let y = buffer.length - 1; y >= earliestLine; y -= 1) {
    const line = getTerminalLine(term, y);
    if (oauthMarkerIndex(line) < 0) continue;
    const link = buildClaudeOAuthLink(term, y, line);
    if (link?.text.startsWith(uri)) return link.text;
  }
  return uri;
}

// Reconstruct Claude Code CLI OAuth URLs that get wrapped across multiple lines
// in plain text output (chat transcripts). The CLI prints something like:
//   https://claude.com/cai/oauth/authorize?code=
//   abc123def
//   ghi456jkl
//
// We join the URL prefix with the following non-empty trimmed lines until a
// blank line is encountered, producing a single URL.
export function reconstructWrappedOAuthUrlsInText(text) {
  if (typeof text !== 'string') return text;
  const marker = /https?:\/\/(?:claude\.com\/cai\/oauth\/authorize\?code=|claude\.ai\/oauth\/authorize\?)\S*/g;
  let result = '';
  let lastIdx = 0;
  let m;
  while ((m = marker.exec(text)) !== null) {
    result += text.slice(lastIdx, m.index);
    let url = m[0];
    let i = m.index + m[0].length;
    // Continue consuming subsequent non-empty lines up to the next blank line.
    // Claude Code may leave trailing spaces after `code=` or indent wrapped lines.
    while (i < text.length) {
      const leadingWhitespaceAndNewlineLength = text.slice(i).match(/^[^\S\n]*\n/)?.[0].length;
      if (leadingWhitespaceAndNewlineLength === undefined) break;
      const lineStart = i + leadingWhitespaceAndNewlineLength;
      let j = lineStart;
      while (j < text.length && text[j] !== '\n') j++;
      const line = text.slice(lineStart, j);
      const trimmed = line.trim();
      if (trimmed === '') break;
      url += trimmed;
      i = j;
    }
    result += url;
    lastIdx = i;
    marker.lastIndex = i;
  }
  result += text.slice(lastIdx);
  return result;
}
