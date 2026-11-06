// Chess AI Helper v4.0.4 - MV3 service worker
// debugger API removed. autoplay clicks now go through chrome.scripting.executeScript
// with world: "MAIN" so the injected function runs in the page's own JS context.
//
// v4.0.4: AUTOPLAY TRUTH FIX. a move is only credited when chess.com itself
// accepted it. the local game-model api paths (board.game.move and friends)
// slide the piece without submitting, so the site keeps the turn on you and
// the board is now one move ahead of the server. every api candidate now reads
// the mover's clock back; a local-only move is undone and the injector falls
// through to the human-shaped drag, which chess.com processes as real input.
// the content script also verifies the piece landed on its destination and
// gates one autoplay move per settled position.
//
// v4.0.1: APPLIED-check in the injector. board.game.move() returns without
// throwing when the board rejects a move (wrong turn, disabled board); the
// old injector credited it while the piece stayed put, and the retry ladder
// just re-fired the same dead call. every api candidate now verifies the
// from-square actually vacated, and a silent no-op falls through to the drag.
//
// v4.0.0: injector drag made human-shaped. pre-move cursor drift from a random
// nearby point onto the from-square, random grab offset, randomized step count
// and hold times, overshoot past the destination then settle-back, release
// 3px off center. chess.com's server-side heuristics score input-stream shape;
// pixel-perfect dead-center drags from rest are a machine tell.
// v3.3.1: chess.com's React board drops the wc-chess-board web component, exposes no .move() method, and
// only accepts DRAG (pointerdown → pointermove → pointerup) not tap-to-move.
// the injector now does a real drag sequence on the board element with
// intermediate pointermove steps, and uses setPointerCapture-aware dispatch.
//
// no chrome.debugger, no CDP, no yellow banner, no debugger permission.

const VERSION = '4.0.5';
const DEFAULTS = {
  enabled: true, depth: 22, multiPV: 3,
  skillLevel: 20, useEloLimit: false, elo: 1500,
  useCloudEval: true, showArrow: true, showEval: true,
  showPrediction: true, arrowsOnlyMyTurn: true,
  autoplay: false, autoplayMinDelay: 0, autoplayMaxDelay: 0,
  autoplaySide: 'auto', autoplayDepth: 8
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(DEFAULTS, (s) => {
    if (Object.keys(s).length === 0) chrome.storage.sync.set(DEFAULTS);
  });
});

// ============================================================
// page-world injection helpers
// ============================================================

