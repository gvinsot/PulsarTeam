FROM python:3.12-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright HOME=/tmp/browser-home
WORKDIR /app
COPY mcp-auth-browser/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && playwright install --with-deps chromium \
    && useradd --uid 10004 --no-create-home browser && chmod -R a+rX /ms-playwright
COPY mcp-auth-browser/src ./src
USER browser
EXPOSE 8000
CMD ["uvicorn", "server:app", "--app-dir", "src", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
