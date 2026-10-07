// Local server: `npm start` on your computer (or any always-on host).
import http from 'node:http';
import net from 'node:net';
import { config } from './config.js';
import { configProblems, handler } from './app.js';
import { startReminderWorker } from './reminders.js';
import { initDb } from './db.js';

if (configProblems.length) {
  console.error(`\n⚠️  Configuration problems:\n - ${configProblems.join('\n - ')}\nCopy .env.example to .env and fill it in.\n`);
  if (process.env.NODE_ENV === 'production') process.exit(1);
}

await initDb();
const server = http.createServer(handler);

function portTakenMessage() {
  console.error(`\n❌ Port ${config.port} is already in use by another program.`);
  if (process.platform === 'darwin' && config.port === 5000) {
    console.error('   On a Mac, port 5000 is used by AirPlay Receiver.');
  }
  console.error(`   Start on another port instead, for example:  PORT=5051 npm start`);
  console.error('   (or change PORT in the .env file)\n');
  process.exit(1);
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') portTakenMessage();
  throw e;
});

// Some programs (e.g. AirPlay on macOS) share the port in a way that still lets us bind,
// but the browser would reach them instead of us — so check that nobody answers first.
function portAnswers(host) {
  return new Promise((resolve) => {
    const sock = net.connect({ port: config.port, host });
    sock.setTimeout(500);
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('timeout', () => { sock.destroy(); resolve(false); });
    sock.once('error', () => resolve(false));
  });
}
const taken = (await Promise.all(['127.0.0.1', '::1'].map(portAnswers))).some(Boolean);
if (taken) portTakenMessage();

server.listen(config.port, () => {
  console.log(`Booking system running at ${config.baseUrl} (port ${config.port})`);
  console.log(`  Booking page: ${config.baseUrl}/`);
  console.log(`  Dashboard:    ${config.baseUrl}/admin`);
});
startReminderWorker();