// injected into the page's MAIN world. logs every path it tries so the
// console shows exactly what worked. tries programmatic API first, then
// a full DRAG sequence (pointerdown on piece, intermediate pointermove
// steps toward dest, pointerup on dest) on the board element.
//
// the drag is dispatched on the BOARD element (not the piece) because:
//  - chess.com's React board uses event delegation at the board container
//  - the board calls setPointerCapture(pointerId) in its pointerdown
//    handler, which redirects all subsequent pointer events for that
//    pointerId to the capturing element — so dispatching on the board
//    keeps the capture chain intact
//  - the board's pointermove handler internally calls
//    document.elementFromPoint(clientX, clientY) to find the target
//    square, so correct coordinates matter more than the dispatch target
//
// returns { ok, path, diag }.
// fromAlg/toAlg are the algebraic move (e.g. 'e7','e5') passed directly from
// the content script — these are authoritative. the pixel coords are only
// used for the drag fallback and MUST be pre-adjusted for flipped orientation
// by the caller (content.js coordToPixel already does this).
const INJECT_MOVE_FN = async (fromX, fromY, toX, toY, fromAlg, toAlg, moverSide, dragOnly) => {
  const W = window;
  const doc = document;
  const log = (...a) => { try { console.log('%c[injector]', 'color:#0ff', ...a); } catch(_) {} };

  const elAt = (x, y) => doc.elementFromPoint(x, y) || doc.body;

  const findBoard = () => {
    return doc.querySelector('wc-chess-board')
        || doc.querySelector('chess-board')
        || doc.querySelector('.board-board')
        || doc.querySelector('[class*="board-board"]')
        || doc.querySelector('.board')
        || (() => {
          const e = elAt(fromX, fromY);
          return e ? e.closest('wc-chess-board, chess-board, .board-board, [class*="board-board"], .board') : null;
        })();
  };

  const board = findBoard();
  const diag = {
    boardTag: board ? board.tagName : null,
    boardClass: board ? (board.className || '') : null,
    boardId: board ? board.id : null,
    hasMove: board ? typeof board.move === 'function' : false,
    hasGame: board && board.game ? typeof board.game.move === 'function' : false,
    reactFiber: board ? Object.keys(board).find(k => k.startsWith('__reactFiber')) : null,
    fromAlg, toAlg,
    triedPaths: []
  };
  log('board found:', diag.boardTag, diag.boardClass, 'reactFiber=', diag.reactFiber, 'move=', fromAlg, '->', toAlg);

  // ---- site receipt helpers ------------------------------------------------
  // a local game-model move slides the piece without telling the server. the
  // running clock is the site's own receipt: it stops for the side that moved.
  const boardFlipped = () => !!(board && (
    (board.classList && board.classList.contains('flipped')) ||
    (board.getAttribute && board.getAttribute('orientation') === 'black')
  ));

  const clockTurn = () => {
    const b = doc.querySelector('.clock-bottom, .player-bottom clock, clock-component.clock-bottom');
    const t = doc.querySelector('.clock-top, .player-top clock, clock-component.clock-top');
    if (!b || !t) return null;
    const bA = b.classList.contains('clock-player-turn');
    const tA = t.classList.contains('clock-player-turn');
    if (bA && !tA) return boardFlipped() ? 'b' : 'w';
    if (tA && !bA) return boardFlipped() ? 'w' : 'b';
    return null;
  };

  const undoLast = () => {
    const cands = [
      () => board.game && typeof board.game.undo === 'function' && board.game.undo(),
      () => board._game && typeof board._game.undo === 'function' && board._game.undo(),
      () => board.__chessboard__ && typeof board.__chessboard__.undo === 'function' && board.__chessboard__.undo(),
      () => W.game && typeof W.game.undo === 'function' && W.game.undo(),
      () => board.engine && typeof board.engine.undo === 'function' && board.engine.undo()
    ];
    for (const fn of cands) {
      try { fn(); log('undo issued'); return true; } catch (_) {}
    }
    return false;
  };

  // ============================================================
  // path 1: programmatic API on the board element
  // ============================================================
  // use the algebraic move passed in directly. do NOT recompute from pixels —
  // the content script already accounts for flipped orientation, and the
  // injector's pixel math cannot tell which side of the board the user is on.
  if (!dragOnly && board && fromAlg && toAlg) {
    const rankFrom = parseInt(fromAlg[1]) - 1;
    const rankTo   = parseInt(toAlg[1]) - 1;
    const isPromo  = (rankFrom === 6 && rankTo === 7) || (rankFrom === 1 && rankTo === 0);
    const mv  = { from: fromAlg, to: toAlg, promotion: isPromo ? 'q' : undefined };
    const uci = fromAlg + toAlg + (isPromo ? 'q' : '');
    log('api move object:', JSON.stringify(mv), 'uci=', uci);

    // v4.0.1: APPLIED-check. board.game.move({from,to}) does not throw when
    // the board rejects the move (wrong turn, disabled board) — it silently
    // returns and the old injector reported ok while the piece stayed put.
    // every api candidate now verifies the from-square actually vacated
    // before it is credited, and a silent no-op falls through to the drag
    // path instead of burning retries on the same dead call.
    const fromNum = ('abcdefgh'.indexOf(fromAlg[0]) + 1) + String(parseInt(fromAlg[1]));
    const fromPieceEl = () => doc.querySelector('.piece[class*="square-' + fromNum + '"]');
    const wait = (ms) => new W.Promise(r => W.setTimeout(r, ms));
    const didApply = async () => {
      if (!fromPieceEl()) return true;
      await wait(35); // some builds flush the square class a tick late
      return !fromPieceEl();
    };

    const tryCall = async (label, fn) => {
      try {
        fn();
        if (await didApply()) {
          // v4.0.4: a local game-model move slides the piece and never reaches
          // the server. chess.com stops the mover's clock on a real accepted
          // move, so read the clock back before crediting the path. a path that
          // moved the piece but left the turn where it was gets undone and the
          // ladder falls through to the next candidate / the drag.
          const ack = await siteAccepted(moverSide);
          if (ack === false) {
            diag.triedPaths.push(label + '(local-only)');
            log(label, 'moved the piece locally, site still has', moverSide, 'to move - undoing');
            undoLast();
            await wait(80);
            return false;
          }
          diag.triedPaths.push(label + '(applied' + (ack === true ? ',ack' : '') + ')');
          log('path: ' + label + ' APPLIED');
          return true;
        }
        diag.triedPaths.push(label + '(noop)');
        log(label, 'returned but piece still on', fromAlg, '- silent no-op, trying next');
      } catch (e) {
        diag.triedPaths.push(label + '(err:' + e.message + ')');
      }
      return false;
    };

    const siteAccepted = async (side) => {
      if (!side) return null;
      if (clockTurn() === null) return null; // no clock on this page: cannot verify
      for (let i = 0; i < 10; i++) {
        const t = clockTurn();
        if (t && t !== side) return true;  // clock left the mover: site took the move
        await wait(70);
      }
      return false;
    };

    const withObj = (o, key, uciForm) => (o && typeof o[key] === 'function') ? () => (uciForm ? o[key](uci) : o[key](mv)) : null;

    // chess.com board API shapes across builds. object form first, then UCI.
    if (await tryCall('board.move',        withObj(board, 'move')))         return { ok: true, path: 'board.move', diag };
    if (await tryCall('board.makeMove',    withObj(board, 'makeMove')))     return { ok: true, path: 'board.makeMove', diag };
    if (await tryCall('board.playMove',    withObj(board, 'playMove')))     return { ok: true, path: 'board.playMove', diag };
    if (await tryCall('board.game.move',   withObj(board.game, 'move')))    return { ok: true, path: 'board.game.move', diag };
    if (await tryCall('board.game.makeMove', withObj(board.game, 'makeMove'))) return { ok: true, path: 'board.game.makeMove', diag };
    if (await tryCall('board.__chessboard__.move', withObj(board.__chessboard__, 'move'))) return { ok: true, path: 'board.__chessboard__.move', diag };
    if (await tryCall('board._game.move',  withObj(board._game, 'move')))   return { ok: true, path: 'board._game.move', diag };
    if (await tryCall('board.engine.move', withObj(board.engine, 'move')))  return { ok: true, path: 'board.engine.move', diag };
    // UCI string forms (some builds take "e2e4" not {from,to})
    if (board && typeof board.move === 'function' && await tryCall('board.move.uci', () => board.move(uci))) return { ok: true, path: 'board.move.uci', diag };
    if (board && typeof board.makeMove === 'function' && await tryCall('board.makeMove.uci', () => board.makeMove(uci))) return { ok: true, path: 'board.makeMove.uci', diag };

    // React fiber walk: probe memoizedProps for move-handling callbacks
    try {
      const fiberKey = diag.reactFiber;
      if (fiberKey) {
        let fiber = board[fiberKey];
        let depth = 0;
        const movePropRegex = /move|makeMove|playMove|onMove|submitMove|handleMove|onPieceDrop|onDrop|onPieceMove/i;
        while (fiber && depth < 15) {
          const props = fiber.memoizedProps;
          if (props && typeof props === 'object') {
            for (const k of Object.keys(props)) {
              if (movePropRegex.test(k) && typeof props[k] === 'function') {
                log('react fiber prop candidate:', k, 'at depth', depth);
                if (await tryCall('react.' + k + '.obj', () => props[k]({ from: fromAlg, to: toAlg, promotion: isPromo ? 'q' : undefined, source: 'drag' }))) return { ok: true, path: 'react.' + k, diag };
                if (await tryCall('react.' + k + '.uci', () => props[k](uci))) return { ok: true, path: 'react.' + k + '.uci', diag };
                if (await tryCall('react.' + k + '.fromto', () => props[k](fromAlg, toAlg))) return { ok: true, path: 'react.' + k + '.fromto', diag };
              }
            }
          }
          // also probe stateNode for game store references
          const sn = fiber.stateNode;
          if (sn && typeof sn === 'object' && sn !== board) {
            for (const k of Object.keys(sn)) {
              if (/game|store|board|chess/i.test(k) && sn[k] && typeof sn[k] === 'object') {
                for (const mk of Object.keys(sn[k])) {
                  if (/move|makeMove|playMove|submitMove/i.test(mk) && typeof sn[k][mk] === 'function') {
                    log('react stateNode candidate:', k + '.' + mk);
                    if (await tryCall('react.sn.' + k + '.' + mk, () => sn[k][mk]({ from: fromAlg, to: toAlg, promotion: isPromo ? 'q' : undefined }))) return { ok: true, path: 'react.sn.' + k + '.' + mk, diag };
                  }
                }
              }
            }
          }
          fiber = fiber.return;
          depth++;
        }
        log('react fiber walk exhausted at depth', depth);
      }
    } catch (e) {
      log('react fiber walk error:', e.message);
    }

    // global game store probes
    const globals = ['chessBoard', 'game', 'chessGame', 'board', 'ChessBoard', 'gameStore'];
    for (const g of globals) {
      try {
        const ref = W[g];
        if (ref && typeof ref === 'object') {
          for (const mk of Object.keys(ref)) {
            if (/move|makeMove|playMove|submitMove/i.test(mk) && typeof ref[mk] === 'function') {
              log('global candidate:', g + '.' + mk);
              if (await tryCall('global.' + g + '.' + mk, () => ref[mk]({ from: fromAlg, to: toAlg, promotion: isPromo ? 'q' : undefined }))) return { ok: true, path: 'global.' + g + '.' + mk, diag };
            }
          }
        }
      } catch (_) {}
    }
  }

  // ============================================================
  // path 2: full DRAG sequence in page world
  // ============================================================
  // chess.com's React board only accepts drag, not tap-to-move. the drag is:
  //   pointerdown on the piece (at piece center)
  //   N intermediate pointermove steps toward dest (for realistic drag + to
  //     trigger the board's drag-tracking handler)
  //   pointermove to dest center
  //   pointerup at dest center
  //
  // ALL events dispatched on the BOARD element so setPointerCapture stays
  // intact. coordinates carry the real hit-test info via clientX/clientY.
  if (!board) {
    log('no board element found, aborting');
    return { ok: false, err: 'no board', diag };
  }

  const fire = (type, x, y, isDown) => {
    const isMove = type === 'move';
    const opts = {
      bubbles: true, cancelable: true, composed: true,
      view: W,
      clientX: x, clientY: y, screenX: x, screenY: y,
      button: 0, buttons: isDown ? 1 : (isMove ? 1 : 0),
      pointerType: 'mouse', pointerId: 1, isPrimary: true,
      width: 1, height: 1,
      pressure: isDown ? 0.5 : (isMove ? 0.5 : 0),
      tiltX: 0, tiltY: 0,
      detail: 0
    };
    try { board.dispatchEvent(new W.PointerEvent('pointer' + type, opts)); } catch (_) {}
    const mo = {
      bubbles: true, cancelable: true, composed: true, view: W,
      clientX: x, clientY: y, screenX: x, screenY: y,
      button: 0, buttons: isDown ? 1 : (isMove ? 1 : 0),
      detail: 0
    };
    try { board.dispatchEvent(new W.MouseEvent('mouse' + type, mo)); } catch (_) {}
  };

  log('starting drag:', fromX, fromY, '->', toX, toY);

  // 0. pre-move drift: the cursor first glides from a random nearby point
  // toward the piece, the way a hand sweeps onto the square. several gentle
  // pointermove events, no buttons held. chess.com's behavioral telemetry
  // keys on the input stream having a human-shaped approach, not on any
  // single event.
  const drift = () => ({
    x: fromX + (Math.random() - 0.5) * 140,
    y: fromY + (Math.random() - 0.5) * 100
  });
  const d0 = drift();
  const driftSteps = 2 + Math.floor(Math.random() * 2); // 2-3 steps
  for (let i = 1; i <= driftSteps; i++) {
    const t = i / driftSteps;
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    fire('move', d0.x + (fromX - d0.x) * e, d0.y + (fromY - d0.y) * e, false);
    await new W.Promise(r => W.setTimeout(r, 20 + Math.floor(Math.random() * 30)));
  }

  // 1. pointerdown on the piece, offset from square center so the grab
  // point is not pixel-perfect every time
  const grabJitter = () => ({
    x: fromX + (Math.random() - 0.5) * Math.max(8, Math.abs(fromX - toX) * 0.06),
    y: fromY + (Math.random() - 0.5) * Math.max(8, Math.abs(fromY - toY) * 0.06)
  });
  const g = grabJitter();
  fire('down', g.x, g.y, true);
  await new W.Promise(r => W.setTimeout(r, 50 + Math.floor(Math.random() * 50))); // 50-100ms hold

  // 2. intermediate pointermove steps (realistic drag curve), randomized count and ease
  const steps = 4 + Math.floor(Math.random() * 3); // 4-6 steps
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    // ease-in-out so the drag doesn't look linear
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const mx = g.x + (toX - g.x) * e;
    const my = g.y + (toY - g.y) * e;
    fire('move', mx, my, false);
    await new W.Promise(r => W.setTimeout(r, 12 + Math.floor(Math.random() * 16)));
  }

  // 3. overshoot past the target, then settle back. humans release the
  // mouse slightly past the drop square and correct. overshoot is 6-18px
  // along the drag direction, settle-back lands 1-3px from center.
  const dxn = toX - g.x, dyn = toY - g.y;
  const len = Math.sqrt(dxn * dxn + dyn * dyn) || 1;
  const ov = 6 + Math.random() * 12;
  fire('move', toX + (dxn / len) * ov, toY + (dyn / len) * ov, false);
  await new W.Promise(r => W.setTimeout(r, 15 + Math.floor(Math.random() * 20)));
  const sox = toX + (Math.random() - 0.5) * 6; // +/- 3px final
  const soy = toY + (Math.random() - 0.5) * 6;
  fire('move', sox, soy, false);
  await new W.Promise(r => W.setTimeout(r, 25 + Math.floor(Math.random() * 30)));

  // 4. pointerup at the settle point (dest center +/- 3px, still inside square)
  fire('up', sox, soy, false);
  log('drag complete');

  diag.triedPaths.push('drag');
  return { ok: true, path: 'drag', diag };
};

