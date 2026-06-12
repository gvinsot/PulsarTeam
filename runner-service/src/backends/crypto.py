"""
Token at-rest encryption — AES-256-GCM with a key derived from ENCRYPTION_KEY.

The encryption key is loaded from the ENCRYPTION_KEY env var (typically wired
to a Docker Swarm secret at /run/secrets/ENCRYPTION_KEY). It must be a base64
or hex-encoded value with at least 32 bytes of entropy after decoding. The key
is required: encrypt/decrypt operations raise RuntimeError when it is missing
or malformed.

Storage format (per file):
    {"v": 1, "alg": "AES-256-GCM", "ct": "<base64(nonce(12) || ciphertext || tag(16))>"}
"""

import os
import json
import base64
import logging
from typing import Optional

from swarm_secrets import read as read_secret

logger = logging.getLogger("runner_service.crypto")

_ENVELOPE_VERSION = 1
_ALG = "AES-256-GCM"
_NONCE_SIZE = 12

_cached_key: Optional[bytes] = None


def _load_key() -> bytes:
    """Load and cache the master encryption key.

    Accepts base64 (preferred) or hex. Must yield at least 32 bytes after
    decoding. Raises RuntimeError when the key is missing or malformed.
    """
    global _cached_key
    if _cached_key is not None:
        return _cached_key

    raw = read_secret("ENCRYPTION_KEY", default="").strip()
    if not raw:
        raise RuntimeError(
            "ENCRYPTION_KEY is not set — required for token at-rest encryption. "
            "Wire a 32-byte base64 (or hex) key via Docker secret or env var."
        )

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
        raise RuntimeError(
            "ENCRYPTION_KEY is set but could not be decoded to >=32 bytes "
            "(expected base64 or hex)."
        )

    _cached_key = decoded
    return _cached_key


def _encrypt_bytes(plaintext: bytes) -> bytes:
    key = _load_key()
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    nonce = os.urandom(_NONCE_SIZE)
    aesgcm = AESGCM(key)
    ct = aesgcm.encrypt(nonce, plaintext, associated_data=None)
    return nonce + ct


def _decrypt_bytes(blob: bytes) -> bytes:
    key = _load_key()
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    if len(blob) < _NONCE_SIZE + 16:
        raise ValueError("Ciphertext too short to contain nonce + tag")
    nonce, ct = blob[:_NONCE_SIZE], blob[_NONCE_SIZE:]
    aesgcm = AESGCM(key)
    return aesgcm.decrypt(nonce, ct, associated_data=None)


def encrypt_text(plaintext: str) -> str:
    """Wrap `plaintext` in a versioned JSON envelope."""
    blob = _encrypt_bytes(plaintext.encode("utf-8"))
    envelope = {
        "v": _ENVELOPE_VERSION,
        "alg": _ALG,
        "ct": base64.b64encode(blob).decode("ascii"),
    }
    return json.dumps(envelope, separators=(",", ":"))


def decrypt_text(stored: str) -> str:
    """Inverse of `encrypt_text`. Raises ValueError if `stored` is not an envelope."""
    s = stored.strip()
    if not s:
        return s
    envelope = None
    if s.startswith("{"):
        try:
            envelope = json.loads(s)
        except json.JSONDecodeError:
            envelope = None
    if (
        not isinstance(envelope, dict)
        or envelope.get("v") != _ENVELOPE_VERSION
        or envelope.get("alg") != _ALG
        or "ct" not in envelope
    ):
        raise ValueError("Stored content is not an encryption envelope")
    try:
        blob = base64.b64decode(envelope["ct"])
        return _decrypt_bytes(blob).decode("utf-8")
    except Exception as e:
        logger.error(f"[Crypto] Failed to decrypt envelope: {e}")
        raise
