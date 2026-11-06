#!/usr/bin/env node
'use strict';

// bridge/uci-bridge.js - native UCI engine bridge for Chess AI Helper.
//
// Komodo Dragon and Rodent IV (and native lc0 for Maia 3) have no browser
// build, so they run as native processes on this machine. This tiny server
// owns those processes and exposes them over a local WebSocket that the
// extension's service worker connects to.
//
// Zero dependencies: the WebSocket handshake and text framing are implemented
// below with Node core only. No `npm install` needed.
//
//   node bridge/uci-bridge.js            # port 8765
//   node bridge/uci-bridge.js 9000       # custom port
//   UCI_BRIDGE_PORT=9000 node bridge/uci-bridge.js
//
// Binary lookup order for an engine:
//   1. engines/<id>/<name>.exe  (Windows)
//   2. engines/<id>/<name>      (Linux / macOS)
//   3. <name> on PATH
//
// The extension sends:
//   { "type": "start", "engine": "komododragon", "bin": "komodo", "args": [...] }
//   { "type": "line",  "line": "position fen ..." }
// and receives:
//   { "type": "ready" }
//   { "type": "line",  "line": "<engine output>" }
//   { "type": "error", "message": "..." }

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = parseInt(process.env.UCI_BRIDGE_PORT || process.argv[2] || '8765', 10);
const ROOT = path.resolve(__dirname, '..');

// engine id -> candidate executable paths (relative to the extension root)
const LOCAL_BINS = {
  maia3: ['engines/maia3/lc0.exe', 'engines/maia3/lc0'],
  stockfish18: ['engines/stockfish18/stockfish.exe', 'engines/stockfish18/stockfish'],
  komododragon: ['engines/komododragon/komodo.exe', 'engines/komododragon/komodo.exe', 'engines/komododragon/komodo'],
  rodent4: ['engines/rodent4/rodent.exe', 'engines/rodent4/rodent'],
  stockfish19lite: ['engines/stockfish19lite/stockfish.exe', 'engines/stockfish19lite/stockfish']
};

function findBinary(engineId, declared) {
  const candidates = (LOCAL_BINS[engineId] || []).slice();
  if (declared) {
    candidates.push('engines/' + engineId + '/' + declared + '.exe');
    candidates.push('engines/' + engineId + '/' + declared);
  }
  for (const rel of candidates) {
    const abs = path.resolve(ROOT, rel);
    if (fs.existsSync(abs)) return abs;
  }
  // last resort: rely on PATH
  return declared || null;
}

function expandArgs(args, engineId) {
  return (args || []).map((a) => String(a)
    .replace(/\{weights\}/g, path.resolve(ROOT, 'engines/' + engineId + '/maia3-79m.pb.gz'))
    .replace(/\{Threads\}/g, '1')
    .replace(/\{Hash\}/g, '128')
    .replace(/\{Personality\}/g, 'default'));
}

// ------------------------------------------------------------
// minimal WebSocket (text frames only)
// ------------------------------------------------------------
function encodeFrame(payload, opcode) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const op = opcode === undefined ? 0x1 : opcode;
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | op;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | op;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | op;
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  return Buffer.concat([header, data]);
}

function decodeFrames(buffer, onMessage, onClose, onPing) {
  let offset = 0;
  const out = [];
  while (offset + 2 <= buffer.length) {
    const b0 = buffer[offset];
    const b1 = buffer[offset + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = offset + 2;
    if (len === 126) {
      if (p + 2 > buffer.length) break;
      len = buffer.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      if (p + 8 > buffer.length) break;
      const hi = buffer.readUInt32BE(p);
      const lo = buffer.readUInt32BE(p + 4);
      len = hi * 0x100000000 + lo;
      p += 8;
    }
    let mask = null;
    if (masked) {
      if (p + 4 > buffer.length) break;
      mask = buffer.slice(p, p + 4);
      p += 4;
    }
    if (p + len > buffer.length) break;
    const data = Buffer.from(buffer.slice(p, p + len));
    if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
    offset = p + len;

    if (opcode === 0x8) { onClose(); return { rest: Buffer.alloc(0), closed: true }; }
    if (opcode === 0x9) { onPing(data); continue; }
    if (opcode === 0xa) continue;
    if (opcode === 0x1 || opcode === 0x0) out.push(data.toString('utf8'));
  }
  return { rest: buffer.slice(offset), messages: out, closed: false };
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Chess AI Helper UCI bridge. WebSocket endpoint: ws://127.0.0.1:' + PORT + '/\n');
});

