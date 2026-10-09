"""Bounded rendering checks for the server-owned page; never drive a login flow."""
import asyncio
import time
from urllib.parse import parse_qs, unquote, urlsplit

from fastapi import HTTPException
from playwright.async_api import Error as PlaywrightError

from egress import https_origin

READ_TIMEOUT = 8.0
MAX_WAIT_SECONDS = 20.0
POLL_SECONDS = 0.25
STABLE_SECONDS = 0.75
# Requests that still carry page content. A request older than LONG_POLL_SECONDS
# is a long poll or a stream, not a pending render: it never blocks a read.
CONTENT_REQUESTS = {"document", "fetch", "xhr"}
LONG_POLL_SECONDS = 5.0
MAX_FRAMES = 5
# Character budgets per format; "both" splits them so one read stays readable.
LIMITS = {"text": (60000, 0), "aria": (0, 60000), "both": (25000, 30000)}
FRAME_LIMIT = 15000
ARIA_TIMEOUT_MS = 5000
AUTH_PARAMS = {"code", "access_token", "id_token", "oauth_token", "oauth_verifier"}
LOGIN_PATHS = ("/login", "/signin", "/sign-in", "/auth/login", "/oauth/authorize",
               "/uas/login", "/authwall", "/checkpoint", "/signup", "/m/login")


def shared_url(value, origin):
    """Only a completed, same-origin page can be transferred or read."""
    if https_origin(value) != origin:
        raise ValueError("The page must belong to the shared website")
    parts = urlsplit(value)
    keys = {key.lower() for key in parse_qs(parts.query, keep_blank_values=True)}
    fragment_keys = {key.lower() for key in parse_qs(parts.fragment, keep_blank_values=True)}
    if AUTH_PARAMS & (keys | fragment_keys):
        raise ValueError("Finish the authentication redirect before sharing")
    path = unquote(parts.path).lower().rstrip("/")
    if any(path == login or path.startswith(login + "/") for login in LOGIN_PATHS):
        raise ValueError("Sign in locally before sharing this page")
    return value


class NetworkTracker:
    """In-flight content requests of one page, so a read does not stop on the
    application shell while the data that fills it is still loading."""

    def __init__(self, page):
        self.pending = {}
        page.on("request", self._started)
        page.on("requestfinished", self._ended)
        page.on("requestfailed", self._ended)

    def _started(self, request):
        if request.resource_type in CONTENT_REQUESTS:
            self.pending[request] = time.monotonic()

    def _ended(self, request):
        self.pending.pop(request, None)

    def quiet(self):
        now = time.monotonic()
        for request, started in list(self.pending.items()):
            if now - started > 60:
                self.pending.pop(request, None)  # Never finished: stop tracking it.
        return not any(now - started < LONG_POLL_SECONDS for started in self.pending.values())


# Text of open shadow roots is added because body.innerText does not enter
# them (web components). Password values are collected only to redact them from
# everything returned; they never leave this worker.
PAGE_SNAPSHOT = """() => {
    const visible = el => el.getClientRects().length > 0 &&
        getComputedStyle(el).visibility !== 'hidden';
    const roots = [document];
    for (let i = 0; i < roots.length && roots.length < 500; i++) {
        for (const el of roots[i].querySelectorAll('*')) {
            if (el.shadowRoot) roots.push(el.shadowRoot);
        }
    }
    const all = selector => roots.flatMap(root => Array.from(root.querySelectorAll(selector)));
    const passwords = all('input[type="password"]');
    const loginRequired = passwords.some(visible);
    const secrets = passwords.map(input => input.value).filter(value => value.length >= 4);
    const body = (document.body?.innerText || '').trim();
    const shadow = roots.slice(1)
        .map(root => Array.from(root.children)
            .filter(el => !['STYLE', 'SCRIPT', 'TEMPLATE', 'LINK'].includes(el.tagName))
            .map(el => el.innerText || '').join('\\n').trim())
        .filter(text => text && !body.includes(text));
    const text = [body, ...shadow].join('\\n\\n').slice(0, 60000);
    const links = Array.from(document.querySelectorAll('a[href]'))
        .filter(a => a.origin === location.origin && a.protocol === 'https:' && visible(a))
        .filter(a => ![...new URL(a.href).searchParams.keys(),
            ...new URLSearchParams(new URL(a.href).hash.slice(1)).keys()]
            .some(k => /^(code|access_token|id_token|oauth_token|oauth_verifier)$/i.test(k)))
        .slice(0, 150).map(a => ({text: (a.innerText || '').trim().slice(0, 200), url: a.href}));
    return {url: location.href, title: document.title, text, links, loginRequired, secrets};
}"""


