/**
 * Reference extraction for the code index's call/import graph.
 *
 * For every indexed file this pulls out two things, both stored in index.json
 * next to the file's symbols:
 *
 *  - `imports`: the import statements (ESM, CommonJS `require`, `export … from`
 *    re-exports, Python `import`/`from … import`) with the local names they bind;
 *  - `references`: every identifier occurrence in code — comments and string
 *    literals are masked out first — tagged as a call, an import or a plain
 *    reference, plus the receiver when it is a member access (`obj.name`).
 *
 * The extraction is purely lexical, like the symbol extractor: no type checker,
 * so the query side (CodeIndexService.findReferences) resolves these occurrences
 * against imports and attaches a confidence level rather than claiming certainty.
 */

/** One name bound by an import. `imported` is a name, `'default'`, or `'*'` (namespace/star). */
export interface ImportBinding {
  imported: string;
  local: string;
}

/** One import statement. `reexport` marks `export … from` forms, which bind nothing locally. */
export interface ImportRecord {
  module: string;
  line: number;
  bindings: ImportBinding[];
  reexport?: boolean;
}

/** Flag bits of a stored reference. */
export const REF_CALL = 1;
export const REF_MEMBER = 2;
export const REF_IMPORT = 4;

/**
 * One occurrence of a name. A repo holds hundreds of thousands of them, so the
 * common case — a plain reference — is stored as its bare line number; anything
 * flagged is `[line, flags]`, or `[line, flags, receiver]` for a member access
 * (`receiver` is the identifier right before the `.`/`->`/`::`, when there is one).
 */
export type ReferenceEntry = number | [number, number] | [number, number, string];

/** A file's references, keyed by identifier so a lookup by symbol name is direct. */
export type FileReferences = Record<string, ReferenceEntry[]>;

/** A reference entry unpacked into named fields. */
export interface DecodedReference {
  line: number;
  flags: number;
  receiver: string | null;
}

export function decodeReference(entry: ReferenceEntry): DecodedReference {
  if (typeof entry === 'number') return { line: entry, flags: 0, receiver: null };
  return { line: entry[0], flags: entry[1], receiver: entry[2] ?? null };
}

/** A symbol definition site, so its own name is not reported as a reference to itself. */
export interface DefinitionSite {
  name: string;
  startLine: number;
}

// prettier-ignore
const JS_KEYWORDS = [
  'abstract', 'any', 'as', 'async', 'await', 'boolean', 'break', 'case', 'catch', 'class',
  'const', 'continue', 'debugger', 'declare', 'default', 'delete', 'do', 'else', 'enum',
  'export', 'extends', 'false', 'finally', 'for', 'from', 'function', 'get', 'if',
  'implements', 'import', 'in', 'infer', 'instanceof', 'interface', 'is', 'keyof', 'let',
  'module', 'namespace', 'never', 'new', 'null', 'number', 'object', 'of', 'private',
  'protected', 'public', 'readonly', 'return', 'satisfies', 'set', 'static', 'string',
  'super', 'switch', 'this', 'throw', 'true', 'try', 'type', 'typeof', 'undefined',
  'unknown', 'var', 'void', 'while', 'with', 'yield',
];
// prettier-ignore
const PYTHON_KEYWORDS = [
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class',
  'cls', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from',
  'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise',
  'return', 'self', 'try', 'while', 'with', 'yield',
];
// prettier-ignore
const GENERIC_KEYWORDS = [
  'auto', 'begin', 'bool', 'break', 'case', 'catch', 'char', 'class', 'const', 'continue',
  'def', 'default', 'defer', 'do', 'double', 'else', 'elsif', 'end', 'enum', 'extends',
  'extern', 'false', 'final', 'float', 'fn', 'for', 'func', 'go', 'goto', 'if', 'impl',
  'implements', 'import', 'in', 'int', 'interface', 'let', 'long', 'loop', 'map', 'match',
  'mod', 'module', 'mut', 'namespace', 'new', 'nil', 'null', 'nullptr', 'package',
  'private', 'protected', 'pub', 'public', 'range', 'return', 'self', 'short', 'signed',
  'sizeof', 'static', 'struct', 'super', 'switch', 'template', 'this', 'throw', 'throws',
  'trait', 'true', 'try', 'type', 'typedef', 'typename', 'union', 'unless', 'unsigned',
  'use', 'using', 'var', 'virtual', 'void', 'where', 'while', 'yield',
];

