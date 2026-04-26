const app = document.getElementById('app');
const USE_HTML_RESULT = true;

const TERMINAL_OPTIONS = {
  JFK: ['Terminal 1', 'Terminal 4', 'Terminal 5', 'Terminal 7', 'Terminal 8'],
  LGA: ['Terminal A', 'Terminal B', 'Terminal C'],
  EWR: ['Terminal A', 'Terminal B', 'Terminal C']
};

const DEFAULT_TERMINAL_BY_AIRPORT = {
  JFK: 'Terminal 4',
  LGA: 'Terminal B',
  EWR: 'Terminal A'
};

const LOCAL_ADDRESS_SUGGESTIONS = [
  '68 Berkeley Place, Brooklyn, NY 11217',
  '142 W 57th St, New York, NY 10019',
  '1 World Trade Center, New York, NY 10007',
  '15 Hudson Yards, New York, NY 10001'
];

const TRAVEL_STYLE_META = {
  Relaxed: {
    label: 'Relaxed',
    desc: 'Extra buffer for a low stress airport experience'
  },
  Balanced: {
    label: 'Balanced',
    desc: 'A comfortable arrival window with some buffer time'
  },
  Tight: {
    label: 'Tight',
    desc: 'Less time at the airport overall'
  }
};

function normalizeTravelStyleKey(raw) {
  const s = String(raw || '').trim();
  if (s === 'Cut it close') return 'Tight';
  if (s === 'No rush') return 'Relaxed';
  if (TRAVEL_STYLE_META[s]) return s;
  const lower = s.toLowerCase();
  if (lower.includes('tight') || lower.includes('cut')) return 'Tight';
  if (lower.includes('relaxed') || lower.includes('no rush')) return 'Relaxed';
  if (lower.includes('balanced')) return 'Balanced';
  return 'Balanced';
}

function syncSettingsTravelStyleUI() {
  const valueEl = document.getElementById('settingsTravelStyleValue');
  const descEl = document.getElementById('settingsTravelStyleDesc');
  if (!valueEl || !descEl) return;
  const key = normalizeTravelStyleKey(
    window.appState?.selections?.style ?? getActiveSelection('style')
  );
  const meta = TRAVEL_STYLE_META[key] || TRAVEL_STYLE_META.Balanced;
  valueEl.textContent = meta.label;
  descEl.textContent = meta.desc;
}

window.syncSettingsTravelStyleUI = syncSettingsTravelStyleUI;

if (window.navigationApi) {
  window.navigationApi.init();
}
if (window.selectionsApi) {
  window.selectionsApi.init();
}
initializeAirportTerminalSelects();
initializeStartingLocationAutocomplete();
if (window.syncSettingsTravelStyleUI) {
  window.syncSettingsTravelStyleUI();
}

function initializeAirportTerminalSelects() {
  const airportSelect = document.getElementById('airportInput');
  const terminalSelect = document.getElementById('terminalInput');
  if (!airportSelect || !terminalSelect) return;

  const syncTerminalOptions = () => {
    const airport = airportSelect.value || 'JFK';
    const options = TERMINAL_OPTIONS[airport] || TERMINAL_OPTIONS.JFK;
    const previousValue = terminalSelect.value;

    terminalSelect.innerHTML = options
      .map(option => `<option value="${option}">${option}</option>`)
      .join('');

    const nextTerminal = options.includes(previousValue)
      ? previousValue
      : (DEFAULT_TERMINAL_BY_AIRPORT[airport] || options[0]);

    terminalSelect.value = nextTerminal;

    if (window.appState) {
      window.appState.form.airport = airport;
      window.appState.form.terminal = nextTerminal;
    }
  };

  airportSelect.addEventListener('change', syncTerminalOptions);
  terminalSelect.addEventListener('change', () => {
    if (window.appState) {
      window.appState.form.terminal = terminalSelect.value;
    }
  });

  syncTerminalOptions();
}