// injected into the page's MAIN world for the promotion chooser.
// taps the queen option at the given pixel. chess.com's promotion
// picker is a regular DOM overlay so a pointer tap on it works.
const INJECT_TAP_FN = async (x, y) => {
  const W = window;
  const el = document.elementFromPoint(x, y) || document.body;
  // dispatch on the element itself for the picker (no pointer capture here)
  const fire = (target, type, isDown) => {
    const opts = {
      bubbles: true, cancelable: true, composed: true, view: W,
      clientX: x, clientY: y, screenX: x, screenY: y,
      button: 0, buttons: isDown ? 1 : 0,
      pointerType: 'mouse', pointerId: 1, isPrimary: true,
      width: 1, height: 1, pressure: isDown ? 0.5 : 0
    };
    try { target.dispatchEvent(new W.PointerEvent('pointer' + type, opts)); } catch (_) {}
    try { target.dispatchEvent(new W.MouseEvent('mouse' + type, {
      bubbles: true, cancelable: true, composed: true, view: W,
      clientX: x, clientY: y, button: 0, buttons: isDown ? 1 : 0
    })); } catch (_) {}
  };
  fire(el, 'down', true);
  fire(el, 'move', false);
  fire(el, 'up', false);
  try { el.dispatchEvent(new W.MouseEvent('click', {
    bubbles: true, cancelable: true, composed: true, view: W,
    clientX: x, clientY: y, button: 0, detail: 1
  })); } catch (_) {}
  return { ok: true, tag: el.tagName, cls: el.className };
};

