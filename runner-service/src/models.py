"""
Runner Service — Pydantic request/response models and helper functions.
"""

from typing import Optional
from pydantic import BaseModel


# --- Request Models -----------------------------------------------------------

class MessageRequest(BaseModel):
    content: str
    system_prompt: Optional[str] = None


class CodeRequest(BaseModel):
    code: str
    language: str = "python"


class OpenAIChatMessage(BaseModel):
    role: str
    content: str


class OpenAIChatCompletionRequest(BaseModel):
    model: Optional[str] = None
    messages: list[OpenAIChatMessage]
    stream: bool = False
    system_prompt: Optional[str] = None


class OpenAICompletionRequest(BaseModel):
    model: Optional[str] = None
    prompt: str
    stream: bool = False
    system_prompt: Optional[str] = None


class TokenRequest(BaseModel):
    token: str


class ShellExecRequest(BaseModel):
    command: str
    cwd: Optional[str] = None
    timeout: int = 60
    # Maximum number of output characters returned to the caller. The default
    # keeps log-style commands cheap; callers that legitimately need large
    # payloads (e.g. base64-encoded attachments up to ~20 MB) can raise it up
    # to the server-side hard cap enforced in routes_api.exec_shell.
    max_output: int = 10000


class EnsureProjectRequest(BaseModel):
    project: str
    git_url: str
    git_credentials: Optional["GitCredentials"] = None


class GitCredentials(BaseModel):
    """Per-agent git authentication forwarded by the API when an agent (or its
    parent board) has a connected git plugin (currently GitHub OAuth).

    The runner installs these credentials in the agent's HOME using the
    `store` credential helper so that subsequent `git` invocations from the
    LLM agent (clone, fetch, push, gh CLI, ...) authenticate transparently.
    """
    provider: str = "github"  # 'github' for now
    token: str
    username: Optional[str] = None  # GitHub login — used as the credential username


EnsureProjectRequest.model_rebuild()


class AgentAuthCallback(BaseModel):
    code: str


class OwnerAuthCallback(BaseModel):
    code: str


# --- Response Models ----------------------------------------------------------

class ExecutionResponse(BaseModel):
    status: str
    output: str
    cost_usd: Optional[float] = None
    duration_ms: Optional[int] = None
    total_tokens: Optional[int] = None
    error: Optional[str] = None
    login_url: Optional[str] = None


# --- Helpers ------------------------------------------------------------------

def chunk_text(text: str, size: int = 700):
    if not text:
        return
    for i in range(0, len(text), size):
        yield text[i:i + size]


def messages_to_prompt(messages: list[OpenAIChatMessage]) -> tuple[str, Optional[str]]:
    """Flatten an OpenAI chat history into a single full-replay prompt.

    This is the prompt used when the runner can't resume a prior CLI
    session (no session_id, or --resume failed) and must replay the
    whole conversation as fresh context. The caller's DB is the source
    of truth for the conversation — every turn passes the complete
    history here, so the model sees the same context regardless of
    which runner instance handles the request.
    """
    system_parts = []
    conversation_parts = []

    for msg in messages:
        if msg.role == "system":
            system_parts.append(msg.content)
        elif msg.role == "user":
            conversation_parts.append(("user", msg.content))
        elif msg.role == "assistant":
            conversation_parts.append(("assistant", msg.content))

    system_prompt = "\n\n".join(system_parts) if system_parts else None

    if not conversation_parts:
        return "Continue.", system_prompt

    if len(conversation_parts) == 1 and conversation_parts[0][0] == "user":
        return conversation_parts[0][1], system_prompt

    parts = []
    for role, content in conversation_parts:
        prefix = "User" if role == "user" else "Assistant"
        parts.append(f"{prefix}: {content}")
    prompt = "\n".join(parts)

    if not prompt or not prompt.strip():
        prompt = "Continue."

    return prompt, system_prompt


def last_user_message(messages: list[OpenAIChatMessage]) -> Optional[str]:
    """Return the most recent user turn, or None if there isn't one.

    Used by backends that own a live CLI session (--resume): the prior
    turns are already in the session's JSONL on disk, so only the new
    user message needs to be fed in.
    """
    for msg in reversed(messages):
        if msg.role == "user":
            return msg.content
    return None
