// Formatting of the native `read_file` tool result (ADR
// docs/adr-sandbox-agentic-loop-2026-11-06.md, P6).
//
// Text is rendered like `cat -n`: `%6d\t<line>`, numbered from the real
// position in the file (so a partial read starting at line 120 shows 120, 121…).
// The numbers help the model locate code and are NOT part of the file — the
// tool description tells it never to write them back with write_file.
//
// Only the tool output is formatted here: provider.readFile and its other
// internal callers keep receiving the raw content.

/** Full reads beyond this many lines are truncated with a "read next" hint. */
export const READ_FILE_MAX_LINES = 500;

export interface FormattedRead {
  text: string;
  totalLines: number;
  startLine: number;
  /** Last line shown (0 when nothing is shown). */
  endLine: number;
  truncated: boolean;
}

/** Split content into lines; a trailing newline does not add an empty line. */
export function splitLines(content: string): string[] {
  if (content === '') return [];
  const lines = content.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Render lines `cat -n` style, numbering the first one `firstLineNumber`. */
export function numberLines(lines: string[], firstLineNumber: number): string {
  return lines
    .map((line, i) => `${String(firstLineNumber + i).padStart(6, ' ')}\t${line}`)
    .join('\n');
}

/**
 * Format file content for the read_file tool. `startLineArg` / `endLineArg`
 * are the raw (possibly missing) 1-indexed range arguments.
 */
export function formatReadFile(
  content: string,
  startLineArg?: string,
  endLineArg?: string,
  maxLines: number = READ_FILE_MAX_LINES
): FormattedRead {
  const allLines = splitLines(content);
  const totalLines = allLines.length;
  const startLine = parseInt(startLineArg ?? '', 10);
  const endLine = parseInt(endLineArg ?? '', 10);

  if (!isNaN(startLine) && startLine > 0) {
    if (startLine > totalLines) {
      return {
        text: `--- start_line=${startLine} is past the end of the file (${totalLines} lines). ---`,
        totalLines,
        startLine,
        endLine: 0,
        truncated: false,
      };
    }
    const end =
      !isNaN(endLine) && endLine >= startLine ? Math.min(endLine, totalLines) : totalLines;
    return {
      text: numberLines(allLines.slice(startLine - 1, end), startLine),
      totalLines,
      startLine,
      endLine: end,
      truncated: false,
    };
  }

  if (totalLines > maxLines) {
    const shown = numberLines(allLines.slice(0, maxLines), 1);
    const next = maxLines + 1;
    return {
      text:
        `${shown}\n\n--- TRUNCATED: showing lines 1-${maxLines} of ${totalLines}. ` +
        `To continue, call read_file with start_line=${next} ` +
        `(e.g. start_line=${next}, end_line=${Math.min(next + maxLines - 1, totalLines)}). ---`,
      totalLines,
      startLine: 1,
      endLine: maxLines,
      truncated: true,
    };
  }

  return {
    text: numberLines(allLines, 1),
    totalLines,
    startLine: 1,
    endLine: totalLines,
    truncated: false,
  };
}
