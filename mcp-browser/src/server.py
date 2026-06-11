"""
MCP Browser Server — Web exploration tools powered by crawl4ai.

Exposes tools as a FastAPI/OpenAPI service so that Open WebUI (and any
OpenAPI-compatible client) can discover and call them automatically.
"""

import os
import json
import asyncio
import logging
from contextlib import asynccontextmanager
from urllib.parse import quote_plus
from typing import Optional

from fastapi import FastAPI
from pydantic import BaseModel, Field

from crawl4ai import (
    AsyncWebCrawler,
    BrowserConfig,
    CrawlerRunConfig,
    CacheMode,
)
from crawl4ai.content_filter_strategy import PruningContentFilter
from crawl4ai.markdown_generation_strategy import DefaultMarkdownGenerator

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://ollama-service:11434")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "qwen3:32b")
MCP_PORT = int(os.getenv("MCP_PORT", "8000"))

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("mcp-browser")

# ---------------------------------------------------------------------------
# Browser / Crawler lifecycle
# ---------------------------------------------------------------------------
_browser_config = BrowserConfig(headless=True, verbose=False)
_crawler: Optional[AsyncWebCrawler] = None
_crawler_lock = asyncio.Lock()

# Signatures of browser-process death (Playwright/CDP). Ordinary page errors
# (timeouts, DNS, HTTP status) must NOT match, or every transient failure
# would pay a full Chromium relaunch.
_BROWSER_FATAL_SIGNATURES = (
    "has been closed",
    "target closed",
    "browser is not available",
    "browser has disconnected",
    "browser closed",
)


def _is_browser_fatal(message) -> bool:
    msg = str(message or "").lower()
    return any(sig in msg for sig in _BROWSER_FATAL_SIGNATURES)


async def get_crawler() -> AsyncWebCrawler:
    global _crawler
    if _crawler is not None:
        return _crawler
    async with _crawler_lock:
        if _crawler is None:
            crawler = AsyncWebCrawler(config=_browser_config)
            await crawler.__aenter__()
            # Publish only after the browser is fully started so concurrent
            # requests never see a half-initialised crawler.
            _crawler = crawler
            logger.info("AsyncWebCrawler initialised")
        return _crawler


async def _reset_crawler(crawler: AsyncWebCrawler) -> None:
    """Discard a crawler whose browser died so the next call relaunches one."""
    global _crawler
    async with _crawler_lock:
        if _crawler is not crawler:
            return
        _crawler = None
    try:
        # Closing a wedged browser can hang; never let it block the request.
        await asyncio.wait_for(crawler.__aexit__(None, None, None), timeout=10)
    except Exception as e:
        logger.warning("Error closing dead crawler: %s", e)
    logger.warning("AsyncWebCrawler discarded after browser failure; will relaunch")


async def _arun_with_recovery(url: str, config: CrawlerRunConfig):
    crawler = await get_crawler()
    try:
        result = await crawler.arun(url=url, config=config)
    except Exception as e:
        if not _is_browser_fatal(e):
            raise
        await _reset_crawler(crawler)
        crawler = await get_crawler()
        return await crawler.arun(url=url, config=config)
    if not result.success and _is_browser_fatal(getattr(result, "error_message", None)):
        await _reset_crawler(crawler)
        crawler = await get_crawler()
        return await crawler.arun(url=url, config=config)
    return result


async def _arun_many_with_recovery(urls: list[str], config: CrawlerRunConfig):
    crawler = await get_crawler()
    try:
        results = await crawler.arun_many(urls=urls, config=config)
    except Exception as e:
        if not _is_browser_fatal(e):
            raise
        await _reset_crawler(crawler)
        crawler = await get_crawler()
        return await crawler.arun_many(urls=urls, config=config)
    if any(
        not r.success and _is_browser_fatal(getattr(r, "error_message", None))
        for r in results
    ):
        await _reset_crawler(crawler)
        crawler = await get_crawler()
        return await crawler.arun_many(urls=urls, config=config)
    return results


