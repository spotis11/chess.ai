// engines/registry.js - the engine roster for Chess AI Helper.
//
// one source of truth for the popup, the content script and the bridge.
// plain global, no modules: MV3 content scripts and popup.html both load it
// before their own code.
//
// transport:
//   'worker'  - engine runs in this tab from engines/<id>/ as a Web Worker.
//               needs a js loader + wasm (and weights for lc0 nets).
//   'bridge'  - engine runs as a native binary on 127.0.0.1 behind
//               bridge/uci-bridge.js (websocket UCI). used for engines with no
//               browser build at all (Komodo Dragon, Rodent IV, native lc0).
//   'audio'   - reserved.
//
// every engine speaks UCI. that is the whole contract: the manager sends
// "uci", waits for "uciok", applies options, then "position fen ..." +
// "go depth N". nothing else in the codebase needs to know which engine it is.
//
// binaries are NOT shipped in the zip. drop the builds into engines/<id>/
// (worker) or install them and start the bridge (native). the manager falls
// back to the bundled stockfish 19 lite when a binary is missing.

(() => {
  'use strict';

  const ENGINES = {
    // ------------------------------------------------------------------
    // MAIA 3 - the human-move network.
    // trained on millions of real lichess games to predict the move a player
    // of a given rating actually plays, blunders included. one forward pass,
    // no deep search tree, so the move distribution looks like a person's.
    // ships as an lc0-format net, so the engine process is lc0.
    // ------------------------------------------------------------------
    maia3: {
      id: 'maia3',
      name: 'Maia 3',
      role: 'stealth',
      blurb: 'Human-move network. Plays the move a 1500 plays, mistakes included.',
      accent: '#8b5cf6',
      transport: 'worker',
      engine: 'lc0',
      protocol: 'uci',
      requiresBridge: false,
      files: {
        js: 'engines/maia3/lc0.js',
        wasm: 'engines/maia3/lc0.wasm',
        weights: 'engines/maia3/maia3-79m.pb.gz'
      },
      bridge: {
        bin: 'lc0',
        args: ['--weights={weights}', '--backend=blas', '--threads={Threads}']
      },
      elo: { min: 600, max: 2600, default: 1500, step: 50 },
      maxMultiPV: 8,
      supportsNodeLimit: true,
      defaultOptions: {
        Threads: 1,
        MultiPV: 3,
        NNCacheSize: 200000,
        UCI_ShowWDL: true,
        Ponder: false
      },
      options: [
        { key: 'Threads', label: 'Threads', type: 'int', min: 1, max: 8 },
        { key: 'MultiPV', label: 'Lines', type: 'int', min: 1, max: 8 },
        { key: 'NNCacheSize', label: 'Net cache', type: 'int', min: 10000, max: 2000000, step: 10000 },
        { key: 'UCI_ShowWDL', label: 'Show WDL', type: 'bool' },
        { key: 'Ponder', label: 'Ponder', type: 'bool' }
      ]
    },

    // ------------------------------------------------------------------
    // STOCKFISH 18 - the wall.
    // SFNNv10 net, correction history, hundreds of millions of nodes/sec on a
    // desktop. max strength when looking natural is not the point.
    // browser build: single-threaded wasm (chess.com sends no COOP/COEP
    // headers, so SharedArrayBuffer multithreading is unavailable in-page).
    // ------------------------------------------------------------------
    stockfish18: {
      id: 'stockfish18',
      name: 'Stockfish 18',
      role: 'power',
      blurb: 'Maximum strength. SFNNv10, correction history, full depth search.',
      accent: '#22d3ee',
      transport: 'worker',
      engine: 'stockfish',
      protocol: 'uci',
      requiresBridge: false,
      files: {
        js: 'engines/stockfish18/stockfish.js',
        wasm: 'engines/stockfish18/stockfish.wasm'
      },
      bridge: {
        bin: 'stockfish',
        args: ['--threads={Threads}', '--hash={Hash}']
      },
      elo: { min: 1320, max: 3500, default: 3500, step: 10 },
      maxMultiPV: 256,
      supportsNodeLimit: true,
      defaultOptions: {
        Threads: 1,
        Hash: 128,
        MultiPV: 3,
        'Skill Level': 20,
        UCI_LimitStrength: false,
        UCI_Elo: 3500,
        'Move Overhead': 10,
        Ponder: false,
        UCI_ShowWDL: true
      },
      options: [
        { key: 'Threads', label: 'Threads', type: 'int', min: 1, max: 8 },
        { key: 'Hash', label: 'Hash (MB)', type: 'int', min: 16, max: 4096 },
        { key: 'MultiPV', label: 'Lines', type: 'int', min: 1, max: 256 },
        { key: 'Skill Level', label: 'Skill level', type: 'int', min: 0, max: 20 },
        { key: 'UCI_LimitStrength', label: 'Cap Elo', type: 'bool' },
        { key: 'UCI_Elo', label: 'Elo cap', type: 'int', min: 1320, max: 3500, step: 10 },
        { key: 'Move Overhead', label: 'Move overhead (ms)', type: 'int', min: 0, max: 5000 },
        { key: 'Ponder', label: 'Ponder', type: 'bool' },
        { key: 'UCI_ShowWDL', label: 'Show WDL', type: 'bool' }
      ]
    },

    // ------------------------------------------------------------------
    // KOMODO DRAGON - the other top tier.
    // NNUE, plus an MCTS mode that hunts the move that gives the opponent the
    // most chances to go wrong instead of the objectively best one.
    // no browser build exists. native binary behind the bridge.
    // ------------------------------------------------------------------
    komododragon: {
      id: 'komododragon',
      name: 'Komodo Dragon',
      role: 'power',
      blurb: 'NNUE monster with MCTS. Picks the move you are most likely to lose to.',
      accent: '#f97316',
      transport: 'bridge',
      engine: 'komodo',
      protocol: 'uci',
      requiresBridge: true,
      bridge: {
        bin: 'komodo',
        args: ['--threads={Threads}', '--hash={Hash}']
      },
      elo: { min: 1320, max: 3500, default: 3500, step: 10 },
      maxMultiPV: 64,
      supportsNodeLimit: true,
      defaultOptions: {
        Threads: 1,
        Hash: 256,
        MultiPV: 3,
        MCTS: false,
        MCTSExplore: 1.0,
        Contempt: 0,
        'Skill Level': 20,
        UCI_LimitStrength: false,
        UCI_Elo: 3500,
        Ponder: false
      },
      options: [
        { key: 'Threads', label: 'Threads', type: 'int', min: 1, max: 8 },
        { key: 'Hash', label: 'Hash (MB)', type: 'int', min: 16, max: 4096 },
        { key: 'MultiPV', label: 'Lines', type: 'int', min: 1, max: 64 },
        { key: 'MCTS', label: 'MCTS mode', type: 'bool' },
        { key: 'MCTSExplore', label: 'MCTS explore', type: 'float', min: 0.1, max: 10, step: 0.1 },
        { key: 'Contempt', label: 'Contempt', type: 'int', min: -100, max: 100 },
        { key: 'Skill Level', label: 'Skill level', type: 'int', min: 0, max: 20 },
        { key: 'UCI_LimitStrength', label: 'Cap Elo', type: 'bool' },
        { key: 'UCI_Elo', label: 'Elo cap', type: 'int', min: 1320, max: 3500, step: 10 },
        { key: 'Ponder', label: 'Ponder', type: 'bool' }
      ]
    },

    // ------------------------------------------------------------------
    // RODENT IV - the personality engine.
    // strength is decoupled from style: pick an Elo, then dial 100+ weights
    // until the move distribution is nobody else's.
    // native binary behind the bridge.
    // ------------------------------------------------------------------
    rodent4: {
      id: 'rodent4',
      name: 'Rodent IV',
      role: 'custom',
      blurb: 'Personality engine. Decouple Elo from style and tune every weight.',
      accent: '#facc15',
      transport: 'bridge',
      engine: 'rodent',
      protocol: 'uci',
      requiresBridge: true,
      bridge: {
        bin: 'rodent',
        args: ['--personality={Personality}']
      },
      elo: { min: 600, max: 3500, default: 1600, step: 25 },
      maxMultiPV: 32,
      supportsNodeLimit: true,
      defaultOptions: {
        Threads: 1,
        Hash: 128,
        MultiPV: 3,
        Personality: 'default',
        UCI_LimitStrength: true,
        UCI_Elo: 1600,
        Contempt: 0,
        Ponder: false
      },
      options: [
        { key: 'Threads', label: 'Threads', type: 'int', min: 1, max: 8 },
        { key: 'Hash', label: 'Hash (MB)', type: 'int', min: 16, max: 4096 },
        { key: 'MultiPV', label: 'Lines', type: 'int', min: 1, max: 32 },
        { key: 'Personality', label: 'Personality', type: 'select',
          choices: ['default', 'aggressive', 'positional', 'sacrificer', 'solid', 'chaotic'] },
        { key: 'UCI_LimitStrength', label: 'Cap Elo', type: 'bool' },
        { key: 'UCI_Elo', label: 'Elo cap', type: 'int', min: 600, max: 3500, step: 25 },
        { key: 'Contempt', label: 'Contempt', type: 'int', min: -100, max: 100 },
        { key: 'Ponder', label: 'Ponder', type: 'bool' }
      ]
    },

    // ------------------------------------------------------------------
    // STOCKFISH 19 LITE - the bundled fallback.
    // already in the zip, no download, always available. this is what the
    // manager boots when a selected engine has no binary on disk yet.
    // ------------------------------------------------------------------
    stockfish19lite: {
      id: 'stockfish19lite',
      name: 'Stockfish 19 Lite',
      role: 'bundled',
      blurb: 'Bundled fallback. Small wasm, instant boot, always present.',
      accent: '#94a3b8',
      transport: 'worker',
      engine: 'stockfish',
      protocol: 'uci',
      requiresBridge: false,
      files: {
        js: 'stockfish.js',
        wasm: 'stockfish.wasm'
      },
      bridge: {
        bin: 'stockfish',
        args: []
      },
      elo: { min: 1320, max: 3190, default: 3190, step: 10 },
      maxMultiPV: 256,
      supportsNodeLimit: true,
      defaultOptions: {
        Threads: 1,
        Hash: 16,
        MultiPV: 3,
        'Skill Level': 20,
        UCI_LimitStrength: false,
        UCI_Elo: 3190,
        'Move Overhead': 10,
        Ponder: false
      },
      options: [
        { key: 'Threads', label: 'Threads', type: 'int', min: 1, max: 1 },
        { key: 'Hash', label: 'Hash (MB)', type: 'int', min: 16, max: 1024 },
        { key: 'MultiPV', label: 'Lines', type: 'int', min: 1, max: 256 },
        { key: 'Skill Level', label: 'Skill level', type: 'int', min: 0, max: 20 },
        { key: 'UCI_LimitStrength', label: 'Cap Elo', type: 'bool' },
        { key: 'UCI_Elo', label: 'Elo cap', type: 'int', min: 1320, max: 3190, step: 10 }
      ]
    }
  };

  // display order: stealth first, power next, custom, bundled last.
  const ORDER = ['maia3', 'stockfish18', 'komododragon', 'rodent4', 'stockfish19lite'];

  // boot target. the bundled engine always exists, so nothing breaks on a
  // fresh install. the popup writes the user's pick into storage.
  const DEFAULT_ENGINE = 'stockfish19lite';

  const STORAGE_KEY = 'engineId';
  const OPTIONS_KEY = 'engineOptions'; // { [engineId]: { [uciOption]: value } }

  function list() {
    return ORDER.map(id => ENGINES[id]).filter(Boolean);
  }

  function get(id) {
    return ENGINES[id] || ENGINES[DEFAULT_ENGINE];
  }

  function defaultOptionsFor(id) {
    const e = get(id);
    return Object.assign({}, e.defaultOptions);
  }

  // merge saved options over defaults, drop keys the engine does not declare,
  // and clamp every numeric to its declared range. a saved value from a build
  // with different limits must never reach a "setoption" line raw.
  function resolveOptions(id, saved) {
    const e = get(id);
    const out = Object.assign({}, e.defaultOptions);
    if (!saved || typeof saved !== 'object') return out;
    const byKey = {};
    for (const o of e.options) byKey[o.key] = o;
    for (const key of Object.keys(saved)) {
      const spec = byKey[key];
      if (!spec) continue;
      let v = saved[key];
      if (spec.type === 'int' || spec.type === 'float') {
        const n = Number(v);
        if (!isFinite(n)) continue;
        const min = spec.min !== undefined ? spec.min : -Infinity;
        const max = spec.max !== undefined ? spec.max : Infinity;
        v = Math.min(max, Math.max(min, n));
        if (spec.type === 'int') v = Math.round(v);
      } else if (spec.type === 'bool') {
        v = !!v;
      } else if (spec.type === 'select') {
        if (spec.choices.indexOf(v) === -1) continue;
      }
      out[key] = v;
    }
    return out;
  }

  // "option name Threads type spin default 1 min 1 max 1" is UCI's own shape.
  // emit exactly that so any UCI engine can consume the registry.
  function toUciOptions(id, options) {
    const e = get(id);
    const byKey = {};
    for (const o of e.options) byKey[o.key] = o;
    const lines = [];
    for (const key of Object.keys(options || {})) {
      const spec = byKey[key];
      if (!spec) continue;
      const v = options[key];
      if (spec.type === 'bool') {
        lines.push('setoption name ' + key + ' value ' + (v ? 'true' : 'false'));
      } else if (spec.type === 'int' || spec.type === 'float' || spec.type === 'select' || spec.type === 'text') {
        lines.push('setoption name ' + key + ' value ' + v);
      }
    }
    return lines;
  }

  // human-readable strength line for the popup / status pill.
  function strengthLabel(id, options) {
    const e = get(id);
    const o = options || e.defaultOptions;
    if (o.UCI_LimitStrength && o.UCI_Elo) return 'Elo cap ' + o.UCI_Elo;
    if (id === 'maia3') return 'Human net @ ' + (e.elo.default || 1500);
    return 'Max (' + e.elo.max + ')';
  }

  const api = {
    ENGINES,
    ORDER,
    DEFAULT_ENGINE,
    STORAGE_KEY,
    OPTIONS_KEY,
    list,
    get,
    defaultOptionsFor,
    resolveOptions,
    toUciOptions,
    strengthLabel
  };

  if (typeof window !== 'undefined') window.ChessAIEngines = api;
  if (typeof globalThis !== 'undefined') globalThis.ChessAIEngines = api;
})();
