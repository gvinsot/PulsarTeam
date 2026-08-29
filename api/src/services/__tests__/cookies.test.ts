/**
 * Tests for lib/cookies — the dependency-free `Cookie:` header parser.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCookies, readCookie, readFirstCookie } from '../../lib/cookies.js';

test('parseCookies returns an empty jar for an empty header', () => {
  assert.deepEqual(Object.keys(parseCookies('')), []);
});

test('parseCookies returns an empty jar for undefined', () => {
  assert.deepEqual(Object.keys(parseCookies(undefined)), []);
});

test('parseCookies returns an empty jar for null', () => {
  assert.deepEqual(Object.keys(parseCookies(null)), []);
});

test('parseCookies reads multiple cookies from one header', () => {
  const jar = parseCookies('a=1; b=2; c=3');
  assert.equal(jar.a, '1');
  assert.equal(jar.b, '2');
  assert.equal(jar.c, '3');
  assert.deepEqual(Object.keys(jar), ['a', 'b', 'c']);
});

test('parseCookies trims whitespace around names and values', () => {
  const jar = parseCookies('  spaced   =   value   ;   other =  second  ');
  assert.equal(jar.spaced, 'value');
  assert.equal(jar.other, 'second');
});

test('parseCookies keeps "=" inside the value (base64 JWT padding)', () => {
  const jwtish = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0=.c2lnbmF0dXJl==';
  const jar = parseCookies(`pt_session=${jwtish}`);
  assert.equal(jar.pt_session, jwtish);
});

test('parseCookies percent-decodes values', () => {
  const jar = parseCookies('greeting=hello%20world; path=%2Fapi%2Fv1');
  assert.equal(jar.greeting, 'hello world');
  assert.equal(jar.path, '/api/v1');
});

test('parseCookies falls back to the raw value on a malformed percent-escape', () => {
  // decodeURIComponent('%zz') throws URIError — the header must survive it.
  let jar: Record<string, string> | undefined;
  assert.doesNotThrow(() => {
    jar = parseCookies('broken=%zz; good=ok');
  });
  assert.equal(jar?.broken, '%zz');
  assert.equal(jar?.good, 'ok');
});

test('parseCookies unquotes a double-quoted value', () => {
  const jar = parseCookies('quoted="hello"; bare=world');
  assert.equal(jar.quoted, 'hello');
  assert.equal(jar.bare, 'world');
});

test('parseCookies leaves a lone quote character alone', () => {
  const jar = parseCookies('odd="');
  assert.equal(jar.odd, '"');
});

test('parseCookies keeps the first value when a name is duplicated', () => {
  const jar = parseCookies('dup=first; dup=second; dup=third');
  assert.equal(jar.dup, 'first');
});

test('parseCookies skips segments with no "=" and nameless segments', () => {
  const jar = parseCookies('novalue; =orphan; real=yes');
  assert.deepEqual(Object.keys(jar), ['real']);
  assert.equal(jar.real, 'yes');
});

test('parseCookies does not let a __proto__ cookie poison the jar', () => {
  const jar = parseCookies('__proto__=isAdmin; other=1');
  assert.equal(Object.getPrototypeOf(jar), null);
  // The value is stored as an ordinary own property, not merged into a prototype.
  assert.equal(Object.prototype.hasOwnProperty.call(jar, '__proto__'), true);
  // …and an unrelated name is still simply absent.
  assert.equal(jar.isAdmin, undefined);
  assert.equal(parseCookies('unrelated=1').anythingElse, undefined);
  // A fresh plain object was not contaminated either.
  assert.equal(({} as Record<string, unknown>).isAdmin, undefined);
});

test('parseCookies does not inherit Object.prototype members as cookies', () => {
  const jar = parseCookies('a=1');
  assert.equal(jar.toString as unknown, undefined);
  assert.equal(jar.constructor as unknown, undefined);
});

test('readCookie returns the named value', () => {
  assert.equal(readCookie('a=1; b=2', 'b'), '2');
});

test('readCookie returns undefined for an absent name or an absent header', () => {
  assert.equal(readCookie('a=1', 'missing'), undefined);
  assert.equal(readCookie(undefined, 'a'), undefined);
});

test('readFirstCookie honours the preference order', () => {
  const header = 'second=b; first=a';
  assert.equal(readFirstCookie(header, ['first', 'second']), 'a');
  assert.equal(readFirstCookie(header, ['second', 'first']), 'b');
});

test('readFirstCookie skips an empty value and moves to the next name', () => {
  assert.equal(readFirstCookie('first=; second=b', ['first', 'second']), 'b');
});

test('readFirstCookie returns undefined when no listed name is present', () => {
  assert.equal(readFirstCookie('x=1', ['first', 'second']), undefined);
  assert.equal(readFirstCookie(undefined, ['first']), undefined);
});
