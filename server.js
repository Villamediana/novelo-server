// The Novelo's built-in intelligence. Two listeners: the API the app talks to, and the panel
// (another port, this machine only unless you say otherwise).
import http from 'node:http';
import { Config } from './src/config.js';
import { openDb, Settings, event } from './src/db.js';
import { Devices } from './src/devices.js';
import { Limits } from './src/limits.js';
import { Router } from './src/router.js';
import { Telemetry } from './src/telemetry.js';
import { Api } from './src/api.js';
import { Admin } from './src/admin.js';
import { Plans } from './src/plans.js';
import { Vaults } from './src/vaults.js';
import { googleRoots, Revocations } from './src/attest.js';

export function build({ config = new Config(), dataDir = config.dataDir, fetcher = fetch, now = Date.now, roots = googleRoots(), heartbeatMs } = {}) {
  const db = openDb(dataDir);
  const settings = new Settings(db);
  const secret = config.serverSecret();
  const revocations = new Revocations(dataDir, { fetcher });
  const limits = new Limits({ db, settings, now });
  const plans = new Plans({ db, settings, now });
  const vaults = new Vaults({ db, settings, dataDir, now });
  const devices = new Devices({ db, settings, secret, plans, roots, revocations, now });
  const telemetry = new Telemetry({ db, now });
  const router = new Router({ db, config, settings, limits, fetcher, now });
  const api = new Api({ config, settings, devices, limits, router, telemetry, plans, vaults, now, heartbeatMs });
  const admin = new Admin({ db, config, settings, devices, limits, router, telemetry, plans, vaults, secret, fetcher, now });

  const flush = () => {
    try {
      telemetry.flush();
      limits.flush();
    } catch (e) {
      console.error('flush:', e);
    }
  };
  const timers = [
    setInterval(flush, 1000),
    setInterval(() => limits.prune(), 10 * 60_000),
    setInterval(() => telemetry.prune(settings.get('keep_days')), 6 * 3600_000),
  ];
  timers.forEach((t) => t.unref());

  const close = () => {
    timers.forEach(clearInterval);
    api.stop();
    router.stop();
    revocations.stop();
    flush();
    db.close();
  };
  return { db, config, settings, devices, limits, telemetry, router, api, admin, plans, vaults, revocations, flush, close };
}

function listen(handler, host, port, name) {
  const server = http.createServer((req, res) => handler(req, res));
  // A body has two minutes to arrive; an answer may take as long as the queue lets it.
  server.requestTimeout = 120_000;
  server.headersTimeout = 20_000;
  server.keepAliveTimeout = 65_000;
  server.listen(port, host, () => console.log(`${name}: http://${host}:${port}`));
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = build();
  app.revocations.start();
  const servers = [listen((q, s) => app.api.handle(q, s), app.config.get('HOST', '127.0.0.1'), app.config.int('PORT', 8787), 'api')];
  if (app.config.has('ADMIN_PASSWORD')) {
    servers.push(listen((q, s) => app.admin.handle(q, s), app.config.get('ADMIN_HOST', '127.0.0.1'), app.config.int('ADMIN_PORT', 8788), 'painel'));
  } else {
    console.log('painel: desligado (falta ADMIN_PASSWORD no .env)');
  }
  event(app.db, 'servidor', 'Servidor iniciado.');

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    console.log('parando…');
    // No new requests; the ones going on get a moment to end.
    servers.forEach((s) => s.close());
    const until = Date.now() + 20_000;
    const wait = setInterval(() => {
      if (app.api.open > 0 && Date.now() < until) return;
      clearInterval(wait);
      servers.forEach((s) => s.closeAllConnections());
      app.close();
      process.exit(0);
    }, 200);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.on('unhandledRejection', (e) => console.error('unhandled:', e));
}
