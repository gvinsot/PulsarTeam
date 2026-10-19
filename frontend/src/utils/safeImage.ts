/**
 * Helpers for rendering / opening chat & tool-result images safely.
 *
 * Image payloads arrive as `{ mediaType, data }` pairs that may originate from
 * untrusted sources (tool output, MCP servers, remote agents). Interpolating
 * `mediaType` straight into a `data:` URI lets an attacker pick `text/html`
 * (or `image/svg+xml`, which can carry script) and get arbitrary markup
 * executed when the URI is opened in a new tab. Everything here is therefore
 * allowlist-based: only well-known raster image types and strict base64
 * payloads are ever turned into URLs.
 */

/** Raster image MIME types that cannot execute script. SVG is deliberately excluded. */
export const SAFE_IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/avif',
]);

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const DATA_URL_RE = /^data:([^;,]+);base64,(.+)$/i;

export interface ImageLike {
  mediaType?: string;
  data?: string;
  preview?: string;
}

/** Returns the normalized media type if it is an allowlisted raster image type, else null. */
export function normalizeSafeImageMediaType(mediaType: unknown): string | null {
  if (typeof mediaType !== 'string') return null;
  const normalized = mediaType.trim().toLowerCase();
  return SAFE_IMAGE_MEDIA_TYPES.has(normalized) ? normalized : null;
}

function isBase64(data: unknown): data is string {
  return typeof data === 'string' && data.length > 0 && BASE64_RE.test(data);
}

/** Resolves a validated `{ mediaType, data }` pair from an image, preferring `preview`. */
function resolveSafeImage(
  img: ImageLike | null | undefined
): { mediaType: string; data: string } | null {
  if (!img) return null;
  if (typeof img.preview === 'string') {
    const match = img.preview.match(DATA_URL_RE);
    const mediaType = match && normalizeSafeImageMediaType(match[1]);
    if (match && mediaType && isBase64(match[2])) return { mediaType, data: match[2] };
  }
  const mediaType = normalizeSafeImageMediaType(img.mediaType);
  if (mediaType && isBase64(img.data)) return { mediaType, data: img.data };
  return null;
}

/**
 * Returns a `data:` URL safe to use as an `<img src>`, or null when the media
 * type is not an allowlisted raster image or the payload is not valid base64.
 */
export function safeImageDataUrl(img: ImageLike | null | undefined): string | null {
  const safe = resolveSafeImage(img);
  return safe ? `data:${safe.mediaType};base64,${safe.data}` : null;
}

/**
 * Opens an image in a new tab via a typed Blob URL (browsers block top-level
 * navigation to `data:` URLs). Does nothing for non-image / malformed payloads.
 * Returns true when a tab was requested.
 */
export function openImageInNewTab(img: ImageLike | null | undefined): boolean {
  const safe = resolveSafeImage(img);
  if (!safe) return false;
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    const binary = atob(safe.data);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  } catch {
    return false;
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: safe.mediaType }));
  window.open(url, '_blank', 'noopener,noreferrer');
  // Give the new tab time to load before releasing the blob.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return true;
}
