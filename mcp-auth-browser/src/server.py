"""Private, ephemeral browser worker. The public MCP lives in the PulsarTeam API.

One Chromium process per scope. Interactive login is a HUMAN-only API; MCP can
only read, navigate or scroll a session explicitly released by that human.
"""
import asyncio
import base64
import contextlib
import hmac
import os
import time
import uuid
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


def secret():
    try:
        return Path("/run/secrets/AUTH_BROWSER_KEY").read_text().strip()
    except FileNotFoundError:
        return os.environ.get("AUTH_BROWSER_KEY", "")


class Command(BaseModel):
    model_config = ConfigDict(extra="forbid")
    scope: str = Field(pattern=r"^(agent|board):[a-zA-Z0-9_-]{1,200}$")
    operation: Literal["status", "start", "frame", "click", "text", "key", "wheel", "back", "home",
                       "activate", "takeover", "disconnect", "read", "navigate", "scroll"]
    session_id: str | None = Field(default=None, max_length=100)
    controller: str | None = Field(default=None, max_length=200)
    url: str = Field(default="", max_length=4000)
    login_origins: list[str] = Field(default_factory=list, max_length=10)
    text: str = Field(default="", max_length=4000)
    x: int = Field(default=0, ge=0, le=1279)
    y: int = Field(default=0, ge=0, le=799)
    delta: int = Field(default=0, ge=-1400, le=1400)


class Session:
    def __init__(self, controller, origin, login_origins):
        self.id = str(uuid.uuid4())
        self.controller = controller
        self.origin = origin
        self.login_origins = {origin, *login_origins}
        self.phase = "login"
        self.created = self.used = time.time()
        self.browser = self.context = self.page = None
        self.proxy = PublicProxy()
        self.lock = asyncio.Lock()

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

    async def open(self, playwright, url):
        proxy_url = await self.proxy.start()
        self.browser = await playwright.chromium.launch(
            headless=True, chromium_sandbox=True,
            proxy={"server": proxy_url, "bypass": "<-loopback>"},
            # No service credentials in the browser's environment.
            env={k: v for k, v in os.environ.items()
                 if k in {"PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SystemRoot", "LOCALAPPDATA"}},
            args=["--disable-quic", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"])
        self.context = await self.browser.new_context(
            viewport={"width": 1280, "height": 800}, accept_downloads=False,
            service_workers="block", permissions=[])

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
        await self.page.goto(url, wait_until="domcontentloaded", timeout=30000)

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
creation_lock = asyncio.Lock()


async def reap():
    while True:
        await asyncio.sleep(30)
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


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


@app.get("/health")
async def health():
    return {"ok": True, "configured": len(secret()) >= 32}


async def snapshot(session):
    page = session.active_page()
    if https_origin(page.url) != session.origin:
        raise HTTPException(409, "La session a quitté le site autorisé. Reconnectez-vous.")
    # No arbitrary evaluation, cookies, storage, inputs or network headers are exposed.
    return await page.evaluate("""() => ({
        url: location.href, title: document.title,
        text: (document.body?.innerText || '').slice(0, 60000),
        links: Array.from(document.querySelectorAll('a[href]'))
          .filter(a => a.origin === location.origin && a.protocol === 'https:')
          .slice(0, 150).map(a => ({text: (a.innerText || '').slice(0, 200), url: a.href}))
    })""")


async def execute(cmd: Command):
    if cmd.operation == "start":
        if not cmd.controller:
            raise HTTPException(403, "Connexion utilisateur requise")
        origin = https_origin(cmd.url)
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
        if cmd.operation == "navigate":
            if https_origin(cmd.url) != session.origin:
                raise HTTPException(403, "Navigation limitée au site partagé")
            await page.goto(cmd.url, wait_until="domcontentloaded", timeout=30000)
        elif cmd.operation == "scroll":
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