// injected into the page's MAIN world to roll back a move that only touched
// chess.com's local game model. undo() is the exact counterpart of the
// game.move()/makeMove() calls the injector can make, so it is a no-op when
// the move was never applied locally.
const INJECT_UNDO_FN = async () => {
  const W = window;
  const doc = document;
  const log = (...a) => { try { console.log('%c[injector]', 'color:#0ff', ...a); } catch(_) {} };
  const board = doc.querySelector('wc-chess-board')
             || doc.querySelector('chess-board')
             || doc.querySelector('.board-board')
             || doc.querySelector('[class*="board-board"]');
  if (!board) return { ok: false, err: 'no board' };
  const cands = [
    ['board.game.undo',   () => board.game && typeof board.game.undo === 'function' && board.game.undo()],
    ['board._game.undo',  () => board._game && typeof board._game.undo === 'function' && board._game.undo()],
    ['board.__chessboard__.undo', () => board.__chessboard__ && typeof board.__chessboard__.undo === 'function' && board.__chessboard__.undo()],
    ['board.undo',        () => typeof board.undo === 'function' && board.undo()],
    ['global.game.undo',  () => W.game && typeof W.game.undo === 'function' && W.game.undo()],
    ['board.engine.undo', () => board.engine && typeof board.engine.undo === 'function' && board.engine.undo()]
  ];
  for (const [label, fn] of cands) {
    try {
      fn();
      log('undo issued via', label);
      return { ok: true, path: label };
    } catch (_) {}
  }
  return { ok: false, err: 'no undo path' };
};

