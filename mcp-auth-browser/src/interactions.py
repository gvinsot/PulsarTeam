"""Bounded agent actions, never arbitrary JavaScript or worker filesystem paths."""
from fastapi import HTTPException
from page_state import shared_url

AGENT_ACTIONS = {"agent_click", "agent_fill", "agent_press", "agent_select", "agent_upload"}
AGENT_KEYS = {"Enter", "Tab", "Shift+Tab", "Backspace", "Delete", "Escape", "ArrowLeft",
              "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "Control+A", "Meta+A", "Space"}


async def action_target(page, target, origin):
    shared_url(page.url, origin)
    # Selectors are CSS only; never Playwright's frame/engine chaining syntax.
    if target.by == "css":
        if ">>" in target.value:
            raise HTTPException(400, "Use a CSS selector without frame chaining")
        locator = page.locator("css=" + target.value)
    elif target.by == "label":
        locator = page.get_by_label(target.value, exact=True)
    else:
        locator = page.get_by_role(target.value, name=target.name, exact=True)
    count = await locator.count()
    if count != 1:
        raise HTTPException(422, "The target must match exactly one element; read the page again")
    # No focusing or filling hidden credentials, even when a site's password
    # input is hidden and thus does not trip the page-wide login guard.
    blocked = await locator.evaluate("el => el.matches('input[type=password], input[type=hidden], iframe, frame')")
    if blocked:
        raise HTTPException(403, "This element cannot be controlled by an agent")
    return locator


async def perform_action(session, cmd, snapshot, upload=None):
    """A post-action read failure is NOT permission to replay a possible publish."""
    await snapshot(session)  # Same origin, completed login, rendered content.
    page = session.active_page()
    if cmd.target is None:
        raise HTTPException(400, "A target is required")
    locator = await action_target(page, cmd.target, session.origin)
    if cmd.operation == "agent_press" and cmd.text not in AGENT_KEYS:
        raise HTTPException(400, "Unsupported key")
    if cmd.operation == "agent_upload" and upload is None:
        raise HTTPException(400, "Use the authenticated upload endpoint")
    try:
        if cmd.operation == "agent_click":
            await locator.click(timeout=10000)
        elif cmd.operation == "agent_fill":
            await locator.fill(cmd.text, timeout=10000)
        elif cmd.operation == "agent_press":
            await locator.press(cmd.text, timeout=10000)
        elif cmd.operation == "agent_select":
            await locator.select_option(value=cmd.values, timeout=10000)
        else:
            await locator.set_input_files(upload, timeout=15000)
    except Exception:
        # Playwright may time out AFTER dispatch. Do not claim failure/no effect,
        # expose its DOM-bearing error, or automatically repeat the operation.
        return {"actionAttempted": True, "outcome": "unknown",
                "message": "The action outcome is uncertain. Read the page before any retry; do not repeat a publication blindly."}
    try:
        result = await snapshot(session, cmd)
        return {**result, "actionPerformed": True,
                "message": "The browser action completed. Verify the website's result; this alone does not confirm publication."}
    except Exception:
        return {"actionPerformed": True, "pageAvailable": False,
                "message": "The action completed but the resulting page could not be read. Check browser_status/browser_read; do not repeat the action."}
