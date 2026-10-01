import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createClaudeOAuthLinkProvider,
  findLatestOAuthUrlInBuffer,
  reconstructClaudeOAuthUrlFromBuffer,
} from '../claudeOAuthLinks.ts';
import { extractLoopbackOAuthCallback } from '../cliOAuthCallback.ts';

// Minimal xterm stand-in: only what the link helpers read.
const fakeTerm = (lines: string[]) =>
  ({
    buffer: {
      active: {
        length: lines.length,
        getLine: (y: number) =>
          y >= 0 && y < lines.length ? { translateToString: () => lines[y] } : undefined,
      },
    },
  }) as any;

const linkAt = (lines: string[], bufferLine: number) =>
  new Promise<any>(resolve =>
    createClaudeOAuthLinkProvider(fakeTerm(lines)).provideLinks(bufferLine, links =>
      resolve(links?.[0])
    )
  );

// The codex TUI's sign-in screen as tmux repaints it: the authorize URL
// hard-wrapped at the pane width, padded with spaces, the hint right below.
const CODEX_URL =
  'https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_EMoamEEZ73f0CkXaXp7hrann' +
  '&redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback&code_challenge=s0MEEdlBlpWtLQGDbIbhz2' +
  '&code_challenge_method=S256&state=IF1hxAnp1kSkU0x&originator=codex-tui';
const CODEX_SCREEN = [
  "  Welcome to Codex, OpenAI's command-line coding agent",
  "  If the link doesn't open automatically, press c to copy it:",
  `  ${CODEX_URL.slice(0, 78)}`,
  `${CODEX_URL.slice(78, 158)}`,
  `${CODEX_URL.slice(158)}                    `,
  '  On a remote or headless machine? Press esc and choose Sign in with Device Code.',
  '  Press esc to cancel',
];

test('codex authorize URL is rebuilt across its wrapped lines', async () => {
  const link = await linkAt(CODEX_SCREEN, 3);
  assert.equal(link.text, CODEX_URL);
  assert.deepEqual(link.range.start, { x: 3, y: 3 });
  assert.equal(link.range.end.y, 5);
});

test('reconstruction stops at the hint line even with no blank line before it', async () => {
  const link = await linkAt(CODEX_SCREEN, 3);
  assert.ok(!link.text.includes('remote'));
});

test('a clicked codex fragment resolves to the full URL', () => {
  const fragment = CODEX_URL.slice(0, 78);
  assert.equal(reconstructClaudeOAuthUrlFromBuffer(fakeTerm(CODEX_SCREEN), fragment), CODEX_URL);
});

test('claude.ai authorize URLs still rebuild until the blank line', async () => {
  const url = 'https://claude.ai/oauth/authorize?code=true&client_id=abc&state=xyz';
  const link = await linkAt(
    ['Browser did not open?', url.slice(0, 40), url.slice(40), '', 'Paste code'],
    2
  );
  assert.equal(link.text, url);
});

const CALLBACK = 'http://127.0.0.1:1455/auth/callback?code=ac_abc&scope=openid&state=st_XYZ';

test('a pasted loopback callback is recognised, bracketed or not', () => {
  assert.equal(extractLoopbackOAuthCallback(CALLBACK), CALLBACK);
  assert.equal(extractLoopbackOAuthCallback(`\x1b[200~${CALLBACK}\n\x1b[201~`), CALLBACK);
  const fallback = 'http://localhost:1457/auth/callback?error=access_denied&state=s';
  assert.equal(extractLoopbackOAuthCallback(fallback), fallback);
});

test('anything else stays a keystroke', () => {
  for (const data of [
    'a',
    '\r',
    'https://example.com/auth/callback?code=c&state=s',
    'http://127.0.0.1:3000/auth/callback?code=c&state=s',
    'http://127.0.0.1:1455/auth/callback?code=c',
    'http://127.0.0.1:1455/success?code=c&state=s',
    `see ${CALLBACK}`,
  ]) {
    assert.equal(extractLoopbackOAuthCallback(data), null, JSON.stringify(data));
  }
});

// Claude Code /login on a 40-column phone grid: the URL hard-wrapped over
// many lines. A tap lands on any of them, not necessarily the first.
const CLAUDE_URL =
  'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e' +
  '&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback' +
  '&scope=org%3Acreate_api_key+user%3Aprofile&code_challenge=xhHKbY2M35wA7b&state=_IukpxHGE05hpL9';
const chunk = (s: string, n: number) => s.match(new RegExp(`.{1,${n}}`, 'g')) as string[];
const PHONE_SCREEN = [
  "Browser didn't open? Use the url below",
  ...chunk(CLAUDE_URL, 40),
  '',
  'Paste code here if prompted >',
];

test('claude: a tap on any continuation line yields the full URL', async () => {
  const urlLines = chunk(CLAUDE_URL, 40).length;
  for (let i = 0; i < urlLines; i += 1) {
    const link = await linkAt(PHONE_SCREEN, i + 2);
    assert.equal(link?.text, CLAUDE_URL, `line ${i}`);
    assert.equal(link.range.start.y, 2);
  }
  assert.equal(await linkAt(PHONE_SCREEN, urlLines + 3), undefined);
  assert.equal(await linkAt(PHONE_SCREEN, 1), undefined);
});

test('findLatestOAuthUrlInBuffer returns the bottom-most complete URL', () => {
  assert.equal(findLatestOAuthUrlInBuffer(fakeTerm(PHONE_SCREEN)), CLAUDE_URL);
  assert.equal(findLatestOAuthUrlInBuffer(fakeTerm(CODEX_SCREEN)), CODEX_URL);
  assert.equal(findLatestOAuthUrlInBuffer(fakeTerm(['$ ls', 'README.md'])), null);
});
