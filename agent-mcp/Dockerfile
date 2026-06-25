# Build stage
FROM oven/bun:1 AS builder

WORKDIR /app

# Install dependencies
COPY package.json ./
RUN bun install

# Copy source
COPY . .

# Runtime stage
FROM oven/bun:1-slim

WORKDIR /app

# Copy from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/agent ./agent
COPY --from=builder /app/package.json ./

# Runs as root (not USER bun): the frontend interface serves the OAuth callback
# on :80, a privileged port a non-root user can't bind. EXPOSE 80 for the ingress.
EXPOSE 80

# Run the agent
CMD ["bun", "run", "agent/index.ts"]
