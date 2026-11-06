const DEFAULTS = {
  enabled: true, depth: 22, multiPV: 3,
  skillLevel: 20, useEloLimit: false, elo: 1500,
  useCloudEval: true, showArrow: true, showEval: true,
  showPrediction: true, arrowsOnlyMyTurn: true,
  autoplay: false, autoplayMinDelay: 0, autoplayMaxDelay: 0,
  autoplaySide: 'auto', autoplayDepth: 8
};

const KEYS = Object.keys(DEFAULTS);
const TOGGLE_KEYS = ['enabled','showArrow','arrowsOnlyMyTurn','showEval','showPrediction','useCloudEval','useEloLimit','autoplay'];

chrome.storage.sync.get(DEFAULTS, (s) => {
  KEYS.forEach(k => {
    const el = document.getElementById(k);
    if (el) {
      if (el.tagName === 'INPUT' && el.type === 'number') el.value = s[k];
      else if (el.tagName === 'SELECT') el.value = s[k];
    }
  });
  // init toggles
  TOGGLE_KEYS.forEach(k => {
    const tog = document.querySelector('.toggle[data-key="' + k + '"]');
    if (tog) {
      if (s[k]) tog.classList.add('on');
      tog.addEventListener('click', () => {
        const newVal = !tog.classList.contains('on');
        tog.classList.toggle('on', newVal);
        chrome.storage.sync.set({ [k]: newVal });
      });
    }
  });
  updateEloRow();
});

// number inputs
['depth','multiPV','skillLevel','elo','autoplayMinDelay','autoplayMaxDelay','autoplayDepth'].forEach(k => {
  const el = document.getElementById(k);
  if (!el) return;
  el.addEventListener('input', () => {
    const v = parseInt(el.value);
    if (!isNaN(v)) chrome.storage.sync.set({ [k]: v });
  });
});

// select
const sideSel = document.getElementById('autoplaySide');
if (sideSel) {
  sideSel.addEventListener('change', (e) => {
    chrome.storage.sync.set({ autoplaySide: e.target.value });
  });
}

// elo row reveal on elo-cap toggle click (the toggle itself re-inits above;
// this only refreshes the row enable state)
const eloLimitEl = document.getElementById('useEloLimit');
if (eloLimitEl) {
  eloLimitEl.addEventListener('click', () => {
    setTimeout(updateEloRow, 50);
  });
}

function updateEloRow() {
  const tog = document.querySelector('.toggle[data-key="useEloLimit"]');
  if (!tog) return;
  const on = tog.classList.contains('on');
  const row = document.getElementById('eloRow');
  if (!row) return;
  row.style.opacity = on ? '1' : '0.4';
  row.style.pointerEvents = on ? 'auto' : 'none';
}
