// Runs the full end-to-end suite against the remote (Turso) database driver, using a local stand-in.
process.env.E2E_REMOTE = '1';
await import('./e2e.test.js');
