FROM ghcr.io/astral-sh/uv:0.9.27 AS uv
FROM node:24.14.1-bookworm-slim
COPY --from=uv /uv /usr/local/bin/uv
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install --global npm@11.11.0
WORKDIR /app
COPY . .
ENV HUSKY=0 UV_PYTHON_INSTALL_DIR=/opt/python
RUN npm run bootstrap && npm run build && EVAL_BASE_URL=https://api.openai.com/v1 npm run doctor
ENTRYPOINT ["node", "dist/apps/host/src/cli.js"]
CMD ["--help"]