// ============================================================
// message router
// ============================================================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'PING') {
    sendResponse({ ok: true, version: VERSION });
    return;
  }

  const tabId = sender && sender.tab && sender.tab.id;
  if (!tabId) { sendResponse({ ok: false, err: 'no tab' }); return; }

  if (msg.type === 'CLICK_MOVE') {
    const { fromX, fromY, toX, toY, fromAlg, toAlg, moverSide, dragOnly } = msg;
    chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: INJECT_MOVE_FN,
      args: [fromX, fromY, toX, toY, fromAlg, toAlg, moverSide || null, !!dragOnly]
    }).then(res => {
      const out = (res && res[0] && res[0].result) || { ok: false, err: 'no result' };
      sendResponse(out);
    }).catch(e => sendResponse({ ok: false, err: String(e && e.message || e) }));
    return true; // async
  }

  if (msg.type === 'REVERT_MOVE') {
    chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: INJECT_UNDO_FN,
      args: []
    }).then(res => {
      const out = (res && res[0] && res[0].result) || { ok: false, err: 'no result' };
      sendResponse(out);
    }).catch(e => sendResponse({ ok: false, err: String(e && e.message || e) }));
    return true;
  }

  if (msg.type === 'CLICK_TAP') {
    const { x, y } = msg;
    chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: INJECT_TAP_FN,
      args: [x, y]
    }).then(res => {
      const out = (res && res[0] && res[0].result) || { ok: false, err: 'no result' };
      sendResponse(out);
    }).catch(e => sendResponse({ ok: false, err: String(e && e.message || e) }));
    return true;
  }

  // diagnostic: probe the board element's shape and return everything we find.
  // useful for debugging when moves don't register.
  if (msg.type === 'PROBE_BOARD') {
    chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        const doc = document;
        const sel = ['wc-chess-board', 'chess-board', '.board-board', '[class*="board-board"]', '.board'];
        let board = null;
        for (const s of sel) { board = doc.querySelector(s); if (board) break; }
        if (!board) return { ok: false, err: 'no board element found' };
        const methods = [];
        for (const k of Object.getOwnPropertyNames(Object.getPrototypeOf(board))) {
          if (typeof board[k] === 'function' && /move|play|drop|drag|click|select/i.test(k)) methods.push(k);
        }
        const ownKeys = Object.keys(board).filter(k => typeof board[k] === 'function');
        const fiberKey = Object.keys(board).find(k => k.startsWith('__reactFiber'));
        const propsKey = Object.keys(board).find(k => k.startsWith('__reactProps'));
        let reactProps = null;
        if (propsKey) {
          try {
            const p = board[propsKey];
            reactProps = Object.keys(p || {}).filter(k => typeof p[k] === 'function');
          } catch (_) {}
        }
        let fiberWalk = [];
        if (fiberKey) {
          let fiber = board[fiberKey];
          let depth = 0;
          while (fiber && depth < 8) {
            const props = fiber.memoizedProps;
            if (props && typeof props === 'object') {
              const fnKeys = Object.keys(props).filter(k => typeof props[k] === 'function');
              if (fnKeys.length) fiberWalk.push({ depth, keys: fnKeys });
            }
            fiber = fiber.return;
            depth++;
          }
        }
        return {
          ok: true,
          tag: board.tagName,
          class: board.className,
          id: board.id,
          protoMethods: methods,
          ownMethods: ownKeys,
          fiberKey, propsKey, reactProps, fiberWalk
        };
      }
    }).then(res => {
      const out = (res && res[0] && res[0].result) || { ok: false, err: 'no result' };
      sendResponse(out);
    }).catch(e => sendResponse({ ok: false, err: String(e && e.message || e) }));
    return true;
  }

  sendResponse({ ok: false, err: 'unknown type' });
});
