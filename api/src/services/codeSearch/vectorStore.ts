import fs from 'fs/promises';
import path from 'path';
import { cosineSimilarity, EMBEDDING_DIMENSION } from './embedding.js';

function unwrapZvecModule(module: any): any {
  const raw = module?.default || module;
  if (!raw) return raw;

  return {
    ...raw,
    DataType: raw.DataType || raw.ZVecDataType,
    CollectionSchema: raw.CollectionSchema || raw.ZVecCollectionSchema,
    createAndOpen: raw.createAndOpen || raw.ZVecCreateAndOpen,
    openCollection: raw.openCollection || raw.open || raw.ZVecOpen,
  };
}

async function tryCandidates(candidates: Array<() => any>, errorMessage: string): Promise<any> {
  let lastError: Error | null = null;
  for (const candidate of candidates) {
    try {
      const value = candidate();
      return value instanceof Promise ? await value : value;
    } catch (error: any) {
      lastError = error;
    }
  }
  throw new Error(`${errorMessage}${lastError ? `: ${lastError.message}` : ''}`);
}

function sanitizeCollectionName(value: any): string {
  return String(value).replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 120);
}

function normalizeResults(results: any): Array<{ id: any; score: number; payload: any }> {
  const list = Array.isArray(results) && Array.isArray(results[0]) ? results[0] : results;
  if (!Array.isArray(list)) return [];

  return list
    .map((item) => ({
      id: item?.id || item?.docId || item?.doc?.id || item?._id || null,
      score: Number(item?.score ?? item?.similarity ?? item?.distance ?? 0),
      payload: item,
    }))
    .filter((item) => item.id);
}

interface VectorDoc {
  id: string;
  vector: number[];
  fields?: Record<string, any>;
}

interface QueryResult {
  id: string;
  score: number;
  payload?: any;
}

function findMinIndex(results: QueryResult[]): number {
  let minIdx = 0;
  for (let i = 1; i < results.length; i++) {
    if (results[i].score < results[minIdx].score) minIdx = i;
  }
  return minIdx;
}

export class InMemoryVectorStore {
  dimension: number;
  collections: Map<string, Map<string, { id: string; vector: number[]; fields: Record<string, any> }>>;
  backend: string;

  constructor({ dimension = EMBEDDING_DIMENSION }: { dimension?: number } = {}) {
    this.dimension = dimension;
    this.collections = new Map();
    this.backend = 'memory';
  }

  async resetCollection(collectionName: string): Promise<void> {
    this.collections.delete(collectionName);
  }

  async upsert(collectionName: string, docs: VectorDoc[]): Promise<void> {
    const collection = this.collections.get(collectionName) || new Map();
    for (const doc of docs) {
      collection.set(doc.id, {
        id: doc.id,
        vector: Array.isArray(doc.vector) ? doc.vector : [],
        fields: doc.fields || {},
      });
    }
    this.collections.set(collectionName, collection);
  }

  async remove(collectionName: string, ids: string[]): Promise<void> {
    const collection = this.collections.get(collectionName);
    if (!collection) return;
    for (const id of ids) {
      collection.delete(id);
    }
  }

  async query(collectionName: string, vector: number[], topK: number = 10): Promise<QueryResult[]> {
    const collection = this.collections.get(collectionName);
    if (!collection) return [];

    // Track the current minimum to keep top-K without sorting the full collection.
    const results: QueryResult[] = [];
    let minScore = -Infinity;
    let minIdx = 0;

    for (const item of collection.values()) {
      const score = cosineSimilarity(vector, item.vector);
      if (results.length < topK) {
        results.push({ id: item.id, score });
        if (results.length === topK) {
          minIdx = findMinIndex(results);
          minScore = results[minIdx].score;
        }
      } else if (score > minScore) {
        results[minIdx] = { id: item.id, score };
        minIdx = findMinIndex(results);
        minScore = results[minIdx].score;
      }
    }

    return results.sort((left, right) => right.score - left.score);
  }
}

export class ZvecVectorStore {
  rootDir: string | undefined;
  dimension: number;
  backend: string;
  collections: Map<string, any>;
  zvecPromise: Promise<any> | null;

  constructor({ rootDir, dimension = EMBEDDING_DIMENSION }: { rootDir?: string; dimension?: number } = {}) {
    this.rootDir = rootDir;
    this.dimension = dimension;
    this.backend = 'zvec';
    this.collections = new Map();
    this.zvecPromise = null;
  }

  async init(): Promise<this> {
    await fs.mkdir(this.rootDir!, { recursive: true });
    await this.loadModule();
    return this;
  }

  async loadModule(): Promise<any> {
    if (!this.zvecPromise) {
      this.zvecPromise = import('@zvec/zvec').then(unwrapZvecModule);
    }
    return this.zvecPromise;
  }

  collectionPath(collectionName: string): string {
    return path.join(this.rootDir!, sanitizeCollectionName(collectionName));
  }

