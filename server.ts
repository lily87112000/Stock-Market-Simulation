import express from 'express';
import http from 'http';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { app } from './src/server/app.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Support CLI args --port and --host as passed by AI Studio runner
const portArgIdx = process.argv.indexOf('--port');
const cliPort = portArgIdx !== -1 && process.argv[portArgIdx + 1] ? Number(process.argv[portArgIdx + 1]) : null;
const PORT = cliPort || Number(process.env.PORT) || 3000;

const hostArgIdx = process.argv.indexOf('--host');
const cliHost = hostArgIdx !== -1 && process.argv[hostArgIdx + 1] ? process.argv[hostArgIdx + 1] : null;
const HOST = cliHost || '0.0.0.0';

// Global error handlers to prevent Node.js 22 process exit on transient API failures
process.on('unhandledRejection', (reason, promise) => {
  console.warn('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

async function startServer() {
  const httpServer = http.createServer(app);
  let vite: Awaited<ReturnType<typeof createViteServer>> | null = null;

  if (process.env.NODE_ENV !== 'production') {
    vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR !== 'true' ? { server: httpServer } : false,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  httpServer.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use.`);
      process.exit(1);
    } else {
      console.error('Server listen error:', err);
    }
  });

  httpServer.listen(PORT, HOST, () => {
    console.log(`Server listening on ${HOST}:${PORT}`);
  });

  const shutdown = async () => {
    try {
      if (vite) await vite.close();
    } catch (_) {}
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };

  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

startServer().catch(err => {
  console.error('Server startup failed:', err);
  process.exit(1);
});
