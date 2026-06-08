import os
import sys
from pathlib import Path

os.environ.setdefault("RUNNER_TYPE", "hermes")
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from backends.aider import AiderBackend  # noqa: E402
from backends.hermes import HermesBackend  # noqa: E402


def test_hermes_uses_yolo_for_dangerous_permissions():
    backend = HermesBackend()

    assert "--yolo" in backend._common_chat_args("agent", None)
    assert "--yolo" not in backend._common_chat_args(
        "agent",
        {"execution": {"dangerousSkipPermissions": False}},
    )


def test_aider_uses_yes_always_for_dangerous_permissions():
    backend = AiderBackend()

    assert "--yes-always" in backend._base_args("agent", None)
    assert "--yes-always" not in backend._base_args(
        "agent",
        {"execution": {"dangerousSkipPermissions": False}},
    )