function initializeStartingLocationAutocomplete() {
  const input = document.getElementById('startingLocationInput');
  const suggestionsEl = document.getElementById('locationSuggestions');
  if (!input || !suggestionsEl) return;

  const locationCard = input.closest('.startingLocationCard');
  let suggestTimer = null;
  let suggestSeq = 0;

  const setSuggestionsOpen = (open) => {
    locationCard?.classList.toggle('startingLocationCard--suggestionsOpen', open);
  };

  const closeSuggestions = () => {
    suggestionsEl.classList.remove('active');
    suggestionsEl.innerHTML = '';
    setSuggestionsOpen(false);
  };

  const openSuggestions = (items) => {
    if (!items.length) {
      closeSuggestions();
      return;
    }

    suggestionsEl.innerHTML = '';
    items.forEach((item) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'locationSuggestionItem';
      button.textContent = item;
      button.addEventListener('mousedown', (event) => {
        event.preventDefault();
        const value = button.textContent || '';
        input.value = value;
        if (window.appState) window.appState.form.startLocation = value;
        clearStartingLocationValidation();
        closeSuggestions();
      });
      suggestionsEl.appendChild(button);
    });
    suggestionsEl.classList.add('active');
    setSuggestionsOpen(true);
  };

  const fetchMapboxSuggestions = async (rawQuery) => {
    const q = String(rawQuery || '').trim();
    if (q.length < 3) return [];
    try {
      const res = await fetch(`/api/places-suggest?q=${encodeURIComponent(q)}`);
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data.suggestions) ? data.suggestions.filter(Boolean) : [];
    } catch {
      return [];
    }
  };

  const mergeSuggestions = (remote, local) => {
    const seen = new Set();
    const out = [];
    [...remote, ...local].forEach((label) => {
      const display = formatAddressForDisplay(String(label));
      const key = display.toLowerCase();
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push(display);
    });
    return out.slice(0, 8);
  };

  const runSuggestions = async () => {
    const raw = input.value.trim();
    const query = raw.toLowerCase();
    if (query.length < 3) {
      closeSuggestions();
      return;
    }
    const seq = ++suggestSeq;
    const localMatches = LOCAL_ADDRESS_SUGGESTIONS.filter((item) => item.toLowerCase().includes(query));
    const remote = await fetchMapboxSuggestions(raw);
    if (seq !== suggestSeq) return;
    openSuggestions(mergeSuggestions(remote, localMatches));
  };

  const scheduleSuggestions = () => {
    if (suggestTimer) clearTimeout(suggestTimer);
    suggestTimer = setTimeout(() => {
      suggestTimer = null;
      void runSuggestions();
    }, 220);
  };

  input.addEventListener('input', () => {
    clearStartingLocationValidation();
    scheduleSuggestions();
  });

  input.addEventListener('focus', () => {
    if (input.value.trim().length >= 3) scheduleSuggestions();
  });

  input.addEventListener('blur', () => {
    const normalized = formatAddressForDisplay(input.value);
    if (normalized !== input.value) {
      input.value = normalized;
      if (window.appState) window.appState.form.startLocation = normalized;
    }
    setTimeout(closeSuggestions, 120);
  });
}

function clearStartingLocationValidation() {
  const el = document.getElementById('startingLocationValidation');
  if (!el) return;
  el.textContent = '';
  el.hidden = true;
}

function showStartingLocationValidation(message) {
  const el = document.getElementById('startingLocationValidation');
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
}
function getActiveSelection(groupName) {
  if (window.selectionsApi) {
    return window.selectionsApi.getActive(groupName);
  }
  if (window.stateApi) {
    return window.stateApi.getSelection(groupName);
  }
  const group = document.querySelector(`[data-group="${groupName}"]`);
  const chip = group?.querySelector('.chip.active');
  if (!chip) return '';
  const explicit = chip.getAttribute('data-selection');
  if (explicit) return explicit.trim();
  const label = chip.querySelector('.styleChipLabel');
  if (label) return label.textContent.trim();
  return chip.textContent.trim();
}

