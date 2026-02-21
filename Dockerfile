# Build Stage 
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm install --only=production

# Runtime Stage 
FROM node:20-alpine AS runtime

# Security: run as non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser  -S nodeuser -u 1001

WORKDIR /app

# Copy only production node_modules from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy application source
COPY --chown=nodeuser:nodejs src/        ./src/
COPY --chown=nodeuser:nodejs migrations/ ./migrations/
COPY --chown=nodeuser:nodejs scripts/    ./scripts/
COPY --chown=nodeuser:nodejs package.json ./

USER nodeuser

EXPOSE 3000

# Health check (Docker will restart container if unhealthy)
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "src/server.js"]
