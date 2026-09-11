/**
 * Shared predicate for "is this LLM config a realtime (speech-to-speech) model".
 * One definition instead of the substring check copy-pasted across the UI.
 * Returns false for undefined/missing model so unset configs stay excluded.
 */
type Config = { provider?: string | null; model?: string | null };
export const isGeminiLlm = (c?: Config | null): boolean =>
  c?.provider === 'google' || c?.provider === 'gemini';
export const isRealtimeLlm = (c?: Config | null): boolean => {
  const model = c?.model || '';
  if (isGeminiLlm(c)) return /^gemini-.*(?:live|native-audio)/.test(model);
  return (!c?.provider || c.provider === 'openai') && model.startsWith('gpt-realtime');
};
export const OPENAI_VOICES = [
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'sage',
  'shimmer',
  'verse',
  'marin',
  'cedar',
];
export const GEMINI_VOICES = [
  'Puck',
  'Charon',
  'Kore',
  'Fenrir',
  'Aoede',
  'Leda',
  'Orus',
  'Zephyr',
];
export const voiceOptions = (c?: Config | null): string[] =>
  isGeminiLlm(c) ? GEMINI_VOICES : OPENAI_VOICES;
export const selectedVoice = (voice: string, c?: Config | null): string =>
  voiceOptions(c).includes(voice) ? voice : isGeminiLlm(c) ? 'Kore' : 'alloy';
