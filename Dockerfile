FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
LABEL org.opencontainers.image.source=https://github.com/1amZach/aura-standalone
LABEL org.opencontainers.image.licenses=LicenseRef-Aura-Attribution
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
VOLUME ["/app/data"]
CMD ["node", "--no-warnings=ExperimentalWarning", "dist/index.js"]
