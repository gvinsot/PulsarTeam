import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import test, { describe } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CodeIndexService } from '../codeIndexService.js';
import { createCodeIndexMcpServer } from '../codeIndexMcp.js';
import { InMemoryVectorStore } from '../codeSearch/vectorStore.js';
import {
  decodeReference,
  extractReferencesFromContent,
  maskNonCode,
  REF_CALL,
  REF_IMPORT,
  REF_MEMBER,
} from '../codeSearch/referenceExtractor.js';

// ─── referenceExtractor ─────────────────────────────────────────────────────

describe('referenceExtractor', () => {
  test('masks comments and strings but keeps template expressions as code', () => {
    const masked = maskNonCode(
      // eslint-disable-next-line no-template-curly-in-string -- JS source under test
      'a(); // b()\n/* c() */ const s = "d()" + `e ${f()} g`;\n',
      'javascript'
    );
    assert.match(masked, /a\(\)/);
    assert.match(masked, /f\(\)/);
    assert.doesNotMatch(masked, /b\(\)|c\(\)|d\(\)|\be\b|\bg\b/);
    assert.equal(masked.split('\n').length, 3, 'line structure is preserved');
  });

  test('masks Python comments, triple-quoted and prefixed strings', () => {
    const masked = maskNonCode('x() # y()\n"""z()"""\nf"w{v}"\n', 'python');
    assert.match(masked, /x\(\)/);
    assert.doesNotMatch(masked, /y\(\)|z\(\)|w|\bf\b/);
  });

  test('parses ESM, re-export and CommonJS imports with their bindings', () => {
    const { imports } = extractReferencesFromContent(
      [
        "import Default, { a, b as c } from './mod.js';",
        "import * as ns from '../ns';",
        "import type { T } from './types';",
        "export { x as y } from './x';",
        "export * from './all';",
        "const { r, s: t } = require('./req');",
        "const whole = require('pkg');",
        "// import { ghost } from './ghost';",
      ].join('\n'),
      'typescript'
    );

    const byModule = Object.fromEntries(imports.map(record => [record.module, record]));
    assert.deepEqual(
      byModule['./mod.js'].bindings.sort((l, r) => l.imported.localeCompare(r.imported)),
      [
        { imported: 'a', local: 'a' },
        { imported: 'b', local: 'c' },
        { imported: 'default', local: 'Default' },
      ]
    );
    assert.deepEqual(byModule['../ns'].bindings, [{ imported: '*', local: 'ns' }]);
    assert.deepEqual(byModule['./types'].bindings, [{ imported: 'T', local: 'T' }]);
    assert.equal(byModule['./x'].reexport, true);
    assert.deepEqual(byModule['./x'].bindings, [{ imported: 'x', local: 'y' }]);
    assert.deepEqual(byModule['./all'].bindings, [{ imported: '*', local: '*' }]);
    assert.deepEqual(byModule['./req'].bindings, [
      { imported: 'r', local: 'r' },
      { imported: 's', local: 't' },
    ]);
    assert.deepEqual(byModule.pkg.bindings, [{ imported: '*', local: 'whole' }]);
    assert.equal(byModule['./ghost'], undefined, 'commented-out imports are ignored');
    assert.equal(byModule['./mod.js'].line, 1);
    assert.equal(byModule['./req'].line, 6);
  });

  test('parses Python imports', () => {
    const { imports } = extractReferencesFromContent(
      'from .util import (\n    parse,\n    load as ld,\n)\nimport pkg.sub as ps, os\nfrom pkg import *\n',
      'python'
    );
    assert.deepEqual(imports[0], {
      module: '.util',
      line: 1,
      bindings: [
        { imported: 'parse', local: 'parse' },
        { imported: 'load', local: 'ld' },
      ],
    });
    const star = imports.find(record => record.module === 'pkg');
    assert.deepEqual(star?.bindings, [{ imported: '*', local: '*' }]);
    const modules = imports.map(record => `${record.module}:${record.bindings[0].local}`);
    assert.ok(modules.includes('pkg.sub:ps'));
    assert.ok(modules.includes('os:os'));
  });

  test('flags calls, member accesses with receivers and import sites', () => {
    const { references } = extractReferencesFromContent(
      [
        "import { save } from './store';",
        'function run(items) {',
        '  save(items);',
        '  this.repo.save(items);',
        '  const handler = save;',
        '  return new Widget();',
        '}',
      ].join('\n'),
      'javascript',
      [{ name: 'run', startLine: 2 }]
    );

    const save = references.save.map(decodeReference);
    assert.deepEqual(save.find(ref => ref.line === 1)?.flags, REF_IMPORT);
    assert.deepEqual(save.find(ref => ref.line === 3)?.flags, REF_CALL);
    assert.deepEqual(
      save.find(ref => ref.line === 4),
      {
        line: 4,
        flags: REF_CALL | REF_MEMBER,
        receiver: 'repo',
      }
    );
    assert.deepEqual(save.find(ref => ref.line === 5)?.flags, 0);
    assert.equal(decodeReference(references.Widget[0]).flags & REF_CALL, REF_CALL);
    assert.equal(references.run, undefined, 'the definition site is not a reference');
    assert.equal(references.handler, undefined, 'a const declaration is not a reference');
    assert.equal(references.function, undefined, 'keywords are skipped');
  });
});

