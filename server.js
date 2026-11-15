// The Novelo's built-in intelligence. Two listeners: the API the app talks to, and the panel
// (another port, this machine only unless you say otherwise). Run as is: node server.js, under
// systemd, pm2 or anything else.
import { build, listen } from './src/app.js';
import { event } from './src/db.js';

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
