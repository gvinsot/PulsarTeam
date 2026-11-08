/**
 * Keep both ends of long output, including the omission marker in `max`.
 * Sizes use UTF-16 code units (like String.length), but cuts never split a
 * surrogate pair. Lines count the line fragments in the omitted text.
 * If the budget cannot hold a marker, keep only the tail.
 */
export function truncateMiddle(text: string, max = 10000, head = 3000): string {
  if (!Number.isInteger(max) || max < 0 || !Number.isInteger(head) || head < 0) {
    throw new RangeError('max and head must be non-negative integers');
  }
  if (text.length <= max) return text;

  const marker = (chars: number, lines: number) =>
    `\n[... ${chars} chars / ${lines} lines omitted ...]\n`;
  const countLines = (value: string) => value.split('\n').length;
  // Reserve an upper bound so the marker itself never exceeds the budget.
  const budget = max - marker(text.length, countLines(text)).length;
  let headEnd = budget > 0 ? Math.min(head, budget - 1) : 0;
  let tailStart = text.length - (budget > 0 ? budget - headEnd : max);
  const splitsPair = (index: number) =>
    /[\uD800-\uDBFF]/.test(text.charAt(index - 1)) && /[\uDC00-\uDFFF]/.test(text.charAt(index));
  if (splitsPair(headEnd)) headEnd--;
  if (splitsPair(tailStart)) tailStart++;
  if (budget <= 0) return text.slice(tailStart);

  const omitted = text.slice(headEnd, tailStart);
  return (
    text.slice(0, headEnd) + marker(omitted.length, countLines(omitted)) + text.slice(tailStart)
  );
}
