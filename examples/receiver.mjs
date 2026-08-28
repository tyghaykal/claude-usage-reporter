#!/usr/bin/env node
/**
 * Minimal reference receiver — the "endpoint" side made concrete.
 *
 * NOT part of the plugin and not required to use it. It exists so you can see
 * exactly what arrives before pointing the plugin at real infrastructure.
 *
 *   node examples/receiver.mjs                 # listens on :8787, no auth
 *   RECEIVER_TOKEN=secret node examples/receiver.mjs   # requires Bearer secret
 *
 * Then:
 *   /usage-config set usageEndpoint http://127.0.0.1:8787/claude-usage
 *   /usage-config set usageAuthType Bearer
 *   /usage-config set usageAuthToken secret
 *
 * Records are appended to usage.jsonl next to this file.
 */

import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || 8787);
const TOKEN = process.env.RECEIVER_TOKEN || '';
const OUT = fileURLToPath(new URL('./usage.jsonl', import.meta.url));

createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405).end('POST only\n');
    return;
  }
  if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) {
    res.writeHead(401).end('unauthorized\n');
    return;
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    try {
      const record = JSON.parse(body);
      appendFileSync(OUT, `${JSON.stringify(record)}\n`);
      console.log(
        `${record.datetime}  ${record.project}  ${record.tokens.total} tokens  ${JSON.stringify(record.prompt).slice(0, 60)}`,
      );
      res.writeHead(202).end('ok\n');
    } catch {
      res.writeHead(400).end('expected JSON\n');
    }
  });
}).listen(PORT, () => {
  console.log(`usage receiver on http://127.0.0.1:${PORT}  ->  ${OUT}`);
  console.log(TOKEN ? 'auth: Bearer required' : 'auth: none (set RECEIVER_TOKEN to require Bearer)');
});
