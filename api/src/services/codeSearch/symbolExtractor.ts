import path from 'path';

const LANGUAGE_BY_EXTENSION = new Map([
  ['.js', 'javascript'],
  ['.jsx', 'javascript'],
  ['.mjs', 'javascript'],
  ['.cjs', 'javascript'],
  ['.ts', 'typescript'],
  ['.tsx', 'typescript'],
  ['.py', 'python'],
  ['.go', 'go'],
  ['.java', 'java'],
  ['.rb', 'ruby'],
  ['.rs', 'rust'],
  ['.c', 'c'],
  ['.cc', 'cpp'],
  ['.cpp', 'cpp'],
  ['.cxx', 'cpp'],
  ['.h', 'c'],
  ['.hpp', 'cpp'],
]);

const JS_LIKE_LANGUAGES = new Set(['javascript', 'typescript']);
// Brace counting is fooled by comments/regex literals; without these caps a single
// unbalanced symbol triggers a synchronous scan to EOF for every following symbol.
const MAX_BLOCK_SCAN_LINES = 2000;
const MAX_BLOCK_SCAN_CHARS = 200_000;
const RESERVED_METHOD_NAMES = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'else',
  'do',
  'try',
]);

/**
 * A symbol located by one of the language extractors, before its `summary` is
 * computed. `parentName` is only set for symbols nested inside a class.
 */
interface RawSymbol {
  name: string;
  qualifiedName: string;
  kind: string;
  signature: string;
  startLine: number;
  endLine: number;
  source: string;
  parentName?: string;
}

/** A `RawSymbol` once its doc/comment summary has been resolved. */
export interface ExtractedSymbol extends RawSymbol {
  summary: string;
}

/**
 * A Python `class`/`def` header found during the first pass. `endLine` is a
 * placeholder until the second pass back-fills it from the indentation of the
 * following definition; nothing reads it before then.
 */
interface PythonDefinition {
  index: number;
  startLine: number;
  indent: number;
  name: string;
  kind: string;
  signature: string;
  endLine: number;
}

function toUnixNewlines(content: string): string {
  return String(content).replace(/\r\n/g, '\n');
}

function countIndent(line: string): number {
  const match = line.match(/^\s*/);
  return match ? match[0].replace(/\t/g, '    ').length : 0;
}

function countBraces(line: string): { open: number; close: number } {
  let open = 0;
  let close = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let escaped = false;

  for (const char of line) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (inSingle) {
      if (char === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (char === '"') inDouble = false;
      continue;
    }
    if (inTemplate) {
      if (char === '`') inTemplate = false;
      continue;
    }

    if (char === "'") {
      inSingle = true;
      continue;
    }
    if (char === '"') {
      inDouble = true;
      continue;
    }
    if (char === '`') {
      inTemplate = true;
      continue;
    }
    if (char === '{') open += 1;
    if (char === '}') close += 1;
  }

  return { open, close };
}

