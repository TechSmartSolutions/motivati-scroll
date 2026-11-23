# Home server image: builds the app, then serves it plus the media library from one port.
FROM node:24-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production PORT=5183 DATA_DIR=/data STATIC_DIR=/app/dist
COPY --from=build /app/dist ./dist
COPY server ./server
EXPOSE 5183
CMD ["node", "server/server.mjs"]
