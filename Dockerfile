# Home server image: builds the app, then serves it plus the media library from one port.
FROM node:24-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-slim
WORKDIR /app
# yt-dlp (standalone binary, no Python needed) + ffmpeg for the Facebook link downloader.
# The server also runs `yt-dlp -U` on every start, because Facebook changes often.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates \
    && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp \
    && chmod 755 /usr/local/bin/yt-dlp \
    && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
# Local speech-to-text (faster-whisper, CPU) for transcribing every video. The model itself
# downloads on first use into /data/models (the mounted volume), so it is fetched only once.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv \
    && python3 -m venv /opt/whisper \
    && /opt/whisper/bin/pip install --no-cache-dir faster-whisper \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production PORT=5183 DATA_DIR=/data STATIC_DIR=/app/dist PYTHON_BIN=/opt/whisper/bin/python
COPY --from=build /app/dist ./dist
# Server runtime dependencies (the official Anthropic SDK, used only when ANTHROPIC_API_KEY is set).
COPY package*.json ./
RUN npm ci --omit=dev
COPY server ./server
EXPOSE 5183
CMD ["node", "server/server.mjs"]
