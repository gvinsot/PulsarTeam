/**
 * Shared predicate for "is this LLM config a realtime (speech-to-speech) model".
 * One definition instead of the substring check copy-pasted across the UI.
 * Returns false for undefined/missing model so unset configs stay excluded.
 */
export const isRealtimeLlm = (c: any): boolean => !!c?.model?.includes('gpt-realtime');
