# Dev-server image for Docker Desktop. Production is a static build on GitHub Pages.
FROM node:24-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
EXPOSE 5183
CMD ["npm", "run", "dev"]