def create_clean_markdown_generator(
    word_count_threshold: int = 10,
    pruning_threshold: float = 0.45,
) -> DefaultMarkdownGenerator:
    """
    Create a markdown generator with content filtering for cleaner results.
    
    Uses PruningContentFilter to remove boilerplate, ads, and low-quality content
    while preserving meaningful text blocks.
    
    Returns high-quality markdown optimized for readability.
    """
    prune_filter = PruningContentFilter(
        threshold=pruning_threshold,
        threshold_type="dynamic",  # Adjusts based on tag type and content density
        min_word_threshold=word_count_threshold,
    )
    return DefaultMarkdownGenerator(content_filter=prune_filter)


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    global _crawler
    if _crawler is not None:
        await _crawler.__aexit__(None, None, None)
        _crawler = None
        logger.info("AsyncWebCrawler shut down")


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------
app = FastAPI(
    title="MCP Browser",
    description="Web exploration tools powered by crawl4ai. "
    "Provides crawling, link extraction, LLM-based structured extraction, "
    "and web search capabilities.",
    version="1.0.0",
    lifespan=lifespan,
)


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------
class CrawlRequest(BaseModel):
    url: str = Field(description="The URL to crawl.")
    word_count_threshold: int = Field(
        default=10,
        description="Minimum words per content block to keep (filters boilerplate).",
    )


class CrawlManyRequest(BaseModel):
    urls: list[str] = Field(description="List of URLs to crawl.")
    word_count_threshold: int = Field(
        default=10,
        description="Minimum words per content block to keep.",
    )


class GetLinksRequest(BaseModel):
    url: str = Field(description="The URL to extract links from.")


class ExtractRequest(BaseModel):
    url: str = Field(description="The URL to extract data from.")
    instruction: str = Field(
        description="Natural-language description of what to extract."
    )
    schema_json: str = Field(
        default="",
        description="Optional JSON-schema string for structured output. "
        "When provided, the LLM returns JSON matching this schema.",
    )


class SearchRequest(BaseModel):
    query: str = Field(description="The search query.")


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------
@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post(
    "/crawl",
    summary="Crawl a webpage",
    description="Crawl a single webpage and return its content as clean Markdown. "
    "Uses content filtering to remove boilerplate, ads, and navigation elements.",
)
async def crawl(req: CrawlRequest):
    # Create markdown generator with content filtering
    md_generator = create_clean_markdown_generator(
        word_count_threshold=req.word_count_threshold
    )
    
    config = CrawlerRunConfig(
        word_count_threshold=req.word_count_threshold,
        cache_mode=CacheMode.BYPASS,
        markdown_generator=md_generator,
        # Exclude common boilerplate elements
        excluded_tags=["nav", "footer", "header", "aside", "script", "style"],
        # Remove overlay elements like modals and popups
        remove_overlay_elements=True,
        # Set reasonable timeout for page loading (30 seconds)
        page_timeout=30000,
    )
    
    result = await _arun_with_recovery(url=req.url, config=config)
    if result.success:
        # crawl4ai retourne déjà du markdown dans result.markdown
        # Préférer fit_markdown (filtré) si disponible, sinon raw_markdown
        if hasattr(result.markdown, "fit_markdown") and result.markdown.fit_markdown:
            content = result.markdown.fit_markdown
        elif hasattr(result.markdown, "raw_markdown") and result.markdown.raw_markdown:
            content = result.markdown.raw_markdown
        else:
            # Fallback si la structure est différente
            content = str(result.markdown) if result.markdown else "No content extracted."
        
        return {"content": content}
    return {"error": f"status={result.status_code}, {result.error_message}"}


@app.post(
    "/crawl_many",
    summary="Crawl multiple webpages",
    description="Crawl multiple webpages in parallel and return each page's clean Markdown. "
    "Uses content filtering to remove boilerplate and improve quality.",
)
async def crawl_many(req: CrawlManyRequest):
    # Create markdown generator with content filtering
    md_generator = create_clean_markdown_generator(
        word_count_threshold=req.word_count_threshold
    )
    
    config = CrawlerRunConfig(
        word_count_threshold=req.word_count_threshold,
        cache_mode=CacheMode.BYPASS,
        markdown_generator=md_generator,
        excluded_tags=["nav", "footer", "header", "aside", "script", "style"],
        remove_overlay_elements=True,
        page_timeout=30000,
    )
    
    results = await _arun_many_with_recovery(urls=req.urls, config=config)
    pages = []
    for r in results:
        if r.success:
            # crawl4ai retourne déjà du markdown dans r.markdown
            # Préférer fit_markdown (filtré) si disponible, sinon raw_markdown
            if hasattr(r.markdown, "fit_markdown") and r.markdown.fit_markdown:
                content = r.markdown.fit_markdown
            elif hasattr(r.markdown, "raw_markdown") and r.markdown.raw_markdown:
                content = r.markdown.raw_markdown
            else:
                content = str(r.markdown) if r.markdown else "No content extracted."
            
            pages.append({"url": r.url, "content": content})
        else:
            pages.append({"url": r.url, "error": r.error_message})
    return {"pages": pages}


