// content.js - chess.com board assist, v4.0.0
// rebuilt against real chess.com DOM (researched from jameslinimk/chess-com-cheater,
// ferdianhafid/chesscheat-pro, psyyke/A.C.A.S).
//
// engine: stockfish 19 lite single-threaded (no COOP/COEP needed, chess.com doesn't
// send those headers so multi-thread is impossible).
// openings: lichess cloud-eval API (instant 40+ depth in book lines).
// strength: UCI Skill Level + UCI_Elo cap so moves look human.
// multiPV: top 3 moves drawn with opacity by relative quality.
// autoplay: programmatic board API (board.move / __chessboard__ / React fiber)
//           probed first, falling back to a MAIN-world PointerEvent sequence
//           dispatched via chrome.scripting.executeScript. no chrome.debugger,
//           no CDP, no yellow banner, no debugger permission.
//
// v4.0.0 fixes:
//  - turn detection rebuilt. the .node parity count lies on the new React board
//    (variation nodes get counted, opponent rows mismatch). primary signal is
//    now the running clock (clock-player-turn on clock-bottom/clock-top), with
//    ply parity demoted to fallback. this was the autoplay line-killer.
//  - en passant square is now written into the FEN (was always '-'). an engine
//    that cannot see an ep capture misreads the position and can return an
//    illegal move, which then fails every injector tier.
//  - engine stop-drain is real now: when a search is running we poll for the
//    stale bestmove instead of firing blind after 50ms ("did not respond to
//    stop, forcing new search" is gone).
//  - opponent-turn analysis is movetime-capped at 4000ms. previously the depth
//    22 search ran 10-20+ seconds, the opponent moved, the result was discarded,
//    and the CPU fought itself.
//  - autoplayMinDelay / autoplayMaxDelay are wired in (they existed in the
//    popup and did nothing).
//  - deep-think spikes: 6% of moves take 6-15s like a real player going into
//    the tank on a complex position.
//
// v4.0.4 fixes (autoplay moved a piece but the site kept the turn):
//  - a move is no longer credited on "the from-square is empty". chess.com's
//    board.game.move()/makeMove()/__chessboard__ paths mutate the LOCAL game
//    model: the piece slides on screen, the server never sees it, and the site
//    still shows your turn. every api path now reads the site's own receipt
//    back (the mover's clock must stop). a local-only move is undone and the
//    injector falls through to a real pointer drag, which the site processes.
//  - the move must also LAND: from-square empty AND destination occupied, polled
//    for 500ms so an in-flight animation is not mistaken for a rejected move.
//  - one autoplay move per settled position (signature latch, 20s expiry).
//    a rejected move that still slid a piece used to read as "our turn again"
//    and fire a second time for the same ply.
//  - auto side is read from the page (bottom/top player vs signed-in username)
//    before falling back to the flip flag, so a manually flipped board no longer
//    makes autoplay play the opponent's moves.
//  - scheduling is vetoed when the site clock disagrees with the inferred turn.
//
// v4.0.3 fixes (autoplay stalled after the first move):
//  - turn is now inferred from the board delta: the side that was to move is
//    the side that moved, so the next turn is the other side. one ply, one
//    flip, no clock, no parity, no move-list lag. this is the primary signal.
//  - the justPlayed marker is one-shot and expires. it used to stay live for
//    as long as the moved piece sat on its destination square, which forced
//    "turn = opponent" forever and stopped autoplay on the next turn.
//  - last-move highlight now outranks the clock (the clock classes leak a
//    stale side in bot games; the repeated turn-truth log lines were it).
//  - autoplay execution is single-flight, the scheduled position signature is
//    checked at fire time, and a miss retries twice with backoff. the next
//    settled pass owns the post-move position, so it cannot double-fire.

const BOARD_ASSIST_VERSION = '4.0.4';
console.log('%c[Chess AI Helper] v' + BOARD_ASSIST_VERSION + ' LOADED', 'background:linear-gradient(135deg,#0f2027,#203a43,#2c5364);color:#00f5d4;font-weight:bold;padding:3px 8px;border-radius:4px;font-size:13px;');

