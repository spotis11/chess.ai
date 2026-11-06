// engine.js - worker bootstrap for stockfish 19 lite single.
// the stockfish script auto-detects worker context and reads the wasm path
// from self.location.hash. we just importScripts it.

try {
  importScripts('stockfish.js');
  // signal wrapper ready (engine will post 'uciok' itself once initialized)
  self.postMessage('wrapper_ready');
} catch (e) {
  self.postMessage('engineerror ' + (e && e.message || e));
}
