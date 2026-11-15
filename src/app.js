// The Novelo's built-in intelligence, put together (server.js starts it; the tests build their own).
import http from 'node:http';
import { Config } from './config.js';
import { openDb, Settings } from './db.js';
import { Devices } from './devices.js';
import { Limits } from './limits.js';
import { Router } from './router.js';
import { Telemetry } from './telemetry.js';
import { Api } from './api.js';
import { Admin } from './admin.js';
import { Plans } from './plans.js';
import { googleRoots, Revocations } from './attest.js';

export function build({ config = new Config(), dataDir = config.dataDir, fetcher = fetch, now = Date.now, roots = googleRoots(), heartbeatMs } = {}) {
  const db = openDb(dataDir);
  const settings = new Settings(db);
  const secret = config.serverSecret();
  const revocations = new Revocations(dataDir, { fetcher });
  const limits = new Limits({ db, settings, now });
  const plans = new Plans({ db, settings, now });
  const devices = new Devices({ db, settings, secret, plans, roots, revocations, now });
  const telemetry = new Telemetry({ db, now });
  const router = new Router({ db, config, settings, limits, fetcher, now });
  const api = new Api({ config, settings, devices, limits, router, telemetry, plans, now, heartbeatMs });
  const admin = new Admin({ db, config, settings, devices, limits, router, telemetry, plans, secret, fetcher, now });

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
  return { db, config, settings, devices, limits, telemetry, router, api, admin, plans, revocations, flush, close };
}

export function listen(handler, host, port, name) {
  const server = http.createServer((req, res) => handler(req, res));
  // A body has two minutes to arrive; an answer may take as long as the queue lets it.
  server.requestTimeout = 120_000;
  server.headersTimeout = 20_000;
  server.keepAliveTimeout = 65_000;
  server.listen(port, host, () => console.log(`${name}: http://${host}:${port}`));
  return server;
}
