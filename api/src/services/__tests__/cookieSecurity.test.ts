import test from 'node:test';
import assert from 'node:assert/strict';
import { hardenCookie, cookieSecurity } from '../../middleware/cookieSecurity.js';

test('hardenCookie adds HttpOnly when missing', () => {
  const out = hardenCookie('sid=abc', false);
  assert.match(out, /HttpOnly/);
});

test('hardenCookie adds SameSite=Lax when missing', () => {
  const out = hardenCookie('sid=abc', false);
  assert.match(out, /SameSite=Lax/);
});

test('hardenCookie preserves an explicit SameSite=Strict', () => {
  const out = hardenCookie('sid=abc; SameSite=Strict', false);
  assert.match(out, /SameSite=Strict/);
  assert.doesNotMatch(out, /SameSite=Lax/);
});

test('hardenCookie adds Path=/ when missing', () => {
  const out = hardenCookie('sid=abc', false);
  assert.match(out, /Path=\//);
});

test('hardenCookie adds Secure in production', () => {
  const out = hardenCookie('sid=abc', true);
  assert.match(out, /Secure/);
});

test('hardenCookie does NOT add Secure in dev (would break http://localhost)', () => {
  const out = hardenCookie('sid=abc', false);
  assert.doesNotMatch(out, /(^|;\s*)Secure(;|$)/);
});

test('hardenCookie enforces Secure + Path=/ for __Host- prefix even in dev', () => {
  const out = hardenCookie('__Host-sid=abc; Path=/api; Domain=example.com', false);
  assert.match(out, /Secure/);
  assert.match(out, /Path=\//);
  assert.doesNotMatch(out, /Domain=/);
});

test('hardenCookie preserves an existing Secure flag', () => {
  const out = hardenCookie('sid=abc; Secure', false);
  // Should appear exactly once.
  const matches = out.match(/Secure/g) || [];
  assert.equal(matches.length, 1);
});

test('hardenCookie does not duplicate HttpOnly', () => {
  const out = hardenCookie('sid=abc; HttpOnly', false);
  const matches = out.match(/HttpOnly/g) || [];
  assert.equal(matches.length, 1);
});

test('cookieSecurity middleware rewrites string Set-Cookie via setHeader', () => {
  const headers: Record<string, any> = {};
  const fakeRes: any = {
    setHeader(name: string, value: any) {
      headers[name.toLowerCase()] = value;
    },
  };
  const fakeReq: any = {};
  cookieSecurity()(fakeReq, fakeRes, () => {});
  fakeRes.setHeader('Set-Cookie', 'sid=abc');
  assert.match(headers['set-cookie'], /HttpOnly/);
  assert.match(headers['set-cookie'], /SameSite=Lax/);
  assert.match(headers['set-cookie'], /Path=\//);
});

test('cookieSecurity middleware rewrites array Set-Cookie via setHeader', () => {
  const headers: Record<string, any> = {};
  const fakeRes: any = {
    setHeader(name: string, value: any) {
      headers[name.toLowerCase()] = value;
    },
  };
  const fakeReq: any = {};
  cookieSecurity()(fakeReq, fakeRes, () => {});
  fakeRes.setHeader('Set-Cookie', ['a=1', 'b=2; SameSite=Strict']);
  assert.equal(headers['set-cookie'].length, 2);
  assert.match(headers['set-cookie'][0], /HttpOnly/);
  assert.match(headers['set-cookie'][0], /SameSite=Lax/);
  assert.match(headers['set-cookie'][1], /SameSite=Strict/);
  assert.match(headers['set-cookie'][1], /HttpOnly/);
});

test('cookieSecurity middleware leaves non-cookie headers untouched', () => {
  const headers: Record<string, any> = {};
  const fakeRes: any = {
    setHeader(name: string, value: any) {
      headers[name.toLowerCase()] = value;
    },
  };
  const fakeReq: any = {};
  cookieSecurity()(fakeReq, fakeRes, () => {});
  fakeRes.setHeader('X-Custom', 'plain-value');
  assert.equal(headers['x-custom'], 'plain-value');
});