// ─── CodeIndexService.findReferences / findCallers ─────────────────────────

const FIXTURES: Record<string, string> = {
  'src/auth.js': `
export class AuthService {
  validateToken(token) {
    return Boolean(token);
  }

  login(token) {
    return this.validateToken(token);
  }
}

export const createToken = (payload) => {
  return 'tok_' + JSON.stringify(payload);
};

export function helper() {
  return createToken({});
}
`,
  'src/index.js': `
export { createToken } from './auth.js';
export * from './auth.js';
`,
  'src/api.ts': `
import { createToken as makeToken, AuthService } from './auth';
import * as auth from './auth.js';

const service = new AuthService();

export function handler() {
  return makeToken({ id: 1 }) + auth.helper();
}

service.login('x');
`,
  'src/viaBarrel.js': `
import { createToken } from './index.js';

export function issue() {
  return createToken({ scope: 'all' });
}
`,
  'src/shadow.js': `
function createToken() {
  return 'local';
}

createToken();
`,
  'src/noise.js': `
// createToken() is mentioned in a comment
const text = "createToken()";
`,
  'pkg/__init__.py': '',
  'pkg/util.py': `
def parse_text(value):
    return value.strip()
`,
  'app.py': `
from pkg.util import parse_text as pt
import pkg.util


def run():
    pt(" a ")
    return pkg.util.parse_text(" b ")
`,
};

