"""
Token at-rest encryption — AES-256-GCM with a key derived from ENCRYPTION_KEY.

The encryption key is loaded from the ENCRYPTION_KEY env var (typically wired
to a Docker Swarm secret at /run/secrets/ENCRYPTION_KEY). It must be a base64
or hex-encoded value with at least 32 bytes of entropy after decoding. If the
env var is missing the module falls back to plaintext storage and logs a clear
warning — this preserves the legacy flow during initial rollout but should
NEVER be the long-term state.

Storage format (per file):
    {"v": 1, "alg": "AES-256-GCM", "ct": "<base64(nonce(12) || ciphertext || tag(16))>"}

Reading is transparent: legacy plaintext JSON files are detected (no "v" key
plus parses as JSON) and re-encrypted on the next write.
"""

import os
import json
import base64
import logging
from typing import Optional

from secrets import read as read_secret

logger = logging.getLogger("runner_service.crypto")

_ENVELOPE_VERSION = 1
_ALG = "AES-256-GCM"
_NONCE_SIZE = 12

_cached_key: Optional[bytes] = None
_warned_no_key = False


def _load_key() -> Optional[bytes]:
    """Load and cache the master encryption key.

    Accepts base64 (preferred) or hex. Must yield at least 32 bytes after decoding.
    Returns None if no key is configured (caller falls back to plaintext).
    """
    global _cached_key, _warned_no_key
    if _cached_key is not None:
        return _cached_key

    raw = read_secret("ENCRYPTION_KEY", default="").strip()
    if not raw:
        if not _warned_no_key:
            logger.warning(
                "[Crypto] ENCRYPTION_KEY is not set — tokens will be stored in plaintext. "
                "Wire a 32-byte base64 key via Docker secret to enable at-rest encryption."
            )
            _warned_no_key = True
        return None

    decoded: Optional[bytes] = None
    for decoder in (base64.b64decode, bytes.fromhex):
        try:
            candidate = decoder(raw)
            if len(candidate) >= 32:
                decoded = candidate[:32]
                break
        except (ValueError, base64.binascii.Error):
            continue

    if decoded is None:
        logger.error(
            "[Crypto] ENCRYPTION_KEY is set but could not be decoded to >=32 bytes "
            "(expected base64 or hex). Falling back to plaintext."
        )
        return None

    _cached_key = decoded
    return _cached_key


def is_enabled() -> bool:
    return _load_key() is not None


def _encrypt_bytes(plaintext: bytes) -> Optional[bytes]:
    key = _load_key()
    if key is None:
        return None
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    nonce = os.urandom(_NONCE_SIZE)
    aesgcm = AESGCM(key)
    ct = aesgcm.encrypt(nonce, plaintext, associated_data=None)
    return nonce + ct


def _decrypt_bytes(blob: bytes) -> bytes:
    key = _load_key()
    if key is None:
        raise RuntimeError("Cannot decrypt: ENCRYPTION_KEY not configured")
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    if len(blob) < _NONCE_SIZE + 16:
        raise ValueError("Ciphertext too short to contain nonce + tag")
    nonce, ct = blob[:_NONCE_SIZE], blob[_NONCE_SIZE:]
    aesgcm = AESGCM(key)
    return aesgcm.decrypt(nonce, ct, associated_data=None)


def encrypt_text(plaintext: str) -> str:
    """Wrap `plaintext` in a versioned JSON envelope. Falls back to plaintext if no key."""
    blob = _encrypt_bytes(plaintext.encode("utf-8"))
    if blob is None:
        return plaintext
    envelope = {
        "v": _ENVELOPE_VERSION,
        "alg": _ALG,
        "ct": base64.b64encode(blob).decode("ascii"),
    }
    return json.dumps(envelope, separators=(",", ":"))


def decrypt_text(stored: str) -> str:
    """Inverse of `encrypt_text`. If `stored` is a legacy plaintext (no envelope), return as-is."""
    s = stored.strip()
    if not s:
        return s
    if not s.startswith("{"):
        return stored
    try:
        envelope = json.loads(s)
    except json.JSONDecodeError:
        return stored
    if not isinstance(envelope, dict) or envelope.get("v") != _ENVELOPE_VERSION:
        return stored
    if envelope.get("alg") != _ALG or "ct" not in envelope:
        return stored
    try:
        blob = base64.b64decode(envelope["ct"])
        return _decrypt_bytes(blob).decode("utf-8")
    except Exception as e:
        logger.error(f"[Crypto] Failed to decrypt envelope: {e}")
        raise


def is_envelope(stored: str) -> bool:
    """True if the stored content looks like an encrypted envelope (current version)."""
    s = stored.strip()
    if not s.startswith("{"):
        return False
    try:
        envelope = json.loads(s)
    except json.JSONDecodeError:
        return False
    return (
        isinstance(envelope, dict)
        and envelope.get("v") == _ENVELOPE_VERSION
        and envelope.get("alg") == _ALG
        and "ct" in envelope
    )
