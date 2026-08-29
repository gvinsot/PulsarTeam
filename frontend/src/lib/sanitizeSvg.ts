/**
 * SVG sanitizer for markup that is injected with dangerouslySetInnerHTML.
 *
 * The call-graph tab renders a Mermaid diagram whose source is produced
 * server-side from repository contents and (optionally) rewritten by an LLM.
 * Neither input is trusted: a crafted file name or a prompt-injected LLM reply
 * could otherwise smuggle markup into the DOM, and the login JWT lives in
 * localStorage, so a single script execution is enough to exfiltrate a session.
 *
 * Mermaid is configured with securityLevel 'strict' (which runs its own
 * DOMPurify pass) — this module is the second, independent layer so the app is
 * not relying on a single third-party sanitizer for its only raw-HTML sink.
 *
 * Strategy is allowlist-first and fail-closed: parse as XML, drop every element
 * outside the SVG rendering set, drop every attribute outside the allowed set,
 * and reject any URL that is not a same-document fragment or a raster data URI.
 * Anything that fails to parse yields an empty string rather than markup.
 */

/** Elements Mermaid emits (or may emit) that are safe to keep. */
const ALLOWED_ELEMENTS = new Set([
  'svg', 'g', 'defs', 'desc', 'title', 'symbol', 'use', 'marker', 'clippath',
  'mask', 'pattern', 'lineargradient', 'radialgradient', 'stop', 'filter',
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'textpath', 'image', 'style',
]);

/**
 * Attributes allowed on any element. Presentation attributes only — no event
 * handlers (`on*`) and no scripting hooks. `href`/`xlink:href` are allowed but
 * their values go through isSafeUrl() below.
 */
const ALLOWED_ATTRIBUTES = new Set([
  'id', 'class', 'style', 'transform', 'viewbox', 'width', 'height', 'x', 'y',
  'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'd', 'points',
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity',
  'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset',
  'stroke-miterlimit', 'opacity', 'color', 'display', 'visibility',
  'font-family', 'font-size', 'font-weight', 'font-style', 'letter-spacing',
  'text-anchor', 'dominant-baseline', 'alignment-baseline', 'baseline-shift',
  'dx', 'dy', 'xml:space', 'preserveaspectratio', 'marker-end', 'marker-start',
  'marker-mid', 'markerwidth', 'markerheight', 'markerunits', 'orient',
  'refx', 'refy', 'offset', 'stop-color', 'stop-opacity', 'gradientunits',
  'gradienttransform', 'spreadmethod', 'patternunits', 'clip-path', 'clip-rule',
  'mask', 'filter', 'href', 'xlink:href', 'aria-hidden', 'aria-label', 'role',
]);

/** Attribute values that may reference a URL and therefore need checking. */
const URL_ATTRIBUTES = new Set([
  'href', 'xlink:href', 'fill', 'stroke', 'clip-path', 'mask', 'filter',
  'marker-end', 'marker-start', 'marker-mid',
]);

/** Matches a leading `<scheme>:` once whitespace/control chars are stripped. */
const HAS_SCHEME = /^[a-z0-9+.-]*:/i;
/** The only external reference we accept: a base64 raster image. */
const SAFE_DATA_URI = /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=]*$/i;
/** A same-document reference, e.g. `url(#arrowhead)`. */
const LOCAL_URL_REF = /^url\(\s*['"]?#[^)'"]*['"]?\s*\)$/i;

/**
 * Only same-document references (`#id`, `url(#id)`), plain colors/keywords, and
 * raster data URIs are allowed. Everything else carrying a scheme is rejected,
 * which covers `javascript:`, `data:text/html`, and `data:image/svg+xml` (an
 * SVG data URI can itself carry a script).
 */
export function isSafeUrl(value: string): boolean {
  const v = value.trim();
  if (v === '') return true;
  if (v.startsWith('#')) return true;
  if (LOCAL_URL_REF.test(v)) return true;

  // Strip whitespace and C0 control characters before looking for the colon, so
  // obfuscations the XML parser has already decoded ("java\tscript:") still hit
  // the scheme check instead of sliding through as a scheme-less token.
  let collapsed = '';
  for (const ch of v) {
    if (ch.charCodeAt(0) > 32) collapsed += ch;
  }

  if (HAS_SCHEME.test(collapsed)) return SAFE_DATA_URI.test(collapsed);

  // No scheme: a bare color, keyword, or relative token. `url(...)` pointing
  // anywhere but a fragment was already rejected above.
  return !/^url\(/i.test(v);
}

/**
 * Strips CSS that can load or execute code. Mermaid's inline <style> only ever
 * needs selectors and static declarations.
 */
export function sanitizeCss(css: string): string {
  return css
    .replace(/@import[^;]*;?/gi, '')
    .replace(/expression\s*\(/gi, '')
    .replace(/url\(\s*['"]?(?!#)[^)]*\)/gi, 'none')
    .replace(/[<>]/g, '');
}

function sanitizeElement(el: Element): void {
  // Walk children first: removing a node while iterating a live collection
  // skips siblings, so snapshot into an array.
  for (const child of Array.from(el.children)) {
    if (!ALLOWED_ELEMENTS.has(child.tagName.toLowerCase())) {
      child.remove();
      continue;
    }
    sanitizeElement(child);
  }

  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase();
    if (name.startsWith('on') || !ALLOWED_ATTRIBUTES.has(name)) {
      el.removeAttribute(attr.name);
      continue;
    }
    if (URL_ATTRIBUTES.has(name) && !isSafeUrl(attr.value)) {
      el.removeAttribute(attr.name);
      continue;
    }
    if (name === 'style') {
      el.setAttribute('style', sanitizeCss(attr.value));
    }
  }

  if (el.tagName.toLowerCase() === 'style') {
    el.textContent = sanitizeCss(el.textContent || '');
  }
}

/**
 * Returns sanitized SVG markup, or '' when the input is not parseable SVG.
 * Safe to hand to dangerouslySetInnerHTML.
 */
export function sanitizeSvg(markup: string): string {
  if (!markup) return '';
  if (typeof DOMParser === 'undefined') return '';

  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
  } catch {
    return '';
  }

  // parseFromString reports XML errors as a <parsererror> node instead of
  // throwing. Treat a malformed diagram as "render nothing".
  if (doc.getElementsByTagName('parsererror').length > 0) return '';

  const root = doc.documentElement;
  if (!root || root.tagName.toLowerCase() !== 'svg') return '';

  sanitizeElement(root);
  return new XMLSerializer().serializeToString(root);
}
