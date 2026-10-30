"""Tests for the Azure CLI plugin login (backends/runner_azure_config.py).

A fake `az` records its argv and environment so the tests can check: the
secret only travels through a 0600 @file (never argv), the login runs once
per credential set, a detached plugin logs out only what we logged in, and
the spawn env gets the AZURE_*/ARM_* mirror.
"""

import json
import os
import stat
import sys
from pathlib import Path

os.environ.setdefault("RUNNER_TYPE", "opencode")
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import pytest  # noqa: E402
import backends.runner_azure_config as rac  # noqa: E402

SP = {
    "tenantId": "11111111-1111-1111-1111-111111111111",
    "clientId": "22222222-2222-2222-2222-222222222222",
    "clientSecret": "s3cr3t-value",
    "subscriptionId": "33333333-3333-3333-3333-333333333333",
}

FAKE_AZ = r"""#!/bin/sh
log="$AZURE_CONFIG_DIR/../az-calls.jsonl"
secret=""
for a in "$@"; do
  case "$a" in @*) f="${a#@}"; secret="$(cat "$f")"; mode="$(stat -c %a "$f")";; esac
done
printf '{"argv": "%s", "secret": "%s", "mode": "%s", "telemetry": "%s"}\n' \
  "$*" "$secret" "$mode" "$AZURE_CORE_COLLECT_TELEMETRY" >> "$log"
case "$1" in
  login) [ "$secret" = "bad" ] && { echo "AADSTS7000215: Invalid client secret" >&2; exit 1; }
         echo '{}' > "$AZURE_CONFIG_DIR/azureProfile.json" ;;
  account) [ "$2" = "clear" ] && rm -f "$AZURE_CONFIG_DIR/azureProfile.json" ;;
esac
exit 0
"""


@pytest.fixture
def env(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    az = tmp_path / "az"
    az.write_text(FAKE_AZ)
    az.chmod(0o755)
    monkeypatch.setattr(rac, "AZ_BIN", str(az))
    payload = {"value": {"configured": True, **SP}}
    monkeypatch.setattr(rac, "_fetch_azure_credentials", lambda _id: payload["value"])
    user = {"home": str(home), "uid": os.getuid(), "gid": os.getgid(), "username": "agent"}

    def calls():
        log = home / "az-calls.jsonl"
        if not log.exists():
            return []
        return [json.loads(line) for line in log.read_text().splitlines()]

    return {"home": home, "user": user, "payload": payload, "calls": calls, "az": az}


def test_logs_in_once_with_secret_in_a_private_file(env):
    rac.configure_azure_credentials(env["user"], "agent-1")
    calls = env["calls"]()
    assert [c["argv"].split()[0:2] for c in calls] == [["login", "--service-principal"], ["account", "set"]]
    login = calls[0]
    assert SP["clientSecret"] not in login["argv"], "secret must never be in argv"
    assert login["secret"] == SP["clientSecret"]
    assert login["mode"] == "600"
    assert login["telemetry"] == "false"
    assert f"--tenant {SP['tenantId']}" in login["argv"]
    assert SP["subscriptionId"] in calls[1]["argv"]
    # The temporary secret file is gone, the state file is private.
    azure_dir = env["home"] / ".azure"
    assert not (azure_dir / ".pulsar-sp-secret").exists()
    state_path = azure_dir / rac.STATE_FILE
    assert stat.S_IMODE(state_path.stat().st_mode) == 0o600
    assert json.loads(state_path.read_text())["loggedIn"] is True

    # Same credentials → no second login.
    rac.configure_azure_credentials(env["user"], "agent-1")
    assert len(env["calls"]()) == 2

    # Rotated secret → login again.
    env["payload"]["value"] = {"configured": True, **SP, "clientSecret": "rotated"}
    rac.configure_azure_credentials(env["user"], "agent-1")
    assert env["calls"]()[-2]["secret"] == "rotated"


def test_failed_login_is_retried_next_spawn(env):
    env["payload"]["value"] = {"configured": True, **SP, "clientSecret": "bad"}
    rac.configure_azure_credentials(env["user"], "agent-1")
    assert rac.read_azure_state(str(env["home"]))["loggedIn"] is False
    rac.configure_azure_credentials(env["user"], "agent-1")
    assert [c["argv"].split()[0] for c in env["calls"]()] == ["login", "login"]


def test_missing_az_defers_login_but_keeps_env(env, monkeypatch):
    monkeypatch.setattr(rac, "AZ_BIN", str(env["home"] / "nope"))
    rac.configure_azure_credentials(env["user"], "agent-1")
    state = rac.read_azure_state(str(env["home"]))
    assert state["loggedIn"] is False
    spawn_env = {}
    rac.apply_azure_env(spawn_env, str(env["home"]))
    assert spawn_env["AZURE_CLIENT_SECRET"] == SP["clientSecret"]
    assert spawn_env["ARM_SUBSCRIPTION_ID"] == SP["subscriptionId"]
    assert spawn_env["AZURE_CONFIG_DIR"] == str(env["home"] / ".azure")


def test_detached_plugin_logs_out_only_a_managed_login(env):
    # A login the agent did by hand (no state file) is left alone.
    env["payload"]["value"] = {"configured": False}
    rac.configure_azure_credentials(env["user"], "agent-1")
    assert env["calls"]() == []

    env["payload"]["value"] = {"configured": True, **SP}
    rac.configure_azure_credentials(env["user"], "agent-1")
    env["payload"]["value"] = {"configured": False}
    rac.configure_azure_credentials(env["user"], "agent-1")
    assert env["calls"]()[-1]["argv"] == "account clear"
    assert rac.read_azure_state(str(env["home"])) is None
    spawn_env = {}
    rac.apply_azure_env(spawn_env, str(env["home"]))
    assert spawn_env == {}


def test_unreachable_api_changes_nothing(env):
    rac.configure_azure_credentials(env["user"], "agent-1")
    before = len(env["calls"]())
    env["payload"]["value"] = None
    rac.configure_azure_credentials(env["user"], "agent-1")
    assert len(env["calls"]()) == before
    assert rac.read_azure_state(str(env["home"]))["loggedIn"] is True


def test_no_agent_is_a_noop(env):
    rac.configure_azure_credentials(None, "agent-1")
    rac.configure_azure_credentials(env["user"], None)
    assert env["calls"]() == []
