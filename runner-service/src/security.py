"""
Runner Service — API key extraction and verification.
"""

from typing import Optional
from fastapi import HTTPException

from config import API_KEY


def extract_api_key(x_api_key: Optional[str], authorization: Optional[str]) -> Optional[str]:
    if x_api_key:
        return x_api_key
    if authorization and authorization.lower().startswith("bearer "):
        return authorization[7:].strip()
    return None


def verify_api_key(api_key: Optional[str]):
    if not api_key:
        raise HTTPException(status_code=401, detail="Missing API key (X-API-Key or Authorization: Bearer)")
    if api_key != API_KEY:
        raise HTTPException(status_code=403, detail="Invalid API key")
    return api_key
