"""Automatic sign-in for a shared session the website rejected (opt-in, human-configured).

The human who shared a session may store a username, password and optional
TOTP secret for it. The API keeps them encrypted and hands them to this worker
only when it signs in again. They are typed ONLY into the main frame of the
session's own origin: the navigation guards of an imported session already
block every other top-level origin, and cross-origin iframes are never filled.
Credentials, page text and Playwright errors are never logged or returned.

Generic form detection only: single-page and two-step (username, then
password) forms, then an optional one-time code. Captchas, device approval,
SMS codes and cross-origin identity providers are out of scope and end as a
failed attempt that the worker counts (see RELOGIN_MAX_FAILURES in server.py).
"""
import asyncio
import base64
import hashlib
import hmac
import re
import time
from urllib.parse import unquote, urlsplit

from page_state import LOGIN_PATHS

USERNAME = ", ".join((
    'input[autocomplete="username"]', 'input[autocomplete="email"]', 'input[type="email"]',
    'input[name="session_key"]', 'input[name*="user" i]', 'input[name*="email" i]',
    'input[name*="login" i]', 'input[id*="user" i]', 'input[id*="email" i]',
))
PASSWORD = 'input[type="password"]'
# Always a one-time-code field, wherever it appears.
OTP_STRICT = 'input[autocomplete="one-time-code"]'
# Plausible code fields, trusted only on a sign-in/checkpoint path.
OTP_LOOSE = ", ".join((
    OTP_STRICT, 'input[name*="otp" i]', 'input[name*="totp" i]', 'input[name*="code" i]',
    'input[id*="otp" i]', 'input[id*="code" i]', 'input[inputmode="numeric"]',
))
BASE32 = re.compile(r"^[A-Z2-7]{16,128}$")
STEP_SECONDS = 10


class LoginFailed(Exception):
    """A sign-in attempt that did not end on an authenticated page."""


def normalize_totp_secret(secret: str) -> str:
    value = re.sub(r"[\s-]", "", secret or "").upper().rstrip("=")
    if not BASE32.fullmatch(value):
        raise ValueError("Invalid TOTP secret")
    return value


def totp(secret: str, now: float | None = None, digits: int = 6, period: int = 30) -> str:
    """RFC 6238 (HMAC-SHA1), the default of authenticator apps."""
    value = normalize_totp_secret(secret)
    key = base64.b32decode(value + "=" * (-len(value) % 8))
    counter = int((time.time() if now is None else now) // period)
    mac = hmac.new(key, counter.to_bytes(8, "big"), hashlib.sha1).digest()
    offset = mac[-1] & 0x0F
    code = (int.from_bytes(mac[offset:offset + 4], "big") & 0x7FFFFFFF) % 10 ** digits
    return f"{code:0{digits}d}"


def on_login_path(url: str) -> bool:
    path = unquote(urlsplit(url).path).lower().rstrip("/")
    return any(path == login or path.startswith(login + "/") for login in LOGIN_PATHS)


async def first_visible(page, selector):
    locator = page.main_frame.locator(selector)
    for index in range(min(await locator.count(), 10)):
        element = locator.nth(index)
        try:
            if await element.is_visible() and await element.is_editable():
                return element
        except Exception:
            continue
    return None


async def otp_field(page):
    return await first_visible(page, OTP_LOOSE if on_login_path(page.url) else OTP_STRICT)


async def wait_for(check, seconds):
    deadline = time.monotonic() + seconds
    while True:
        result = await check()
        if result or time.monotonic() >= deadline:
            return result
        await asyncio.sleep(0.25)


async def submit(field):
    await field.press("Enter")
    # Let the submission navigate or re-render before the next check.
    await asyncio.sleep(1)


async def sign_in(page, origin: str, credentials: dict, step_seconds: float = STEP_SECONDS):
    """Fill the website's own sign-in form. Raises LoginFailed when the form
    cannot be completed; the caller verifies the outcome on the shared site."""
    login_url = credentials.get("login_url") or ""
    if login_url:
        await page.goto(login_url, wait_until="domcontentloaded", timeout=15000)
    elif not await first_visible(page, f"{PASSWORD}, {USERNAME}"):
        # A rejected session usually lands on the sign-in page already;
        # otherwise the site's home redirects there.
        await page.goto(origin, wait_until="domcontentloaded", timeout=15000)

    async def form():
        return await first_visible(page, PASSWORD) or await first_visible(page, USERNAME)
    if not await wait_for(form, step_seconds):
        raise LoginFailed("No sign-in form")
    password = await first_visible(page, PASSWORD)
    username = await first_visible(page, USERNAME)
    if username:
        await username.fill(credentials["username"])
    if not password:
        # Two-step forms ask for the identifier first.
        await submit(username)
        password = await wait_for(lambda: first_visible(page, PASSWORD), step_seconds)
        if not password:
            raise LoginFailed("No password field")
    await password.fill(credentials["password"])
    await submit(password)

    async def left_password():
        return await otp_field(page) or not await first_visible(page, PASSWORD)
    await wait_for(left_password, step_seconds)
    code = await otp_field(page)
    if code:
        secret = credentials.get("totp_secret") or ""
        if not secret:
            raise LoginFailed("A one-time code is required")
        await code.fill(totp(secret))
        await submit(code)

        async def left_code():
            return not await otp_field(page)
        if not await wait_for(left_code, step_seconds):
            raise LoginFailed("One-time code rejected")
    if await first_visible(page, PASSWORD):
        raise LoginFailed("Credentials rejected")
    if https_origin_of(page.url) != origin:
        raise LoginFailed("Left the shared website")


def https_origin_of(url: str) -> str:
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}".lower()


def valid_credentials(raw, origin: str) -> dict:
    """The API validates these too; never trust a decrypted payload blindly."""
    if not isinstance(raw, dict) or set(raw) - {"username", "password", "totp_secret", "login_url"}:
        raise ValueError("Invalid credentials")
    username, password = raw.get("username"), raw.get("password")
    if (not isinstance(username, str) or not 0 < len(username) <= 500 or
            not isinstance(password, str) or not 0 < len(password) <= 1000):
        raise ValueError("Invalid credentials")
    result = {"username": username, "password": password}
    if raw.get("totp_secret"):
        result["totp_secret"] = normalize_totp_secret(raw["totp_secret"])
    login_url = raw.get("login_url") or ""
    if login_url:
        if not isinstance(login_url, str) or len(login_url) > 4000 or https_origin_of(login_url) != origin:
            raise ValueError("The sign-in page must belong to the shared website")
        result["login_url"] = login_url
    return result