async function withIndexedRepo(
  run: (service: CodeIndexService, repoId: string, repoDir: string) => Promise<void>
) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'code-index-refs-'));
  try {
    const repoDir = path.join(tempDir, 'repo');
    for (const [relativePath, content] of Object.entries(FIXTURES)) {
      const absolutePath = path.join(repoDir, relativePath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, content.trimStart());
    }
    const service = new CodeIndexService({
      storageRoot: path.join(tempDir, '.index-data'),
      allowedRoots: [tempDir],
      vectorStoreFactory: async () => new InMemoryVectorStore(),
    });
    const repo = await service.indexFolder({ folderPath: repoDir, repoName: 'refs-demo' });
    await run(service, repo.id, repoDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

const at = (ref: { filePath: string; line: number }) => `${ref.filePath}:${ref.line}`;

describe('CodeIndexService reference graph', () => {
  test('stores imports and references per file at indexing time', async () => {
    await withIndexedRepo(async (service, repoId) => {
      const index = await service.loadIndex(repoId);
      const api = index.files.find(file => file.path === 'src/api.ts');
      assert.ok(api?.imports?.some(record => record.module === './auth'));
      assert.ok(api?.references && Object.hasOwn(api.references, 'makeToken'));
    });
  });

  test('find_references resolves aliases, barrels and namespaces, and skips look-alikes', async () => {
    await withIndexedRepo(async (service, repoId) => {
      const result = await service.findReferences(repoId, 'src/auth.js::createToken#function');
      assert.equal(result.graphAvailable, true);
      const byLocation = new Map(result.references.map(ref => [at(ref), ref]));

      // Same file
      assert.equal(byLocation.get('src/auth.js:16')?.kind, 'call');
      assert.equal(byLocation.get('src/auth.js:16')?.enclosingSymbol?.qualifiedName, 'helper');
      // Aliased import + call through the alias
      assert.equal(byLocation.get('src/api.ts:1')?.kind, 'import');
      const aliasCall = byLocation.get('src/api.ts:7');
      assert.equal(aliasCall?.kind, 'call');
      assert.equal(aliasCall?.confidence, 'high');
      assert.equal(aliasCall?.enclosingSymbol?.qualifiedName, 'handler');
      assert.match(aliasCall?.preview ?? '', /makeToken/);
      // Re-exported through the barrel
      assert.equal(byLocation.get('src/index.js:1')?.kind, 'import');
      const barrelCall = byLocation.get('src/viaBarrel.js:4');
      assert.equal(barrelCall?.confidence, 'high');
      assert.equal(barrelCall?.enclosingSymbol?.qualifiedName, 'issue');

      // A local function with the same name, comments and strings are not references
      assert.ok(!result.references.some(ref => ref.filePath === 'src/shadow.js'));
      assert.ok(!result.references.some(ref => ref.filePath === 'src/noise.js'));
      // The definition itself is not reported
      assert.ok(!byLocation.has('src/auth.js:11'));

      const withoutImports = await service.findReferences(
        repoId,
        'src/auth.js::createToken#function',
        {
          includeImports: false,
        }
      );
      assert.ok(withoutImports.references.every(ref => ref.kind !== 'import'));

      const limited = await service.findReferences(repoId, 'src/auth.js::createToken#function', {
        limit: 1,
      });
      assert.equal(limited.references.length, 1);
      assert.equal(limited.truncated, true);
      assert.equal(limited.total, result.total);
    });
  });

  test('find_references follows namespace imports and Python modules', async () => {
    await withIndexedRepo(async (service, repoId) => {
      const helper = await service.findReferences(repoId, 'src/auth.js::helper#function');
      const viaNamespace = helper.references.find(ref => at(ref) === 'src/api.ts:7');
      assert.equal(viaNamespace?.confidence, 'high');
      assert.equal(viaNamespace?.receiver, 'auth');

      const parse = await service.findReferences(repoId, 'pkg/util.py::parse_text#function');
      const locations = parse.references.map(ref => `${at(ref)}:${ref.kind}:${ref.confidence}`);
      assert.ok(locations.includes('app.py:1:import:high'));
      assert.ok(locations.includes('app.py:6:call:high'), 'call through the `as` alias');
      assert.ok(locations.includes('app.py:7:call:high'), 'call through `pkg.util.`');
    });
  });

  test('find_callers groups call sites per calling symbol', async () => {
    await withIndexedRepo(async (service, repoId) => {
      const validate = await service.findCallers(
        repoId,
        'src/auth.js::AuthService.validateToken#method'
      );
      assert.equal(validate.total, 1);
      assert.equal(validate.callers[0].caller?.qualifiedName, 'AuthService.login');
      assert.deepEqual(validate.callers[0].lines, [7]);
      assert.equal(validate.callers[0].confidence, 'high');

      // `new AuthService()` at module level of api.ts
      const ctor = await service.findCallers(repoId, 'src/auth.js::AuthService#class');
      assert.deepEqual(
        ctor.callers.map(entry => [entry.caller, entry.filePath, entry.lines]),
        [[null, 'src/api.ts', [4]]]
      );

      const createToken = await service.findCallers(repoId, 'src/auth.js::createToken#function');
      assert.deepEqual(createToken.callers.map(entry => entry.caller?.qualifiedName).sort(), [
        'handler',
        'helper',
        'issue',
      ]);
      assert.equal(createToken.totalCalls, 3);
    });
  });

  test('update_files refreshes the graph for changed files', async () => {
    await withIndexedRepo(async (service, repoId) => {
      await service.updateFiles(repoId, [
        {
          path: 'src/late.js',
          content:
            "import { helper } from './auth.js';\nexport function late() {\n  return helper();\n}\n",
        },
        { path: 'src/viaBarrel.js', content: 'export const nothing = 1;\n' },
      ]);
      const callers = await service.findCallers(repoId, 'src/auth.js::createToken#function');
      assert.ok(!callers.callers.some(entry => entry.filePath === 'src/viaBarrel.js'));

      const helperCallers = await service.findCallers(repoId, 'src/auth.js::helper#function');
      assert.ok(
        helperCallers.callers.some(
          entry => entry.caller?.qualifiedName === 'late' && entry.confidence === 'high'
        )
      );
    });
  });

  test('reports a missing graph on indexes built before it existed', async () => {
    await withIndexedRepo(async (service, repoId) => {
      const index = await service.loadIndex(repoId);
      for (const file of index.files) {
        delete file.imports;
        delete file.references;
      }
      const result = await service.findReferences(repoId, 'src/auth.js::helper#function');
      assert.equal(result.graphAvailable, false);
      assert.equal(result.total, 0);
    });
  });

  test('rejects unknown symbols', async () => {
    await withIndexedRepo(async (service, repoId) => {
      await assert.rejects(service.findReferences(repoId, 'nope#function'), /not found/);
      await assert.rejects(service.findCallers(repoId, 'nope#function'), /not found/);
    });
  });
});

// ─── MCP tools ─────────────────────────────────────────────────────────────

describe('Code Index MCP reference tools', () => {
  test('find_references and find_callers are exposed and render results', async () => {
    await withIndexedRepo(async (service, repoId) => {
      const server = createCodeIndexMcpServer(service);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'test', version: '1.0.0' });
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      try {
        const { tools } = await client.listTools();
        const names = tools.map(tool => tool.name);
        assert.ok(names.includes('find_references'));
        assert.ok(names.includes('find_callers'));

        const references = await client.callTool({
          name: 'find_references',
          arguments: {
            repoId,
            symbolId: 'src/auth.js::createToken#function',
            minConfidence: 'high',
          },
        });
        const referencesText = (references.content as { text: string }[])[0].text;
        assert.match(referencesText, /References to createToken \[function\]/);
        assert.match(referencesText, /src\/api\.ts:7 \[call, high\] in handler/);

        const callers = await client.callTool({
          name: 'find_callers',
          arguments: { repoId, symbolId: 'src/auth.js::AuthService.validateToken#method' },
        });
        const callersText = (callers.content as { text: string }[])[0].text;
        assert.match(callersText, /AuthService\.login \[method\]/);
        assert.match(callersText, /lines 7 \[high\]/);
      } finally {
        await client.close();
        await server.close();
      }
    });
  });
});
