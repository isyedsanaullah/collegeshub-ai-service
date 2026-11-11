# Multi-stage production Dockerfile for collegeshub-ai-service
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Generate Prisma Client
COPY prisma ./prisma/
RUN npx prisma generate

# Build TypeScript source
COPY tsconfig.json ./
COPY src ./src/
RUN npm run build

# Prune dev dependencies
RUN npm prune --production

# ------------------------------------------------------------------------------
# Production Runner
# ------------------------------------------------------------------------------
FROM node:20-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=10001

# Copy production artifacts
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma

# Non-root user for security
USER node

EXPOSE 10001

CMD ["node", "dist/server.js"]