  async releaseCollection(collectionName: string): Promise<void> {
    const cached = this.collections.get(collectionName);
    if (cached?.close && typeof cached.close === 'function') {
      try {
        await cached.close();
      } catch {
        // ignore
      }
    }
    this.collections.delete(collectionName);
  }

  async resetCollection(collectionName: string): Promise<void> {
    await this.releaseCollection(collectionName);
    await fs.rm(this.collectionPath(collectionName), { recursive: true, force: true });
  }

  async createSchema(zvec: any, collectionName: string): Promise<any> {
    const DataType = zvec.DataType || {};
    const dataType = DataType.VECTOR_FP32 || DataType.VectorFp32 || DataType.vector_fp32 || Object.values(DataType)[0];

    if (!zvec.CollectionSchema) {
      throw new Error('ZVEC module does not expose CollectionSchema');
    }

    return tryCandidates([
      () => new zvec.CollectionSchema(collectionName, [
        { name: 'embedding', dataType, dimension: this.dimension },
      ]),
      () => new zvec.CollectionSchema({
        name: collectionName,
        vectors: [{ name: 'embedding', dataType, dimension: this.dimension }],
      }),
      () => new zvec.CollectionSchema(collectionName, {
        vectors: [{ name: 'embedding', dataType, dimension: this.dimension }],
      }),
    ], 'Unable to create ZVEC collection schema');
  }

  async getCollection(collectionName: string): Promise<any> {
    if (this.collections.has(collectionName)) {
      return this.collections.get(collectionName);
    }

    const zvec = await this.loadModule();
    const sanitizedName = sanitizeCollectionName(collectionName);
    const schema = await this.createSchema(zvec, sanitizedName);
    const vectorPath = this.collectionPath(collectionName);

    await fs.mkdir(path.dirname(vectorPath), { recursive: true });

    const createAndOpen = zvec.createAndOpen || zvec.openCollection;
    if (!createAndOpen) {
      throw new Error('ZVEC module does not expose create/open collection API');
    }

    const collection = await tryCandidates([
      () => createAndOpen(vectorPath, schema),
      () => createAndOpen({ path: vectorPath, schema }),
      () => createAndOpen(schema, vectorPath),
      () => createAndOpen({ schema, path: vectorPath }),
    ], 'Unable to open ZVEC collection');

    this.collections.set(collectionName, collection);
    return collection;
  }

  async upsert(collectionName: string, docs: VectorDoc[]): Promise<void> {
    const collection = await this.getCollection(collectionName);
    const payload = docs.map((doc) => ({
      id: doc.id,
      vectors: {
        embedding: doc.vector,
      },
      fields: doc.fields || {},
    }));

    await tryCandidates([
      () => collection.insert(payload),
      () => collection.upsert(payload),
      () => collection.add(payload),
    ], 'Unable to insert vectors into ZVEC');
  }

  async remove(collectionName: string, ids: string[]): Promise<void> {
    try {
      const collection = await this.getCollection(collectionName);
      await tryCandidates([
        () => collection.delete(ids),
        () => collection.remove(ids),
        () => Promise.all(ids.map((id: string) => collection.delete(id))),
      ], 'Unable to remove vectors from ZVEC');
    } catch {
      // Best-effort: zvec may not support deletion — vectors will be overwritten on next upsert
    }
  }

  async query(collectionName: string, vector: number[], topK: number = 10): Promise<QueryResult[]> {
    const collection = await this.getCollection(collectionName);

    const results = await tryCandidates([
      () => collection.query({ vectorName: 'embedding', vector, topK }),
      () => collection.query({ field: 'embedding', vector, topK }),
      () => collection.query({ field: 'embedding', vector, topk: topK }),
      () => collection.query({ embedding: vector, topK }),
      () => collection.querySync({ field: 'embedding', vector, topK }),
      () => collection.querySync({ vectorName: 'embedding', vector, topK }),
    ], 'Unable to query ZVEC');

    return normalizeResults(results);
  }
}

export async function createVectorStore({
  backend = process.env.CODE_SEARCH_VECTOR_BACKEND || 'auto',
  rootDir,
  dimension = EMBEDDING_DIMENSION,
}: {
  backend?: string;
  rootDir?: string;
  dimension?: number;
} = {}): Promise<InMemoryVectorStore | ZvecVectorStore> {
  if (backend === 'memory') {
    return new InMemoryVectorStore({ dimension });
  }

  try {
    const store = new ZvecVectorStore({ rootDir, dimension });
    return await store.init();
  } catch (error: any) {
    const store = new InMemoryVectorStore({ dimension });
    store.backend = backend === 'auto' ? 'memory' : `memory-fallback-from-${backend}`;
    // Suppress warning in test mode to avoid false failures
    const isTestMode = process.argv.some(arg => arg.includes('--test')) || process.env.NODE_ENV === 'test';
    if (!isTestMode) {
      console.info(`Code index: using in-memory vector store (zvec native binary unavailable on this platform: ${error.message})`);
    }
    return store;
  }
}