server.on('upgrade', (req, socket) => {
  if (!req.headers['sec-websocket-key']) {
    socket.destroy();
    return;
  }
  const accept = crypto.createHash('sha1')
    .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  socket.setNoDelay(true);

  let child = null;
  let engineId = null;
  let buffer = Buffer.alloc(0);
  let alive = true;

  const send = (obj) => {
    if (!alive) return;
    try { socket.write(encodeFrame(JSON.stringify(obj))); } catch (_) {}
  };

  const stopChild = () => {
    if (!child) return;
    try { child.stdin.write('quit\n'); } catch (_) {}
    setTimeout(() => {
      try { if (child && !child.killed) child.kill(); } catch (_) {}
    }, 300);
    child = null;
  };

  const startEngine = (msg) => {
    if (child) stopChild();
    engineId = msg.engine || 'unknown';
    const bin = findBinary(engineId, msg.bin);
    const args = expandArgs(msg.args, engineId);

    if (!bin) {
      send({ type: 'error', message: 'no binary configured for ' + engineId });
      return;
    }

    console.log('[bridge] starting ' + engineId + ' -> ' + bin + ' ' + args.join(' '));
    try {
      child = spawn(bin, args, { cwd: ROOT, windowsHide: true });
    } catch (e) {
      send({ type: 'error', message: 'spawn failed: ' + ((e && e.message) || e) });
      return;
    }

    child.stdout.setEncoding('utf8');
    let pending = '';
    child.stdout.on('data', (chunk) => {
      pending += chunk;
      let nl;
      while ((nl = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, nl).replace(/\r$/, '');
        pending = pending.slice(nl + 1);
        if (line) send({ type: 'line', line });
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) console.error('[bridge:' + engineId + '] ' + text);
    });

    child.on('error', (e) => {
      send({ type: 'error', message: 'engine error: ' + ((e && e.message) || e) });
    });

    child.on('exit', (code, signal) => {
      console.log('[bridge] ' + engineId + ' exited code=' + code + ' signal=' + signal);
      send({ type: 'closed' });
      child = null;
    });

    send({ type: 'ready' });
  };

  const handleMessage = (text) => {
    let msg;
    try { msg = JSON.parse(text); } catch (_) { return; }
    if (!msg || !msg.type) return;

    if (msg.type === 'start') {
      startEngine(msg);
      return;
    }
    if (msg.type === 'line') {
      if (child && child.stdin.writable) {
        try { child.stdin.write(String(msg.line) + '\n'); } catch (_) {}
      }
      return;
    }
    if (msg.type === 'stop') {
      stopChild();
    }
  };

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    const res = decodeFrames(
      buffer,
      (text) => handleMessage(text),
      () => { alive = false; stopChild(); try { socket.end(); } catch (_) {} },
      (data) => { try { socket.write(encodeFrame(data, 0xa)); } catch (_) {} }
    );
    if (res.closed) { alive = false; stopChild(); return; }
    buffer = res.rest || Buffer.alloc(0);
  });

  socket.on('close', () => { alive = false; stopChild(); });
  socket.on('error', () => { alive = false; stopChild(); });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('Chess AI Helper UCI bridge listening on ws://127.0.0.1:' + PORT + '/');
  console.log('Drop native engines into engines/<id>/ (komodo.exe, rodent.exe, lc0.exe, ...).');
});
