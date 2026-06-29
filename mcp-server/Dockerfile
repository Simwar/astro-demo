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

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src
COPY --from=builder /app/package.json ./

# Runs as root (not a non-root USER): the frontend interface serves on :80, a
# privileged port a non-root user can't bind. EXPOSE 80 for the ingress.
EXPOSE 80

CMD ["bun", "run", "src/index.ts"]