const KEYWORDS_BY_FAMILY: Record<string, Set<string>> = {
  js: new Set(JS_KEYWORDS),
  python: new Set(PYTHON_KEYWORDS),
  generic: new Set(GENERIC_KEYWORDS),
};

/** Keywords after which the next identifier is being declared, not referenced. */
// prettier-ignore
const DECLARATION_KEYWORDS = new Set([
  'function', 'class', 'def', 'interface', 'type', 'enum', 'fn', 'func', 'struct',
  'trait', 'const', 'let', 'var', 'namespace', 'module',
]);

/** Receivers that point at the enclosing instance. */
export const SELF_RECEIVERS = new Set(['this', 'self', 'cls']);

export function languageFamily(language: string): 'js' | 'python' | 'generic' {
  if (language === 'javascript' || language === 'typescript') return 'js';
  if (language === 'python') return 'python';
  return 'generic';
}

/** Overwrite `[from, to)` with spaces, keeping newlines so offsets and line numbers hold. */
function blank(out: string[], from: number, to: number) {
  for (let k = from; k < to && k < out.length; k += 1) {
    if (out[k] !== '\n') out[k] = ' ';
  }
}

/** Index right after the closing `quote`, or the end of line for an unterminated literal. */
function scanQuoted(src: string, start: number, quote: string): number {
  for (let i = start + 1; i < src.length; i += 1) {
    const c = src[i];
    if (c === '\\') {
      i += 1;
      continue;
    }
    if (c === quote) return i + 1;
    if (c === '\n') return i;
  }
  return src.length;
}

/** Mask comments and string literals of JS/TS, keeping `${…}` template expressions as code. */
function maskJsLike(src: string): string {
  const out = src.split('');
  const templateDepths: number[] = [];
  let braceDepth = 0;

  // Scans a template body from `start`; returns where code resumes.
  const scanTemplateBody = (start: number): number => {
    for (let i = start; i < src.length; i += 1) {
      const c = src[i];
      if (c === '\\') {
        i += 1;
        continue;
      }
      if (c === '`') {
        blank(out, start, i + 1);
        return i + 1;
      }
      if (c === '$' && src[i + 1] === '{') {
        blank(out, start, i + 2);
        templateDepths.push(braceDepth);
        return i + 2;
      }
    }
    blank(out, start, src.length);
    return src.length;
  };

  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      const end = src.indexOf('\n', i);
      const stop = end < 0 ? src.length : end;
      blank(out, i, stop);
      i = stop;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      blank(out, i, stop);
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      const stop = scanQuoted(src, i, c);
      blank(out, i, stop);
      i = stop;
      continue;
    }
    if (c === '`') {
      blank(out, i, i + 1);
      i = scanTemplateBody(i + 1);
      continue;
    }
    if (c === '{') braceDepth += 1;
    if (c === '}') {
      if (templateDepths.length && templateDepths[templateDepths.length - 1] === braceDepth) {
        templateDepths.pop();
        blank(out, i, i + 1);
        i = scanTemplateBody(i + 1);
        continue;
      }
      braceDepth -= 1;
    }
    i += 1;
  }
  return out.join('');
}