function minutesForSelection() {
  const transport = getActiveSelection('transport');
  const luggage = getActiveSelection('luggage');
  const security = getActiveSelection('security');
  const boarding = getActiveSelection('boarding');
  const style = normalizeTravelStyleKey(getActiveSelection('style'));

  let travel = 45;
  let airport = 35;
  let buffer = 15;

  if (transport === 'Transit') travel += 20;
  if (transport === 'Drive & park') travel += 15;
  if (transport === 'Drop-off') travel -= 5;

  if (luggage === 'Checking bags') airport += 25;
  if (luggage === 'Bag drop') airport += 15;

  if (security === 'Standard') airport += 25;
  if (security === 'CLEAR + PreCheck') airport -= 10;

  if (boarding === 'Lounge') airport += 35;
  if (boarding === 'Grab food') airport += 20;

  if (style === 'Tight') buffer -= 10;
  if (style === 'Relaxed') buffer += 25;

  return { travel, airport, buffer, total: travel + airport + buffer };
}

function formatTime(date) {
  return date.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit'
  });
}

function calculateETA() {
  if (window.stateApi) {
    window.stateApi.syncFormFromDom();
  }

  const startLocationRaw = (
    window.appState?.form?.startLocation
    ?? document.getElementById('startingLocationInput')?.value
    ?? ''
  ).trim();
  if (!startLocationRaw) {
    showStartingLocationValidation('Add a starting address to calculate your ETA.');
    return;
  }
  clearStartingLocationValidation();

  const flightTimeValue = window.appState?.form?.flightTime || document.getElementById('flightTime')?.value || '19:30';
  const [hours, minutes] = flightTimeValue.split(':').map(Number);

  const flight = new Date();
  flight.setHours(hours, minutes, 0, 0);

  const timing = minutesForSelection();
  const leave = new Date(flight.getTime() - timing.total * 60000);

  const etaResult = {
    leaveBy: formatTime(leave),
    flightTime: formatTime(flight),
    airport: window.appState?.form?.airport || document.getElementById('airportInput')?.value || 'JFK',
    travel: timing.travel,
    airportTime: timing.airport,
    buffer: timing.buffer,
    total: timing.total,
    style: getActiveSelection('style')
  };

  if (window.stateApi) {
    window.stateApi.setEta(etaResult);
  }

  localStorage.setItem('etaResult', JSON.stringify(etaResult));

  show('loading');

  setTimeout(() => {
    renderResult();
    show('result');
  }, 1200);
}

