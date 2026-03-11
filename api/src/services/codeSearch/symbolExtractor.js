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

function toUnixNewlines(content) {
  return String(content).replace(/\r\n/g, '\n');
}

function countIndent(line) {
  const match = line.match(/^\s*/);
  return match ? match[0].replace(/\t/g, '    ').length : 0;
}

function countBraces(line) {
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
      if (char === '\'') inSingle = false;
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

    if (char === '\'') {
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

function extractLeadingComment(lines, startIndex, language) {
  const collected = [];

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
      collected.unshift(trimmed.replace(/^\*\s?/, '').replace(/\*\/$/, '').trim());
      continue;
    }

    if (trimmed.startsWith('/*')) {
      collected.unshift(trimmed.replace(/^\/\*+\s?/, '').replace(/\*\/$/, '').trim());
      continue;
    }

    if (trimmed.endsWith('*/')) {
      collected.unshift(trimmed.replace(/^\/\*+\s?/, '').replace(/\*\/$/, '').trim());
      continue;
    }

    break;
  }

  return collected.filter(Boolean).join(' ').trim();
}

function extractPythonDocstring(lines, startLine, endLine) {
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

function findBlockEndJs(lines, startIndex) {
  let depth = 0;
  let hasOpened = false;

  for (let index = startIndex; index < lines.length; index += 1) {
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
  }

  return Math.min(lines.length, startIndex + 1);
}

function findInnermostClass(classSymbols, lineNumber) {
  return classSymbols
    .filter((symbol) => lineNumber > symbol.startLine && lineNumber <= symbol.endLine)
    .sort((left, right) => (left.endLine - left.startLine) - (right.endLine - right.startLine))[0] || null;
}

function createSource(lines, startLine, endLine) {
  return lines.slice(startLine - 1, endLine).join('\n').trimEnd();
}

function createSummary(lines, symbol, language) {
  const docstring = language === 'python'
    ? extractPythonDocstring(lines, symbol.startLine, symbol.endLine)
    : '';
  const leading = extractLeadingComment(lines, symbol.startLine - 1, language);
  return docstring || leading || symbol.signature;
}

function extractJavaScriptSymbols(lines, language) {
  const classSymbols = [];
  const symbols = [];

  const classRegex = /^\s*(?:export\s+default\s+|export\s+)?class\s+([A-Za-z_$][\w$]*)/;
  const functionRegex = /^\s*(?:export\s+default\s+|export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/;
  const arrowRegex = /^\s*(?:export\s+default\s+|export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/;
  const functionExprRegex = /^\s*(?:export\s+default\s+|export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?function\s*\(([^)]*)\)/;
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
    const lineNumber = index + 1;
    const classContext = findInnermostClass(classSymbols, lineNumber);
    let match = line.match(functionRegex);

    if (match) {
      const startLine = lineNumber;
      const endLine = findBlockEndJs(lines, index);
      symbols.push({
        name: match[1],
        qualifiedName: match[1],
        kind: 'function',
        signature: line.trim(),
        startLine,
        endLine,
        source: createSource(lines, startLine, endLine),
      });
      continue;
    }

    match = line.match(arrowRegex) || line.match(functionExprRegex);
    if (match) {
      const startLine = lineNumber;
      const endLine = findBlockEndJs(lines, index);
      symbols.push({
        name: match[1],
        qualifiedName: match[1],
        kind: 'function',
        signature: line.trim(),
        startLine,
        endLine,
        source: createSource(lines, startLine, endLine),
      });
      continue;
    }

    if (!classContext) continue;

    match = line.match(methodRegex);
    if (!match) continue;

    const methodName = match[1];
    if (RESERVED_METHOD_NAMES.has(methodName)) continue;
    if (line.trim().startsWith('class ')) continue;

    const startLine = lineNumber;
    const endLine = findBlockEndJs(lines, index);
    symbols.push({
      name: methodName,
      qualifiedName: `${classContext.name}.${methodName}`,
      kind: 'method',
      signature: line.trim(),
      startLine,
      endLine,
      source: createSource(lines, startLine, endLine),
      parentName: classContext.name,
    });
  }

  const allSymbols = [...classSymbols, ...symbols]
    .map((symbol) => ({
      ...symbol,
      summary: createSummary(lines, symbol, language),
    }))
    .sort((left, right) => left.startLine - right.startLine || left.kind.localeCompare(right.kind));

  return allSymbols;
}

function extractPythonSymbols(lines) {
  const definitions = [];
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

  const classes = definitions.filter((definition) => definition.kind === 'class');

  return definitions
    .map((definition) => {
      let qualifiedName = definition.name;
      let kind = definition.kind;
      let parentName = null;

      if (definition.kind === 'function') {
        const parentClass = classes
          .filter((candidate) =>
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

      const symbol = {
        name: definition.name,
        qualifiedName,
        kind,
        signature: definition.signature,
        startLine: definition.startLine,
        endLine: definition.endLine,
        source: createSource(lines, definition.startLine, definition.endLine),
      };

      if (parentName) symbol.parentName = parentName;
      symbol.summary = createSummary(lines, symbol, 'python');
      return symbol;
    })
    .sort((left, right) => left.startLine - right.startLine || left.kind.localeCompare(right.kind));
}

function extractGenericSymbols(lines, language) {
  const patterns = [
    {
      kind: 'class',
      regex: /^\s*(?:export\s+)?class\s+([A-Za-z_][\w]*)/,
    },
    {
      kind: 'function',
      regex: /^\s*(?:export\s+)?(?:async\s+)?(?:function\s+)?([A-Za-z_][\w]*)\s*\([^)]*\)\s*(?:\{|=>|:)/,
    },
  ];

  const symbols = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    for (const pattern of patterns) {
      const match = line.match(pattern.regex);
      if (!match) continue;

      const startLine = index + 1;
      const endLine = language === 'python'
        ? Math.min(lines.length, startLine + 20)
        : findBlockEndJs(lines, index);

      const symbol = {
        name: match[1],
        qualifiedName: match[1],
        kind: pattern.kind,
        signature: line.trim(),
        startLine,
        endLine,
        source: createSource(lines, startLine, endLine),
      };
      symbol.summary = createSummary(lines, symbol, language);
      symbols.push(symbol);
      break;
    }
  }

  return symbols;
}

export function detectLanguage(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return LANGUAGE_BY_EXTENSION.get(extension) || 'text';
}

export function extractSymbolsFromContent(filePath, content) {
  const language = detectLanguage(filePath);
  const normalized = toUnixNewlines(content);
  const lines = normalized.split('\n');

  let symbols = [];
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