function extractLeadingComment(lines: string[], startIndex: number, language: string): string {
  const collected: string[] = [];

  for (let index = startIndex - 1; index >= 0; index -= 1) {
    const raw = lines[index];
    const trimmed = raw.trim();

    if (!trimmed) {
      if (collected.length === 0) continue;
      break;
    }

    if (language === 'python' && trimmed.startsWith('#')) {
      collected.unshift(trimmed.replace(/^#+\s?/, ''));
      continue;
    }

    if (trimmed.startsWith('//')) {
      collected.unshift(trimmed.replace(/^\/\/\s?/, ''));
      continue;
    }

    if (trimmed.startsWith('*')) {
      collected.unshift(
        trimmed
          .replace(/^\*\s?/, '')
          .replace(/\*\/$/, '')
          .trim()
      );
      continue;
    }

    if (trimmed.startsWith('/*')) {
      collected.unshift(
        trimmed
          .replace(/^\/\*+\s?/, '')
          .replace(/\*\/$/, '')
          .trim()
      );
      continue;
    }

    if (trimmed.endsWith('*/')) {
      collected.unshift(
        trimmed
          .replace(/^\/\*+\s?/, '')
          .replace(/\*\/$/, '')
          .trim()
      );
      continue;
    }

    break;
  }

  return collected.filter(Boolean).join(' ').trim();
}

function extractPythonDocstring(lines: string[], startLine: number, endLine: number): string {
  let index = startLine;

  while (index < Math.min(lines.length, endLine) && !lines[index].trim()) {
    index += 1;
  }

  const firstLine = lines[index]?.trim();
  if (!firstLine) return '';

  if (!(firstLine.startsWith('"""') || firstLine.startsWith("'''"))) {
    return '';
  }

  const delimiter = firstLine.startsWith('"""') ? '"""' : "'''";
  const firstBody = firstLine.slice(3).trim();

  if (firstBody.endsWith(delimiter)) {
    return firstBody.slice(0, -3).trim();
  }

  const parts = [firstBody];
  for (let cursor = index + 1; cursor < Math.min(lines.length, endLine + 1); cursor += 1) {
    const value = lines[cursor];
    if (value.includes(delimiter)) {
      parts.push(value.replace(delimiter, '').trim());
      break;
    }
    parts.push(value.trim());
  }

  return parts.filter(Boolean).join(' ').trim();
}

function findBlockEndJs(lines: string[], startIndex: number): number {
  let depth = 0;
  let hasOpened = false;
  let scannedChars = 0;
  const maxIndex = Math.min(lines.length, startIndex + MAX_BLOCK_SCAN_LINES);

  for (let index = startIndex; index < maxIndex; index += 1) {
    const { open, close } = countBraces(lines[index]);

    if (open > 0) {
      hasOpened = true;
      depth += open;
    }

    if (close > 0) {
      depth -= close;
    }

    if (hasOpened && depth <= 0) {
      return index + 1;
    }

    scannedChars += lines[index].length;
    if (scannedChars > MAX_BLOCK_SCAN_CHARS) break;
  }

  return Math.min(lines.length, startIndex + 1);
}

function findInnermostClass(classSymbols: RawSymbol[], lineNumber: number): RawSymbol | null {
  return (
    classSymbols
      .filter(symbol => lineNumber > symbol.startLine && lineNumber <= symbol.endLine)
      .sort(
        (left, right) => left.endLine - left.startLine - (right.endLine - right.startLine)
      )[0] || null
  );
}

function createSource(lines: string[], startLine: number, endLine: number): string {
  return lines
    .slice(startLine - 1, endLine)
    .join('\n')
    .trimEnd();
}

function createSummary(lines: string[], symbol: RawSymbol, language: string): string {
  const docstring =
    language === 'python' ? extractPythonDocstring(lines, symbol.startLine, symbol.endLine) : '';
  const leading = extractLeadingComment(lines, symbol.startLine - 1, language);
  return docstring || leading || symbol.signature;
}

function extractJavaScriptSymbols(lines: string[], language: string): ExtractedSymbol[] {
  const classSymbols: RawSymbol[] = [];
  const symbols: RawSymbol[] = [];

  const pushSymbol = (
    index: number,
    name: string,
    kind: string,
    extra: { qualifiedName?: string; parentName?: string } = {}
  ) => {
    const startLine = index + 1;
    const endLine = findBlockEndJs(lines, index);
    symbols.push({
      name,
      qualifiedName: extra.qualifiedName ?? name,
      kind,
      signature: lines[index].trim(),
      startLine,
      endLine,
      source: createSource(lines, startLine, endLine),
      ...(extra.parentName ? { parentName: extra.parentName } : {}),
    });
  };

  const classRegex = /^\s*(?:export\s+default\s+|export\s+)?class\s+([A-Za-z_$][\w$]*)/;
  const functionRegex =
    /^\s*(?:export\s+default\s+|export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/;
  const arrowRegex =
    /^\s*(?:export\s+default\s+|export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/;
  const functionExprRegex =
    /^\s*(?:export\s+default\s+|export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?function\s*\(([^)]*)\)/;
  const methodRegex = /^\s*(?:static\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(classRegex);
    if (!match) continue;

    const startLine = index + 1;
    const endLine = findBlockEndJs(lines, index);
    classSymbols.push({
      name: match[1],
      qualifiedName: match[1],
      kind: 'class',
      signature: line.trim(),
      startLine,
      endLine,
      source: createSource(lines, startLine, endLine),
    });
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    let match = line.match(functionRegex);

    if (match) {
      pushSymbol(index, match[1], 'function');
      continue;
    }

    match = line.match(arrowRegex) || line.match(functionExprRegex);
    if (match) {
      pushSymbol(index, match[1], 'function');
      continue;
    }

    match = line.match(methodRegex);
    if (!match) continue;

    const methodName = match[1];
    if (RESERVED_METHOD_NAMES.has(methodName)) continue;
    if (line.trim().startsWith('class ')) continue;

    const classContext = findInnermostClass(classSymbols, index + 1);
    if (!classContext) continue;

    pushSymbol(index, methodName, 'method', {
      qualifiedName: `${classContext.name}.${methodName}`,
      parentName: classContext.name,
    });
  }

  const allSymbols = [...classSymbols, ...symbols]
    .map(symbol => ({
      ...symbol,
      summary: createSummary(lines, symbol, language),
    }))
    .sort((left, right) => left.startLine - right.startLine || left.kind.localeCompare(right.kind));

  return allSymbols;
}

function extractPythonSymbols(lines: string[]): ExtractedSymbol[] {
  const definitions: PythonDefinition[] = [];
  const classRegex = /^\s*class\s+([A-Za-z_][\w]*)\s*(?:\([^)]*\))?\s*:/;
  const functionRegex = /^\s*def\s+([A-Za-z_][\w]*)\s*\(([^)]*)\)\s*:/;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    let match = line.match(classRegex);
    if (match) {
      definitions.push({
        index,
        startLine: index + 1,
        indent: countIndent(line),
        name: match[1],
        kind: 'class',
        signature: line.trim(),
        endLine: 0,
      });
      continue;
    }

    match = line.match(functionRegex);
    if (match) {
      definitions.push({
        index,
        startLine: index + 1,
        indent: countIndent(line),
        name: match[1],
        kind: 'function',
        signature: line.trim(),
        endLine: 0,
      });
    }
  }

  for (let position = 0; position < definitions.length; position += 1) {
    const definition = definitions[position];
    let endLine = lines.length;

    for (let cursor = position + 1; cursor < definitions.length; cursor += 1) {
      const candidate = definitions[cursor];
      if (candidate.indent <= definition.indent) {
        endLine = candidate.startLine - 1;
        break;
      }
    }

    definition.endLine = Math.max(definition.startLine, endLine);
  }

  const classes = definitions.filter(definition => definition.kind === 'class');

  return definitions
    .map(definition => {
      let qualifiedName = definition.name;
      let kind = definition.kind;
      let parentName: string | null = null;

      if (definition.kind === 'function') {
        const parentClass =
          classes
            .filter(
              candidate =>
                definition.startLine > candidate.startLine &&
                definition.startLine <= candidate.endLine &&
                definition.indent > candidate.indent
            )
            .sort((left, right) => right.indent - left.indent)[0] || null;

        if (parentClass) {
          kind = 'method';
          parentName = parentClass.name;
          qualifiedName = `${parentClass.name}.${definition.name}`;
        }
      }

      const symbol: RawSymbol = {
        name: definition.name,
        qualifiedName,
        kind,
        signature: definition.signature,
        startLine: definition.startLine,
        endLine: definition.endLine,
        source: createSource(lines, definition.startLine, definition.endLine),
        ...(parentName ? { parentName } : {}),
      };

      return { ...symbol, summary: createSummary(lines, symbol, 'python') };
    })
    .sort((left, right) => left.startLine - right.startLine || left.kind.localeCompare(right.kind));
}

function extractGenericSymbols(lines: string[], language: string): ExtractedSymbol[] {
  const patterns = [
    {
      kind: 'class',
      regex: /^\s*(?:export\s+)?class\s+([A-Za-z_][\w]*)/,
    },
    {
      kind: 'function',
      regex:
        /^\s*(?:export\s+)?(?:async\s+)?(?:function\s+)?([A-Za-z_][\w]*)\s*\([^)]*\)\s*(?:\{|=>|:)/,
    },
  ];

  const symbols: ExtractedSymbol[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    for (const pattern of patterns) {
      const match = line.match(pattern.regex);
      if (!match) continue;

      const startLine = index + 1;
      const endLine = findBlockEndJs(lines, index);

      const symbol: RawSymbol = {
        name: match[1],
        qualifiedName: match[1],
        kind: pattern.kind,
        signature: line.trim(),
        startLine,
        endLine,
        source: createSource(lines, startLine, endLine),
      };
      symbols.push({ ...symbol, summary: createSummary(lines, symbol, language) });
      break;
    }
  }

  return symbols;
}

function detectLanguage(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  return LANGUAGE_BY_EXTENSION.get(extension) || 'text';
}

export function extractSymbolsFromContent(
  filePath: string,
  content: string
): { language: string; symbols: ExtractedSymbol[] } {
  const language = detectLanguage(filePath);
  const normalized = toUnixNewlines(content);
  const lines = normalized.split('\n');

  let symbols: ExtractedSymbol[] = [];
  if (JS_LIKE_LANGUAGES.has(language)) {
    symbols = extractJavaScriptSymbols(lines, language);
  } else if (language === 'python') {
    symbols = extractPythonSymbols(lines);
  } else {
    symbols = extractGenericSymbols(lines, language);
  }

  return {
    language,
    symbols,
  };
}
