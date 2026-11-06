FROM node:22-alpine AS build
WORKDIR /app
# Shared discovery lib (named build context `discovery`); package.json points at ../service-discoverer/Libs/typescript.
COPY --from=discovery . /service-discoverer/Libs/typescript
COPY package.json package-lock.json* ./
# Uses the lockfile when it exists (commit package-lock.json after the first `npm install`).
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=discovery . /service-discoverer/Libs/typescript
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "dist/main.js"]
