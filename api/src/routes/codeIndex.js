import express from 'express';
import { z } from 'zod';

const booleanQuerySchema = z
  .union([z.boolean(), z.string()])
  .transform((value, ctx) => {
    if (typeof value === 'boolean') return value;
    const normalized = value.toLowerCase().trim();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;

    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Expected "true" or "false"',
    });
    return z.NEVER;
  });

const indexFolderSchema = z.object({
  path: z.string().min(1).max(5000),
  repoName: z.string().min(1).max(200).optional(),
  maxFiles: z.number().int().min(1).max(20000).optional(),
  maxFileSize: z.number().int().min(1024).max(5 * 1024 * 1024).optional(),
});

const repoParamsSchema = z.object({
  repoId: z.string().min(1).max(200),
});

const fileOutlineQuerySchema = z.object({
  filePath: z.string().min(1).max(5000),
});

const getSymbolQuerySchema = z.object({
  symbolId: z.string().min(1).max(5000),
  verify: booleanQuerySchema.optional(),
  contextLines: z.coerce.number().int().min(0).max(50).optional(),
});

const searchQuerySchema = z.object({
  query: z.string().min(1).max(1000),
  topK: z.coerce.number().int().min(1).max(50).optional(),
});

const searchSymbolsQuerySchema = searchQuerySchema.extend({
  kind: z.enum(['function', 'class', 'method']).optional(),
});

function handleValidationError(res, error) {
  if (error instanceof z.ZodError) {
    return res.status(400).json({ error: 'Validation failed', details: error.issues });
  }
  return null;
}

export function codeIndexRoutes(codeIndexService) {
  const router = express.Router();

  router.post('/index-folder', async (req, res) => {
    try {
      const parsed = indexFolderSchema.parse(req.body);
      const result = await codeIndexService.indexFolder({
        folderPath: parsed.path,
        repoName: parsed.repoName,
        maxFiles: parsed.maxFiles,
        maxFileSize: parsed.maxFileSize,
      });
      res.status(201).json(result);
    } catch (error) {
      if (handleValidationError(res, error)) return;
      res.status(400).json({ error: error.message });
    }
  });

  router.get('/repos', async (req, res) => {
    try {
      const repos = await codeIndexService.listRepos();
      res.json(repos);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get('/repos/:repoId', async (req, res) => {
    try {
      const params = repoParamsSchema.parse(req.params);
      const repo = await codeIndexService.getRepoSummary(params.repoId);
      res.json(repo);
    } catch (error) {
      if (handleValidationError(res, error)) return;
      res.status(404).json({ error: error.message });
    }
  });

  router.get('/repos/:repoId/file-tree', async (req, res) => {
    try {
      const params = repoParamsSchema.parse(req.params);
      const tree = await codeIndexService.getFileTree(params.repoId);
      res.json(tree);
    } catch (error) {
      if (handleValidationError(res, error)) return;
      res.status(404).json({ error: error.message });
    }
  });

  router.get('/repos/:repoId/file-outline', async (req, res) => {
    try {
      const params = repoParamsSchema.parse(req.params);
      const query = fileOutlineQuerySchema.parse(req.query);
      const outline = await codeIndexService.getFileOutline(params.repoId, query.filePath);
      res.json(outline);
    } catch (error) {
      if (handleValidationError(res, error)) return;
      res.status(404).json({ error: error.message });
    }
  });

  router.get('/repos/:repoId/symbol', async (req, res) => {
    try {
      const params = repoParamsSchema.parse(req.params);
      const query = getSymbolQuerySchema.parse(req.query);
      const symbol = await codeIndexService.getSymbol(params.repoId, query.symbolId, {
        verify: query.verify,
        contextLines: query.contextLines,
      });
      res.json(symbol);
    } catch (error) {
      if (handleValidationError(res, error)) return;
      res.status(404).json({ error: error.message });
    }
  });

  router.get('/repos/:repoId/search-symbols', async (req, res) => {
    try {
      const params = repoParamsSchema.parse(req.params);
      const query = searchSymbolsQuerySchema.parse(req.query);
      const results = await codeIndexService.searchSymbols(params.repoId, query);
      res.json(results);
    } catch (error) {
      if (handleValidationError(res, error)) return;
      res.status(400).json({ error: error.message });
    }
  });

  router.get('/repos/:repoId/search-semantic', async (req, res) => {
    try {
      const params = repoParamsSchema.parse(req.params);
      const query = searchQuerySchema.parse(req.query);
      const results = await codeIndexService.searchSemantic(params.repoId, query);
      res.json(results);
    } catch (error) {
      if (handleValidationError(res, error)) return;
      res.status(400).json({ error: error.message });
    }
  });

  router.get('/repos/:repoId/search-text', async (req, res) => {
    try {
      const params = repoParamsSchema.parse(req.params);
      const query = searchQuerySchema.parse(req.query);
      const results = await codeIndexService.searchText(params.repoId, query);
      res.json(results);
    } catch (error) {
      if (handleValidationError(res, error)) return;
      res.status(400).json({ error: error.message });
    }
  });

  router.delete('/repos/:repoId', async (req, res) => {
    try {
      const params = repoParamsSchema.parse(req.params);
      const result = await codeIndexService.invalidate(params.repoId);
      res.json(result);
    } catch (error) {
      if (handleValidationError(res, error)) return;
      res.status(400).json({ error: error.message });
    }
  });

  return router;
}