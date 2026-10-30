"""
Log the agent's Azure CLI in with the service principal of its Azure CLI plugin.

Companion to runner_mcp_config / runner_instructions_config: before each CLI
spawn the runner fetches GET /api/internal/runner-azure/agents/<id> from
team-api, which returns the service principal connected on the plugin (agent
scope, else board scope) while the plugin is attached, or
`{"configured": false}`.

- configured → `az login --service-principal` runs once as the agent's UID
  into `$HOME/.azure`, so the LLM's `az …` commands are authenticated. The
  secret goes through a 0600 `@file` argument (knack expands it), never argv,
  so it does not show up in `ps`. A fingerprint of the credentials is kept in
  `$HOME/.azure/pulsar-sp.json`: later spawns skip the login until the
  credentials change or the HOME is recycled.
- not configured (plugin detached / disconnected) → if WE logged the agent
  in, `az account clear` and the state file is removed. A login the agent did
  by hand is left alone.
- team-api unreachable → nothing changes (the next spawn retries).

The same state file feeds `apply_azure_env`, which exposes the principal as
AZURE_* (azure-identity's EnvironmentCredential) and ARM_* (Terraform azurerm)
so SDK-based tooling works too — the same trade-off as the GitHub token
mirrored into GITHUB_TOKEN.

`az` itself comes from the per-node `azure-cli` volume (azure_cli.sh). While
it is still being provisioned the login is skipped and retried next spawn;
the env vars are set regardless.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
from typing import Optional

import httpx

from config import logger
from .runner_mcp_config import _API_BASE, _API_KEY, _resolve_home, _atomic_write

_PATH = "/api/internal/runner-azure/agents"
AZ_BIN = os.getenv("AZURE_CLI_BIN", "/opt/azure-cli/current/bin/az")
STATE_FILE = "pulsar-sp.json"
_LOGIN_TIMEOUT_S = 120


def _azure_dir(home: str) -> str:
    return os.path.join(home, ".azure")


def _state_path(home: str) -> str:
    return os.path.join(_azure_dir(home), STATE_FILE)


def _fingerprint(creds: dict) -> str:
    raw = "\n".join(
        str(creds.get(k) or "") for k in ("tenantId", "clientId", "clientSecret", "subscriptionId")
    )
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _fetch_azure_credentials(agent_id: str) -> Optional[dict]:
    """Return the API payload ({configured: bool, …}) or None when team-api
    can't be reached / answers garbage (leave the current state untouched)."""
    if not _API_KEY:
        return None
    try:
        r = httpx.get(
            f"{_API_BASE}{_PATH}/{agent_id}",
            headers={"X-Api-Key": _API_KEY},
            timeout=5.0,
        )
    except httpx.HTTPError as e:
        logger.warning(f"[Runner Azure] api unreachable for agent {agent_id[:12]}: {e}")
        return None
    if r.status_code >= 400:
        if r.status_code != 404:
            logger.warning(f"[Runner Azure] api {r.status_code} for agent {agent_id[:12]}")
        return None
    try:
        data = r.json()
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


