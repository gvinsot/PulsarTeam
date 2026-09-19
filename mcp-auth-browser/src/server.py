"""Private, ephemeral browser worker. The public MCP lives in the PulsarTeam API.

One Chromium process per scope. Interactive login is a HUMAN-only API; MCP can
only read, navigate or scroll a session explicitly released by that human.
A `linkedin:` scope prefix is a separate slot pinned to www.linkedin.com.
"""
import asyncio
import base64
import contextlib
import hmac
import os
import json
import re
import time
import uuid
from collections import deque
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit, parse_qs

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from playwright.async_api import async_playwright

from egress import PublicProxy, https_origin, public_addresses

MAX_SESSIONS = 6
SESSION_SECONDS = 8 * 3600
IDLE_SECONDS = 30 * 60
HUMAN_OPS = {"frame", "click", "text", "key", "wheel", "back", "home", "activate", "takeover", "disconnect"}
KEYS = {"Enter", "Tab", "Shift+Tab", "Backspace", "Delete", "Escape", "ArrowLeft",
        "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "Control+A", "Meta+A"}

LINKEDIN_ORIGIN = "https://www.linkedin.com"
# Where LinkedIn sends a copied session it refuses: login, auth wall, challenge.
LINKEDIN_LOGIN_PATHS = ("/login", "/uas/", "/authwall", "/checkpoint/", "/signup", "/m/login")
LINKEDIN_ENTITY = re.compile(
    r"^/(?:in|company|school|showcase|jobs/view|feed/update|posts|pulse|events|groups|newsletters)/[^/?#]+")
# Paced like a person reading, to keep the shared account within LinkedIn's limits.
LINKEDIN_MIN_INTERVAL = 3.0
LINKEDIN_PAGES_PER_HOUR = 120
LINKEDIN_SNAPSHOT = """() => {
    const root = document.querySelector('main') || document.body;
    const links = [];
    for (const a of (root ? root.querySelectorAll('a[href]') : [])) {
        if (a.origin !== location.origin || a.protocol !== 'https:') continue;
        links.push({text: (a.innerText || a.getAttribute('aria-label') || '').slice(0, 300), url: a.href});
        if (links.length >= 500) break;
    }
    return {url: location.href, title: document.title,
            text: (root?.innerText || '').slice(0, 60000), links};
}"""


def scope_site(scope: str) -> str | None:
    """The origin a site-pinned scope may use; None for the generic browser."""
    return LINKEDIN_ORIGIN if scope.startswith("linkedin:") else None


def linkedin_login_wall(url: str) -> bool:
    try:
        return https_origin(url) != LINKEDIN_ORIGIN or urlsplit(url).path.startswith(LINKEDIN_LOGIN_PATHS)
    except ValueError:
        return True


def linkedin_links(raw) -> list[dict]:
    """Profile/company/job/post links only, without tracking query strings."""
    found: dict[str, dict] = {}
    for link in raw if isinstance(raw, list) else []:
        if not isinstance(link, dict) or not isinstance(link.get("url"), str):
            continue
        try:
            if https_origin(link["url"]) != LINKEDIN_ORIGIN:
                continue
        except ValueError:
            continue
        match = LINKEDIN_ENTITY.match(urlsplit(link["url"]).path)
        if not match:
            continue
        url = LINKEDIN_ORIGIN + match.group(0) + "/"
        text = " ".join(str(link.get("text") or "").split())[:200]
        if url in found:
            found[url]["text"] = found[url]["text"] or text
        elif len(found) < 150:
            found[url] = {"text": text, "url": url}
    return list(found.values())


# Cloudflare challenges: the API has FlareSolverr solve the site's root and sends
# back only these cookies plus the solver's user agent, which cf_clearance is
# bound to. The user's own cookies never leave this worker.
CLEARANCE_COOKIES = {"cf_clearance", "__cf_bm", "_cfuvid"}
USER_AGENT = re.compile(r"Mozilla/5\.0 [\x20-\x7e]{10,500}")


def cloudflare_challenge(response) -> bool:
    return response is not None and (response.headers.get("cf-mitigated") or "").lower() == "challenge"


def clearance_cookies(raw, origin) -> list[dict]:
    if not isinstance(raw, list) or not raw or len(raw) > len(CLEARANCE_COOKIES):
        raise ValueError("Invalid clearance")
    result, seen = [], set()
    for c in raw:
        if not isinstance(c, dict) or set(c) - {"name", "value", "expires"}:
            raise ValueError("Invalid clearance cookie")
        name, value, expires = c.get("name"), c.get("value"), c.get("expires", -1)
        if (name not in CLEARANCE_COOKIES or name in seen or not isinstance(value, str) or
                not 0 < len(value) <= 4096 or any(ord(x) < 33 or ord(x) > 126 or x in ";," for x in value) or
                type(expires) not in {int, float} or not -1 <= expires <= 253402300799):
            raise ValueError("Invalid clearance cookie")
        seen.add(name)
        # Scoped to the exact shared host, like imported cookies.
        result.append({"name": name, "value": value, "domain": urlsplit(origin).hostname, "path": "/",
                       "secure": True, "httpOnly": True, "sameSite": "None", "expires": expires})
    if "cf_clearance" not in seen:
        raise ValueError("Missing cf_clearance")
    return result


def secret():
    try:
        return Path("/run/secrets/AUTH_BROWSER_KEY").read_text().strip()
    except FileNotFoundError:
        return os.environ.get("AUTH_BROWSER_KEY", "")


class Command(BaseModel):
    model_config = ConfigDict(extra="forbid")
    scope: str = Field(pattern=r"^(linkedin:)?(agent|board):[a-zA-Z0-9_-]{1,200}$")
    operation: Literal["status", "start", "frame", "click", "text", "key", "wheel", "back", "home",
                       "activate", "takeover", "disconnect", "read", "navigate", "scroll",
                       "clearance", "prepare_import", "import"]
    session_id: str | None = Field(default=None, max_length=100)
    controller: str | None = Field(default=None, max_length=200)
    url: str = Field(default="", max_length=4000)
    login_origins: list[str] = Field(default_factory=list, max_length=10)
    text: str = Field(default="", max_length=4000)
    x: int = Field(default=0, ge=0, le=1279)
    y: int = Field(default=0, ge=0, le=799)
    delta: int = Field(default=0, ge=-1400, le=1400)
    storage: dict | None = None
    # `clearance` only: Cloudflare cookies and the user agent they are bound to.
    cookies: list | None = Field(default=None, max_length=5)
    user_agent: str = Field(default="", max_length=512)


class Session:
    def __init__(self, controller, origin, login_origins, kind="site"):
        self.id = str(uuid.uuid4())
        self.controller = controller
        self.origin = origin
        self.login_origins = {origin, *login_origins}
        self.kind = kind
        self.phase = "login"
        self.created = self.used = time.time()
        self.browser = self.context = self.page = None
        self.proxy = PublicProxy()
        self.lock = asyncio.Lock()
        self.page_loads = deque()

    async def pace(self):
        """LinkedIn only: space page loads and cap them per hour (None = go ahead)."""
        now = time.time()
        while self.page_loads and now - self.page_loads[0] >= 3600:
            self.page_loads.popleft()
        if len(self.page_loads) >= LINKEDIN_PAGES_PER_HOUR:
            return {"limited": True, "retryAfterSeconds": int(3600 - (now - self.page_loads[0])) + 1}
        if self.page_loads:
            wait = LINKEDIN_MIN_INTERVAL - (now - self.page_loads[-1])
            if wait > 0:
                await asyncio.sleep(wait)
        self.page_loads.append(time.time())
        return None

    def expired(self):
        now = time.time()
        return now - self.created > SESSION_SECONDS or now - self.used > IDLE_SECONDS

    def status(self):
        return {"exists": True, "connected": self.phase == "ready", "phase": self.phase,
                "sessionId": self.id, "site": self.origin,
                "expiresAt": int((self.created + SESSION_SECONDS) * 1000)}

    def require_human(self, cmd):
        if not cmd.controller or cmd.controller != self.controller or cmd.session_id != self.id:
            raise HTTPException(403, "Seul l’utilisateur ayant ouvert cette session peut la contrôler.")

    def require_agent(self):
        if self.phase != "ready":
            raise HTTPException(409, "Connexion en cours : attendez que l’utilisateur partage la session.")

    async def open(self, playwright, url, storage=None):
        proxy_url = await self.proxy.start()
        self.browser = await playwright.chromium.launch(
            headless=True, chromium_sandbox=True,
            proxy={"server": proxy_url, "bypass": "<-loopback>"},
            # No service credentials in the browser's environment.
            env={k: v for k, v in os.environ.items()
                 if k in {"PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SystemRoot", "LOCALAPPDATA"}},
            args=["--disable-quic", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"])
        await self.new_context(storage)
        await self.page.goto(url, wait_until="domcontentloaded", timeout=30000)

    async def new_context(self, storage=None, user_agent=None):
        """(Re)build the single browsing context. Playwright fixes the user agent
        per context, so adopting a challenge solver's user agent needs a new one."""
        previous = self.context
        self.context = await self.browser.new_context(
            viewport={"width": 1280, "height": 800}, accept_downloads=False,
            service_workers="block", permissions=[],
            **({"storage_state": storage} if storage is not None else {}),
            **({"user_agent": user_agent} if user_agent else {}))

        async def route(request_route):
            request = request_route.request
            try:
                origin = https_origin(request.url)
                # Restrict every top-level navigation, including popups/redirects.
                if request.is_navigation_request() and request.frame.parent_frame is None:
                    allowed = self.login_origins if self.phase == "login" else {self.origin}
                    if origin not in allowed:
                        raise ValueError("Navigation outside the configured site")
                await request_route.fallback()
            except Exception:
                await request_route.abort()

        await self.context.route("**/*", route)
        # WebSockets are unnecessary for this browsing-only initial version.
        await self.context.route_web_socket("**/*", lambda ws: ws.close())

        async def new_page(page):
            self.page = page
            page.on("dialog", lambda dialog: dialog.dismiss())
            page.on("download", lambda download: download.cancel())

        self.context.on("page", new_page)
        self.page = await self.context.new_page()
        self.page.set_default_timeout(10000)
        if previous:
            await previous.close()

    def active_page(self):
        pages = [p for p in self.context.pages if not p.is_closed()]
        if not pages:
            raise HTTPException(409, "Navigateur fermé. Reconnectez-vous.")
        if self.page.is_closed():
            self.page = pages[-1]
        return self.page

    async def close(self):
        if self.browser:
            await self.browser.close()
        await self.proxy.close()


sessions: dict[str, Session] = {}
pending_imports: dict[str, dict] = {}
creation_lock = asyncio.Lock()


def import_storage(raw, origin):
    """No caller-controlled cookie domain or storage origin reaches Chromium."""
    if not isinstance(raw, dict) or set(raw) - {"cookies", "localStorage"}:
        raise ValueError("Invalid storage")
    if len(json.dumps(raw).encode()) > 512_000:
        raise ValueError("Storage too large")
    cookies, local = raw.get("cookies", []), raw.get("localStorage", [])
    if not isinstance(cookies, list) or len(cookies) > 200 or not isinstance(local, list) or len(local) > 200:
        raise ValueError("Too many entries")
    result = []
    seen = set()
    for c in cookies:
        if not isinstance(c, dict) or set(c) - {"name", "value", "path", "expires", "httpOnly", "sameSite"}:
            raise ValueError("Invalid cookie")
        name, value, path = c.get("name"), c.get("value"), c.get("path", "/")
        if (not isinstance(name, str) or not name or len(name) > 256 or
                any(ord(x) < 33 or ord(x) > 126 or x in "=;," for x in name) or
                not isinstance(value, str) or len(value) > 8192 or
                any(ord(x) < 32 or ord(x) == 127 for x in value) or
                not isinstance(path, str) or not path.startswith("/") or len(path) > 2000 or
                any(ord(x) < 32 or ord(x) == 127 for x in path)):
            raise ValueError("Invalid cookie fields")
        same_site = c.get("sameSite", "Lax")
        expires = c.get("expires", -1)
        http_only = c.get("httpOnly", False)
        if (same_site not in {"Strict", "Lax", "None"} or type(http_only) is not bool or
                type(expires) not in {int, float} or not (-1 <= expires <= 253402300799)):
            raise ValueError("Invalid cookie attributes")
        if (name, path) in seen:
            raise ValueError("Ambiguous cookie")
        seen.add((name, path))
        if expires != -1 and expires <= time.time():
            continue
        # Strip parent domains: the imported credential is scoped to this exact host.
        result.append({"name": name, "value": value, "domain": urlsplit(origin).hostname,
                       "path": path, "secure": True, "httpOnly": http_only,
                       "sameSite": same_site, "expires": expires})
    local_seen = set()
    for entry in local:
        if (not isinstance(entry, dict) or set(entry) != {"name", "value"} or
                not isinstance(entry["name"], str) or len(entry["name"]) > 1000 or
                not isinstance(entry["value"], str) or len(entry["value"]) > 65536 or
                entry["name"] in local_seen):
            raise ValueError("Invalid local storage")
        local_seen.add(entry["name"])
    if not result and not local:
        raise ValueError("No session data")
    return {"cookies": result, "origins": [{"origin": origin, "localStorage": local}]}


def pending_status(pending, controller):
    return {"exists": True, "connected": False, "phase": "pending",
            "sessionId": pending["id"], "site": pending["origin"],
            "expiresAt": int(pending["expires"] * 1000),
            "canControl": controller == pending["controller"]}


def expire_imports():
    for scope, pending in list(pending_imports.items()):
        if pending["expires"] <= time.time():
            pending_imports.pop(scope, None)


async def reap():
    while True:
        await asyncio.sleep(30)
        expire_imports()
        for scope, session in list(sessions.items()):
            async with session.lock:
                if session.expired() and sessions.get(scope) is session:
                    sessions.pop(scope)
                    await session.close()


@asynccontextmanager
async def lifespan(app):
    # Disabled until provisioned; health remains available to the orchestrator.
    async with async_playwright() as playwright:
        app.state.playwright = playwright
        task = asyncio.create_task(reap())
        yield
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
        await asyncio.gather(*(s.close() for s in sessions.values()), return_exceptions=True)
        sessions.clear()
        pending_imports.clear()


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


@app.get("/health")
async def health():
    return {"ok": True, "configured": len(secret()) >= 32}


async def settle(page):
    """LinkedIn renders client-side: wait until the main content stops growing."""
    with contextlib.suppress(Exception):
        await page.wait_for_selector("main", state="attached", timeout=10000)
    previous = -1
    for _ in range(12):
        await page.wait_for_timeout(500)
        try:
            size = await page.evaluate(
                "() => ((document.querySelector('main') || document.body)?.innerText || '').length")
        except Exception:
            return
        if size and size == previous:
            return
        previous = size


async def linkedin_snapshot(session):
    page = session.active_page()
    # A login wall means LinkedIn refused the copied session: report it, never read it.
    if linkedin_login_wall(page.url):
        return {"loginRequired": True}
    await settle(page)
    if linkedin_login_wall(page.url):
        return {"loginRequired": True}
    data = await page.evaluate(LINKEDIN_SNAPSHOT)
    return {"url": data.get("url"), "title": data.get("title"), "text": data.get("text"),
            "links": linkedin_links(data.get("links"))}


async def snapshot(session):
    page = session.active_page()
    if https_origin(page.url) != session.origin:
        raise HTTPException(409, "La session a quitté le site autorisé. Reconnectez-vous.")
    if session.kind == "linkedin":
        return await linkedin_snapshot(session)
    # No arbitrary evaluation, cookies, storage, inputs or network headers are exposed.
    return await page.evaluate("""() => ({
        url: location.href, title: document.title,
        text: (document.body?.innerText || '').slice(0, 60000),
        links: Array.from(document.querySelectorAll('a[href]'))
          .filter(a => a.origin === location.origin && a.protocol === 'https:')
          .slice(0, 150).map(a => ({text: (a.innerText || '').slice(0, 200), url: a.href}))
    })""")


async def execute(cmd: Command):
    expire_imports()
    if cmd.operation == "prepare_import":
        if not cmd.controller:
            raise HTTPException(403, "Connexion utilisateur requise")
        origin = https_origin(cmd.url)
        if scope_site(cmd.scope) not in {None, origin}:
            raise HTTPException(400, "Site non autorisé pour ce plugin")
        await public_addresses(urlsplit(origin).hostname)
        async with creation_lock:
            if cmd.scope in sessions or cmd.scope in pending_imports:
                raise HTTPException(409, "Déconnectez la session existante.")
            if len(pending_imports) >= 100:
                raise HTTPException(429, "Trop de connexions en attente.")
            pending = {"id": str(uuid.uuid4()), "origin": origin, "controller": cmd.controller,
                       "expires": time.time() + 600}
            pending_imports[cmd.scope] = pending
            return pending_status(pending, cmd.controller)
    if cmd.operation == "import":
        async with creation_lock:
            pending = pending_imports.get(cmd.scope)
            if not pending or pending["expires"] <= time.time() or pending.get("consumed"):
                raise HTTPException(409, "Connexion expirée")
            if cmd.controller != pending["controller"] or cmd.session_id != pending["id"]:
                raise HTTPException(403, "Connexion incorrecte")
            state = import_storage(cmd.storage, pending["origin"])
            if cmd.scope in sessions:
                raise HTTPException(409, "Une session existe déjà")
            if len(sessions) >= MAX_SESSIONS:
                raise HTTPException(429, "Capacité atteinte")
            # Consume before I/O, but keep the scope reserved during launch so
            # agents cannot fall through to their board's different account.
            pending["consumed"] = True
            linkedin = scope_site(cmd.scope) == LINKEDIN_ORIGIN
            session = Session(cmd.controller, pending["origin"], [],
                              kind="linkedin" if linkedin else "site")
            session.phase = "ready"
            try:
                # The LinkedIn home page stays public when logged out; the feed does not.
                start = LINKEDIN_ORIGIN + "/feed/" if linkedin else session.origin
                await session.open(app.state.playwright, start, state)
                if pending_imports.get(cmd.scope) is not pending or pending["expires"] <= time.time():
                    raise HTTPException(409, "Transfert annulé ou expiré")
                if https_origin(session.active_page().url) != session.origin:
                    raise HTTPException(409, "Le site demande une nouvelle connexion")
                if linkedin and linkedin_login_wall(session.active_page().url):
                    raise HTTPException(401, "LinkedIn refuse la session transférée")
                sessions[cmd.scope] = session
                return {**session.status(), "canControl": True}
            except BaseException:
                await session.close()
                raise
            finally:
                if pending_imports.get(cmd.scope) is pending:
                    pending_imports.pop(cmd.scope)
    pending = pending_imports.get(cmd.scope)
    if pending:
        if cmd.operation == "status":
            return pending_status(pending, cmd.controller)
        if cmd.operation == "disconnect" and cmd.controller and cmd.session_id == pending["id"]:
            pending_imports.pop(cmd.scope)
            return {"exists": False, "connected": False}
        raise HTTPException(409, "Transfert de session en attente")
    if cmd.operation == "start":
        if not cmd.controller:
            raise HTTPException(403, "Connexion utilisateur requise")
        origin = https_origin(cmd.url)
        if scope_site(cmd.scope):
            # Pinned sites are connected only by importing a local browser session.
            raise HTTPException(400, "Connexion à distance non disponible pour ce plugin")
        login_origins = [https_origin(u) for u in cmd.login_origins]
        await public_addresses(urlsplit(cmd.url).hostname)
        async with creation_lock:
            if cmd.scope in sessions:
                raise HTTPException(409, "Une session existe déjà. Déconnectez-la avant de la remplacer.")
            if len(sessions) >= MAX_SESSIONS:
                raise HTTPException(429, "Capacité de navigateurs atteinte. Fermez une session.")
            session = Session(cmd.controller, origin, login_origins)
            try:
                await session.open(app.state.playwright, cmd.url)
                sessions[cmd.scope] = session
                return session.status()
            except BaseException:
                await session.close()
                raise

    session = sessions.get(cmd.scope)
    if not session:
        if cmd.operation == "status":
            return {"exists": False, "connected": False}
        raise HTTPException(409, "Aucune session. Connectez le navigateur dans les plugins.")
    async with session.lock:
        if sessions.get(cmd.scope) is not session or session.expired():
            if sessions.get(cmd.scope) is session:
                sessions.pop(cmd.scope)
                await session.close()
            if cmd.operation == "status":
                return {"exists": False, "connected": False}
            raise HTTPException(409, "Session expirée. Reconnectez-vous.")
        if cmd.operation == "status":
            return {**session.status(), "canControl": cmd.controller == session.controller}
        if cmd.operation in HUMAN_OPS:
            # Any authorized editor may revoke, but cannot view/control another
            # user's login screen. Session id prevents stale-tab revocation.
            if cmd.operation == "disconnect":
                if not cmd.controller or cmd.session_id != session.id:
                    raise HTTPException(403, "Session incorrecte")
                sessions.pop(cmd.scope)
                await session.close()
                return {"exists": False, "connected": False}
            session.require_human(cmd)
        else:
            session.require_agent()
        if cmd.operation not in {"frame"}:
            session.used = time.time()
        page = session.active_page()
        if cmd.operation == "takeover":
            session.phase = "login"
            return session.status()
        if cmd.operation == "activate":
            if https_origin(page.url) != session.origin:
                raise HTTPException(409, "Revenez sur le site après la connexion avant de partager.")
            query = parse_qs(urlsplit(page.url).query)
            if {"code", "access_token", "id_token"} & query.keys() or urlsplit(page.url).fragment:
                raise HTTPException(409, "Terminez la redirection de connexion avant de partager.")
            session.phase = "ready"
            # Close login popups and other tabs before the agent can read.
            for other in list(session.context.pages):
                if other != page:
                    await other.close()
            return session.status()
        if cmd.operation == "frame":
            if session.phase != "login":
                raise HTTPException(409, "Reprenez la main avant d’afficher le navigateur.")
            return {"image": base64.b64encode(await page.screenshot(type="jpeg", quality=65)).decode(),
                    "url": page.url, "width": 1280, "height": 800}
        if cmd.operation in {"click", "text", "key", "wheel", "back", "home"}:
            if session.phase != "login":
                raise HTTPException(409, "Reprenez la main avant de contrôler le navigateur.")
            if cmd.operation == "click":
                await page.mouse.click(cmd.x, cmd.y)
            elif cmd.operation == "text":
                await page.keyboard.insert_text(cmd.text)
            elif cmd.operation == "key":
                if cmd.text not in KEYS:
                    raise HTTPException(400, "Touche non autorisée")
                await page.keyboard.press(cmd.text)
            elif cmd.operation == "wheel":
                await page.mouse.wheel(0, cmd.delta)
            elif cmd.operation == "back":
                await page.go_back(wait_until="domcontentloaded", timeout=30000)
            else:
                await page.goto(session.origin, wait_until="domcontentloaded", timeout=30000)
            return {"ok": True}
        if cmd.operation in {"navigate", "clearance"}:
            if https_origin(cmd.url) != session.origin:
                raise HTTPException(403, "Navigation limitée au site partagé")
            if cmd.operation == "clearance":
                cookies = clearance_cookies(cmd.cookies, session.origin)
                if not USER_AGENT.fullmatch(cmd.user_agent):
                    raise HTTPException(400, "User agent invalide")
                # Keep the user's session, swap in the solver's clearance and user agent.
                state = await session.context.storage_state()
                state["cookies"] = [c for c in state["cookies"]
                                    if c["name"] not in CLEARANCE_COOKIES] + cookies
                await session.new_context(state, cmd.user_agent)
                page = session.page
            if session.kind == "linkedin" and (limited := await session.pace()):
                return limited
            # Shorter for LinkedIn: settle() still has to fit in the 50 s command budget.
            response = await page.goto(cmd.url, wait_until="domcontentloaded",
                                       timeout=25000 if session.kind == "linkedin" else 30000)
            if cloudflare_challenge(response):
                # The API may answer with a `clearance` command; never read the challenge.
                return {"challenge": True}
        elif cmd.operation == "scroll":
            if session.kind == "linkedin" and (limited := await session.pace()):
                return limited
            await page.mouse.wheel(0, cmd.delta)
            await page.wait_for_timeout(400)
        return await snapshot(session)


@app.post("/command")
async def command(cmd: Command, authorization: str = Header(default="")):
    key = secret()
    if len(key) < 32 or not hmac.compare_digest(authorization, "Bearer " + key):
        raise HTTPException(403, "Browser worker authentication required")
    try:
        return await asyncio.wait_for(execute(cmd), 50)
    except HTTPException:
        raise
    except ValueError:
        raise HTTPException(400, "URL HTTPS publique invalide ou destination interdite")
    except Exception:
        # Playwright exceptions often contain URLs or DOM/password details.
        raise HTTPException(502, "Le navigateur ne peut pas effectuer cette opération. Vérifiez la connexion ou reconnectez-vous.")
