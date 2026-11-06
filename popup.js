// popup.js - settings + engine roster UI.
// engines/registry.js loads before this file and exposes window.ChessAIEngines.

const REG = window.ChessAIEngines;

const DEFAULTS = {
  enabled: true, depth: 22, multiPV: 3,
  skillLevel: 20, useEloLimit: false, elo: 1500,
  useCloudEval: true, showArrow: true, showEval: true,
  showPrediction: true, arrowsOnlyMyTurn: true,
  autoplay: false, autoplayMinDelay: 0, autoplayMaxDelay: 0,
  autoplaySide: 'auto', autoplayDepth: 8,
  engineId: REG ? REG.DEFAULT_ENGINE : 'stockfish19lite',
  engineOptions: {},
  bridgePort: 8765
};

const KEYS = Object.keys(DEFAULTS);
const TOGGLE_KEYS = ['enabled','showArrow','arrowsOnlyMyTurn','showEval','showPrediction','useCloudEval','useEloLimit','autoplay'];

// live copy of storage; engine option edits merge into this
let state = Object.assign({}, DEFAULTS);

function save(obj) {
  Object.assign(state, obj);
  chrome.storage.sync.set(obj);
}

function renderBlurb(id) {
  const el = document.getElementById('engineBlurb');
  if (!el || !REG) return;
  const spec = REG.get(id);
  const transport = spec.requiresBridge ? 'Native · bridge on 127.0.0.1' : 'In-browser WASM';
  el.innerHTML = '<b>' + spec.name + '</b><span class="badge">' + spec.role + '</span><br>' +
    spec.blurb + '<br><span style="color:#5a6378">' + transport + ' · Elo ' +
    spec.elo.min + '-' + spec.elo.max + '</span>';
}

function setEngineOption(id, key, value) {
  const all = Object.assign({}, state.engineOptions || {});
  const mine = Object.assign({}, all[id] || {});
  mine[key] = value;
  all[id] = mine;
  save({ engineOptions: all });
}

function renderEngineOptions(id) {
  const wrap = document.getElementById('engineOptions');
  if (!wrap || !REG) return;
  wrap.innerHTML = '';
  const spec = REG.get(id);
  const saved = (state.engineOptions && state.engineOptions[id]) || {};
  const values = REG.resolveOptions(id, saved);

  for (const opt of spec.options) {
    const row = document.createElement('div');
    row.className = 'opt-row';

    const label = document.createElement('label');
    label.textContent = opt.label;
    label.htmlFor = 'opt-' + opt.key;
    row.appendChild(label);

    const value = values[opt.key];
    let input;

    if (opt.type === 'bool') {
      input = document.createElement('div');
      input.className = 'toggle' + (value ? ' on' : '');
      input.id = 'opt-' + opt.key;
      input.addEventListener('click', () => {
        const on = !input.classList.contains('on');
        input.classList.toggle('on', on);
        setEngineOption(id, opt.key, on);
      });
      row.appendChild(input);
    } else if (opt.type === 'select') {
      input = document.createElement('select');
      for (const choice of opt.choices) {
        const o = document.createElement('option');
        o.value = choice;
        o.textContent = choice;
        input.appendChild(o);
      }
      input.id = 'opt-' + opt.key;
      input.value = value;
      input.addEventListener('change', () => setEngineOption(id, opt.key, input.value));
      row.appendChild(input);
    } else {
      input = document.createElement('input');
      input.type = opt.type === 'text' ? 'text' : 'number';
      if (opt.min !== undefined) input.min = opt.min;
      if (opt.max !== undefined) input.max = opt.max;
      input.step = opt.step !== undefined ? opt.step : (opt.type === 'float' ? 0.1 : 1);
      input.id = 'opt-' + opt.key;
      input.value = value;
      input.addEventListener('input', () => {
        if (opt.type === 'text') { setEngineOption(id, opt.key, input.value); return; }
        const n = Number(input.value);
        if (!isFinite(n)) return;
        setEngineOption(id, opt.key, n);
      });
      row.appendChild(input);
    }
    wrap.appendChild(row);
  }

  const bridgeRow = document.getElementById('bridgeRow');
  const bridgeNote = document.getElementById('bridgeNote');
  if (bridgeRow) bridgeRow.style.display = spec.requiresBridge ? 'flex' : 'none';
  if (bridgeNote) bridgeNote.style.display = spec.requiresBridge ? 'block' : 'none';
}

function renderEnginePicker(selected) {
  const sel = document.getElementById('engineId');
  if (!sel || !REG) return;

  sel.innerHTML = '';
  for (const spec of REG.list()) {
    const o = document.createElement('option');
    o.value = spec.id;
    o.textContent = spec.name;
    sel.appendChild(o);
  }

  const id = REG.ENGINES[selected] ? selected : REG.DEFAULT_ENGINE;
  sel.value = id;

  renderBlurb(id);
  renderEngineOptions(id);

  sel.addEventListener('change', () => {
    const next = sel.value;
    save({ engineId: next });
    renderBlurb(next);
    renderEngineOptions(next);
  });
}

chrome.storage.sync.get(DEFAULTS, (s) => {
  state = Object.assign({}, DEFAULTS, s);

  KEYS.forEach(k => {
    const el = document.getElementById(k);
    if (el) {
      if (el.tagName === 'INPUT' && el.type === 'number') el.value = state[k];
      else if (el.tagName === 'SELECT') el.value = state[k];
    }
  });

  TOGGLE_KEYS.forEach(k => {
    const tog = document.querySelector('.toggle[data-key="' + k + '"]');
    if (!tog) return;
    if (state[k]) tog.classList.add('on');
    tog.addEventListener('click', () => {
      const newVal = !tog.classList.contains('on');
      tog.classList.toggle('on', newVal);
      save({ [k]: newVal });
    });
  });

  // engine roster
  renderEnginePicker(state.engineId);

  const portEl = document.getElementById('bridgePort');
  if (portEl) {
    portEl.value = state.bridgePort || 8765;
    portEl.addEventListener('input', () => {
      const n = parseInt(portEl.value, 10);
      if (!isNaN(n) && n >= 1024 && n <= 65535) save({ bridgePort: n });
    });
  }

  updateEloRow();
});

// number inputs
['depth','autoplayMinDelay','autoplayMaxDelay','autoplayDepth'].forEach(k => {
  const el = document.getElementById(k);
  if (!el) return;
  el.addEventListener('input', () => {
    const v = parseInt(el.value);
    if (!isNaN(v)) save({ [k]: v });
  });
});

// select
const sideSel = document.getElementById('autoplaySide');
if (sideSel) {
  sideSel.addEventListener('change', (e) => {
    save({ autoplaySide: e.target.value });
  });
}

// elo row reveal on elo-cap toggle click (only present on old builds)
const eloLimitEl = document.getElementById('useEloLimit');
if (eloLimitEl) {
  eloLimitEl.addEventListener('click', () => {
    setTimeout(updateEloRow, 50);
  });
}

function updateEloRow() {
  const tog = document.querySelector('.toggle[data-key="useEloLimit"]');
  if (!tog) return;
  const row = document.getElementById('eloRow');
  if (!row) return;
  const on = tog.classList.contains('on');
  row.style.opacity = on ? '1' : '0.4';
  row.style.pointerEvents = on ? 'auto' : 'none';
}