/** Mask Python comments and strings, including triple-quoted and prefixed (f/r/b) literals. */
function maskPython(src: string): string {
  const out = src.split('');
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '#') {
      const end = src.indexOf('\n', i);
      const stop = end < 0 ? src.length : end;
      blank(out, i, stop);
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      // Swallow a string prefix such as f"", rb'' so it is not read as an identifier.
      let from = i;
      while (from > 0 && /[rRbBfFuU]/.test(src[from - 1]) && i - from < 2) from -= 1;
      if (from > 0 && /[\w]/.test(src[from - 1])) from = i;

      let stop: number;
      if (src.startsWith(c.repeat(3), i)) {
        const end = src.indexOf(c.repeat(3), i + 3);
        stop = end < 0 ? src.length : end + 3;
      } else {
        stop = scanQuoted(src, i, c);
      }
      blank(out, from, stop);
      i = stop;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

/** Mask C-family (C/C++/Go/Java/Rust) and Ruby comments and strings. */
function maskGeneric(src: string, language: string): string {
  const out = src.split('');
  const hashComments = language === 'ruby';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if ((c === '/' && next === '/') || (hashComments && c === '#')) {
      const end = src.indexOf('\n', i);
      const stop = end < 0 ? src.length : end;
      blank(out, i, stop);
      i = stop;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      blank(out, i, stop);
      i = stop;
      continue;
    }
    if (c === '"' || (c === '`' && language === 'go')) {
      const stop = c === '`' ? src.indexOf('`', i + 1) + 1 || src.length : scanQuoted(src, i, c);
      blank(out, i, stop);
      i = stop;
      continue;
    }
    if (c === "'") {
      // Ruby single-quoted strings are real strings; elsewhere only a short char
      // literal ('a', '\n') counts, so Rust lifetimes ('a) are left alone.
      const stop = scanQuoted(src, i, c);
      if (language === 'ruby' || (src[stop - 1] === "'" && stop - i <= 4)) {
        blank(out, i, stop);
        i = stop;
        continue;
      }
    }
    i += 1;
  }
  return out.join('');
}

export function maskNonCode(content: string, language: string): string {
  const family = languageFamily(language);
  if (family === 'js') return maskJsLike(content);
  if (family === 'python') return maskPython(content);
  return maskGeneric(content, language);
}

/** 1-based line numbers for offsets, via a precomputed table of line starts. */
function createLineLookup(text: string) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return (offset: number) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid] <= offset) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
}

/** An import statement plus the source span it covers, used to tag its identifiers. */
interface ImportMatch {
  record: ImportRecord;
  start: number;
  end: number;
}

function parseJsBindingClause(clause: string): ImportBinding[] {
  const bindings: ImportBinding[] = [];
  let rest = clause.trim().replace(/^type\s+/, '');

  const braceMatch = rest.match(/\{([^}]*)\}/);
  if (braceMatch) {
    for (const part of braceMatch[1].split(',')) {
      const item = part.trim().replace(/^type\s+/, '');
      if (!item) continue;
      const [imported, local] = item.split(/\s+as\s+/).map(value => value.trim());
      if (/^[\w$]+$/.test(imported)) bindings.push({ imported, local: local || imported });
    }
    rest = rest.replace(braceMatch[0], '');
  }

  const namespaceMatch = rest.match(/\*\s*as\s+([\w$]+)/);
  if (namespaceMatch) {
    bindings.push({ imported: '*', local: namespaceMatch[1] });
    rest = rest.replace(namespaceMatch[0], '');
  } else if (/\*/.test(rest)) {
    bindings.push({ imported: '*', local: '*' });
    rest = rest.replace('*', '');
  }

  const defaultMatch = rest.match(/^\s*([\w$]+)/);
  if (defaultMatch) bindings.push({ imported: 'default', local: defaultMatch[1] });

  return bindings;
}

function parseRequireBindings(pattern: string): ImportBinding[] {
  const trimmed = pattern.trim();
  if (!trimmed.startsWith('{')) return [{ imported: '*', local: trimmed }];
  const bindings: ImportBinding[] = [];
  for (const part of trimmed.slice(1, -1).split(',')) {
    const [imported, local] = part.split(':').map(value => value.trim());
    if (imported && /^[\w$]+$/.test(imported)) {
      bindings.push({ imported, local: local && /^[\w$]+$/.test(local) ? local : imported });
    }
  }
  return bindings;
}

