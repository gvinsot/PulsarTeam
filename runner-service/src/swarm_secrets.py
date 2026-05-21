"""
Read Docker Swarm secrets directly from /run/secrets/<NAME>.

The deployment system mounts every env var matching `*_SECRET`, `*_KEY`,
`*_TOKEN`, or `*_PASSWORD` as a file under `/run/secrets/`. Code that needs
those values calls `read("JWT_SECRET")` instead of touching `os.environ` —
that way the secret never has to transit through environment variables, where
it would be visible to anything with access to /proc/<pid>/environ or to
`docker inspect`.

For local development (no /run/secrets directory), the helper falls back
transparently to the env var of the same name, then to the supplied default.
"""

import os
from typing import Optional

_SECRETS_DIR = "/run/secrets"
_cache: dict[str, str] = {}


# Docker Swarm mounts each secret at /run/secrets/<full-secret-name>. Our stacks
# are named `<env>-pulsarteam` (e.g. `qa-pulsarteam`, `prod-pulsarteam`) or just
# `pulsarteam` when no env is pinned, so secrets show up as
# `/run/secrets/qa-pulsarteam_JWT_SECRET` etc. We try the bare name first (dev /
# `target:` alias) and fall back to the stack-prefixed name.
def _stack_prefix() -> str:
    env = (os.environ.get("APP_ENVIRONMENT") or "").strip()
    return f"{env}-pulsarteam_" if env else "pulsarteam_"


def read(name: str, default: str = "") -> str:
    """Return the secret value for `name`. Order: file → env → default."""
    if name in _cache:
        return _cache[name]
    for candidate in (name, _stack_prefix() + name):
        try:
            with open(os.path.join(_SECRETS_DIR, candidate)) as f:
                value = f.read().rstrip("\n")
            _cache[name] = value
            return value
        except OSError:
            continue
    return os.environ.get(name, default)


def read_optional(name: str) -> Optional[str]:
    """Like `read`, but returns None when the secret is unset rather than ''."""
    value = read(name, default="")
    return value or None


def invalidate(name: Optional[str] = None) -> None:
    """Drop one or all cached values (use after a secret has been rotated in-place)."""
    if name is None:
        _cache.clear()
    else:
        _cache.pop(name, None)