@app.post(
    "/get_links",
    summary="Get links from a webpage",
    description="Extract all hyperlinks (internal and external) from a webpage. "
    "Excludes links from boilerplate sections like navigation and footers.",
)
async def get_links(req: GetLinksRequest):
    config = CrawlerRunConfig(
        cache_mode=CacheMode.BYPASS,
        excluded_tags=["nav", "footer", "header", "aside", "script", "style"],
        remove_overlay_elements=True,
        page_timeout=30000,
    )
    result = await _arun_with_recovery(url=req.url, config=config)
    if result.success:
        return {"links": result.links}
    return {"error": result.error_message}


@app.post(
    "/extract",
    summary="Extract structured data with LLM",
    description="Extract structured data from a webpage using the configured LLM (Ollama). "
    "The LLM reads the page content and follows your instruction to produce "
    "either free-form text or JSON conforming to an optional schema.",
)
async def extract(req: ExtractRequest):
    from crawl4ai import LLMConfig
    from crawl4ai.extraction_strategy import LLMExtractionStrategy

    extraction_kwargs: dict = {
        "llm_config": LLMConfig(
            provider=f"ollama/{OLLAMA_MODEL}",
            api_token="no-token",
            base_url=OLLAMA_BASE_URL,
        ),
        "instruction": req.instruction,
        "input_format": "markdown",
        "extra_args": {"temperature": 0.0},
    }

    if req.schema_json:
        try:
            extraction_kwargs["schema"] = json.loads(req.schema_json)
        except json.JSONDecodeError as e:
            return {"error": f"invalid schema_json: {e}"}
        extraction_kwargs["extraction_type"] = "schema"
    else:
        extraction_kwargs["extraction_type"] = "block"

    try:
        strategy = LLMExtractionStrategy(**extraction_kwargs)

        config = CrawlerRunConfig(
            extraction_strategy=strategy,
            cache_mode=CacheMode.BYPASS,
            excluded_tags=["nav", "footer", "header", "aside", "script", "style"],
            remove_overlay_elements=True,
            page_timeout=30000,
        )
        result = await _arun_with_recovery(url=req.url, config=config)
        if result.success:
            return {"content": result.extracted_content or "No content extracted."}
        return {"error": result.error_message}
    except Exception as e:
        logger.error(f"Error in extract: {e}")
        return {"error": f"Unexpected error: {str(e)}"}


@app.post(
    "/search_web",
    summary="Search the web",
    description="Search the web via DuckDuckGo and return structured results as clean Markdown. "
    "Uses crawl4ai to crawl the DuckDuckGo search results page and extract content automatically.",
)
async def search_web(req: SearchRequest):
    from urllib.parse import quote_plus
    
    try:
        # Use DuckDuckGo static HTML version - crawl4ai will handle the parsing
        search_url = f"https://html.duckduckgo.com/html/?q={quote_plus(req.query)}"
        logger.info(f"Searching DuckDuckGo for: {req.query}")
        
        # Create markdown generator with content filtering
        md_generator = create_clean_markdown_generator(
            word_count_threshold=10,
            pruning_threshold=0.45,
        )
        
        config = CrawlerRunConfig(
            word_count_threshold=10,
            cache_mode=CacheMode.BYPASS,
            markdown_generator=md_generator,
            excluded_tags=["nav", "footer", "header", "aside", "script", "style"],
            remove_overlay_elements=True,
            page_timeout=30000,
        )
        
        result = await _arun_with_recovery(url=search_url, config=config)
        
        if result.success:
            # Get markdown content from crawled page
            if hasattr(result.markdown, "fit_markdown") and result.markdown.fit_markdown:
                content = result.markdown.fit_markdown
            elif hasattr(result.markdown, "raw_markdown") and result.markdown.raw_markdown:
                content = result.markdown.raw_markdown
            elif isinstance(result.markdown, str):
                content = result.markdown
            else:
                content = str(result.markdown) if result.markdown else "No content extracted."
            
            if content:
                # Add a header to make it clear these are search results
                formatted_content = f"# Search Results for: {req.query}\n\n{content}"
                return {"content": formatted_content}
            else:
                return {"content": f"# Search Results for: {req.query}\n\nNo results found."}
        else:
            logger.error(f"Failed to crawl DuckDuckGo: {result.error_message}")
            return {"error": f"Failed to fetch search results: {result.error_message}"}
        
    except Exception as e:
        logger.error(f"Error in search_web: {e}")
        return {"error": f"Unexpected error: {str(e)}"}


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import uvicorn

    logger.info("Starting MCP Browser on port %s (OpenAPI)", MCP_PORT)
    uvicorn.run(app, host="0.0.0.0", port=MCP_PORT)
