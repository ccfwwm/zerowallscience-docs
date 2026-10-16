FROM node:20-alpine AS build
WORKDIR /app
COPY packages/nowen-mcp/package.json packages/nowen-mcp/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY packages/nowen-mcp/tsconfig.json ./
COPY packages/nowen-mcp/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
CMD ["node", "dist/http-entry.js"]
