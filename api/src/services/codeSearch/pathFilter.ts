/**
 * Path filters and file-name globs for the Code Index search tools.
 *
 * Paths are repo-relative POSIX paths (`src/auth/service.ts`). Two kinds of
 * patterns are accepted, chosen by whether the pattern holds a glob character
 * (`*`, `?`, `[`, `{`):
 *
 * - **plain prefix** — `api/src/` keeps the files whose path starts with it.
 * - **glob** — `**` matches any number of path segments, `*` anything but `/`,
 *   `?` one character but `/`, `[abc]` / `[!abc]` a character class, `{a,b}`
 *   alternatives. A path filter glob matches the whole path *or a leading
 *   directory of it*, so `packages/*\/src` keeps everything under each package's
 *   `src` folder without a trailing `/**`.
 *
 * A hand-written converter rather than `path.matchesGlob`: we need the
 * "directory prefix" form above, and full control over the dialect agents use.
 */

const GLOB_CHARS = /[*?[{]/;

export function hasGlobChars(pattern: string): boolean {
  return GLOB_CHARS.test(pattern);
}

/** Strip `./` and leading `/` and turn `\` into `/` so patterns look like index paths. */
export function normalizePattern(pattern: string): string {
  return pattern
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/^\/+/, '');
}

function escapeRegExpChar(char: string): string {
  return /[.*+?^${}()|[\]\\/]/.test(char) ? `\\${char}` : char;
}

/** Translate a glob into the body of a regular expression (no anchors). */
export function globToRegExpSource(glob: string): string {
  let out = '';
  let braceDepth = 0;
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*') {
      if (glob[index + 1] === '*') {
        // `**/` matches zero or more whole segments; a bare `**` anything at all.
        index += 1;
        if (glob[index + 1] === '/') {
          index += 1;
          out += '(?:.*/)?';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else if (char === '?') {
      out += '[^/]';
    } else if (char === '[') {
      const close = glob.indexOf(']', index + 2);
      if (close === -1) {
        out += '\\[';
        continue;
      }
      let body = glob.slice(index + 1, close);
      const negated = body.startsWith('!') || body.startsWith('^');
      if (negated) body = body.slice(1);
      body = body.replace(/[\\\]^]/g, '\\$&');
      out += negated ? `[^/${body}]` : `[${body}]`;
      index = close;
    } else if (char === '{') {
      braceDepth += 1;
      out += '(?:';
    } else if (char === '}' && braceDepth > 0) {
      braceDepth -= 1;
      out += ')';
    } else if (char === ',' && braceDepth > 0) {
      out += '|';
    } else {
      out += escapeRegExpChar(char);
    }
  }
  // An unbalanced `{` would leave the group open: close it so the RegExp compiles.
  out += ')'.repeat(braceDepth);
  return out;
}

export type PathPredicate = (filePath: string) => boolean;

/**
 * Compile a `pathPrefix` filter. Empty / missing patterns keep everything (null).
 * Matching is case-sensitive, like the paths on the Linux hosts that run the index.
 */
export function compilePathFilter(pattern: string | null | undefined): PathPredicate | null {
  if (pattern == null) return null;
  const normalized = normalizePattern(pattern);
  if (!normalized || normalized === '.' || normalized === '**') return null;

  if (!hasGlobChars(normalized)) {
    return filePath => filePath.startsWith(normalized);
  }

  const body = globToRegExpSource(normalized.replace(/\/+$/, ''));
  const regex = new RegExp(`^${body}(?:/.*)?$`);
  return filePath => regex.test(filePath);
}

/**
 * Compile a `find_files` pattern:
 * - no glob character: case-insensitive substring of the path (`authService`);
 * - glob without `/`: matched against the file name only (`*.test.ts`);
 * - glob with `/`: matched against the whole path (`api/**\/routes/*.ts`).
 */
export function compileFilePattern(pattern: string): PathPredicate {
  const normalized = normalizePattern(pattern);
  if (!normalized) throw new Error('find_files: pattern must not be empty');

  if (!hasGlobChars(normalized)) {
    const needle = normalized.toLowerCase();
    return filePath => filePath.toLowerCase().includes(needle);
  }

  const regex = new RegExp(`^${globToRegExpSource(normalized)}$`);
  if (normalized.includes('/')) return filePath => regex.test(filePath);
  return filePath => regex.test(filePath.slice(filePath.lastIndexOf('/') + 1));
}
