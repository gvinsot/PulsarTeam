"""DuckDuckGo result parsing, on a fixture page shaped like html.duckduckgo.com.
Run: python -m pytest mcp-browser/tests  (or python -m unittest discover -s mcp-browser/tests -v)
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ddg_results import parse_ddg_results, resolve_result_url  # noqa: E402

PAGE = """
<html><body>
<div id="header"><a href="/html/">DuckDuckGo</a><a href="https://duckduckgo.com/settings">Settings</a></div>
<div id="links" class="results">
  <div class="result results_links results_links_deep result--ad result--ad--small">
    <div class="links_main links_deep result__body">
      <h2 class="result__title">
        <a rel="nofollow" class="result__a" href="https://duckduckgo.com/y.js?ad_domain=shop.example&amp;ad_provider=bingv7aa&amp;u3=https%3A%2F%2Fwww.bing.com%2Faclick">Buy Python <b>Books</b></a>
      </h2>
    </div>
  </div>
  <div class="result results_links results_links_deep web-result ">
    <div class="links_main links_deep result__body">
      <h2 class="result__title">
        <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.python.org%2F3%2Flibrary%2Fasyncio.html%3Fhighlight%3Dtask%26x%3D1&amp;rut=f2f261">asyncio — Asynchronous I/O — <b>Python</b> 3.15
          documentation</a>
      </h2>
      <div class="result__extras"><div class="result__extras__url">
        <a class="result__url" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.python.org%2F3%2Flibrary%2Fasyncio.html&amp;rut=f2f261">docs.python.org/3/library/asyncio.html</a>
      </div></div>
      <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.python.org%2F3%2Flibrary%2Fasyncio.html&amp;rut=f2f261"><b>asyncio</b> is a library</a>
    </div>
  </div>
  <div class="result results_links results_links_deep web-result ">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Frealpython.com%2Fasync-io-python%2F&amp;rut=46dfd8">Python&#x27;s asyncio: A Hands-On Walkthrough - Real Python</a>
    </h2>
  </div>
  <div class="result results_links results_links_deep web-result ">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Frealpython.com%2Fasync-io-python%2F&amp;rut=99">Duplicate of Real Python</a>
    </h2>
  </div>
  <div class="result results_links results_links_deep web-result ">
    <h2 class="result__title"><a class="result__a" href="http://plain.example.org/page">Direct link</a></h2>
  </div>
  <div class="result results_links web-result ">
    <h2 class="result__title"><a class="result__a" href="/html/?q=python+asyncio&amp;s=30">More results</a></h2>
  </div>
  <div class="result results_links web-result ">
    <h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fduckduckgo.com%2F%3Fq%3Dx">Internal via redirect</a></h2>
  </div>
  <div class="result results_links web-result ">
    <h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=ftp%3A%2F%2Ffiles.example.org%2Fx">FTP</a></h2>
  </div>
  <div class="result results_links web-result ">
    <h2 class="result__title"><a class="result__a" href="javascript:alert(1)">Script</a></h2>
  </div>
</div>
<div class="nav-link"><form action="/html/" method="post"><input type="submit" value="Next"/></form></div>
<a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnot-a-result.example%2F">Footer link outside results</a>
</body></html>
"""


class ParseDdgResultsTests(unittest.TestCase):
    def test_organic_results_in_order_with_plain_titles(self):
        self.assertEqual(
            parse_ddg_results(PAGE),
            [
                {
                    "url": "https://docs.python.org/3/library/asyncio.html?highlight=task&x=1",
                    "title": "asyncio — Asynchronous I/O — Python 3.15 documentation",
                },
                {
                    "url": "https://realpython.com/async-io-python/",
                    "title": "Python's asyncio: A Hands-On Walkthrough - Real Python",
                },
                {"url": "http://plain.example.org/page", "title": "Direct link"},
            ],
        )

    def test_empty_or_resultless_page(self):
        self.assertEqual(parse_ddg_results(""), [])
        self.assertEqual(parse_ddg_results("<html><body><div class='no-results'>No results.</div></body></html>"), [])

    def test_resolve_result_url(self):
        self.assertEqual(
            resolve_result_url("//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.example%2Fp%3Fq%3D1&rut=x"),
            "https://a.example/p?q=1",
        )
        self.assertEqual(resolve_result_url("https://b.example/"), "https://b.example/")
        for href in [
            "",
            "https://duckduckgo.com/y.js?ad_domain=x.example&u3=https%3A%2F%2Fwww.bing.com",
            "//duckduckgo.com/l/?rut=x",
            "//duckduckgo.com/l/?uddg=https%3A%2F%2Fhtml.duckduckgo.com%2Fhtml%2F",
            "/html/?q=next",
            "mailto:someone@example.org",
            "http://[broken",
        ]:
            with self.subTest(href=href):
                self.assertIsNone(resolve_result_url(href))


if __name__ == "__main__":
    unittest.main()
