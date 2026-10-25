'use strict';

/**
 * Express application assembly.
 * Security middleware first, then routes, then a single error funnel so every
 * failure (including ones thrown deep in a transaction) returns the same
 * redacted JSON envelope.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const helmet = require('helmet');
const cors = require('cors');

const config = require('./config/env');
const { requestContext } = require('./middleware/context');
const { apiLimiter } = require('./middleware/rateLimit');
const routes = require('./routes');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');

const app = express();

if (process.env.TRUST_PROXY === 'true') {
  app.set('trust proxy', 1);
}

// Security headers. The CSP is deliberately permissive on connect-src so the
// same build works behind the Vite dev proxy and a static origin.
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);

const allowedOrigins = new Set(config.corsOrigins);
app.use(
  cors({
    origin(origin, callback) {
      // No Origin header = same-origin fetch, curl, or a native client.
      if (!origin || allowedOrigins.has(origin) || (!config.isProduction && allowedOrigins.has('*'))) {
        return callback(null, true);
      }
      return callback(null, false);
    },
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id'],
    maxAge: 600,
  })
);

app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));

// Correlation id + client metadata, available to every handler and audit row.
app.use(requestContext);

// Liveness probe lives outside the /api limiter bucket.
app.get('/health', (req, res) =>
  res.json({ status: 'ok', service: 'qrus-api', time: new Date().toISOString() })
);

app.use('/api', apiLimiter);
app.use('/api', routes);

// --- production SPA ----------------------------------------------------------
// In production the React build is served by this same process, so the whole
// app is one origin: no CORS config, SSE just works, cookies would work.
// Any non-API GET falls through to index.html and the client router decides
// what to render.
if (config.isProduction) {
  const distPath = path.resolve(__dirname, '..', '..', 'frontend', 'dist');
  if (fs.existsSync(distPath)) {
    app.use(express.static(distPath, { index: false, maxAge: '1h' }));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path === '/health') return next();
      return res.sendFile(path.join(distPath, 'index.html'));
    });
  } else {
    // eslint-disable-next-line no-console
    console.error('[qrus] frontend/dist not found — run `npm run build` in frontend/');
  }
}

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