def redact(value, secrets):
    if isinstance(value, str):
        for secret in secrets:
            value = value.replace(secret, "••••")
        return value
    if isinstance(value, list):
        return [redact(item, secrets) for item in value]
    if isinstance(value, dict):
        return {key: redact(item, secrets) for key, item in value.items()}
    return value


def clip(value, limit):
    if len(value) <= limit:
        return value
    return value[:limit] + f"\n… [truncated at {limit} of {len(value)} characters; scroll or narrow the page]"


async def aria_tree(frame, limit):
    """Accessibility snapshot: roles, names, form state ([checked], values,
    selected options) and open shadow DOM, which plain text cannot show."""
    try:
        return clip(await frame.locator("body").aria_snapshot(timeout=ARIA_TIMEOUT_MS), limit)
    except PlaywrightError:
        return ""


async def same_site_frames(page, origin, aria_limit, secrets):
    """Same-site iframes only: third-party frames are outside the shared session."""
    frames = []
    for frame in page.frames[1:]:
        if len(frames) >= MAX_FRAMES:
            break
        try:
            shared_url(frame.url, origin)
            data = await frame.evaluate(PAGE_SNAPSHOT)
        except (ValueError, PlaywrightError):
            continue
        if data.get("loginRequired"):
            continue  # An embedded sign-in form is never read.
        secrets.extend(data.get("secrets", []))
        entry = {"url": frame.url, "text": clip(data.get("text", "").strip(), FRAME_LIMIT)}
        if aria_limit:
            entry["aria"] = await aria_tree(frame, min(aria_limit, FRAME_LIMIT))
        if entry["text"] or entry.get("aria"):
            frames.append(entry)
    return frames


async def read_page(page, origin, network=None, fmt="both", wait_for="", wait_ms=0, extras=True):
    """Wait for visible content, then a short stable window, within one deadline.

    DOMContentLoaded alone is insufficient for client-rendered websites. A title
    or an empty SPA shell is not readable content. No login page is returned.
    Stable means: same text, no content request in flight and, when asked,
    `wait_for` present. A page that never settles is returned at the deadline
    with settled=false. extras=False (session checks, not agent reads) skips the
    accessibility tree and frames.
    """
    timeout = min(wait_ms / 1000, MAX_WAIT_SECONDS) if wait_ms else READ_TIMEOUT
    deadline = time.monotonic() + timeout
    wanted = wait_for.strip().lower()
    signature = None
    stable_since = time.monotonic()
    while True:
        try:
            shared_url(page.url, origin)
        except ValueError:
            raise HTTPException(401, "The website requires a new local login")
        try:
            data = await page.evaluate(PAGE_SNAPSHOT)
            # Navigation can occur between the first URL check and evaluation.
            shared_url(data.get("url", page.url), origin)
        except ValueError:
            raise HTTPException(401, "The website requires a new local login")
        except PlaywrightError:
            # A client-side redirect can destroy the JS context while it renders.
            data = {}
        if data.pop("loginRequired", False):
            raise HTTPException(401, "The website requires a new local login")
        text = data.get("text", "").strip()
        links = data.get("links", [])
        readable = bool(text or any(link.get("text", "").strip() for link in links))
        if text.lower().rstrip(".… ") in {"loading", "please wait", "chargement"}:
            readable = False
        found = not wanted or wanted in text.lower()
        current = (data.get("url"), text, tuple((l.get("text"), l.get("url")) for l in links))
        now = time.monotonic()
        if not readable or current != signature:
            signature, stable_since = current, now
        quiet = network is None or network.quiet()
        settled = readable and found and quiet and now - stable_since >= STABLE_SECONDS
        if settled or now >= deadline:
            if not readable:
                raise HTTPException(424, "The server browser did not render readable page content")
            # Live feeds need not stop changing to be readable.
            return await finish(page, origin, data, fmt, settled, wanted, found, extras)
        await asyncio.sleep(min(POLL_SECONDS, max(0, deadline - now)))


async def finish(page, origin, data, fmt, settled, wanted, found, extras=True):
    text_limit, aria_limit = LIMITS.get(fmt, LIMITS["both"]) if extras else (LIMITS["text"][0], 0)
    secrets = list(data.pop("secrets", []))
    result = {"url": data.get("url"), "title": data.get("title"), "links": data.get("links", []),
              "settled": settled}
    if text_limit:
        result["text"] = clip(data.get("text", "").strip(), text_limit)
    if aria_limit:
        result["aria"] = await aria_tree(page, aria_limit)
    frames = await same_site_frames(page, origin, aria_limit, secrets) if extras else []
    if frames:
        result["frames"] = frames
    if wanted:
        result["waitFor"] = {"text": wanted, "found": found}
    # Longest first, so a password containing another is not partially revealed.
    return redact(result, sorted(set(secrets), key=len, reverse=True))
