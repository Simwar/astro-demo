# ---- Stage 1: build the React/Vite dashboard to static assets ----
FROM node:22-slim AS frontend
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install
COPY frontend/ ./
RUN npm run build            # -> /web/dist

# ---- Stage 2: Python runtime ----
FROM python:3.12-slim
WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Backend source and the built frontend (served by FastAPI on /).
COPY agent/ ./agent/
COPY --from=frontend /web/dist ./static/

# Frontend interface: the platform routes the public host to :80 and injects
# PORT=80. Binding :80 in-container works for a non-root user (not a privileged
# host port). The prod FS is read-only; nothing writes to disk at runtime.
EXPOSE 80

CMD ["python", "-m", "agent.main"]
