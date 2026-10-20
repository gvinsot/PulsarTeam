"""
Structured results of a DuckDuckGo HTML search page (html.duckduckgo.com).

search_web hands the agent Markdown; team-api also needs to know WHICH pages
the search returned (the pages an answer may cite), and the Markdown is not a
reliable source for that: titles and links are pruned, rewritten or split by
the content filter. The result anchors of the raw page are.

Pure function, no crawl4ai: tested on a fixture page in tests/.
"""

from typing import Optional
from urllib.parse import parse_qs, urljoin, urlparse

from bs4 import BeautifulSoup


def _is_ddg_host(host: str) -> bool:
    host = host.lower()
    return host == "duckduckgo.com" or host.endswith(".duckduckgo.com")


def resolve_result_url(href: str) -> Optional[str]:
    """The target of a result link, or None when it is not a public page.

    DuckDuckGo wraps results in `//duckduckgo.com/l/?uddg=<target>&rut=…`;
    the target is unwrapped. Ads (`/y.js?ad_domain=…`) and every other
    DuckDuckGo-internal link resolve to None, as does anything not http(s).
    """
    if not href:
        return None
    try:
        parsed = urlparse(urljoin("https://html.duckduckgo.com/html/", href.strip()))
        if parsed.hostname and _is_ddg_host(parsed.hostname):
            if parsed.path != "/l/":
                return None
            target = parse_qs(parsed.query).get("uddg", [""])[0]
            parsed = urlparse(target)
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            return None
        if _is_ddg_host(parsed.hostname):
            return None
    except ValueError:
        return None
    return parsed.geturl()


def parse_ddg_results(html: str) -> list[dict]:
    """[{"url", "title"}] of the organic results, in page order, deduplicated."""
    if not html:
        return []
    soup = BeautifulSoup(html, "html.parser")
    results: list[dict] = []
    seen: set[str] = set()
    for anchor in soup.select("a.result__a"):
        block = anchor.find_parent(class_="result")
        if block is not None and "result--ad" in (block.get("class") or []):
            continue
        href = anchor.get("href") or ""
        if "ad_domain=" in href:
            continue
        url = resolve_result_url(href)
        if url is None or url in seen:
            continue
        seen.add(url)
        results.append({"url": url, "title": " ".join(anchor.get_text().split())})
    return results
