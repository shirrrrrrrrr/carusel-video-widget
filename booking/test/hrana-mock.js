// Minimal stand-in for Turso's HTTP API (Hrana v2 /v2/pipeline) backed by node:sqlite.
// Lets the test suite exercise the remote database driver without network access.
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';

export function startHranaMock({ port, token }) {
  const db = new DatabaseSync(':memory:');
  const decode = (a) => (a.type === 'null' ? null : a.type === 'integer' ? Number(a.value) : a.type === 'float' ? Number(a.value) : a.value);
  const encode = (v) => (v === null ? { type: 'null' }
    : typeof v === 'number' || typeof v === 'bigint' ? (Number.isInteger(Number(v)) ? { type: 'integer', value: String(v) } : { type: 'float', value: Number(v) })
      : { type: 'text', value: String(v) });
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url !== '/v2/pipeline' || req.method !== 'POST') { res.writeHead(404); return res.end(); }
      if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); return res.end('unauthorized'); }
      const { requests } = JSON.parse(body);
      const results = requests.map((r) => {
        if (r.type === 'close') return { type: 'ok', response: { type: 'close' } };
        try {
          const { sql, args = [] } = r.stmt;
          const stmt = db.prepare(sql);
          const params = args.map(decode);
          if (/^\s*(select|pragma|with)\b/i.test(sql) || /\breturning\b/i.test(sql)) {
            const rows = stmt.all(...params);
            const cols = rows.length ? Object.keys(rows[0]) : [];
            return { type: 'ok', response: { type: 'execute', result: {
              cols: cols.map((name) => ({ name })), rows: rows.map((row) => cols.map((c) => encode(row[c]))),
              affected_row_count: 0, last_insert_rowid: null } } };
          }
          const info = stmt.run(...params);
          return { type: 'ok', response: { type: 'execute', result: {
            cols: [], rows: [], affected_row_count: Number(info.changes), last_insert_rowid: String(info.lastInsertRowid) } } };
        } catch (e) {
          return { type: 'error', error: { message: e.message } };
        }
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ baton: null, base_url: null, results }));
    });
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}
