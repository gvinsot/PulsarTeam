"""FlareSolverr fallback contract, without crawl4ai or a live solver.
Run: python -m unittest discover -s mcp-browser/tests -v
"""
import importlib
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))


def load(url):
    with patch.dict(os.environ, {"FLARESOLVERR_URL": url}):
        import flaresolverr
        return importlib.reload(flaresolverr)


class FallbackTests(unittest.IsolatedAsyncioTestCase):
    def test_disabled_without_url(self):
        self.assertIsNone(load("").make_fallback(AsyncMock()))

    async def test_returns_solved_html_after_checking_final_url(self):
        module = load("http://flaresolverr:8191/v1")
        guard = AsyncMock()
        answer = {"status": "ok", "solution": {"url": "https://site.test/final", "response": "<p>ok</p>"}}
        with patch.object(module, "_request", return_value=answer) as request:
            html = await module.make_fallback(guard)("https://site.test/")
        self.assertEqual(html, "<p>ok</p>")
        request.assert_called_once_with("https://site.test/")
        guard.assert_awaited_once_with("https://site.test/final")

    async def test_failure_or_inward_redirect_withholds_content(self):
        module = load("http://flaresolverr:8191/v1")
        for answer in [{"status": "error", "message": "timeout"}, {"status": "ok", "solution": {}}]:
            with self.subTest(answer=answer), patch.object(module, "_request", return_value=answer), \
                    self.assertRaises(RuntimeError):
                await module.make_fallback(AsyncMock())("https://site.test/")
        inward = {"status": "ok", "solution": {"url": "http://team-api:3001/", "response": "secret"}}
        guard = AsyncMock(side_effect=PermissionError("private"))
        with patch.object(module, "_request", return_value=inward), self.assertRaises(PermissionError):
            await module.make_fallback(guard)("https://site.test/")


if __name__ == "__main__":
    unittest.main()
