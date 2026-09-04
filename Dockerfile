FROM node:22-bookworm-slim AS web-build

WORKDIR /source
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/react/package.json packages/react/package.json
COPY apps/standalone/package.json apps/standalone/package.json
RUN npm ci --ignore-scripts --no-audit
COPY packages ./packages
COPY apps ./apps
RUN npm run build

FROM python:3.12-slim-bookworm AS runtime

RUN apt-get update \
    && apt-get install --no-install-recommends -y ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1000 dolphin

WORKDIR /source
COPY python ./python
COPY --from=web-build /source/python/dolphin_terminal/static ./python/dolphin_terminal/static
RUN pip install --no-cache-dir ./python && rm -rf /source/python

USER dolphin
WORKDIR /workspace
EXPOSE 8733
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8733/health', timeout=2)"

ENTRYPOINT ["dolphin-terminal", "serve"]
CMD ["/workspace", "--session-backend", "native", "--host", "0.0.0.0", "--allow-remote", "--no-open"]
