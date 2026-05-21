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


def read(name: str, default: str = "") -> str:
    """Return the secret value for `name`. Order: file → env → default."""
    if name in _cache:
        return _cache[name]
    path = os.path.join(_SECRETS_DIR, name)
    try:
        with open(path) as f:
            value = f.read().rstrip("\n")
        _cache[name] = value
        return value
    except (OSError, FileNotFoundError):
        pass
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
