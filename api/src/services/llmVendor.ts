// ─── LLM vendor labels for usage reporting ──────────────────────────────────
//
// token_usage_log rows written by CLI runners often carry no model (the CLI
// bills against a subscription and its transcripts may not name one), so the
// row is stored with model='unknown' and a provider that is really the runner
// id ('claudecode', 'codex', …) or an LLM-config provider type ('claude',
// 'openai', …). Charts keyed on the model then show a meaningless "unknown"
// slice. These helpers turn such a row into the vendor behind it.

const VENDOR_PATTERNS: Array<[RegExp, string]> = [
  // Order matters: 'github-copilot' must win over any generic match.
  [/copilot/i, 'Copilot'],
  [/claude|anthropic|^coder$/i, 'Anthropic'],
  [/codex|openai|gpt|^o\d/i, 'OpenAI'],
  [/mistral/i, 'Mistral'],
  [/gemini|google/i, 'Google'],
  [/ollama/i, 'Ollama'],
  [/vllm/i, 'vLLM'],
  [/opencode/i, 'OpenCode'],
  [/hermes/i, 'Hermes'],
  [/openclaw/i, 'OpenClaw'],
  [/aider/i, 'Aider'],
];

const PLACEHOLDERS = new Set(['', 'unknown', 'cli', 'null', 'undefined']);

function isPlaceholder(value: unknown): boolean {
  return PLACEHOLDERS.has(
    String(value ?? '')
      .trim()
      .toLowerCase()
  );
}

/** Vendor name for a provider / runner id / model string, or null. */
export function vendorFor(value: unknown): string | null {
  if (isPlaceholder(value)) return null;
  const s = String(value).trim();
  for (const [re, vendor] of VENDOR_PATTERNS) {
    if (re.test(s)) return vendor;
  }
  return null;
}

/**
 * Human label for a usage row: the model when it is known, otherwise the
 * vendor inferred from the provider/runner, otherwise the provider display
 * name, otherwise 'Unknown'.
 */
export function usageLabel(row: {
  provider?: unknown;
  model?: unknown;
  displayName?: unknown;
}): string {
  if (!isPlaceholder(row.model)) return String(row.model).trim();
  const vendor = vendorFor(row.provider) || vendorFor(row.displayName);
  if (vendor) return vendor;
  if (!isPlaceholder(row.displayName)) return String(row.displayName).trim();
  if (!isPlaceholder(row.provider)) return String(row.provider).trim();
  return 'Unknown';
}