(() => {
  const STATE = {
    enabled: true,
    depth: 22,               // MAX depth for analysis - smartest possible
    multiPV: 3,
    skillLevel: 20,          // 0-20, 20 = max strength (always)
    useEloLimit: false,
    elo: 1500,
    useCloudEval: true,
    showArrow: true,
    showEval: true,
    showPrediction: true,    // show opponent's predicted next move
    arrowsOnlyMyTurn: true,
    autoplay: false,
    autoplayMinDelay: 0,     // INSTANT - 0ms
    autoplayMaxDelay: 0,     // INSTANT - 0ms
    autoplaySide: 'auto',
    autoplayDepth: 8,        // fast depth for instant autoplay moves
    engine: null,
    engineReady: false,
    thinking: false,
    lastFen: null,
    panel: null,
    pendingAutoMove: null,
    autoInFlight: false,       // one execution at a time
    boardSignature: null,      // 64-cell piece map of the last settled position
    knownTurn: null,           // verified side to move for boardSignature
    lastKnownTurn: null,     // last turn detection that survived verification
    justPlayed: null,        // {from,to,char,moverSide,at} of our last landed move
    autoDoneSig: null,       // position autoplay already fired on - one shot per ply
    autoDoneAt: 0,           // when that one shot was taken (latch expiry)
    forceDrag: false,        // api path moved the piece locally, site never took it
    tryApiFirst: false,      // real pointer input is the default; api only if opted in
    debug: true
  };

  const FILES = 'abcdefgh';
  const log = (...a) => { if (STATE.debug) console.log('[board-assist]', ...a); };

  // ============================================================
  // board reading
  // ============================================================
  function getBoardEl() {
    return document.querySelector('wc-chess-board')
        || document.querySelector('chess-board')
        || document.querySelector('.board-board');
  }

  function isFlipped(boardEl) {
    if (!boardEl) return false;
    if (boardEl.classList && boardEl.classList.contains('flipped')) return true;
    const o = boardEl.getAttribute && boardEl.getAttribute('orientation');
    return o === 'black';
  }

  function readPieces(boardEl) {
    const out = [];
    const els = boardEl.querySelectorAll('.piece');
    const rect = boardEl.getBoundingClientRect();
    const sq = Math.min(rect.width, rect.height) / 8;
    const flipped = isFlipped(boardEl);
    els.forEach(el => {
      const cls = el.className || '';
      // chess.com: class="piece wp square-11" or "piece bn square-67"
      const sm = cls.match(/square-(\d)(\d)/);
      let coord = null;
      if (sm) {
        coord = { file: parseInt(sm[1]) - 1, rank: parseInt(sm[2]) - 1 };
      } else {
        // fallback: parse transform: translate(Xpx, Ypx)
        const style = el.getAttribute('style') || '';
        const tm = /translate\(\s*([\d.-]+)px\s*,\s*([\d.-]+)px\s*\)/.exec(style)
                || /translate3d\(\s*([\d.-]+)px\s*,\s*([\d.-]+)px/.exec(style);
        if (tm && sq > 0) {
          const x = parseFloat(tm[1]), y = parseFloat(tm[2]);
          let file, rank;
          if (!flipped) { file = Math.round(x / sq); rank = 7 - Math.round(y / sq); }
          else { file = 7 - Math.round(x / sq); rank = Math.round(y / sq); }
          coord = { file, rank };
        }
      }
      if (!coord) return;
      const ch = pieceChar(el, cls);
      if (!ch) return;
      if (coord.file < 0 || coord.file > 7 || coord.rank < 0 || coord.rank > 7) return;
      out.push({ file: coord.file, rank: coord.rank, char: ch });
    });
    return out;
  }

  function pieceChar(el, cls) {
    // chess.com uses classes like "wp", "bn", "bq", "wk"
    const m = cls.match(/\b([wb])([pnbrqk])\b/);
    if (m) {
      const c = m[2];
      return m[1] === 'w' ? c.toUpperCase() : c.toLowerCase();
    }
    // fallback: piece-type / piece-color attrs (older chess.com)
    const type = (el.getAttribute && (el.getAttribute('piece-type') || el.getAttribute('data-piece'))) || '';
    const color = (el.getAttribute && (el.getAttribute('piece-color') || el.getAttribute('data-color'))) || '';
    if (type && color) {
      const map = {p:'p',n:'n',b:'b',r:'r',q:'q',k:'k'};
      const t = map[(type||'').toLowerCase()[0]];
      if (!t) return null;
      return color.toLowerCase().startsWith('w') ? t.toUpperCase() : t.toLowerCase();
    }
    return null;
  }

  function boardToFEN(pieces, turn, epSquare) {
    const grid = Array.from({length: 8}, () => Array(8).fill(null));
    for (const p of pieces) {
      if (p.file >= 0 && p.file < 8 && p.rank >= 0 && p.rank < 8) grid[7 - p.rank][p.file] = p.char;
    }
    let fen = '';
    for (let r = 0; r < 8; r++) {
      let empty = 0;
      for (let f = 0; f < 8; f++) {
        if (!grid[r][f]) { empty++; continue; }
        if (empty) { fen += empty; empty = 0; }
        fen += grid[r][f];
      }
      if (empty) fen += empty;
      if (r < 7) fen += '/';
    }
    let castle = '';
    const find = (ch, f, r) => pieces.some(p => p.char === ch && p.file === f && p.rank === r);
    if (find('K', 4, 0) && find('R', 7, 0)) castle += 'K';
    if (find('K', 4, 0) && find('R', 0, 0)) castle += 'Q';
    if (find('k', 4, 7) && find('r', 7, 7)) castle += 'k';
    if (find('k', 4, 7) && find('r', 0, 7)) castle += 'q';
    if (!castle) castle = '-';
    return `${fen} ${turn} ${castle} ${epSquare || '-'} 0 1`;
  }

  // en passant square for the FEN. detectable from chess.com's last-move
  // highlight pair: the opponent just double-pushed a pawn iff one highlighted
  // square is empty and the other holds a pawn, same file, two ranks apart,
  // pawn color opposite to the side now to move.
  function detectEpSquare(pieces, turn, boardEl) {
    if (!boardEl) return null;
    const squares = boardEl.querySelectorAll('.highlight, .last-move-highlight, [class*="last-move"]');
    if (!squares || squares.length < 2) return null;
    const parsed = [];
    for (const sq of squares) {
      const m = (sq.className || '').match(/square-(\d)(\d)/);
      if (!m) parsed.push(null);
      else {
        const file = parseInt(m[1]) - 1;
        const rank = parseInt(m[2]) - 1;
        parsed.push({ file, rank, piece: pieces.find(p => p.file === file && p.rank === rank) || null });
      }
    }
    const [from, to] = parsed;
    if (!from || !to || !to.piece || from.piece) return null;
    if (from.file !== to.file || Math.abs(to.rank - from.rank) !== 2) return null;
    const isPawn = to.piece.char.toLowerCase() === 'p';
    if (!isPawn) return null;
    // the double-push must have been by the side NOT to move
    const moverIsWhite = to.piece.char === to.piece.char.toUpperCase();
    if (moverIsWhite && turn !== 'b') return null;
    if (!moverIsWhite && turn !== 'w') return null;
    const epRank = (from.rank + to.rank) / 2; // 0-based behind the pawn
    return FILES[from.file] + (epRank + 1);
  }

  function detectTurn(flipped, pieces, boardEl) {
    // PRIMARY: the running clock. chess.com marks the clock of the side to move
    // with clock-player-turn. the bottom clock belongs to the player we play as
    // (bottom = me). this survives SPA staleness, variation nodes, everything a
    // raw .node count chokes on.
    const bottomClock = document.querySelector('.clock-bottom')
                     || document.querySelector('.player-bottom clock')
                     || document.querySelector('clock-component.clock-bottom');
    const topClock = document.querySelector('.clock-top')
                  || document.querySelector('.player-top clock')
                  || document.querySelector('clock-component.clock-top');
    let clockTurn = null;
    if (bottomClock && topClock) {
      const bActive = bottomClock.classList.contains('clock-player-turn');
      const tActive = topClock.classList.contains('clock-player-turn');
      if (bActive && !tActive) clockTurn = flipped ? 'b' : 'w';
      else if (tActive && !bActive) clockTurn = flipped ? 'w' : 'b';
      // both flagged = class leak (clock class lingers a beat after a move) or
      // neither has the class — no signal either way, fall through.
    }

    // SECONDARY: the board itself. chess.com paints two last-move highlights:
    // an empty from-square and a to-square holding the piece that moved. the
    // mover is that piece's color; the side to move is the other one. this
    // shows even in bot/computer games where clocks and move-list parity lie,
    // and it is why the v3 logs saw 'w' right after our own move (parity was
    // counting a not-yet-rendered move list).
    let highlightTurn = null;
    if (boardEl && pieces) {
      const squares = boardEl.querySelectorAll('.highlight, .last-move-highlight, [class*="last-move"]');
      if (squares && squares.length >= 2) {
        let fromSq = null, toSq = null;
        for (const sq of squares) {
          const m = (sq.className || '').match(/square-(\d)(\d)/);
          if (!m) continue;
          const file = parseInt(m[1]) - 1, rank = parseInt(m[2]) - 1;
          const piece = pieces.find(p => p.file === file && p.rank === rank);
          if (!piece && !fromSq) fromSq = { file, rank };
          else if (piece && !toSq) toSq = piece;
        }
        if (fromSq && toSq) {
          const moverIsWhite = toSq.char === toSq.char.toUpperCase();
          highlightTurn = moverIsWhite ? 'b' : 'w';
        }
      }
    }

    // TERTIARY: ply parity from the move list main line. each visible .node is
    // one ply. even count = white to move. can be stale for a beat right after
    // a move lands, which is exactly when it must not be trusted.
    let pliesByMoveList = null;
    const sels = [
      'wc-vertical-move-list .node',
      '.move-list-wrapper-component .node',
      '.main-line-container .node',
      '.main-line-row .node',
      '.vertical-move-list .node',
      '.move-list .node'
    ];
    for (const s of sels) {
      const nodes = document.querySelectorAll(s);
      if (nodes.length) {
        pliesByMoveList = nodes.length;
        break;
      }
    }
    const parityTurn = (pliesByMoveList === null) ? null
                     : ((pliesByMoveList % 2 === 0) ? 'w' : 'b');

    // consensus: board highlights (live DOM, no SPA lag) > clock (classes can
    // leak a stale side for many seconds in bot games) > ply parity
    // (stale-prone) > remembered turn > start position.
    if (highlightTurn) return highlightTurn;
    if (clockTurn) return clockTurn;
    if (parityTurn) return parityTurn;
    if (STATE.lastKnownTurn) return STATE.lastKnownTurn;
    // absolute fallback
    return 'w';
  }

  // ---- board state tracking ------------------------------------------------
  // a 64-cell map of the current pieces, index = (7 - rank) * 8 + file, so it
  // compares row-major exactly like the FEN body. two snapshots that differ
  // somewhere mean exactly one move was made between them.
  function piecesSignature(pieces) {
    const sig = new Array(64).fill(null);
    for (const p of pieces) {
      if (p.file >= 0 && p.file < 8 && p.rank >= 0 && p.rank < 8) {
        sig[(7 - p.rank) * 8 + p.file] = p.char;
      }
    }
    return sig;
  }

  function signatureDiff(a, b) {
    let n = 0;
    for (let i = 0; i < 64; i++) if (a[i] !== b[i]) n++;
    return n;
  }

  function sigKey(sig) {
    return sig.join(',');
  }

  function isStartPosition(pieces) {
    if (!pieces || pieces.length !== 32) return false;
    return boardToFEN(pieces, 'w', '-').split(' ')[0]
      === 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';
  }

  function syncBoardState(pieces, turn) {
    STATE.boardSignature = piecesSignature(pieces);
    STATE.knownTurn = turn;
    STATE.lastKnownTurn = turn;
  }

  // the real turn arbiter. chess alternates: the side that was to move is the
  // side that moved, so any settled board change flips the turn exactly once.
  // a legal move touches 2-4 cells (quiet, capture, en passant, castling,
  // promotion). more than that is a new game / board reload, so the DOM
  // heuristic takes over there.
  function inferTurn(pieces, heuristic) {
    const sig = piecesSignature(pieces);
    const prev = STATE.boardSignature;
    const diff = prev ? signatureDiff(prev, sig) : -1;
    if (diff === 0) return STATE.knownTurn || heuristic;
    if (diff > 0 && diff <= 4 && STATE.knownTurn) {
      const next = STATE.knownTurn === 'w' ? 'b' : 'w';
      STATE.boardSignature = sig;
      STATE.knownTurn = next;
      STATE.lastKnownTurn = next;
      return next;
    }
    if (isStartPosition(pieces)) {
      syncBoardState(pieces, 'w');
      return 'w';
    }
    STATE.boardSignature = sig;
    STATE.knownTurn = heuristic;
    STATE.lastKnownTurn = heuristic;
    return heuristic;
  }

  // TURN TRUTH: one-shot correction for the move autoplay just played. if the
  // piece is on its destination and the inferred turn still points at the
  // mover, flip once. the marker is then retired — it must never outlive the
  // single ply it describes, or every later turn gets overridden too.
  function reconcileJustPlayed(pieces, turn) {
    const jp = STATE.justPlayed;
    if (!jp) return turn;
    if (Date.now() - (jp.at || 0) > 6000) { STATE.justPlayed = null; return turn; }
    const fromFile = FILES.indexOf(jp.from[0]);
    const fromRank = parseInt(jp.from[1]) - 1;
    const toFile = FILES.indexOf(jp.to[0]);
    const toRank = parseInt(jp.to[1]) - 1;
    const stillOnFrom = pieces.some(p => p.file === fromFile && p.rank === fromRank && p.char === jp.char);
    const landedOnTo = pieces.some(p => p.file === toFile && p.rank === toRank && p.char === jp.char);
    if (landedOnTo && !stillOnFrom && turn === jp.moverSide) {
      log('turn-truth: our', jp.from, jp.to, 'landed, turn', turn, '->', (jp.moverSide === 'w' ? 'b' : 'w'));
      STATE.justPlayed = null;
      const next = jp.moverSide === 'w' ? 'b' : 'w';
      STATE.knownTurn = next;
      STATE.lastKnownTurn = next;
      return next;
    }
    STATE.justPlayed = null;
    return turn;
  }

  // one read for every caller: delta first, heuristic only when there is no
  // snapshot yet, one-shot marker correction last.
  function resolveTurn(pieces, flipped, boardEl) {
    const heuristic = detectTurn(flipped, pieces, boardEl);
    return reconcileJustPlayed(pieces, inferTurn(pieces, heuristic));
  }

  // ============================================================
  // site truth - what chess.com itself says, not what we infer
  // ============================================================
  // the delta arbiter can be off by one ply for a single settle window, and
  // the flip heuristic guesses the player's colour from board orientation.
  // both are fine for arrows and fatal for autoplay: a wrong turn means the
  // engine hands back a move for the side that is NOT on the clock, the
  // injector slides the piece anyway, and the site never accepts it.
  // these read the site's own receipts instead.

  function clockSideRaw() {
    const bottomClock = document.querySelector('.clock-bottom')
                     || document.querySelector('.player-bottom clock')
                     || document.querySelector('clock-component.clock-bottom');
    const topClock = document.querySelector('.clock-top')
                  || document.querySelector('.player-top clock')
                  || document.querySelector('clock-component.clock-top');
    if (!bottomClock || !topClock) return null;
    const b = bottomClock.classList.contains('clock-player-turn');
    const t = topClock.classList.contains('clock-player-turn');
    if (b && !t) return 'bottom';
    if (t && !b) return 'top';
    return null;
  }

  // side to move according to the clock, or null when the page gives no
  // clean signal (both classes, neither, analysis board, puzzle, clipped UI).
  function siteTurnFromClock(flipped) {
    const side = clockSideRaw();
    if (!side) return null;
    return side === 'bottom' ? (flipped ? 'b' : 'w') : (flipped ? 'w' : 'b');
  }

  function moveListPlies() {
    const sels = [
      'wc-vertical-move-list .node',
      '.move-list-wrapper-component .node',
      '.main-line-container .node',
      '.main-line-row .node',
      '.vertical-move-list .node',
      '.move-list .node'
    ];
    for (const s of sels) {
      const n = document.querySelectorAll(s).length;
      if (n) return n;
    }
    return null;
  }

  // the two squares chess.com paints for the last move, normalised so the pair
  // compares order-independently ("a2e4" === "e4a2").
  function lastMoveHighlightKey(boardEl) {
    if (!boardEl) return null;
    const squares = boardEl.querySelectorAll('.highlight, .last-move-highlight, [class*="last-move"]');
    if (!squares || squares.length < 2) return null;
    const names = [];
    for (const sq of squares) {
      const m = (sq.className || '').match(/square-(\d)(\d)/);
      if (m) names.push(FILES[parseInt(m[1]) - 1] + m[2]);
    }
    return names.length >= 2 ? names.sort().join('') : null;
  }

  // which colour is the user? bottom player if the username matches the
  // signed-in account, else top. null when the header/name pair cannot be
  // resolved (logged out, bot game without a name node, etc.).
  function detectUserSide(flipped) {
    try {
      const meEl = document.querySelector('.user-username')
                || document.querySelector('.profile-username')
                || document.querySelector('a.user-username');
      const bottomEl = document.querySelector(
        '.player-bottom .player-username, .player-bottom .user-username, ' +
        '.player-bottom .username, .clock-bottom .username, ' +
        '.board-player-default--bottom .username'
      );
      const topEl = document.querySelector(
        '.player-top .player-username, .player-top .user-username, ' +
        '.player-top .username, .clock-top .username, ' +
        '.board-player-default--top .username'
      );
      const mine = (meEl && meEl.textContent || '').trim().toLowerCase();
      const bottom = (bottomEl && bottomEl.textContent || '').trim().toLowerCase();
      const top = (topEl && topEl.textContent || '').trim().toLowerCase();
      if (!mine) return null;
      if (bottom && bottom === mine) return flipped ? 'b' : 'w';
      if (top && top === mine) return flipped ? 'w' : 'b';
    } catch (_) {}
    return null;
  }

  // verify a move is legal for the side to move, given the pieces on the board.
  // this catches the case where detectTurn() returns the wrong side and the engine
  // returns a move for the opposite color.
  function verifyMoveForSide(move, pieces, turn) {
    if (!move || move.length < 4) return false;
    const fromAlg = move.slice(0, 2);
    const fromFile = FILES.indexOf(fromAlg[0]);
    const fromRank = parseInt(fromAlg[1]) - 1;
    const piece = pieces.find(p => p.file === fromFile && p.rank === fromRank);
    if (!piece) return false;
    if (turn === 'w' && piece.char !== piece.char.toUpperCase()) return false; // white move but piece is black
    if (turn === 'b' && piece.char !== piece.char.toLowerCase()) return false; // black move but piece is white
    return true;
  }

  // ============================================================
  // lichess cloud-eval (opening book, instant)
  // ============================================================
  async function cloudEval(fen) {
    try {
      const url = 'https://lichess.org/api/cloud-eval?fen=' + encodeURIComponent(fen);
      const r = await fetch(url);
      if (!r.ok) return null;
      const d = await r.json();
      if (!d || !d.pvs || !d.pvs.length) return null;
      return d;
    } catch (e) { return null; }
  }

  // ============================================================
  // engine
  // ============================================================
  // MV3 content scripts can't spawn a Worker from a chrome-extension:// URL
  // (SecurityError). Workaround: fetch engine + wasm as Blobs, create the
  // worker from blob: URLs which are same-origin to the page. The wasm
  // blob URL is passed to stockfish via the worker script URL hash.
  async function loadEngine(cb) {
    if (STATE.engine) return cb(STATE.engine);
    try {
      log('fetching engine + wasm as blobs');
      const [jsText, wasmBuf] = await Promise.all([
        fetch(chrome.runtime.getURL('stockfish.js')).then(r => r.text()),
        fetch(chrome.runtime.getURL('stockfish.wasm')).then(r => r.arrayBuffer())
      ]);
      const wasmBlob = new Blob([wasmBuf], { type: 'application/wasm' });
      const wasmUrl = URL.createObjectURL(wasmBlob);
      // stockfish.js worker bootstrap reads self.location.hash.substr(1)
      // and uses it as the wasm fetch URL. encode so commas/colons don't break parsing.
      const jsBlob = new Blob([jsText], { type: 'application/javascript' });
      const jsUrl = URL.createObjectURL(jsBlob) + '#' + encodeURIComponent(wasmUrl);
      log('starting blob worker', jsUrl.split('#')[0], 'wasm', wasmUrl);
      const w = new Worker(jsUrl);
      STATE.engine = w;
      STATE._blobUrls = STATE._blobUrls || [];
      STATE._blobUrls.push(jsUrl, wasmUrl);
      w.onmessage = (e) => {
        const line = (typeof e.data === 'string') ? e.data : (e.data && e.data.data) || '';
        handleEngineLine(line);
      };
      w.onerror = (err) => {
        log('worker error', err && err.message || err);
        setStatus('engine err', '#ff5555');
      };
      STATE._readyCb = cb;
      setTimeout(() => { try { w.postMessage('uci'); } catch(_){} }, 300);
      setTimeout(() => {
        if (!STATE.engineReady) {
          log('engine timeout, retrying uci');
          try { w.postMessage('uci'); } catch(_){}
        }
      }, 2000);
    } catch (e) {
      log('worker create failed', e);
      setStatus('no engine', '#ff5555');
    }
  }

  let bestMoveResolve = null;
  let pvAccum = [];          // collected PV lines from current search
  let lastInfo = null;
  let currentSearchId = 0;   // increments on every search; discard stale bestmoves
  let activeSearchFen = null; // the FEN the current search is for
  let isThinking = false;     // is the engine currently searching?
  let liveUpdateCallback = null; // called with PV info as it arrives (for instant arrows)

  function handleEngineLine(line) {
    if (!line) return;
    log('engine:', line);
    if (line === 'wrapper_ready') return;
    if (line.startsWith('uciok')) {
      STATE.engineReady = true;
      applyStrengthOptions();
      setStatus('ready', '#6cf36c');
      if (STATE._readyCb) { STATE._readyCb(STATE.engine); STATE._readyCb = null; }
      return;
    }
    if (line.startsWith('info ') && line.includes(' pv ')) {
      const dm = /depth (\d+)/.exec(line);
      const sm = /score cp (-?\d+)/.exec(line);
      const mm = /score mate (-?\d+)/.exec(line);
      const pvM = / pv (.+)$/.exec(line);
      const mpvM = / multipv (\d+)/.exec(line);
      if (dm || sm || mm) {
        lastInfo = lastInfo || {};
        if (dm) lastInfo.depth = +dm[1];
        if (sm) lastInfo.cp = +sm[1];
        if (mm) lastInfo.mate = +mm[1];
        if (pvM) {
          const idx = mpvM ? +mpvM[1] - 1 : 0;
          pvAccum[idx] = {
            moves: pvM[1].trim().split(/\s+/),
            cp: sm ? +sm[1] : null,
            mate: mm ? +mm[1] : null,
            depth: dm ? +dm[1] : null
          };
          if (idx === 0 && STATE.showEval) {
            let ev = '--';
            if (lastInfo.mate !== undefined) ev = `M${lastInfo.mate}`;
            else if (lastInfo.cp !== undefined) {
              const p = (lastInfo.cp / 100).toFixed(2);
              ev = (lastInfo.cp > 0 ? '+' : '') + p;
            }
            setField('eval', ev);
            setField('depth', lastInfo.depth || '--');
          }
          // LIVE UPDATE: call the callback with current PVs so arrows can render
          // instantly as info arrives (sub-100ms), not waiting for bestmove.
          if (liveUpdateCallback && idx === 0) {
            liveUpdateCallback({
              pvs: pvAccum.slice(),
              depth: dm ? +dm[1] : null,
              cp: sm ? +sm[1] : null,
              mate: mm ? +mm[1] : null
            });
          }
        }
      }
      return;
    }
    if (line.startsWith('bestmove ')) {
      const m = /bestmove (\w+)/.exec(line);
      const move = m ? m[1] : null;
      isThinking = false;
      setStatus('idle', '#6cf36c');
      const mySearchId = currentSearchId;
      const fenForThisSearch = activeSearchFen;
      if (bestMoveResolve && mySearchId === currentSearchId) {
        log('bestmove accepted for search', mySearchId, 'fen', fenForThisSearch, 'move', move);
        bestMoveResolve({ best: move, pvs: pvAccum.slice(), searchFen: fenForThisSearch });
        bestMoveResolve = null;
      } else {
        log('STALE bestmove discarded: move', move, 'searchId', mySearchId, 'current', currentSearchId);
      }
      pvAccum = [];
      liveUpdateCallback = null;
    }
  }

  function applyStrengthOptions() {
    const e = STATE.engine; if (!e || !STATE.engineReady) return;
    e.postMessage('setoption name Skill Level value ' + STATE.skillLevel);
    if (STATE.useEloLimit) {
      e.postMessage('setoption name UCI_LimitStrength value true');
      e.postMessage('setoption name UCI_Elo value ' + STATE.elo);
    } else {
      e.postMessage('setoption name UCI_LimitStrength value false');
    }
    e.postMessage('setoption name MultiPV value ' + STATE.multiPV);
  }

  function think(fen) {
    return new Promise((resolve) => {
      if (!STATE.engine || !STATE.engineReady) return resolve(null);
      bestMoveResolve = resolve;
      STATE.thinking = true;
      pvAccum = [];
      setStatus('thinking', '#ffd166');
      applyStrengthOptions();
      STATE.engine.postMessage('stop');
      STATE.engine.postMessage('position fen ' + fen);
      STATE.engine.postMessage('go depth ' + STATE.depth);
    });
  }

  // ============================================================
  // overlay
  // ============================================================
  function ensurePanel() {
    if (STATE.panel && document.body.contains(STATE.panel)) return STATE.panel;
    const panel = document.createElement('div');
    panel.id = 'unc-board-panel';
    panel.innerHTML = `
      <div class="ub-title">CHESS AI <span class="ub-ver">v4.0.3</span></div>
      <div class="ub-body">
        <div class="ub-row"><span>Eval</span><b class="ub-eval">--</b></div>
        <div class="ub-row"><span>Best</span><b class="ub-best">--</b></div>
        <div class="ub-row"><span>Predict</span><b class="ub-pred">--</b></div>
        <div class="ub-row"><span>Depth</span><b class="ub-depth">--</b></div>
        <div class="ub-divider"></div>
        <div class="ub-row"><span>Source</span><b class="ub-src">--</b></div>
        <div class="ub-row"><span>Status</span><b class="ub-state">init</b></div>
      </div>`;
    document.body.appendChild(panel);
    STATE.panel = panel;
    let dragging = false, dx = 0, dy = 0;
    panel.addEventListener('mousedown', (e) => {
      dragging = true;
      dx = e.clientX - panel.offsetLeft;
      dy = e.clientY - panel.offsetTop;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      panel.style.left = (e.clientX - dx) + 'px';
      panel.style.top = (e.clientY - dy) + 'px';
      panel.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => { dragging = false; });
    return panel;
  }

  function setField(field, text) {
    const el = STATE.panel && STATE.panel.querySelector('.ub-' + field);
    if (el) el.textContent = text;
  }
  function setStatus(text, color) {
    const el = STATE.panel && STATE.panel.querySelector('.ub-state');
    if (el) { el.textContent = text; el.style.color = color || '#ffd166'; }
  }

  function ensureArrowLayer(boardEl) {
    let layer = boardEl.querySelector(':scope > .unc-arrow-layer');
    if (!layer) {
      layer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      layer.setAttribute('class', 'unc-arrow-layer');
      layer.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:9999;';
      boardEl.appendChild(layer);
    }
    return layer;
  }
  function clearArrows(boardEl) {
    if (!boardEl) return;
    const layer = boardEl.querySelector(':scope > .unc-arrow-layer');
    if (layer) layer.innerHTML = '';
  }
  function drawArrow(boardEl, fromCoord, toCoord, flipped, opacity, color) {
    const layer = ensureArrowLayer(boardEl);
    const rect = boardEl.getBoundingClientRect();
    const sq = Math.min(rect.width, rect.height) / 8;
    function center(c) {
      const f = flipped ? 7 - c.file : c.file;
      const r = flipped ? 7 - c.rank : c.rank;
      return { x: f * sq + sq / 2, y: (7 - r) * sq + sq / 2 };
    }
    const a = center(fromCoord), b = center(toCoord);
    const ns = 'http://www.w3.org/2000/svg';
    const col = color || 'rgba(20,200,60,1)';
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', a.x); line.setAttribute('y1', a.y);
    line.setAttribute('x2', b.x); line.setAttribute('y2', b.y);
    line.setAttribute('stroke', col);
    line.setAttribute('stroke-width', Math.max(6, sq * 0.18));
    line.setAttribute('stroke-linecap', 'round');
    line.setAttribute('opacity', opacity);
    layer.appendChild(line);
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const hl = sq * 0.42;
    const p1 = { x: b.x - hl * Math.cos(ang - 0.4), y: b.y - hl * Math.sin(ang - 0.4) };
    const p2 = { x: b.x - hl * Math.cos(ang + 0.4), y: b.y - hl * Math.sin(ang + 0.4) };
    const poly = document.createElementNS(ns, 'polygon');
    poly.setAttribute('points', `${b.x},${b.y} ${p1.x},${p1.y} ${p2.x},${p2.y}`);
    poly.setAttribute('fill', col);
    poly.setAttribute('opacity', opacity);
    layer.appendChild(poly);
  }

  function renderArrows(boardEl, pvs, flipped) {
    if (!STATE.showArrow) { clearArrows(boardEl); return; }
    clearArrows(boardEl);
    if (!pvs || !pvs.length) return;
    // normalize scores to white-relative cp for comparison
    const toCp = (pv) => pv.mate !== null && pv.mate !== undefined
      ? (pv.mate > 0 ? 10000 : -10000)
      : (pv.cp || 0);
    const best = toCp(pvs[0]);
    pvs.slice(0, 3).forEach((pv, i) => {
      const mv = pv.moves && pv.moves[0];
      if (!mv || mv.length < 4) return;
      const from = mv.slice(0, 2), to = mv.slice(2, 4);
      const fc = { file: FILES.indexOf(from[0]), rank: parseInt(from[1]) - 1 };
      const tc = { file: FILES.indexOf(to[0]), rank: parseInt(to[1]) - 1 };
      if (fc.file < 0 || tc.file < 0) return;
      // opacity by relative quality (jameslinimk scheme)
      const diff = best - toCp(pv);
      let op;
      if (diff > 5) op = 0.30;
      else if (diff > 3) op = 0.40;
      else if (diff > 1) op = 0.55;
      else if (diff > 0.5) op = 0.70;
      else op = 0.85;
      const color = i === 0 ? 'rgba(20,200,60,1)' : 'rgba(80,160,255,1)';
      drawArrow(boardEl, fc, tc, flipped, op, color);
    });
  }

  // ============================================================
  // main loop
  // ============================================================
  // ============================================================
  // autoplay - move execution on chess.com
  // ============================================================
  function determineAutoSide(flipped) {
    if (STATE.autoplaySide === 'white') return 'w';
    if (STATE.autoplaySide === 'black') return 'b';
    // auto: ask the page who the user is before trusting the flip. a manually
    // flipped board puts black at the bottom while the user is still white;
    // playing "the bottom colour" then plays the opponent's moves.
    const detected = detectUserSide(flipped);
    if (detected) return detected;
    return flipped ? 'b' : 'w';
  }

  function algebraicToCoord(sq) {
    return { file: FILES.indexOf(sq[0]), rank: parseInt(sq[1]) - 1 };
  }

  function coordToSquareName(coord) {
    return FILES[coord.file] + (coord.rank + 1);
  }

  function coordToPixel(boardEl, coord, flipped) {
    const rect = boardEl.getBoundingClientRect();
    const sq = Math.min(rect.width, rect.height) / 8;
    const f = flipped ? 7 - coord.file : coord.file;
    const r = flipped ? 7 - coord.rank : coord.rank;
    return {
      x: rect.left + f * sq + sq / 2,
      y: rect.top + (7 - r) * sq + sq / 2
    };
  }

  // isolated-world synthetic events - kept only as a last-ditch in-page
  // fallback. the real autoplay path now routes through background, which
  // injects into the page's MAIN world (see background.js INJECT_MOVE_FN).
  function fireEvents(target, type, x, y) {
    const mouseEv = new MouseEvent(type, {
      bubbles: true, cancelable: true, view: window,
      clientX: x, clientY: y, button: 0,
      buttons: type === 'mousedown' ? 1 : 0
    });
    target.dispatchEvent(mouseEv);
    try {
      const ptrEv = new PointerEvent('pointer' + type, {
        bubbles: true, cancelable: true, view: window,
        clientX: x, clientY: y, button: 0,
        buttons: type === 'mousedown' ? 1 : 0,
        pointerType: 'mouse', pointerId: 1, isPrimary: true
      });
      target.dispatchEvent(ptrEv);
    } catch(_) {}
  }

  function findSquareEl(boardEl, coord, flipped) {
    // chess.com squares have class "square-XY" where X=file(1-8), Y=rank(1-8)
    const fileNum = coord.file + 1;
    const rankNum = coord.rank + 1;
    let el = boardEl.querySelector('.square-' + fileNum + rankNum);
    if (el) return el;
    const p = coordToPixel(boardEl, coord, flipped);
    return document.elementFromPoint(p.x, p.y) || boardEl;
  }

  // route a click-to-move through background. background injects a function
  // into the page's MAIN world that tries board.move / board.game.move /
  // __chessboard__ / React fiber first (using the algebraic move directly),
  // then a full pointer drag sequence on the pixels as fallback.
  // resolves to { ok, path, diag }.
  function bgPointerMove(boardEl, fromCoord, toCoord, flipped, moverSide, dragOnly) {
    const p1 = coordToPixel(boardEl, fromCoord, flipped);
    const p2 = coordToPixel(boardEl, toCoord, flipped);
    const fromAlg = coordToSquareName(fromCoord);
    const toAlg = coordToSquareName(toCoord);
    return new Promise(resolve => {
      chrome.runtime.sendMessage(
        {
          type: 'CLICK_MOVE',
          fromX: p1.x, fromY: p1.y, toX: p2.x, toY: p2.y,
          fromAlg, toAlg, moverSide, dragOnly: !!dragOnly
        },
        (resp) => resolve(resp || { ok: false, err: 'no response' })
      );
    });
  }

  // undo a move that only touched chess.com's local game model. the api
  // candidates call board.game.move()/undo() on the same object, so undo is
  // the exact counterpart and costs nothing when the move never applied.
  function bgRevertMove() {
    return new Promise(resolve => {
      chrome.runtime.sendMessage({ type: 'REVERT_MOVE' }, (resp) => {
        resolve(resp || { ok: false, err: 'no response' });
      });
    });
  }

  // route a single tap through background (used for the promotion chooser).
  function bgTap(x, y) {
    return new Promise(resolve => {
      chrome.runtime.sendMessage(
        { type: 'CLICK_TAP', x, y },
        (resp) => resolve(resp || { ok: false, err: 'no response' })
      );
    });
  }

  // try to use chess.com's own board API as a fallback.
  // the wc-chess-board element sometimes exposes a move() or game object.
  function tryBoardAPI(boardEl, fromAlg, toAlg, promotion) {
    try {
      // method 1: boardEl.move({from, to, promotion})
      if (typeof boardEl.move === 'function') {
        boardEl.move({ from: fromAlg, to: toAlg, promotion: promotion || 'q' });
        log('autoplay: boardEl.move() succeeded');
        return true;
      }
      // method 2: boardEl.game.move()
      if (boardEl.game && typeof boardEl.game.move === 'function') {
        boardEl.game.move({ from: fromAlg, to: toAlg, promotion: promotion || 'q' });
        log('autoplay: game.move() succeeded');
        return true;
      }
      // method 3: chess.com's global chess board instance
      if (window.chessBoard && typeof window.chessBoard.move === 'function') {
        window.chessBoard.move({ from: fromAlg, to: toAlg, promotion: promotion || 'q' });
        log('autoplay: global board move succeeded');
        return true;
      }
    } catch (e) {
      log('autoplay: board API failed', e);
    }
    return false;
  }

  // record the marker that reconcileJustPlayed reads back.
  function markJustPlayed(fromAlg, toAlg, char) {
    const moverSide = char === char.toUpperCase() ? 'w' : 'b';
    STATE.justPlayed = { from: fromAlg, to: toAlg, char, moverSide, at: Date.now() };
    STATE.lastKnownTurn = moverSide === 'w' ? 'b' : 'w';
  }

  // the piece has to leave its square AND arrive somewhere. a cancelled drag
  // or a rejected api call can leave the from-square empty for a frame while
  // the board re-renders, and "from empty" alone used to count as a win.
  function moveLanded(boardEl, fromAlg, toAlg) {
    const pieces = readPieces(boardEl);
    const fromCoord = algebraicToCoord(fromAlg);
    const toCoord = algebraicToCoord(toAlg);
    const stillOnFrom = pieces.some(p => p.file === fromCoord.file && p.rank === fromCoord.rank);
    const onTo = pieces.some(p => p.file === toCoord.file && p.rank === toCoord.rank);
    return !stillOnFrom && onTo;
  }

  async function moveLandedSettled(boardEl, fromAlg, toAlg, budgetMs) {
    const deadline = Date.now() + (budgetMs || 500);
    do {
      if (moveLanded(boardEl, fromAlg, toAlg)) return true;
      await new Promise(r => setTimeout(r, 60));
    } while (Date.now() < deadline);
    return false;
  }

  // chess.com's receipt for a move: the mover's clock stops, or the move list
  // grows one ply. true = accepted, false = still the mover's turn, null = the
  // page exposes neither (analysis board / puzzle / clipped UI) so we cannot
  // verify and must not block.
  async function waitForSiteAccept(boardEl, moverSide, pliesBefore, budgetMs, fromAlg, toAlg) {
    const deadline = Date.now() + (budgetMs || 1200);
    let clockObserved = false;
    const wantHl = (fromAlg && toAlg) ? [fromAlg, toAlg].sort().join('') : null;
    while (Date.now() < deadline) {
      if (wantHl && lastMoveHighlightKey(boardEl) === wantHl) return true;
      const ct = siteTurnFromClock(isFlipped(boardEl));
      if (ct) {
        clockObserved = true;
        if (ct !== moverSide) return true;
      }
      if (!clockObserved && pliesBefore !== null) {
        const plies = moveListPlies();
        if (plies !== null && plies > pliesBefore) return true;
      }
      await new Promise(r => setTimeout(r, 70));
    }
    return clockObserved ? false : null;
  }

  async function revertLocalMove(reason) {
    try {
      const r = await bgRevertMove();
      log('autoplay: reverted local-only move (' + reason + ')', r && r.path || r);
    } catch (e) {
      log('autoplay: revert failed', e && e.message || e);
    }
    await new Promise(r => setTimeout(r, 140));
  }

  async function executeMove(boardEl, fromAlg, toAlg, flipped) {
    log('autoplay executing', fromAlg, '->', toAlg);

    // SAFETY: verify the from-square actually has a piece of our color.
    const pieces = readPieces(boardEl);
    const fromCoord = algebraicToCoord(fromAlg);
    const toCoord = algebraicToCoord(toAlg);
    const piece = pieces.find(p => p.file === fromCoord.file && p.rank === fromCoord.rank);
    if (!piece) {
      log('autoplay: ABORTED - no piece on', fromAlg, '(stale move, position changed)');
      setStatus('stale move aborted', '#ff5555');
      return false;
    }
    const autoSide = determineAutoSide(flipped);
    const isOurPiece = (autoSide === 'w' && piece.char === piece.char.toUpperCase())
                    || (autoSide === 'b' && piece.char === piece.char.toLowerCase());
    if (!isOurPiece) {
      log('autoplay: ABORTED - piece on', fromAlg, 'is', piece.char, '(not ours)');
      setStatus('wrong piece aborted', '#ff5555');
      return false;
    }
    const moverSide = piece.char === piece.char.toUpperCase() ? 'w' : 'b';
    const plies0 = moveListPlies();
    log('autoplay: verified', piece.char, 'on', fromAlg, 'mover', moverSide, 'plies', plies0);

    // ---- tier 1: isolated-world board API (cheap, no round-trip) ----------
    // boardEl.move() if it exists is callable from the isolated world since
    // the method lives on the element itself. some of these mutate only the
    // local game model, so the site receipt decides whether it counts.
    if (STATE.tryApiFirst && !STATE.forceDrag && tryBoardAPI(boardEl, fromAlg, toAlg)) {
      await handlePromotion(fromAlg, toAlg);
      await new Promise(r => setTimeout(r, 100));
      if (await moveLandedSettled(boardEl, fromAlg, toAlg)) {
        const ack = await waitForSiteAccept(boardEl, moverSide, plies0, 1200, fromAlg, toAlg);
        if (ack !== false) {
          log('autoplay: move confirmed via isolated board API (site ack=' + ack + ')');
          markJustPlayed(fromAlg, toAlg, piece.char);
          return true;
        }
        log('autoplay: board API slid the piece locally, chess.com still has', moverSide, 'to move - undoing, using real input');
        await revertLocalMove('api not accepted');
        STATE.forceDrag = true;
      } else {
        log('autoplay: isolated board API returned but the piece did not land, escalating');
      }
    }

    // ---- tier 2: MAIN-world injector via background ----------------------
    // real pointer drag first: chess.com's own handler validates and submits
    // it, so a piece only moves when the site actually took the move. the api
    // ladder is only reached on the last attempt (or when drag is known bad).
    for (let attempt = 1; attempt <= 3; attempt++) {
      const dragOnly = attempt < 3 || STATE.forceDrag;
      log('autoplay: MAIN-world injector attempt', attempt, dragOnly ? '(drag only)' : '(api fallback)');
      const resp = await bgPointerMove(boardEl, fromCoord, toCoord, flipped, moverSide, dragOnly);
      // log path + diag explicitly (not collapsed Object) so the console
      // shows exactly which injector path fired and what it found.
      const path = resp && resp.path || '?';
      const diag = resp && resp.diag || {};
      log('autoplay: injector attempt', attempt, 'path=' + path,
          'board=' + (diag.boardTag || '?') + '.' + (diag.boardClass || '?'),
          'reactFiber=' + (diag.reactFiber || 'none'),
          'tried=' + JSON.stringify(diag.triedPaths || []));
      // brief settle for the board to apply the move / open promotion chooser
      await new Promise(r => setTimeout(r, 180));
      await handlePromotion(fromAlg, toAlg);
      await new Promise(r => setTimeout(r, 100));

      if (await moveLandedSettled(boardEl, fromAlg, toAlg)) {
        const ack = await waitForSiteAccept(boardEl, moverSide, plies0, 1600, fromAlg, toAlg);
        if (ack !== false) {
          log('autoplay: move confirmed via MAIN-world injector on attempt', attempt, '(' + path + ', site ack=' + ack + ')');
          markJustPlayed(fromAlg, toAlg, piece.char);
          return true;
        }
        log('autoplay: piece moved via', path, 'but chess.com still has', moverSide, 'to move - not a real move');
        await revertLocalMove('injector not accepted');
        // any api path that slid without submitting is dead on this build.
        // stop crediting api paths entirely and only use real input.
        if (path && path !== 'drag') STATE.forceDrag = true;
        continue;
      }
      log('autoplay: move did not register on attempt', attempt, '- piece still on', fromAlg, '(path=' + path + ')');
    }

    // ---- tier 3: isolated-world synthetic events (last ditch) ------------
    // same pixels, no background round-trip. weakest path, kept as a fallback
    // for the case where the background service worker has gone to sleep and
    // a restart would take too long.
    log('autoplay: last-ditch isolated-world synthetic events');
    const p1 = coordToPixel(boardEl, fromCoord, flipped);
    const p2 = coordToPixel(boardEl, toCoord, flipped);
    const fromEl = findSquareEl(boardEl, fromCoord, flipped);
    const toEl   = findSquareEl(boardEl, toCoord, flipped);
    fireEvents(fromEl, 'mousedown', p1.x, p1.y);
    fireEvents(boardEl, 'mousedown', p1.x, p1.y);
    fireEvents(fromEl, 'mouseup', p1.x, p1.y);
    fireEvents(boardEl, 'mouseup', p1.x, p1.y);
    fireEvents(fromEl, 'click', p1.x, p1.y);
    fireEvents(boardEl, 'click', p1.x, p1.y);
    await new Promise(r => setTimeout(r, 80));
    fireEvents(toEl, 'mousedown', p2.x, p2.y);
    fireEvents(boardEl, 'mousedown', p2.x, p2.y);
    fireEvents(toEl, 'mouseup', p2.x, p2.y);
    fireEvents(boardEl, 'mouseup', p2.x, p2.y);
    fireEvents(toEl, 'click', p2.x, p2.y);
    fireEvents(boardEl, 'click', p2.x, p2.y);
    await new Promise(r => setTimeout(r, 140));
    await handlePromotion(fromAlg, toAlg);
    await new Promise(r => setTimeout(r, 80));
    if (await moveLandedSettled(boardEl, fromAlg, toAlg)) {
      const ack = await waitForSiteAccept(boardEl, moverSide, plies0, 1200, fromAlg, toAlg);
      if (ack !== false) {
        log('autoplay: move confirmed via isolated-world synthetic events (site ack=' + ack + ')');
        markJustPlayed(fromAlg, toAlg, piece.char);
        return true;
      }
      log('autoplay: synthetic events slid the piece but the site still has', moverSide, 'to move');
      await revertLocalMove('synthetic not accepted');
    }

    log('autoplay: FAILED after all tiers');
    setStatus('autoplay failed', '#ff5555');
    return false;
  }

  async function handlePromotion(fromAlg, toAlg) {
    const fr = fromAlg[1], tr = toAlg[1];
    if (!((fr === '7' && tr === '8') || (fr === '2' && tr === '1'))) return;
    await new Promise(r => setTimeout(r, 250));
    const sels = [
      '.promotion-piece-q', '.promotion-queen',
      '[data-piece="q"]', '.promotion-piece:first-child',
      '.promotion-context piece-q', '.piece-promotion-q',
      'piece-q', '.promotion piece[q]'
    ];
    let qBtn = null;
    for (const s of sels) {
      qBtn = document.querySelector(s);
      if (qBtn) break;
    }
    if (!qBtn) {
      log('autoplay: promotion dialog not found');
      return;
    }
    const r = qBtn.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    // route through background so the tap fires from the page's MAIN world.
    const resp = await bgTap(cx, cy);
    log('autoplay: promoted to queen via MAIN-world tap', resp);
    // fallback: isolated-world synthetic events if the background tap missed
    await new Promise(res => setTimeout(res, 60));
    const stillOpen = document.querySelector('.promotion-piece-q, .promotion-queen, .promotion-context');
    if (stillOpen) {
      fireEvents(qBtn, 'mousedown', cx, cy);
      fireEvents(qBtn, 'mouseup', cx, cy);
      fireEvents(qBtn, 'click', cx, cy);
      log('autoplay: promotion fallback isolated-world tap');
    }
  }

  // ============================================================
  // evasion layer — timing, move selection, tab-focus gating
  // ============================================================

  // Box-Muller gaussian. mean in ms, std in ms.
  function gaussianRandom(mean, std) {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    return mean + z * std;
  }

  // detect the from-square of chess.com's last-move highlight.
  // chess.com paints two squares with .highlight / [class*="last-move"] and
  // tags each with .square-XY. the from-square is whichever of the two does
  // NOT currently hold a piece. returns null if not found.
  function getLastMoveFromSquare() {
    const boardEl = getBoardEl();
    if (!boardEl) return null;
    const squares = boardEl.querySelectorAll('.highlight, .last-move-highlight, [class*="last-move"]');
    if (!squares || squares.length < 2) return null;
    for (const sq of squares) {
      const cls = sq.className || '';
      const m = cls.match(/square-(\d)(\d)/);
      if (!m) continue;
      const file = parseInt(m[1]) - 1;
      const rank = parseInt(m[2]) - 1;
      const piece = sq.querySelector('.piece') || (sq.classList && sq.classList.contains('piece') ? sq : null);
      if (!piece) {
        return FILES[file] + (rank + 1);
      }
    }
    // fallback: assume the first square is the from
    const cls0 = squares[0].className || '';
    const m0 = cls0.match(/square-(\d)(\d)/);
    if (m0) return FILES[parseInt(m0[1]) - 1] + parseInt(m0[2]);
    return null;
  }

  // detect a forced / recapture shape from the PV list. a single legal move or
  // an obvious recapture manifests as a huge eval gap between rank 1 and rank 2:
  // every alternative loses material, so the gap blows past 1.5 pawns.
  function detectForcedMove(pvs) {
    if (!pvs || pvs.length < 2) return true; // only one line => effectively forced
    const cp0 = pvs[0].cp;
    const cp1 = pvs[1].cp;
    if (cp0 === null || cp0 === undefined || cp1 === null || cp1 === undefined) return false;
    const gap = Math.abs(cp0 - cp1);
    return gap >= 150; // 1.5 pawns gap => alternatives are clearly worse
  }

  // compute human-like delay.
  // 1. popup min/max override: when both are set (>0), a uniform draw on that
  //    range is the schedule. absolute floor 350ms.
  // 2. deep-think spike: 6% of moves take 6-15s — the tank pause on a complex
  //    position. a player who never goes long is as machine-shaped as one who
  //    never goes short.
  // 3. otherwise: base gaussian 2800±900 clamped 800-7000. difficult positions
  //    (eval gap < 0.4 pawns between rank 1 and 2) multiply 1.6-2.2x. forced
  //    positions (huge eval gap) collapse to 500-1000ms — no capture-recapture
  //    below that ever looks like preloading.
  function computeDelay(pvs, fen) {
    const mn = STATE.autoplayMinDelay | 0;
    const mx = STATE.autoplayMaxDelay | 0;
    if (mn > 0 && mx > 0 && mx >= mn) {
      return Math.max(350, Math.round(mn + Math.random() * (mx - mn)));
    }
    if (Math.random() < 0.06) {
      const tank = Math.round(6000 + Math.random() * 9000);
      log('timing: deep-think spike', tank, 'ms');
      return tank;
    }
    if (!pvs || !pvs.length) {
      return Math.max(800, Math.min(7000, Math.round(gaussianRandom(2800, 900))));
    }
    const cp0 = pvs[0].cp;
    const cp1 = pvs.length > 1 ? pvs[1].cp : null;
    if (detectForcedMove(pvs)) {
      return Math.round(500 + Math.random() * 500); // 500-1000
    }
    let base = gaussianRandom(2800, 900);
    base = Math.max(800, Math.min(7000, base));
    if (cp0 !== null && cp0 !== undefined && cp1 !== null && cp1 !== undefined) {
      const gap = Math.abs(cp0 - cp1);
      if (gap < 40) {
        const mult = 1.6 + Math.random() * 0.6; // 1.6-2.2
        base = Math.min(7000, Math.round(base * mult));
      }
    }
    return base;
  }

  // weighted move selector. pvs is an array of {moves, cp, mate, depth}.
  // returns the chosen UCI move string (e.g. 'e2e4').
  // distribution when not in a blunder trigger:
  //   25% rank 1, 60% rank 2, 15% rank 3
  // when our advantage is >= 3.0 pawns, with ~30% probability, play a move
  // that drops 0.3-0.8 pawns instead (a human coasting while ahead).
  // every nextHumanMoveAt moves, skip the weighted path and play a plan-like
  // move (last-moved piece again if available, else rank 3).
  function selectMoveFromPVs(pvs, pieces, turn, flipped) {
    if (!pvs || !pvs.length) return null;
    const rank = (i) => pvs[i] && pvs[i].moves && pvs[i].moves[0] ? pvs[i].moves[0] : null;

    // --- occasional human move (every 8-15 moves) ---------------------
    STATE.humanMoveCounter = (STATE.humanMoveCounter || 0) + 1;
    if (STATE.humanMoveCounter >= STATE.nextHumanMoveAt) {
      STATE.humanMoveCounter = 0;
      STATE.nextHumanMoveAt = 8 + Math.floor(Math.random() * 8);
      log('evasion: human-move trigger, next at +' + STATE.nextHumanMoveAt);
      // preference 1: move the piece that just moved again, if it's in the PVs
      const lastFrom = getLastMoveFromSquare() || STATE.lastAutoMoveFrom;
      if (lastFrom) {
        for (let i = 1; i < pvs.length && i < 6; i++) {
          const mv = rank(i);
          if (mv && mv.slice(0, 2) === lastFrom) {
            log('evasion: human move = continue plan with', mv, '(rank', i + 1 + ')');
            return mv;
          }
        }
      }
      // preference 2: a central pawn push from the PV list (rank 2-5)
      for (let i = 1; i < pvs.length && i < 6; i++) {
        const mv = rank(i);
        if (!mv) continue;
        const f = mv.slice(0, 2);
        const file = FILES.indexOf(f[0]);
        if (file >= 2 && file <= 5) {
          log('evasion: human move = central pawn push', mv, '(rank', i + 1 + ')');
          return mv;
        }
      }
      // preference 3: rank 3 if available, else rank 2
      const fallback = rank(2) || rank(1) || rank(0);
      log('evasion: human move fallback', fallback);
      return fallback;
    }

    const cp0 = pvs[0].cp;
    const mate0 = pvs[0].mate;
    // --- blunder-while-ahead trigger ----------------------------------
    const winning = (cp0 !== null && cp0 !== undefined && cp0 >= 300)
                 || (mate0 !== null && mate0 !== undefined && mate0 > 0 && mate0 <= 5);
    if (winning && Math.random() < 0.30) {
      const target0 = (cp0 === null || cp0 === undefined) ? null : cp0 - 30;
      const target1 = (cp0 === null || cp0 === undefined) ? null : cp0 - 80;
      for (let i = 1; i < pvs.length; i++) {
        const cpI = pvs[i].cp;
        if (cpI === null || cpI === undefined) continue;
        if (cpI <= target0 && cpI >= target1) {
          const mv = rank(i);
          if (mv) {
            log('evasion: coasting blunder', mv, 'cp', cpI, '(drops', ((cp0 - cpI) / 100).toFixed(2), 'pawns)');
            return mv;
          }
        }
      }
      // no PV in the drop window — fall through to weighted selector
    }

    // --- weighted selector: 25% rank1 / 60% rank2 / 15% rank3 ----------
    const r = Math.random();
    let chosen, chosenRank;
    if (r < 0.25) { chosen = rank(0); chosenRank = 1; }
    else if (r < 0.85) { chosen = rank(1) || rank(0); chosenRank = 2; }
    else { chosen = rank(2) || rank(1) || rank(0); chosenRank = 3; }
    if (!chosen) chosen = rank(0);
    log('evasion: weighted pick rank', chosenRank, '=', chosen, '(r=' + r.toFixed(2) + ')');
    return chosen;
  }

  function maybeAutoplay(pvs, boardEl, flipped, turn, fen) {
    log('autoplay check: enabled=' + STATE.autoplay, 'turn=' + turn, 'flipped=' + flipped);
    if (!STATE.autoplay) return;
    if (STATE.autoInFlight) return;
    if (!pvs || !pvs.length || !pvs[0].moves || !pvs[0].moves[0]) return;
    const autoSide = determineAutoSide(flipped);
    if (turn !== autoSide) {
      log('autoplay: not our turn (turn=' + turn + ' autoSide=' + autoSide + ')');
      return;
    }
    // CROSS-CHECK: our turn is inferred from the board delta, the site's clock
    // is not. if we think it is our move but the clock still sits on the other
    // side, we are a ply behind and any move we inject is the opponent's.
    const siteTurn = siteTurnFromClock(flipped);
    if (siteTurn && siteTurn !== turn) {
      log('autoplay: blocked - inferred turn', turn, 'but site clock says', siteTurn);
      return;
    }
    // tab-focus gate: if the tab is hidden, do not schedule. the visibilitychange
    // handler re-triggers analysis on focus return with its own think delay.
    if (STATE.tabHidden) {
      log('autoplay: tab hidden, deferring');
      return;
    }

    // one move per position. without this a rejected move that still slid the
    // piece re-reads as "our turn again" and autoplay fires twice for the same
    // ply, which is exactly how a double move sneaks through.
    const pieces = readPieces(boardEl);
    const posSig = sigKey(piecesSignature(pieces)) + ':' + turn;
    if (STATE.autoDoneSig && Date.now() - (STATE.autoDoneAt || 0) > 20000) {
      STATE.autoDoneSig = null;
    }
    if (STATE.autoDoneSig === posSig) {
      log('autoplay: already played this position, waiting for the board to change');
      return;
    }

    // pick the actual move via the evasion selector (NOT necessarily rank 1)
    let chosenUci = selectMoveFromPVs(pvs, pieces, turn, flipped);
    if (!chosenUci || chosenUci.length < 4) {
      log('autoplay: selector returned no move');
      return;
    }
    // verify the chosen move is for the correct side before scheduling
    if (!verifyMoveForSide(chosenUci, pieces, turn)) {
      log('autoplay: selector move', chosenUci, 'failed side-verify, falling back to rank 1');
      const fallback = pvs[0].moves[0];
      if (!fallback || !verifyMoveForSide(fallback, pieces, turn)) return;
      chosenUci = fallback;
    }
    const fromAlg = chosenUci.slice(0, 2);
    const toAlg = chosenUci.slice(2, 4);

    if (STATE.pendingAutoMove) clearTimeout(STATE.pendingAutoMove);

    const delay = computeDelay(pvs, fen);
    const scheduledSig = sigKey(piecesSignature(pieces));
    STATE.lastAutoMoveFrom = fromAlg;
    setStatus('move in ' + Math.round(delay) + 'ms', '#ffd166');
    log('autoplay scheduled in', Math.round(delay), 'ms:', fromAlg, '->', toAlg, '(selector-chosen)');

    STATE.pendingAutoMove = setTimeout(() => {
      STATE.pendingAutoMove = null;
      if (!STATE.autoplay) {
        log('autoplay: aborted, toggle turned off during wait');
        return;
      }
      if (STATE.tabHidden) {
        log('autoplay: aborted, tab hidden during wait');
        return;
      }
      const boardEl2 = getBoardEl();
      if (!boardEl2) return;
      // board-disabled = chess.com locked input (opponent thinking / game over
      // / bot turn). injecting against a locked board only burns the retry
      // ladder; bail and let the next mutation re-arm us.
      if (boardEl2.classList.contains('board-disabled')) {
        log('autoplay: board disabled (input locked), aborting');
        return;
      }
      const currentPieces = readPieces(boardEl2);
      if (currentPieces.length < 4 || currentPieces.length > 32) {
        log('autoplay: aborted, board mid-render');
        return;
      }
      // exact position check: any change at all invalidates the scheduled move
      // (the old FEN compare could let a half-applied move through).
      if (sigKey(piecesSignature(currentPieces)) !== scheduledSig) {
        log('autoplay: aborted, position changed during wait');
        return;
      }
      const currentTurn = resolveTurn(currentPieces, isFlipped(boardEl2), boardEl2);
      if (currentTurn !== autoSide) {
        log('autoplay: aborted, turn changed during wait');
        return;
      }
      // re-read the clock at fire time: the board can be visually settled while
      // chess.com has already handed the move to the other side.
      const currentSiteTurn = siteTurnFromClock(isFlipped(boardEl2));
      if (currentSiteTurn && currentSiteTurn !== currentTurn) {
        log('autoplay: aborted, site clock says', currentSiteTurn, 'not', currentTurn);
        return;
      }
      STATE.autoDoneSig = posSig;
      STATE.autoDoneAt = Date.now();
      STATE.autoInFlight = true;
      executeMove(boardEl2, fromAlg, toAlg, isFlipped(boardEl2)).then(ok => {
        STATE.autoInFlight = false;
        if (!ok) {
          // injector missed: retry twice with light backoff. the board may have
          // been mid-animation or the service worker asleep. no infinite loop.
          STATE.autoRetry = (STATE.autoRetry || 0) + 1;
          if (STATE.autoRetry <= 2) {
            STATE.autoDoneSig = null;
            setTimeout(() => { STATE.lastFen = null; schedule(); }, 400 * STATE.autoRetry);
          }
          return;
        }
        STATE.autoRetry = 0;
        // do not snapshot here: executeMove only proves the piece left its
        // from-square, not that it landed. the next settled pass owns the new
        // position via the delta (pre-move snapshot -> opponent's turn).
        schedule();
      }).catch(err => {
        STATE.autoInFlight = false;
        STATE.autoDoneSig = null;
        log('autoplay: execution error', err && err.message || err);
      });
    }, delay);
  }

  let debounce = null;
  function schedule() {
    clearTimeout(debounce);
    debounce = setTimeout(analyze, 250);
  }

  async function analyze() {
    if (!STATE.enabled) return;
    let boardEl = getBoardEl();
    if (!boardEl) { setStatus('no board', '#ff5555'); return; }
    let pieces = readPieces(boardEl);
    if (pieces.length < 4) { setStatus('reading...', '#ffd166'); return; }
    // double-render guard: during game load the board element can briefly hold
    // two piece sets (32 -> 64). any FEN built from that is garbage, so skip
    // this pass; the next mutation re-triggers cleanly.
    if (pieces.length > 32) { setStatus('reading...', '#ffd166'); return; }
    // settle gate: move animations flip square classes in stages. two reads
    // 90ms apart must agree before the delta arbiter is allowed to flip a turn,
    // otherwise a lifted piece counts as a move and the turn flips twice.
    if (STATE.boardSignature) {
      const firstSig = sigKey(piecesSignature(pieces));
      // a pending move scheduled for a position that is already gone must die
      // before anything else. its own signature check would also catch it, but
      // stop it here so it cannot fire inside the settle window.
      if (firstSig !== sigKey(STATE.boardSignature) && STATE.pendingAutoMove) {
        clearTimeout(STATE.pendingAutoMove);
        STATE.pendingAutoMove = null;
        log('autoplay: cancelled stale timer (board moved)');
      }
      await new Promise(r => setTimeout(r, 90));
      if (!STATE.enabled) return;
      const settledEl = getBoardEl();
      if (!settledEl) return;
      const settledPieces = readPieces(settledEl);
      if (sigKey(piecesSignature(settledPieces)) !== firstSig) {
        log('board still settling, deferring');
        schedule();
        return;
      }
      boardEl = settledEl;
      pieces = settledPieces;
    }
    const flipped = isFlipped(boardEl);
    // TURN: settled board delta is the arbiter (one move = one flip), the DOM
    // heuristics only seed the first pass, and the marker is a one-shot.
    let turn = resolveTurn(pieces, flipped, boardEl);
    let fen = boardToFEN(pieces, turn, detectEpSquare(pieces, turn, boardEl));
    // SAFETY: if the FEN turn is wrong, the engine returns a move for the wrong side.
    // Cross-check: if there's a king in check or the position looks like the opposite
    // side should move, flip. But the most reliable signal: if we already have a lastFen
    // and the position changed by ONE piece, the side that JUST moved is NOT the side to move.
    // Simplest robust check: the engine will return a move; we verify it matches the turn.
    // If not, flip the turn and rebuild the FEN. This is done after engine returns.
    if (fen === STATE.lastFen) return;
    STATE.lastFen = fen;
    // CRITICAL: cancel any pending autoplay whenever position changes.
    // the old timer was for the OLD position and is now stale.
    if (STATE.pendingAutoMove) {
      clearTimeout(STATE.pendingAutoMove);
      STATE.pendingAutoMove = null;
      log('autoplay: cancelled stale timer (position changed)');
    }
    // always clear stale arrows when position changes
    clearArrows(boardEl);
    log('fen', fen, 'pieces', pieces.length, 'turn', turn, 'flipped', flipped, 'autoplay', STATE.autoplay);
    ensurePanel();
    setStatus('loading', '#ffd166');

    // 1. try lichess cloud-eval first (instant for book positions)
    if (STATE.useCloudEval) {
      const cloud = await cloudEval(fen);
      if (cloud && cloud.pvs && cloud.pvs.length) {
        const pvs = cloud.pvs.map(p => ({
          moves: p.moves.split(/\s+/),
          cp: p.cp !== undefined ? p.cp : null,
          mate: p.mate !== undefined ? p.mate : null,
          depth: cloud.depth
        }));
        setField('best', pvs[0].moves[0] ? (pvs[0].moves[0].slice(0,2) + '-' + pvs[0].moves[0].slice(2,4)) : '--');
        setField('depth', cloud.depth + ' (cloud)');
        setField('src', 'lichess');
        if (STATE.showEval) {
          let ev = '--';
          if (pvs[0].mate !== null) ev = `M${pvs[0].mate}`;
          else if (pvs[0].cp !== null) {
            const v = (pvs[0].cp / 100).toFixed(2);
            ev = (pvs[0].cp > 0 ? '+' : '') + v;
          }
          setField('eval', ev);
        }
        const autoSide = determineAutoSide(flipped);
        const isOurTurn = (turn === autoSide);
        const shouldShowArrows = STATE.showArrow && (!STATE.arrowsOnlyMyTurn || isOurTurn);
        if (shouldShowArrows) {
          renderArrows(boardEl, pvs, flipped);
        } else {
          clearArrows(boardEl);
        }
        setStatus('idle', '#6cf36c');
        if (isOurTurn && pvs[0].moves && pvs[0].moves[0]) {
          maybeAutoplay(pvs, boardEl, flipped, turn, fen);
        }
        loadEngine(() => {});
        return;
      }
    }

    // 2. local engine
    // when autoplay is on and it's our turn, use lower depth + multiPV 1 for speed.
    // otherwise use full depth + multiPV for analysis quality.
    const autoSide = determineAutoSide(flipped);
    const isOurTurn = (turn === autoSide);
    const useFastPath = STATE.autoplay && isOurTurn;
    // AUTOPLAY: depth 8 MultiPV 1 = instant (~30-80ms), still 2700+ ELO.
    // ANALYSIS (opponent's turn): full depth 22 MultiPV 3 = smartest, predicts their moves.
    const thinkDepth = useFastPath ? Math.min(STATE.autoplayDepth || 8, 10) : STATE.depth;
    const shouldShowArrows = STATE.showArrow && (!STATE.arrowsOnlyMyTurn || isOurTurn);
    log('arrow decision: showArrow=' + STATE.showArrow, 'arrowsOnlyMyTurn=' + STATE.arrowsOnlyMyTurn, 'isOurTurn=' + isOurTurn, 'autoSide=' + autoSide, 'turn=' + turn, '-> shouldShow=' + shouldShowArrows, 'depth=' + thinkDepth);
    if (!shouldShowArrows) {
      clearArrows(boardEl);
    }
    setStatus(useFastPath ? 'analyzing (instant)' : 'analyzing (max)', '#ffd166');
    loadEngine(async () => {
      // autoplay path: MultiPV 5 so the evasion selector has ranks 1-5 to
      // pick from (the selector plays rank 2 60% of the time, so we need at
      // least 3 PVs, plus a couple more for the blunder-while-ahead picker).
      // depth 8 with MultiPV 5 is still sub-400ms on a modern machine.
      // opponent turn: MultiPV 3 = smartest, predicts their moves.
      if (useFastPath) {
        STATE.engine.postMessage('setoption name MultiPV value 5');
      } else {
        STATE.engine.postMessage('setoption name MultiPV value ' + STATE.multiPV);
      }
      // LIVE UPDATE callback: render arrows as info arrives, not just at bestmove.
      // this gives sub-100ms arrow appearance instead of waiting for depth 14.
      const onLiveUpdate = (info) => {
        // only show live arrows if shouldShowArrows is true (our turn)
        const liveAutoSide = determineAutoSide(flipped);
        const liveIsOurTurn = (turn === liveAutoSide);
        const liveShouldShow = STATE.showArrow && (!STATE.arrowsOnlyMyTurn || liveIsOurTurn);
        if (liveShouldShow && info.pvs && info.pvs.length && info.pvs[0].moves && info.pvs[0].moves[0]) {
          // verify the live move is for the correct side before drawing
          if (verifyMoveForSide(info.pvs[0].moves[0], pieces, turn)) {
            renderArrows(boardEl, info.pvs, flipped);
            setField('best', info.pvs[0].moves[0].slice(0,2) + '-' + info.pvs[0].moves[0].slice(2,4));
            setField('src', 'stockfish (live d' + (info.depth || '?') + ')');
          }
        }
      };
      const result = await thinkWithDepth(fen, thinkDepth, onLiveUpdate, useFastPath ? 0 : 4000);
      // restore multiPV
      STATE.engine.postMessage('setoption name MultiPV value ' + STATE.multiPV);
      if (!result || !result.best || result.best === '(none)') {
        setField('best', '--');
        setStatus('idle', '#6cf36c');
        return;
      }
      // CRITICAL: verify the search result is for THIS position, not a stale one.
      if (result.searchFen && result.searchFen !== fen) {
        log('STALE search result discarded: result fen', result.searchFen, '!= current', fen);
        setField('best', '-- (stale)');
        setStatus('stale result', '#ff5555');
        return;
      }
      // also verify the board hasn't changed since we started searching
      const currentPieces = readPieces(boardEl);
      const currentTurn = resolveTurn(currentPieces, flipped, boardEl);
      const currentFen = boardToFEN(currentPieces, currentTurn, detectEpSquare(currentPieces, currentTurn, boardEl));
      if (currentFen !== fen) {
        log('board changed during search, discarding result. was:', fen, 'now:', currentFen);
        setField('best', '-- (board changed)');
        setStatus('board changed', '#ff5555');
        return;
      }
      let best = result.best;
      // CRITICAL TURN VERIFICATION: if the engine's move is for the WRONG side,
      // our detectTurn() was wrong. Flip the turn and re-search with the correct FEN.
      if (!verifyMoveForSide(best, currentPieces, turn)) {
        log('TURN MISMATCH: engine move', best, 'is not for side', turn, '. flipping turn and re-searching');
        const correctedTurn = (turn === 'w') ? 'b' : 'w';
        const correctedFen = boardToFEN(currentPieces, correctedTurn, detectEpSquare(currentPieces, correctedTurn, boardEl));
        log('re-searching with corrected turn', correctedTurn, 'fen', correctedFen);
        // autoplay path: keep MultiPV 5 + fast depth so several candidate
        // moves arrive fast for the evasion selector
        if (useFastPath) {
          STATE.engine.postMessage('setoption name MultiPV value 5');
        }
        const correctedResult = await thinkWithDepth(correctedFen, thinkDepth, null, useFastPath ? 0 : 4000);
        STATE.engine.postMessage('setoption name MultiPV value ' + STATE.multiPV);
        if (!correctedResult || !correctedResult.best || correctedResult.best === '(none)') {
          setField('best', '--');
          setStatus('idle', '#6cf36c');
          return;
        }
        // update turn and fen to corrected values
        turn = correctedTurn;
        fen = correctedFen;
        best = correctedResult.best;
        syncBoardState(currentPieces, correctedTurn);
        STATE.lastFen = correctedFen;
        // re-verify
        if (!verifyMoveForSide(best, currentPieces, turn)) {
          log('TURN STILL WRONG after correction. giving up on this position.');
          setField('best', '-- (turn error)');
          setStatus('turn error', '#ff5555');
          return;
        }
        log('turn corrected successfully. best move is now', best);
        // re-evaluate isOurTurn with corrected turn
        const correctedAutoSide = determineAutoSide(flipped);
        const correctedIsOurTurn = (turn === correctedAutoSide);
        const correctedShouldShowArrows = STATE.showArrow && (!STATE.arrowsOnlyMyTurn || correctedIsOurTurn);
        log('corrected arrow decision: shouldShow=' + correctedShouldShowArrows, 'isOurTurn=' + correctedIsOurTurn);
        if (!correctedShouldShowArrows) {
          clearArrows(boardEl);
          setField('best', best.slice(0,2) + '-' + best.slice(2,4));
          setField('src', 'stockfish (corrected)');
          setStatus('idle', '#6cf36c');
          return;
        }
        if (correctedResult.pvs && correctedResult.pvs.length) {
          renderArrows(boardEl, correctedResult.pvs, flipped);
        }
        if (correctedIsOurTurn) {
          maybeAutoplay(correctedResult.pvs || [{ moves: [best], cp: null, mate: null }], boardEl, flipped, turn, fen);
        }
        return;
      }
      setField('best', best.slice(0,2) + '-' + best.slice(2,4));
      setField('src', useFastPath ? 'stockfish (instant)' : 'stockfish (max)');
      // engine accepted a move for this turn: detection side is verified truth
      syncBoardState(currentPieces, turn);
      // OPPONENT PREDICTION: when it's the opponent's turn, the engine's PV[0]
      // IS their best move. show it in the panel as the predicted move.
      // when it's our turn, PV[1] (the 2nd move in the line) is their predicted reply.
      if (STATE.showPrediction) {
        let predictedMove = null;
        if (!isOurTurn && result.pvs && result.pvs[0] && result.pvs[0].moves && result.pvs[0].moves[0]) {
          // opponent's turn: their best move = PV[0]
          predictedMove = result.pvs[0].moves[0];
        } else if (isOurTurn && result.pvs && result.pvs[0] && result.pvs[0].moves && result.pvs[0].moves[1]) {
          // our turn: after we play PV[0], opponent's predicted reply = PV[1]
          predictedMove = result.pvs[0].moves[1];
        }
        if (predictedMove && predictedMove.length >= 4) {
          setField('pred', predictedMove.slice(0,2) + '-' + predictedMove.slice(2,4));
        } else {
          setField('pred', '--');
        }
      }
      // RE-CHECK shouldShowArrows here, in case setting changed during search
      const stillShowArrows = STATE.showArrow && (!STATE.arrowsOnlyMyTurn || (turn === determineAutoSide(flipped)));
      if (stillShowArrows) {
        if (result.pvs && result.pvs.length) {
          renderArrows(boardEl, result.pvs, flipped);
        } else {
          const fc = { file: FILES.indexOf(best[0]), rank: parseInt(best[1]) - 1 };
          const tc = { file: FILES.indexOf(best[2]), rank: parseInt(best[3]) - 1 };
          drawArrow(boardEl, fc, tc, flipped, 0.85, 'rgba(20,200,60,1)');
        }
      } else {
        // explicitly clear - don't leave old arrows
        clearArrows(boardEl);
      }
      // only autoplay on our turn
      if (isOurTurn) {
        maybeAutoplay(result.pvs, boardEl, flipped, turn, fen);
      }
    });
  }

  // think with a specific depth (for fast autoplay path)
  // onLiveUpdate: optional callback called with {pvs, depth, cp, mate} as info arrives
  // movetimeMs: optional hard cap. opponent-turn analysis passes 4000 so a
  // depth-20+ search can never run 10-20s while the board keeps changing; every
  // deep result past that was being discarded anyway.
  async function thinkWithDepth(fen, depth, onLiveUpdate, movetimeMs) {
    return new Promise((resolve) => {
      if (!STATE.engine || !STATE.engineReady) { resolve(null); return; }
      // CRITICAL: if the engine is still thinking from a previous search, we MUST
      // drain the stale bestmove before starting a new one. stop, then POLL for
      // the stale bestmove. the old 50ms blind shot raced the engine ("did not
      // respond to stop, forcing new search" in the logs).
      const startNewSearch = () => {
        currentSearchId++;
        activeSearchFen = fen;
        bestMoveResolve = resolve;
        liveUpdateCallback = onLiveUpdate || null;
        isThinking = true;
        pvAccum = [];
        setStatus('thinking', '#ffd166');
        log('starting search', currentSearchId, 'fen', fen, 'depth', depth, movetimeMs ? ('movetime ' + movetimeMs) : '');
        STATE.engine.postMessage('position fen ' + fen);
        STATE.engine.postMessage('go depth ' + depth + (movetimeMs ? ' movetime ' + movetimeMs : ''));
      };
      if (isThinking) {
        log('engine still thinking, sending stop and waiting for stale bestmove');
        STATE.engine.postMessage('stop');
        let waited = 0;
        const poll = () => {
          if (!isThinking) {
            // stale bestmove arrived and was discarded; safe to start now
            startNewSearch();
            return;
          }
          waited += 50;
          if (waited < 600) { setTimeout(poll, 50); return; }
          // engine wedged (rare) — force through. the stale search id ensures
          // any late bestmove from the dead search is discarded.
          log('stop not acknowledged in 600ms, forcing new search');
          startNewSearch();
        };
        setTimeout(poll, 50);
      } else {
        startNewSearch();
      }
    });
  }

  // ============================================================
  // observers
  // ============================================================
  let attached = false;
  let boardProbed = false;
  function attach() {
    if (attached) return;
    const boardEl = getBoardEl();
    if (!boardEl) { setTimeout(attach, 800); return; }
    attached = true;
    ensurePanel();
    const mo = new MutationObserver(schedule);
    mo.observe(boardEl, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
    const mo2 = new MutationObserver(schedule);
    mo2.observe(document.body, { childList: true, subtree: true });
    setInterval(() => {
      if (!getBoardEl()) { attached = false; clearArrows(null); attach(); }
    }, 2000);
    schedule();
    log('attached to', boardEl.tagName, boardEl.className);
    // one-time board probe: ask background to run a MAIN-world diagnostic
    // that logs the board element's tag, class, methods, React fiber props.
    // the result lands in the page console (via the injector's log) AND here.
    if (!boardProbed) {
      boardProbed = true;
      chrome.runtime.sendMessage({ type: 'PROBE_BOARD' }, (resp) => {
        if (chrome.runtime.lastError) { log('probe lastError:', chrome.runtime.lastError.message); return; }
        log('board probe:', JSON.stringify(resp).slice(0, 800));
      });
    }
  }

  // ============================================================
  // settings
  // ============================================================
  const DEFAULTS = {
    enabled: true, depth: 22, multiPV: 3,
    skillLevel: 20, useEloLimit: false, elo: 1500,
    useCloudEval: true, showArrow: true, showEval: true,
    showPrediction: true, arrowsOnlyMyTurn: true,
    autoplay: false, autoplayMinDelay: 0, autoplayMaxDelay: 0,
    autoplaySide: 'auto', autoplayDepth: 8,
    // evasion state — human-move cadence and tab-focus gating.
    // nextHumanMoveAt counts down from a random 8-15; when it hits 0 the
    // selector skips the engine-weighted path and plays a plan-like move.
    humanMoveCounter: 0,
    nextHumanMoveAt: 8 + Math.floor(Math.random() * 8),
    tabHidden: false,
    tabResumeAt: 0,
    lastAutoMoveFrom: null
  };
  chrome.storage.sync.get(DEFAULTS, (s) => {
    Object.assign(STATE, s);
    attach();
  });
  chrome.storage.onChanged.addListener((chg, area) => {
    if (area !== 'sync') return;
    // log every storage change so we can see what's flipping autoplay
    for (const k in chg) {
      log('storage change:', k, 'old=', chg[k].oldValue, 'new=', chg[k].newValue);
    }
    let needReanalyze = false;
    for (const k in chg) {
      STATE[k] = chg[k].newValue;
      if (['enabled','depth','multiPV','skillLevel','useEloLimit','elo','useCloudEval','autoplaySide','arrowsOnlyMyTurn','showPrediction','autoplayDepth'].includes(k)) needReanalyze = true;
    }
    if (chg.showArrow !== undefined && !chg.showArrow.newValue) clearArrows(getBoardEl());
    if (chg.autoplay !== undefined && !chg.autoplay.newValue && STATE.pendingAutoMove) {
      clearTimeout(STATE.pendingAutoMove);
      STATE.pendingAutoMove = null;
      log('autoplay: cancelled via toggle');
    }
    if (STATE.engineReady && (chg.skillLevel || chg.useEloLimit || chg.elo || chg.multiPV)) applyStrengthOptions();
    if (needReanalyze) { STATE.lastFen = null; schedule(); }
  });

  // ============================================================
  // tab-focus gating — suppress the second-device signal
  // ============================================================
  // chess.com's anti-cheat tracks visibilitychange, blur, and focus events
  // to infer second-device usage. when the tab is hidden we pause analysis
  // and clear any pending autoplay timer so no move fires while the user is
  // "away". when focus returns we hold for a 1200-3000ms human-looked-back
  // delay before re-triggering analysis, so the resume looks like a human
  // glancing at the board and then thinking, not an instant engine query.
  function handleVisibilityChange() {
    if (document.hidden) {
      if (STATE.tabHidden) return;
      STATE.tabHidden = true;
      log('tab hidden — pausing analysis and clearing pending autoplay');
      if (STATE.pendingAutoMove) {
        clearTimeout(STATE.pendingAutoMove);
        STATE.pendingAutoMove = null;
      }
      if (debounce) {
        clearTimeout(debounce);
        debounce = null;
      }
      setStatus('paused (tab hidden)', '#ffd166');
    } else {
      if (!STATE.tabHidden) {
        // focus returned but we never marked hidden — still re-run with a
        // small think delay to blur the focus-event fingerprint.
        const delay = 1200 + Math.random() * 1800;
        log('focus returned (was not marked hidden) — resuming in', Math.round(delay), 'ms');
        STATE.tabResumeAt = Date.now() + delay;
        setTimeout(() => { if (!STATE.tabHidden) { STATE.lastFen = null; STATE.boardSignature = null; schedule(); } }, delay);
        return;
      }
      STATE.tabHidden = false;
      const delay = 1200 + Math.random() * 1800; // 1200-3000ms think delay
      STATE.tabResumeAt = Date.now() + delay;
      log('tab visible — resuming analysis in', Math.round(delay), 'ms (human look-back delay)');
      setStatus('resuming in ' + Math.round(delay) + 'ms', '#ffd166');
      setTimeout(() => {
        if (STATE.tabHidden) return;
        // force a fresh analysis pass on resume, and drop the delta snapshot:
        // several plies may have passed while hidden, so parity is unknown.
        STATE.lastFen = null;
        STATE.boardSignature = null;
        schedule();
      }, delay);
    }
  }
  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('blur', () => {
    // blur without visibilitychange (e.g. another window focused) — treat as
    // a soft hide but don't fully pause, just suppress new autoplay scheduling.
    if (!STATE.tabHidden) {
      log('window blurred — suppressing autoplay scheduling');
      if (STATE.pendingAutoMove) {
        clearTimeout(STATE.pendingAutoMove);
        STATE.pendingAutoMove = null;
      }
    }
  });
  window.addEventListener('focus', () => {
    if (!STATE.tabHidden && document.visibilityState === 'visible') {
      const delay = 800 + Math.random() * 1200;
      log('window focused — re-triggering analysis in', Math.round(delay), 'ms');
      setTimeout(() => { if (!STATE.tabHidden) { STATE.lastFen = null; STATE.boardSignature = null; schedule(); } }, delay);
    }
  });
})();
