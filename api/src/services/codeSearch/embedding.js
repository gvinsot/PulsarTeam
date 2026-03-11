import crypto from 'crypto';

export const EMBEDDING_DIMENSION = 256;

const TOKEN_REGEX = /[a-z0-9_.$:-]{2,}/g;

export function normalizeText(value = '') {
  return String(value)
    .normalize('NFKD')
    .replace(/[^\w\s.$:-]+/g, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenizeForEmbedding(value = '') {
  const normalized = normalizeText(value).slice(0, 8000);
  if (!normalized) return [];

  const tokens = [];
  const matches = normalized.match(TOKEN_REGEX) || [];
  for (const token of matches.slice(0, 256)) {
    tokens.push(token);

    if (token.includes('.')) {
      for (const part of token.split('.')) {
        if (part.length >= 2) tokens.push(part);
      }
    }

    if (token.includes('_')) {
      for (const part of token.split('_')) {
        if (part.length >= 2) tokens.push(part);
      }
    }

    if (token.length >= 5) {
      for (let i = 0; i <= token.length - 3; i += 1) {
        tokens.push(token.slice(i, i + 3));
      }
    }
  }

  for (let i = 0; i <= Math.min(normalized.length - 3, 384); i += 3) {
    const gram = normalized.slice(i, i + 3).trim();
    if (gram.length === 3) tokens.push(gram);
  }

  return tokens;
}

function hashToken(token, dimension) {
  const digest = crypto.createHash('sha1').update(token).digest();
  const index = digest.readUInt32BE(0) % dimension;
  const sign = (digest[4] & 1) === 0 ? 1 : -1;
  const weight = 1 + (digest[5] / 255) * 0.25;
  return { index, sign, weight };
}

export function normalizeVector(vector) {
  let norm = 0;
  for (const value of vector) {
    norm += value * value;
  }

  if (norm === 0) return vector;
  const scale = 1 / Math.sqrt(norm);
  return vector.map((value) => Number((value * scale).toFixed(8)));
}

export function createHashedEmbedding(value = '', dimension = EMBEDDING_DIMENSION) {
  const vector = new Array(dimension).fill(0);
  for (const token of tokenizeForEmbedding(value)) {
    const { index, sign, weight } = hashToken(token, dimension);
    vector[index] += sign * weight;
  }
  return normalizeVector(vector);
}

export function cosineSimilarity(left = [], right = []) {
  if (!left.length || !right.length || left.length !== right.length) return 0;

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (let i = 0; i < left.length; i += 1) {
    dot += left[i] * right[i];
    leftNorm += left[i] * left[i];
    rightNorm += right[i] * right[i];
  }

  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}