def read_azure_state(home: Optional[str]) -> Optional[dict]:
    if not home:
        return None
    try:
        with open(_state_path(home), "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _az_env(home: str) -> dict:
    return {
        "HOME": home,
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "AZURE_CONFIG_DIR": _azure_dir(home),
        "AZURE_CORE_COLLECT_TELEMETRY": "false",
        "AZURE_CORE_NO_COLOR": "true",
        "AZURE_CORE_ONLY_SHOW_ERRORS": "true",
    }


def _run_az(agent_user: dict, home: str, args: list[str]) -> subprocess.CompletedProcess:
    from .claude_token_store import get_subprocess_kwargs

    kwargs = get_subprocess_kwargs(agent_user) or {}
    return subprocess.run(
        [AZ_BIN, *args],
        env=_az_env(home),
        cwd=home,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        timeout=_LOGIN_TIMEOUT_S,
        preexec_fn=kwargs.get("preexec_fn"),
    )


def _short_error(proc: subprocess.CompletedProcess) -> str:
    lines = [l.strip() for l in (proc.stderr or proc.stdout or "").splitlines() if l.strip()]
    if not lines:
        return f"exit {proc.returncode}"
    # Entra ID's AADSTS code names the cause (bad secret, unknown tenant…);
    # otherwise az prints its summary last, after any traceback.
    useful = next((l for l in lines if "AADSTS" in l), lines[-1])
    return useful[:300]


def _login(agent_user: dict, home: str, uid: Optional[int], gid: Optional[int], creds: dict) -> bool:
    azure_dir = _azure_dir(home)
    secret_path = os.path.join(azure_dir, ".pulsar-sp-secret")
    _atomic_write(secret_path, azure_dir, creds["clientSecret"], uid, gid)
    args = [
        "login", "--service-principal",
        "--username", creds["clientId"],
        "--password", f"@{secret_path}",
        "--tenant", creds["tenantId"],
        "--allow-no-subscriptions",
        "--output", "none",
    ]
    try:
        proc = _run_az(agent_user, home, args)
        if proc.returncode != 0:
            logger.warning(f"[Runner Azure] az login failed: {_short_error(proc)}")
            return False
        sub = creds.get("subscriptionId")
        if sub:
            proc = _run_az(agent_user, home, ["account", "set", "--subscription", sub])
            if proc.returncode != 0:
                logger.warning(f"[Runner Azure] az account set failed: {_short_error(proc)}")
        return True
    except (OSError, subprocess.SubprocessError) as e:
        logger.warning(f"[Runner Azure] az login could not run: {e}")
        return False
    finally:
        try:
            os.remove(secret_path)
        except OSError:
            pass


def configure_azure_credentials(agent_user: Optional[dict], agent_id: Optional[str]) -> None:
    """Pre-spawn hook (see module docstring). Best-effort: never raises."""
    if not agent_id or not agent_user:
        return
    home, uid, gid = _resolve_home(agent_user, agent_id)
    if not home:
        return
    try:
        data = _fetch_azure_credentials(agent_id)
        if data is None:
            return
        state = read_azure_state(home)
        short = agent_id[:12]

        if not data.get("configured"):
            if state is not None:
                if os.path.exists(AZ_BIN):
                    _run_az(agent_user, home, ["account", "clear"])
                try:
                    os.remove(_state_path(home))
                except OSError:
                    pass
                logger.info(f"[Runner Azure] agent={short} plugin disconnected — logged out")
            return

        creds = {
            k: data.get(k) for k in ("tenantId", "clientId", "clientSecret", "subscriptionId")
        }
        if not (creds["tenantId"] and creds["clientId"] and creds["clientSecret"]):
            return
        fingerprint = _fingerprint(creds)
        if (
            state
            and state.get("fingerprint") == fingerprint
            and state.get("loggedIn")
            and os.path.exists(os.path.join(_azure_dir(home), "azureProfile.json"))
        ):
            return

        logged_in = False
        if os.path.exists(AZ_BIN):
            logged_in = _login(agent_user, home, uid, gid, creds)
            if logged_in:
                logger.info(
                    f"[Runner Azure] agent={short} az logged in "
                    f"(tenant={creds['tenantId']}, client={creds['clientId']})"
                )
        else:
            logger.info(f"[Runner Azure] agent={short} {AZ_BIN} not provisioned yet — login deferred")

        _atomic_write(
            _state_path(home),
            _azure_dir(home),
            json.dumps({**creds, "fingerprint": fingerprint, "loggedIn": logged_in}),
            uid,
            gid,
        )
    except Exception as e:  # noqa: BLE001 — a spawn must never fail on this
        logger.warning(f"[Runner Azure] configure failed for agent {agent_id[:12]}: {e}")


def apply_azure_env(env: dict, home: Optional[str]) -> None:
    """Expose the plugin's service principal to the spawn env (see module
    docstring). No state file → env untouched."""
    state = read_azure_state(home)
    if not state or not state.get("clientSecret") or not home:
        return
    env["AZURE_CONFIG_DIR"] = _azure_dir(home)
    env.setdefault("AZURE_CORE_COLLECT_TELEMETRY", "false")
    for prefix in ("AZURE", "ARM"):
        env[f"{prefix}_TENANT_ID"] = state.get("tenantId") or ""
        env[f"{prefix}_CLIENT_ID"] = state.get("clientId") or ""
        env[f"{prefix}_CLIENT_SECRET"] = state["clientSecret"]
        if state.get("subscriptionId"):
            env[f"{prefix}_SUBSCRIPTION_ID"] = state["subscriptionId"]