function renderResult() {
  const stored = JSON.parse(localStorage.getItem('etaResult') || '{}');
  const result = {
    ...stored,
    ...(window.appState?.eta || {})
  };

  const leaveEl = document.getElementById('dynamicLeaveBy');
  const summaryEl = document.getElementById('dynamicSummary');

  if (leaveEl) leaveEl.textContent = result.leaveBy || '5:42 PM';

  if (summaryEl) {
    summaryEl.innerHTML = `
      <div>Flight: ${result.flightTime || '7:30 PM'} from ${result.airport || 'JFK'}</div>
      <div>Travel time: ${result.travel || 45} min</div>
      <div>Airport time: ${result.airportTime || 35} min</div>
      <div>Buffer: ${result.buffer || 15} min</div>
      <div>Total planning window: ${result.total || 95} min</div>
    `;
  }

  renderHtmlResult(result);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Strip country suffix for UI only (geocoding still tolerates the trimmed string). */
function formatAddressForDisplay(value) {
  let s = String(value ?? '').trim();
  if (!s) return '';
  s = s.replace(/,\s*United States\s*$/i, '');
  s = s.replace(/,\s*USA\s*$/i, '');
  s = s.replace(/\s+United States\s*$/i, '');
  s = s.replace(/\s+USA\s*$/i, '');
  return s.trim();
}

function ensureHtmlResultContainer() {
  const resultSection = document.getElementById('result');
  if (!resultSection) return null;

  let container = resultSection.querySelector('.resultHtmlContainer');
  if (!container) {
    container = document.createElement('div');
    container.className = 'resultHtmlContainer';
    resultSection.appendChild(container);
  }

  return container;
}

function renderHtmlResult(result) {
  const resultSection = document.getElementById('result');
  if (!resultSection) return;

  resultSection.classList.toggle('useHtmlResult', USE_HTML_RESULT);
  if (!USE_HTML_RESULT) return;

  const container = ensureHtmlResultContainer();
  if (!container) return;

  const form = window.appState?.form || {};
  const selections = window.appState?.selections || {};
  const paceMessage = getPaceMessage(result);
  const airportLabel = (result.airport || form.airport || 'JFK').trim();
  const terminalLabel = (form.terminal || 'Terminal 4').trim();
  const startForDisplay = formatAddressForDisplay(form.startLocation || '').trim();
  const flightDetail = startForDisplay
    ? `Domestic flight · ${airportLabel} · ${terminalLabel} · From ${startForDisplay}`
    : `Domestic flight · ${airportLabel} · ${terminalLabel}`;
  const securityWait = getSecurityWaitEstimate(result, selections);

  container.innerHTML = `
    <div class="resultHtmlHeader">
      <h2 class="resultHtmlTitle">Your ETA</h2>
      <button class="resultHtmlEdit" onclick="show('calculate')">Edit</button>
    </div>
    <div class="resultHeroCard">
      <div class="resultHtmlEyebrow">Leave at</div>
      <div class="resultHeroClock" aria-hidden="true">
        <svg viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="9"></circle>
          <path d="M12 7v5l3 2"></path>
        </svg>
      </div>
      <div class="resultHtmlTime">${escapeHtml(result.leaveBy || '5:42 PM')}</div>
      <div class="resultHtmlStatus">${escapeHtml(paceMessage)}</div>
      <div class="resultHtmlFlight">${escapeHtml(flightDetail)}</div>
    </div>
    <div class="resultBreakdownCard">
      <div class="resultBreakdownTitle">Trip breakdown</div>
      <div class="resultBreakdownRow"><span>Leave home</span><strong>${escapeHtml(result.leaveBy || '5:42 PM')}</strong></div>
      <div class="resultBreakdownRow"><span>Travel time</span><strong>${escapeHtml(result.travel || 45)} min</strong></div>
      <div class="resultBreakdownRow"><span>Security</span><strong>${escapeHtml(securityWait)} min</strong></div>
      <div class="resultBreakdownRow"><span>Buffer</span><strong>${escapeHtml(result.buffer || 15)} min</strong></div>
    </div>
    <div class="resultLiveCard">
      <div class="resultLiveTitle">Live Conditions</div>
      <div class="resultLiveRow primary">
        <div class="resultLiveLabelWrap">
          <span class="resultLiveLabel">Traffic</span>
          <span class="resultLiveTag">Live</span>
        </div>
        <strong class="resultLiveValue">${escapeHtml(result.travel || 45)} min</strong>
      </div>
      <div class="resultLiveRow">
        <div class="resultLiveLabelWrap">
          <span class="resultLiveLabel">Security wait</span>
          <span class="resultLiveTag">Estimated</span>
        </div>
        <strong class="resultLiveValue">${escapeHtml(securityWait)} min</strong>
      </div>
      <div class="resultLiveRow">
        <div class="resultLiveLabelWrap">
          <span class="resultLiveLabel">Airport status</span>
          <span class="resultLiveTag">FAA</span>
        </div>
        <strong class="resultLiveValue text">${escapeHtml('No advisory')}</strong>
      </div>
      <div class="resultLiveRow">
        <div class="resultLiveLabelWrap">
          <span class="resultLiveLabel">Weather</span>
          <span class="resultLiveTag">Clear</span>
        </div>
        <strong class="resultLiveValue text">${escapeHtml('No delays')}</strong>
      </div>
    </div>
  `;
}

function getPaceMessage(result) {
  const total = Number(result?.total) || 95;
  const styleKey = normalizeTravelStyleKey(result?.style || '');
  if (styleKey === 'Tight') return 'You should leave soon';
  if (styleKey === 'Relaxed') return 'Comfortable pace';
  if (total >= 125) return 'Comfortable pace';
  if (total <= 85) return 'You should leave soon';
  return 'Tight but manageable';
}

function getSecurityWaitEstimate(result, selections) {
  const selected = (selections?.security || '').toLowerCase();
  if (selected.includes('clear')) return 6;
  if (selected.includes('pre')) return 8;
  if (selected.includes('standard')) return 15;
  return Math.max(8, Math.round((Number(result?.airportTime) || 35) * 0.4));
}
