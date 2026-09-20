"""Bounded rendering checks for the server-owned page; never drive a login flow."""
import asyncio
import time
from urllib.parse import parse_qs, unquote, urlsplit

from fastapi import HTTPException
from playwright.async_api import Error as PlaywrightError

from egress import https_origin

READ_TIMEOUT = 8.0
POLL_SECONDS = 0.25
STABLE_SECONDS = 0.75
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


PAGE_SNAPSHOT = """() => {
    const visible = el => el.getClientRects().length > 0 &&
        getComputedStyle(el).visibility !== 'hidden';
    const loginRequired = Array.from(document.querySelectorAll('input[type="password"]'))
        .some(visible);
    const text = (document.body?.innerText || '').trim().slice(0, 60000);
    const links = Array.from(document.querySelectorAll('a[href]'))
        .filter(a => a.origin === location.origin && a.protocol === 'https:' && visible(a))
        .filter(a => ![...new URL(a.href).searchParams.keys(),
            ...new URLSearchParams(new URL(a.href).hash.slice(1)).keys()]
            .some(k => /^(code|access_token|id_token|oauth_token|oauth_verifier)$/i.test(k)))
        .slice(0, 150).map(a => ({text: (a.innerText || '').trim().slice(0, 200), url: a.href}));
    return {url: location.href, title: document.title, text, links, loginRequired};
}"""


async def read_page(page, origin):
    """Wait for visible content, then a short stable window, within one deadline.

    DOMContentLoaded alone is insufficient for client-rendered websites. A title
    or an empty SPA shell is not readable content. No login page is returned.
    """
    deadline = time.monotonic() + READ_TIMEOUT
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
        current = (data.get("url"), text, tuple((l.get("text"), l.get("url")) for l in links))
        now = time.monotonic()
        if not readable or current != signature:
            signature, stable_since = current, now
        if readable and now - stable_since >= STABLE_SECONDS:
            return data
        if now >= deadline:
            if readable:
                return data  # Live feeds need not stop changing to be readable.
            raise HTTPException(424, "The server browser did not render readable page content")
        await asyncio.sleep(min(POLL_SECONDS, max(0, deadline - now)))
