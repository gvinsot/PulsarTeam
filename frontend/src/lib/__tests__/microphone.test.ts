import test from 'node:test';
import assert from 'node:assert/strict';
import { requestMicrophone } from '../voice/microphone.ts';

function environment(t, overrides = {}) {
  const values = {
    isSecureContext: true,
    document: {},
    navigator: {
      mediaDevices: { getUserMedia: async () => ({ id: 'microphone' }) },
      permissions: {
        query: () => {
          throw new Error('Permission preflight must not run');
        },
      },
    },
    ...overrides,
  };
  for (const [key, value] of Object.entries(values)) {
    const before = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => {
      if (before) Object.defineProperty(globalThis, key, before);
      else delete globalThis[key];
    });
  }
}

test('microphone asks getUserMedia directly, without permission preflight', async t => {
  environment(t);
  assert.deepEqual(await requestMicrophone(), { id: 'microphone' });
});
test('microphone diagnoses server policy rather than blaming browser permissions', async t => {
  environment(t, { document: { featurePolicy: { allowsFeature: () => false } } });
  await assert.rejects(requestMicrophone(), /Permissions-Policy/);
});
test('microphone diagnoses insecure origins', async t => {
  environment(t, { isSecureContext: false });
  await assert.rejects(requestMicrophone(), /HTTPS or localhost/);
});
for (const [name, message] of [
  ['NotAllowedError', /browser permissions/],
  ['NotFoundError', /No microphone/],
  ['NotReadableError', /Microphone unavailable/],
]) {
  test(`microphone diagnoses ${name}`, async t => {
    environment(t, {
      navigator: {
        mediaDevices: {
          getUserMedia: async () => {
            throw new DOMException('', name);
          },
        },
      },
    });
    await assert.rejects(requestMicrophone(), message);
  });
}
