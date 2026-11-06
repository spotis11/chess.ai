// engines/engine-manager.js - transport layer for the engine roster.
//
// the rest of the extension only knows Worker-shaped adapters:
//
//     adapter.postMessage('position fen ...')
//     adapter.onmessage = (e) => handleEngineLine(e.data)
//     adapter.start() / adapter.terminate()
//
// both transports are hidden behind that shape:
//
//   worker  - fetch engines/<id>/* as Blobs, boot a Web Worker from the blob
//             URL (MV3 content scripts cannot create a worker straight from a
//             chrome-extension:// URL). stockfish gets the wasm blob URL in the
//             hash, exactly like the bundled loader always did.
//   bridge  - open ws://127.0.0.1:<port>/ and let bridge/uci-bridge.js spawn the
//             native binary. used for engines with no browser build.
//
// any missing file, refused socket or binary crash falls back to the bundled
// stockfish 19 lite, so the extension always has a working engine.
//
// UCI options: the registry is the single source of truth. once an engine says
// "uciok" the manager applies every resolved option before forwarding uciok to
// the content script. the content script's legacy Stockfish options still work
// on top of that for stockfish-family engines.

(() => {
  'use strict';

  const FALLBACK = 'stockfish19lite';
  const DEFAULT_BRIDGE_PORT = 8765;

  function registry() {
    if (typeof window !== 'undefined' && window.ChessAIEngines) return window.ChessAIEngines;
    if (typeof globalThis !== 'undefined' && globalThis.ChessAIEngines) return globalThis.ChessAIEngines;
    return null;
  }

  function lineOf(payload) {
    if (typeof payload === 'string') return payload;
    if (payload && typeof payload.data === 'string') return payload.data;
    return '';
  }

  class EngineManager {
    constructor(log) {
      this.log = typeof log === 'function' ? log : function () {};
      this.current = null;
      this.engineId = null;
    }

    teardown() {
      const cur = this.current;
      this.current = null;
      this.engineId = null;
      if (cur && typeof cur.terminate === 'function') {
        try { cur.terminate(); } catch (_) {}
      }
    }

    // boot resolves once the transport is alive (worker constructed or bridge
    // socket ready). the engine handshake ("uci") is sent by adapter.start(),
    // which the caller runs after binding onmessage, so no uciok is ever lost.
    async boot(engineId, savedOptions, opts) {
      const reg = registry();
      if (!reg) throw new Error('engine registry missing');
      const spec = reg.get(engineId);
      const options = reg.resolveOptions(spec.id, savedOptions || {});
      const port = (opts && opts.port) || DEFAULT_BRIDGE_PORT;

      this.teardown();
      this.log('engine: booting ' + spec.name + ' [' + spec.transport + '] options=' + JSON.stringify(options));

      let adapter;
      try {
        if (spec.requiresBridge || spec.transport === 'bridge') {
          adapter = await this._bootBridge(spec, options, port);
        } else {
          adapter = await this._bootWorker(spec, options);
        }
      } catch (e) {
        const why = (e && e.message) || String(e);
        this.log('engine: ' + spec.id + ' unavailable (' + why + ')');
        if (spec.id === FALLBACK) throw e;
        const fb = reg.get(FALLBACK);
        this.log('engine: falling back to ' + fb.name);
        adapter = await this._bootWorker(fb, reg.resolveOptions(FALLBACK, {}));
        adapter.fellBackFrom = spec.id;
        adapter.fellBackReason = why;
      }

      this.current = adapter;
      this.engineId = adapter.engineId;
      return adapter;
    }

    // apply options to a live adapter (popup changes, no full reboot needed)
    applyOptions(engineId, savedOptions) {
      const reg = registry();
      const adapter = this.current;
      if (!reg || !adapter || typeof adapter.postMessage !== 'function') return;
      const spec = reg.get(engineId || this.engineId);
      const options = reg.resolveOptions(spec.id, savedOptions || {});
      for (const line of reg.toUciOptions(spec.id, options)) {
        adapter.postMessage(line);
      }
    }

    async _bootWorker(spec, options) {
      if (!spec.files || !spec.files.js) {
        throw new Error('no worker build shipped for ' + spec.id);
      }
      if (typeof Worker === 'undefined') throw new Error('Worker unavailable');
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.getURL) {
        throw new Error('chrome.runtime.getURL unavailable');
      }

      const urlFor = (p) => chrome.runtime.getURL(p);
      const fetchBlob = async (p, type) => {
        const r = await fetch(urlFor(p));
        if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + p);
        return type === 'text' ? r.text() : r.arrayBuffer();
      };

      const blobs = [];
      const jsText = await fetchBlob(spec.files.js, 'text');

      let hash = '';
      let wasmUrl = '';
      if (spec.files.wasm) {
        const wasmBuf = await fetchBlob(spec.files.wasm, 'buffer');
        wasmUrl = URL.createObjectURL(new Blob([wasmBuf], { type: 'application/wasm' }));
        blobs.push(wasmUrl);
        hash = wasmUrl;
      }

      if (spec.files.weights) {
        const weightsBuf = await fetchBlob(spec.files.weights, 'buffer');
        const weightsUrl = URL.createObjectURL(new Blob([weightsBuf], { type: 'application/octet-stream' }));
        blobs.push(weightsUrl);
        // lc0 builds read their Module config from the worker hash. stockfish
        // reads just the wasm URL, lc0 reads {wasm, weights}.
        hash = JSON.stringify({ wasm: wasmUrl, weights: weightsUrl });
      }

      const jsUrl = URL.createObjectURL(new Blob([jsText], { type: 'application/javascript' })) +
        (hash ? '#' + encodeURIComponent(hash) : '');
      blobs.push(jsUrl);

      this.log('engine: blob worker ' + jsUrl.split('#')[0] + (wasmUrl ? ' wasm ' + wasmUrl : ''));
      let worker;
      try {
        worker = new Worker(jsUrl);
      } catch (e) {
        blobs.forEach((u) => { try { URL.revokeObjectURL(u); } catch (_) {} });
        throw new Error('Worker construction failed: ' + ((e && e.message) || e));
      }

      const handlers = { message: null, error: null };
      let optionsApplied = false;

      const adapter = {
        engineId: spec.id,
        engineName: spec.name,
        transport: 'worker',
        fellBackFrom: null,
        get onmessage() { return handlers.message; },
        set onmessage(fn) { handlers.message = fn; },
        get onerror() { return handlers.error; },
        set onerror(fn) { handlers.error = fn; },
        postMessage(line) {
          try { worker.postMessage(line); } catch (_) {}
        },
        start() {
          const send = () => { try { worker.postMessage('uci'); } catch (_) {} };
          setTimeout(send, 60);
          // a slow wasm init can eat the first "uci"; retry once.
          setTimeout(() => { if (!optionsApplied) send(); }, 2200);
        },
        terminate() {
          try { worker.terminate(); } catch (_) {}
          blobs.forEach((u) => { try { URL.revokeObjectURL(u); } catch (_) {} });
        }
      };

      worker.onmessage = (e) => {
        const line = lineOf(e && e.data);
        if (line && line.indexOf('uciok') === 0 && !optionsApplied) {
          optionsApplied = true;
          const reg = registry();
          if (reg) {
            for (const optLine of reg.toUciOptions(spec.id, options)) {
              try { worker.postMessage(optLine); } catch (_) {}
            }
          }
        }
        if (handlers.message) handlers.message({ data: line });
      };
      worker.onerror = (err) => {
        const msg = (err && err.message) || 'worker error';
        this.log('engine: ' + spec.id + ' worker error: ' + msg);
        if (handlers.error) handlers.error(err);
      };

      return adapter;
    }

    // Bridge engines reach 127.0.0.1. A content script's WebSocket can be
    // blocked by the host page's connect-src CSP, so the extension routes the
    // socket through the MV3 service worker by default (extension origin, no
    // page CSP) and keeps a direct socket as the fallback for testing pages.
    _bootBridge(spec, options, port) {
      const hasRuntime = typeof chrome !== 'undefined' && chrome.runtime &&
        typeof chrome.runtime.connect === 'function';
      if (!hasRuntime) return this._bootBridgeSocket(spec, options, port);
      return this._bootBridgeBackground(spec, options, port).catch((e) => {
        // a refused/failed bridge means the server itself is unreachable; a
        // direct socket from the page would fail the same way, so don't waste
        // another timeout on it. only retry directly when the background
        // relay was unavailable for a different reason.
        if (e && e.bridgeRefused) throw e;
        this.log('engine: background bridge failed (' + ((e && e.message) || e) + '), trying direct socket');
        return this._bootBridgeSocket(spec, options, port);
      });
    }

    _bootBridgeBackground(spec, options, port) {
      return new Promise((resolve, reject) => {
        let portObj;
        try {
          portObj = chrome.runtime.connect({ name: 'uci-bridge' });
        } catch (e) {
          reject(new Error('background bridge connect failed: ' + ((e && e.message) || e)));
          return;
        }

        const handlers = { message: null, error: null };
        let ready = false;
        let optionsApplied = false;

        const timer = setTimeout(() => {
          if (!ready) {
            try { portObj.disconnect(); } catch (_) {}
            reject(new Error('background bridge did not answer on port ' + port));
          }
        }, 3500);

        const sendLine = (line) => {
          try { portObj.postMessage({ type: 'line', line: String(line) }); } catch (_) {}
        };

        const adapter = {
          engineId: spec.id,
          engineName: spec.name,
          transport: 'bridge',
          fellBackFrom: null,
          get onmessage() { return handlers.message; },
          set onmessage(fn) { handlers.message = fn; },
          get onerror() { return handlers.error; },
          set onerror(fn) { handlers.error = fn; },
          postMessage(line) { sendLine(line); },
          start() {
            sendLine('uci');
            setTimeout(() => { if (!optionsApplied) sendLine('uci'); }, 1500);
          },
          terminate() {
            try { portObj.disconnect(); } catch (_) {}
          }
        };

        const handle = (msg) => {
          if (!msg || !msg.type) return;
          if (msg.type === 'ready') {
            ready = true;
            clearTimeout(timer);
            resolve(adapter);
            return;
          }
          if (msg.type === 'line') {
            const line = String(msg.line == null ? '' : msg.line);
            if (line.indexOf('uciok') === 0 && !optionsApplied) {
              optionsApplied = true;
              const reg = registry();
              if (reg) {
                for (const optLine of reg.toUciOptions(spec.id, options)) sendLine(optLine);
              }
            }
            if (handlers.message) handlers.message({ data: line });
            return;
          }
          if (msg.type === 'error') {
            const err = new Error(msg.message || 'bridge error');
            err.bridgeRefused = true;
            this.log('engine: ' + spec.id + ' bridge error: ' + err.message);
            if (!ready) {
              clearTimeout(timer);
              try { portObj.disconnect(); } catch (_) {}
              reject(err);
            } else if (handlers.error) handlers.error(err);
            return;
          }
          if (msg.type === 'closed' && ready && handlers.error) {
            handlers.error(new Error('bridge closed'));
          }
        };

        portObj.onMessage.addListener((msg) => {
          if (msg && msg.type === 'bridge') {
            let parsed;
            try { parsed = JSON.parse(msg.data); } catch (_) { parsed = { type: 'line', line: String(msg.data) }; }
            handle(parsed);
          } else {
            handle(msg);
          }
        });

        portObj.onDisconnect.addListener(() => {
          if (!ready) {
            clearTimeout(timer);
            reject(new Error('background bridge disconnected'));
          } else if (handlers.error) {
            handlers.error(new Error('bridge disconnected'));
          }
        });

        try {
          portObj.postMessage({
            type: 'start',
            engine: spec.id,
            bin: spec.bridge.bin,
            args: spec.bridge.args || [],
            port: port
          });
        } catch (e) {
          clearTimeout(timer);
          reject(e);
        }
      });
    }

    _bootBridgeSocket(spec, options, port) {
      const bin = spec.bridge && spec.bridge.bin;
      if (!bin) return Promise.reject(new Error('no bridge binary configured for ' + spec.id));
      if (typeof WebSocket === 'undefined') return Promise.reject(new Error('WebSocket unavailable'));

      return new Promise((resolve, reject) => {
        let ws;
        try {
          ws = new WebSocket('ws://127.0.0.1:' + port + '/');
        } catch (e) {
          reject(new Error('bridge socket failed: ' + ((e && e.message) || e)));
          return;
        }

        const handlers = { message: null, error: null };
        let ready = false;
        let optionsApplied = false;
        const timer = setTimeout(() => {
          if (!ready) {
            try { ws.close(); } catch (_) {}
            reject(new Error('bridge did not answer on port ' + port));
          }
        }, 3000);

        function sendObj(obj) {
          try {
            if (ws.readyState === 1) ws.send(JSON.stringify(obj));
          } catch (_) {}
        }

        const adapter = {
          engineId: spec.id,
          engineName: spec.name,
          transport: 'bridge',
          fellBackFrom: null,
          get onmessage() { return handlers.message; },
          set onmessage(fn) { handlers.message = fn; },
          get onerror() { return handlers.error; },
          set onerror(fn) { handlers.error = fn; },
          postMessage(line) { sendObj({ type: 'line', line: String(line) }); },
          start() {
            sendObj({ type: 'line', line: 'uci' });
            setTimeout(() => { if (!optionsApplied) sendObj({ type: 'line', line: 'uci' }); }, 1500);
          },
          terminate() {
            try { ws.close(); } catch (_) {}
          }
        };

        ws.onopen = () => {
          this.log('engine: bridge connected on ' + port + ', starting ' + bin);
          sendObj({
            type: 'start',
            engine: spec.id,
            bin: bin,
            args: spec.bridge.args || []
          });
        };

        ws.onmessage = (ev) => {
          let msg;
          try { msg = JSON.parse(ev.data); } catch (_) { msg = { type: 'line', line: String(ev.data) }; }
          if (!msg || !msg.type) return;

          if (msg.type === 'ready') {
            ready = true;
            clearTimeout(timer);
            resolve(adapter);
            return;
          }
          if (msg.type === 'line') {
            const line = String(msg.line == null ? '' : msg.line);
            if (line.indexOf('uciok') === 0 && !optionsApplied) {
              optionsApplied = true;
              const reg = registry();
              if (reg) {
                for (const optLine of reg.toUciOptions(spec.id, options)) {
                  sendObj({ type: 'line', line: optLine });
                }
              }
            }
            if (handlers.message) handlers.message({ data: line });
            return;
          }
          if (msg.type === 'error') {
            const err = new Error(msg.message || 'bridge error');
            this.log('engine: ' + spec.id + ' bridge error: ' + err.message);
            if (!ready) { clearTimeout(timer); try { ws.close(); } catch (_) {} reject(err); }
            else if (handlers.error) handlers.error(err);
          }
        };

        ws.onerror = () => {
          const err = new Error('bridge connection refused on port ' + port);
          if (!ready) { clearTimeout(timer); reject(err); }
          else if (handlers.error) handlers.error(err);
        };

        ws.onclose = () => {
          if (!ready) return; // rejected above
          if (handlers.error) handlers.error(new Error('bridge closed'));
        };
      });
    }
  }

  if (typeof window !== 'undefined') window.ChessAIEngineManager = EngineManager;
  if (typeof globalThis !== 'undefined') globalThis.ChessAIEngineManager = EngineManager;
})();
