# syntax=docker/dockerfile:1
# Qrus — single container: Express API serves /api and the built React SPA.

# --- frontend build -----------------------------------------------------------
FROM node:20-alpine AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# --- runtime ------------------------------------------------------------------
FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app

# Backend production dependencies only.
COPY backend/package.json backend/package-lock.json ./backend/
RUN cd backend && npm ci --omit=dev --no-audit --no-fund

COPY backend/ ./backend/
COPY database/ ./database/
COPY --from=frontend /app/frontend/dist ./frontend/dist

# config.paths.database resolves backend/../../database -> /app/database
# app.js resolves src/../../frontend/dist        -> /app/frontend/dist
WORKDIR /app/backend
EXPOSE 4000

# Migrations/seeds run via the platform's release command, not here.
CMD ["node", "src/server.js"]
