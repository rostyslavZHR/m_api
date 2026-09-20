FROM node:24-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-slim AS runner
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY .env.example ./
COPY openapi/openapi.yaml ./openapi/
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
