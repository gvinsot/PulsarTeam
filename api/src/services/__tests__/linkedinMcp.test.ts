import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLinkedInMcpServer,
  formatLinkedInPage,
  linkedinCompanyUrl,
  linkedinProfileUrl,
  linkedinSearchUrl,
  normalizeLinkedInUrl,
} from '../linkedinMcp.js';

function getTool(server: any, name: string) {
  const reg = server._registeredTools?.[name];
  assert.ok(reg, `tool not registered: ${name}`);
  return (args: any) => (reg.handler || reg.callback)(args, {});
}

test('LinkedIn URLs are pinned to www.linkedin.com and refuse account actions', () => {
  assert.equal(
    normalizeLinkedInUrl('fr.linkedin.com/in/jane-doe/?trk=x'),
    'https://www.linkedin.com/in/jane-doe/?trk=x'
  );
  assert.equal(
    normalizeLinkedInUrl('http://linkedin.com/jobs/view/42/'),
    'https://www.linkedin.com/jobs/view/42/'
  );
  for (const url of [
    'https://evil.test/in/jane',
    'https://www.linkedin.com.evil.test/in/jane',
    'https://business.linkedin.com/talent',
    'https://user:pw@www.linkedin.com/feed/',
    'https://www.linkedin.com:8443/feed/',
    'https://www.linkedin.com/m/logout/',
    'https://www.linkedin.com/psettings/',
    'https://www.linkedin.com/login?session_redirect=x',
    'https://www.linkedin.com/in/jane/../../mypreferences/d/',
    'javascript:alert(1)',
  ]) {
    assert.throws(() => normalizeLinkedInUrl(url), Error, url);
  }
});

test('search, profile and company references build the member-facing pages', () => {
  assert.equal(
    linkedinSearchUrl({ query: 'data engineer Lyon', type: 'people', page: 2 }),
    'https://www.linkedin.com/search/results/people/?keywords=data+engineer+Lyon&page=2'
  );
  assert.equal(
    linkedinSearchUrl({ query: 'SRE', type: 'jobs', page: 3, location: 'France' }),
    'https://www.linkedin.com/jobs/search/?keywords=SRE&location=France&start=50'
  );
  assert.equal(
    linkedinSearchUrl({ query: 'ai', type: 'posts' }),
    'https://www.linkedin.com/search/results/content/?keywords=ai'
  );
  assert.equal(linkedinProfileUrl('me'), 'https://www.linkedin.com/in/me/');
  assert.equal(
    linkedinProfileUrl('https://www.linkedin.com/in/jane-doe/details/skills/', 'experience'),
    'https://www.linkedin.com/in/jane-doe/details/experience/'
  );
  assert.equal(
    linkedinProfileUrl('jane-doe', 'activity'),
    'https://www.linkedin.com/in/jane-doe/recent-activity/all/'
  );
  assert.equal(
    linkedinCompanyUrl('https://www.linkedin.com/school/polytechnique/', 'people'),
    'https://www.linkedin.com/school/polytechnique/people/'
  );
  assert.equal(linkedinCompanyUrl('acme'), 'https://www.linkedin.com/company/acme/');
  for (const bad of [
    '..',
    '%2e%2e',
    'jane/../../psettings',
    'a',
    'https://www.linkedin.com/feed/',
  ]) {
    assert.throws(() => linkedinProfileUrl(bad), Error, bad);
  }
  assert.throws(() => linkedinCompanyUrl('https://www.linkedin.com/in/jane-doe/'));
});

test('page formatting drops hidden duplicates, truncates and marks content untrusted', () => {
  const out = formatLinkedInPage({
    url: 'https://www.linkedin.com/in/jane/',
    title: 'Jane Doe | LinkedIn',
    text: 'Jane Doe\nJane Doe\n\n\n\nHead of Data\n  Lyon  ',
    links: [{ text: '', url: 'https://www.linkedin.com/company/acme/' }],
  });
  assert.match(out, /^# Jane Doe \| LinkedIn\nSource: https:\/\/www\.linkedin\.com\/in\/jane\//);
  assert.match(out, /untrusted data/);
  assert.match(out, /\nJane Doe\n\nHead of Data\nLyon\n/);
  assert.match(out, /## Links\n- https:\/\/www\.linkedin\.com\/company\/acme\/ — https:/);
  const long = 'x'.repeat(50_000) + '\nEND';
  assert.ok(formatLinkedInPage({ text: long }, { tail: true }).includes('END'));
  assert.ok(!formatLinkedInPage({ text: long }).includes('END'));
});

test('tools browse only the linkedin slot and surface login walls and limits as errors', async () => {
  process.env.AUTH_BROWSER_KEY = 'test-browser-key-with-at-least-32-characters';
  const bodies: any[] = [];
  let reply: unknown = {
    url: 'https://www.linkedin.com/search/results/people/?keywords=sre',
    title: 'Search',
    text: 'Jane Doe',
    links: [{ text: 'Jane Doe', url: 'https://www.linkedin.com/in/jane/' }],
  };
  const stub = mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => {
    bodies.push(JSON.parse(String(options.body)));
    return new Response(JSON.stringify(reply), { status: 200 });
  });
  try {
    const server = createLinkedInMcpServer({ agentId: null, boardId: 'board-1' });
    const search = await getTool(
      server,
      'linkedin_search'
    )({ query: 'sre', type: 'people', page: 1 });
    assert.equal(search.isError, undefined);
    assert.match(search.content[0].text, /- Jane Doe — https:\/\/www\.linkedin\.com\/in\/jane\//);
    assert.deepEqual(bodies.pop(), {
      url: 'https://www.linkedin.com/search/results/people/?keywords=sre',
      scope: 'linkedin:board:board-1',
      operation: 'navigate',
    });

    const blocked = await getTool(
      server,
      'linkedin_open'
    )({ url: 'https://www.linkedin.com/m/logout/' });
    assert.equal(blocked.isError, true);
    assert.equal(bodies.length, 0, 'a refused URL never reaches the worker');

    reply = { loginRequired: true };
    const wall = await getTool(server, 'linkedin_feed')({});
    assert.equal(wall.isError, true);
    assert.match(wall.content[0].text, /reconnect LinkedIn/);

    reply = { limited: true, retryAfterSeconds: 600 };
    const limited = await getTool(server, 'linkedin_scroll')({ direction: 'down' });
    assert.equal(limited.isError, true);
    assert.match(limited.content[0].text, /about 10 min/);
    assert.equal(bodies.pop().delta, 1400);
  } finally {
    stub.mock.restore();
  }
});