function extractJsImports(
  content: string,
  masked: string,
  lineOf: (offset: number) => number
): ImportMatch[] {
  const matches: ImportMatch[] = [];
  const clause = String.raw`(?:type\s+)?(?:[\w$]+\s*,\s*)?(?:\{[^}]*\}|\*\s*as\s+[\w$]+|\*|[\w$]+)`;
  const fromRegex = new RegExp(
    String.raw`\b(import|export)\s+(${clause})\s*from\s*(['"])([^'"\n]+)\3`,
    'g'
  );
  const requireRegex =
    /\b(?:const|let|var)\s+(\{[^}]*\}|[\w$]+)\s*=\s*require\s*\(\s*(['"])([^'"\n]+)\2\s*\)/g;

  // A match only counts when its first character is live code, not inside a comment/string.
  const isCode = (index: number) => masked[index] === content[index];

  for (const match of content.matchAll(fromRegex)) {
    const index = match.index ?? 0;
    if (!isCode(index)) continue;
    const reexport = match[1] === 'export';
    const bindings = parseJsBindingClause(match[2]);
    matches.push({
      record: {
        module: match[4],
        line: lineOf(index),
        bindings,
        ...(reexport ? { reexport: true } : {}),
      },
      start: index,
      end: index + match[0].length,
    });
  }

  for (const match of content.matchAll(requireRegex)) {
    const index = match.index ?? 0;
    if (!isCode(index)) continue;
    matches.push({
      record: { module: match[3], line: lineOf(index), bindings: parseRequireBindings(match[1]) },
      start: index,
      end: index + match[0].length,
    });
  }

  return matches;
}

function extractPythonImports(
  content: string,
  masked: string,
  lineOf: (offset: number) => number
): ImportMatch[] {
  const matches: ImportMatch[] = [];
  const isCode = (index: number) => masked[index] === content[index];
  const fromRegex = /^[ \t]*from[ \t]+([.\w]+)[ \t]+import[ \t]+(\([^)]*\)|[^\n#;]+)/gm;
  const importRegex = /^[ \t]*import[ \t]+([^\n#;]+)/gm;

  for (const match of content.matchAll(fromRegex)) {
    const index = (match.index ?? 0) + match[0].indexOf('from');
    if (!isCode(index)) continue;
    const bindings: ImportBinding[] = [];
    for (const part of match[2].replace(/[()\\]/g, ' ').split(',')) {
      const item = part.trim();
      if (!item) continue;
      const [imported, local] = item.split(/\s+as\s+/).map(value => value.trim());
      if (imported === '*') bindings.push({ imported: '*', local: '*' });
      else if (/^\w+$/.test(imported)) bindings.push({ imported, local: local || imported });
    }
    matches.push({
      record: { module: match[1], line: lineOf(index), bindings },
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
    });
  }

  for (const match of content.matchAll(importRegex)) {
    const index = (match.index ?? 0) + match[0].indexOf('import');
    if (!isCode(index)) continue;
    for (const part of match[1].split(',')) {
      const [module, alias] = part
        .trim()
        .split(/\s+as\s+/)
        .map(value => value.trim());
      if (!module || !/^[\w.]+$/.test(module)) continue;
      // `a.b.c.fn()` is seen with receiver `c`, so bind the last segment.
      const local = alias || module.split('.').pop() || module;
      matches.push({
        record: { module, line: lineOf(index), bindings: [{ imported: '*', local }] },
        start: match.index ?? 0,
        end: (match.index ?? 0) + match[0].length,
      });
    }
  }

  return matches;
}

/** Previous non-whitespace offset before `index`, or -1. */
function previousCodeIndex(masked: string, index: number): number {
  let cursor = index - 1;
  while (cursor >= 0 && /\s/.test(masked[cursor])) cursor -= 1;
  return cursor;
}

/** The identifier ending at `endIndex` (inclusive), or null. */
function identifierEndingAt(masked: string, endIndex: number): string | null {
  let start = endIndex;
  while (start >= 0 && /[\w$]/.test(masked[start])) start -= 1;
  if (start === endIndex) return null;
  const word = masked.slice(start + 1, endIndex + 1);
  return /^[A-Za-z_$]/.test(word) ? word : null;
}

/**
 * Extract the imports and identifier references of one file.
 * `definitions` are the symbols declared in it: their own name on their header
 * line is a declaration (e.g. a class method `foo() {`), not a call.
 */
export function extractReferencesFromContent(
  content: string,
  language: string,
  definitions: DefinitionSite[] = []
): { imports: ImportRecord[]; references: FileReferences } {
  const normalized = String(content).replace(/\r\n/g, '\n');
  const family = languageFamily(language);
  if (language === 'text') return { imports: [], references: {} };

  const masked = maskNonCode(normalized, language);
  const lineOf = createLineLookup(normalized);
  const keywords = KEYWORDS_BY_FAMILY[family];

  const importMatches =
    family === 'js'
      ? extractJsImports(normalized, masked, lineOf)
      : family === 'python'
        ? extractPythonImports(normalized, masked, lineOf)
        : [];
  importMatches.sort((left, right) => left.start - right.start);

  const definitionKeys = new Set(definitions.map(def => `${def.startLine}:${def.name}`));
  // Null-prototype so names such as `constructor` or `__proto__` are plain keys.
  const references: FileReferences = Object.create(null);
  const seen = new Set<string>();
  const push = (name: string, line: number, flags: number, receiver: string | null = null) => {
    const key = `${name}\u0000${line}\u0000${flags}\u0000${receiver ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    const entry: ReferenceEntry = receiver ? [line, flags, receiver] : flags ? [line, flags] : line;
    (references[name] ||= []).push(entry);
  };

  let importCursor = 0;
  let previousWord: string | null = null;
  const tokenRegex = /[A-Za-z_$][\w$]*/g;

  for (const match of masked.matchAll(tokenRegex)) {
    const name = match[0];
    const index = match.index ?? 0;
    const before = index > 0 ? masked[index - 1] : '';
    const wordBefore = previousWord;
    previousWord = name;
    // Skip the tail of a numeric literal such as 1e5 or 0xff.
    if (/[0-9]/.test(before)) continue;
    if (keywords.has(name)) continue;

    const line = lineOf(index);

    while (importCursor < importMatches.length && importMatches[importCursor].end <= index) {
      importCursor += 1;
    }
    const importMatch = importMatches[importCursor];
    if (importMatch && importMatch.start <= index && index < importMatch.end) {
      // Inside an import statement only the bound names matter, not module path parts.
      const bound = importMatch.record.bindings.some(
        binding => binding.local === name || binding.imported === name
      );
      if (bound) push(name, line, REF_IMPORT);
      continue;
    }

    if (wordBefore && DECLARATION_KEYWORDS.has(wordBefore)) {
      const previousIndex = previousCodeIndex(masked, index);
      // `const foo` declares foo; `const { foo }` (destructuring) is still a reference.
      if (previousIndex >= 0 && /[\w$]/.test(masked[previousIndex])) continue;
    }

    const definitionKey = `${line}:${name}`;
    if (definitionKeys.has(definitionKey)) {
      // Only the first occurrence on the header line is the declaration itself.
      definitionKeys.delete(definitionKey);
      continue;
    }

    let flags = 0;
    let receiver: string | null = null;
    const previousIndex = previousCodeIndex(masked, index);
    const previousChar = previousIndex >= 0 ? masked[previousIndex] : '';
    const isDot = previousChar === '.' && masked[previousIndex - 1] !== '.';
    const isArrow = previousChar === '>' && masked[previousIndex - 1] === '-';
    const isPath = previousChar === ':' && masked[previousIndex - 1] === ':';
    if (isDot || isArrow || isPath) {
      flags |= REF_MEMBER;
      let receiverEnd = previousIndex - (isDot ? 1 : 2);
      if (masked[receiverEnd] === '?') receiverEnd -= 1;
      while (receiverEnd >= 0 && /[ \t]/.test(masked[receiverEnd])) receiverEnd -= 1;
      receiver = identifierEndingAt(masked, receiverEnd);
    }

    let after = index + name.length;
    while (after < masked.length && (masked[after] === ' ' || masked[after] === '\t')) after += 1;
    if (masked[after] === '(' || wordBefore === 'new') flags |= REF_CALL;

    push(name, line, flags, receiver);
  }

  return { imports: importMatches.map(match => match.record), references };
}
