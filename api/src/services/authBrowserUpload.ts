import { readSecret } from '../secrets.js';
import { assertPublicUrl } from '../lib/ssrfGuard.js';
import { remoteMcpFetch, validateRemoteUrl } from './remoteMcpFetch.js';
import { sanitizeAttachmentName } from '../lib/taskAttachments.js';
import { workerScope, type BrowserScope } from './authBrowser.js';

export const BROWSER_UPLOAD_MAX_BYTES = 250 * 1024 * 1024;
export interface BrowserUploadFile {
  filename: string;
  body: ReadableStream<Uint8Array>;
}

/** No cookies/provider credentials are sent to the source. HTTPS, pinned public
 * DNS and no redirects prevent local-network reads and credential forwarding. */
export async function publicBrowserUpload(
  url: string,
  filename?: string
): Promise<BrowserUploadFile> {
  const parsed = validateRemoteUrl(url);
  const uploadName = sanitizeAttachmentName(
    filename || decodeURIComponent(parsed.pathname.split('/').pop() || 'file')
  );
  await assertPublicUrl(parsed.href);
  const response = await remoteMcpFetch(parsed.href, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(
      'The upload source could not be downloaded. Use a direct public HTTPS file URL.'
    );
  }
  if (Number(response.headers.get('content-length')) > BROWSER_UPLOAD_MAX_BYTES) {
    await response.body.cancel();
    throw new Error('The file exceeds the 250 MB browser upload limit.');
  }
  return {
    filename: uploadName,
    body: response.body,
  };
}

export async function uploadBrowserFile(
  scope: BrowserScope,
  params: Record<string, unknown>,
  file: BrowserUploadFile
): Promise<Record<string, unknown>> {
  let size = 0;
  let status = 0;
  const body = file.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength;
        if (size > BROWSER_UPLOAD_MAX_BYTES) throw new Error('Upload exceeds 250 MB');
        controller.enqueue(chunk);
      },
    })
  );
  try {
    const key = readSecret('AUTH_BROWSER_KEY');
    if (key.length < 32) throw new Error('Browser unavailable');
    const options: RequestInit & { duplex: 'half' } = {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/octet-stream',
        'X-Browser-Command': Buffer.from(
          JSON.stringify({
            ...params,
            scope: workerScope(scope),
            operation: 'agent_upload',
          })
        ).toString('base64'),
        'X-Upload-Filename': Buffer.from(sanitizeAttachmentName(file.filename)).toString('base64'),
      },
      body,
      duplex: 'half',
      redirect: 'error',
      signal: AbortSignal.timeout(190_000),
    };
    const response = await fetch(
      `${process.env.AUTH_BROWSER_SERVICE_URL || 'http://mcp-auth-browser:8000'}/upload`,
      options
    );
    status = response.status;
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 413 || size > BROWSER_UPLOAD_MAX_BYTES)
        throw new Error('The file exceeds the 250 MB browser upload limit.');
      throw new Error(
        'Browser upload was not confirmed. Read the page and check the shared session before retrying.'
      );
    }
    return (await response.json()) as Record<string, unknown>;
  } catch {
    if (status === 413 || size > BROWSER_UPLOAD_MAX_BYTES)
      throw new Error('The file exceeds the 250 MB browser upload limit.');
    if (status === 429)
      throw new Error(
        'Browser upload storage is full. Disconnect unused sessions to release staged files.'
      );
    throw new Error(
      'Browser upload was not confirmed. Read the page and check the shared session before retrying.'
    );
  } finally {
    // fetch may reject before consuming the request body.
    if (!body.locked) await body.cancel().catch(() => {});
  }
}
