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

// JFK security minutes: terminal-aware fallbacks are served from GET /api/security (see server.js).
// Live JFK wait-time parsing is not enabled yet; the client only passes terminal and displays ESTIMATED.
const TERMINAL_DESTINATION_MAP = {
  JFK: {
    'Terminal 4': 'JFK Terminal 4 Departures, Queens, NY',
    'Terminal 5': 'JFK Terminal 5 Departures, Queens, NY'
  },
  LGA: {
    'Terminal B': 'LaGuardia Terminal B Departures, Queens, NY'
  },
  EWR: {
    'Terminal A': 'Newark Liberty Terminal A Departures, Newark, NJ',
    'Terminal B': 'Newark Liberty Terminal B Departures, Newark, NJ',
    'Terminal C': 'Newark Liberty Terminal C Departures, Newark, NJ'
  }
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
initializeUseCurrentLocationAction();
if (window.syncSettingsTravelStyleUI) {
  window.syncSettingsTravelStyleUI();
}
initializeAirportsConditions();

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

function initializeUseCurrentLocationAction() {
  const input = document.getElementById('startingLocationInput');
  const actionButton = document.getElementById('useCurrentLocationButton');
  if (!input || !actionButton) return;

  const setActionBusy = (busy) => {
    actionButton.disabled = busy;
    actionButton.classList.toggle('locationIconButton--busy', busy);
    actionButton.setAttribute('aria-label', busy ? 'Locating current position' : 'Use current location');
    actionButton.setAttribute('title', busy ? 'Locating current position' : 'Use current location');
  };

  const fetchReverseGeocode = async (lat, lng) => {
    try {
      const res = await fetch(`/api/reverse-geocode?lat=${encodeURIComponent(String(lat))}&lng=${encodeURIComponent(String(lng))}`);
      if (!res.ok) return '';
      const data = await res.json();
      return formatAddressForDisplay(data.address || '');
    } catch {
      return '';
    }
  };

  actionButton.addEventListener('click', () => {
    if (!navigator.geolocation) {
      showStartingLocationValidation('Location access unavailable');
      return;
    }

    setActionBusy(true);
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const lat = Number(position.coords?.latitude);
        const lng = Number(position.coords?.longitude);
        const resolved = await fetchReverseGeocode(lat, lng);
        const fallback = 'Current Location';
        const nextValue = resolved || fallback;
        input.value = nextValue;
        if (window.appState) {
          window.appState.form.startLocation = nextValue;
        }
        clearStartingLocationValidation();
        setActionBusy(false);
      },
      () => {
        showStartingLocationValidation('Location access unavailable');
        setActionBusy(false);
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 120000
      }
    );
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

function destinationForSelection(airport, terminal) {
  const airportCode = String(airport || 'JFK').trim().toUpperCase();
  const terminalLabel = String(terminal || '').trim();
  const mapped = TERMINAL_DESTINATION_MAP[airportCode]?.[terminalLabel];
  if (mapped) return mapped;
  if (airportCode === 'JFK') return 'JFK Airport Departures, Queens, NY';
  if (airportCode === 'LGA') return 'LaGuardia Airport Departures, Queens, NY';
  if (airportCode === 'EWR') return 'Newark Liberty International Airport Departures, Newark, NJ';
  return `${airportCode} Airport Departures`;
}

async function fetchTravelEstimate({ airport, terminal, origin, departAt }) {
  const params = new URLSearchParams({
    airport: String(airport || 'JFK'),
    terminal: String(terminal || ''),
    mode: 'rideshare',
    origin: String(origin || ''),
    destination: destinationForSelection(airport, terminal),
    departAt: departAt || ''
  });
  try {
    const res = await fetch(`/api/travel?${params.toString()}`);
    if (!res.ok) return null;
    const data = await res.json();
    if (!Number.isFinite(Number(data?.travelMinutes))) return null;
    return data;
  } catch {
    return null;
  }
}

function airportsConfig() {
  return [
    { code: 'JFK', terminal: 'Terminal 4' },
    { code: 'LGA', terminal: 'Terminal B' },
    { code: 'EWR', terminal: 'Terminal C' }
  ];
}

function preferredAirportsOrigin() {
  const fromCalc = formatAddressForDisplay(window.appState?.form?.startLocation || '').trim();
  if (fromCalc && fromCalc.toLowerCase() !== 'current location') return fromCalc;
  const fromSettings = formatAddressForDisplay(document.querySelector('#settings .appCard .rowSub')?.textContent || '').trim();
  if (fromSettings) return fromSettings;
  return 'Midtown Manhattan, NY';
}

function setAirportRowState(code, { travelText, isLive }) {
  const timeEl = document.querySelector(`[data-airport-time="${code}"]`);
  const statusEl = document.querySelector(`[data-airport-status="${code}"]`);
  if (timeEl) timeEl.textContent = travelText;
  if (!statusEl) return;
  statusEl.textContent = isLive ? 'Live' : 'Estimated';
  statusEl.classList.toggle('pillActive', isLive);
}

function setAirportSecurityState(code, { minutes, estimated, walkMinutes = null }) {
  const securityEl = document.querySelector(`[data-airport-security="${code}"]`);
  if (!securityEl) return;
  const minutesText = Number.isFinite(minutes) && minutes > 0 ? `${Math.round(minutes)} min` : '--';
  const walkText = Number.isFinite(walkMinutes) && walkMinutes > 0 ? `${Math.round(walkMinutes)} min` : '--';
  const walkSuffix =
  walkMinutes == null
    ? ''
    : ` · ${walkText} to gate`;
  securityEl.textContent = `${minutesText} security${walkSuffix}${estimated ? ' (estimated)' : ''}`;
  securityEl.classList.toggle('estimated', Boolean(estimated));
}

async function fetchAirportSecurityEstimate(airportCode, jfkTerminal) {
  try {
    const code = String(airportCode || '').toUpperCase();
    const params = new URLSearchParams({ airport: code || 'OTHER' });
    if (code === 'JFK' && String(jfkTerminal || '').trim()) {
      params.set('terminal', String(jfkTerminal).trim());
    }
    const res = await fetch(`/api/security?${params.toString()}`);
    if (!res.ok) return null;
    const data = await res.json();
    const mode = String(window.appState?.selections?.security || '').toLowerCase();
    const preferPre = mode.includes('pre') || mode.includes('clear');
    const minutesRaw = preferPre ? data?.precheck : data?.regular;
    const minutes = Number(minutesRaw);
    const estimated = data?.status !== 'live';
    if (!Number.isFinite(minutes)) return { minutes: NaN, estimated: true };
    return { minutes, estimated };
  } catch {
    return null;
  }
}

async function fetchLgaConditions() {
  try {
    const res = await fetch('/api/lga-conditions');
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function refreshAirportConditions() {
  const origin = preferredAirportsOrigin();
  const nowIso = new Date().toISOString();

  await Promise.all(
    airportsConfig().map(async ({ code, terminal }) => {
      const travelApi = await fetchTravelEstimate({
        airport: code,
        terminal,
        origin,
        departAt: nowIso
      });
      const provider = String(travelApi?.provider || '').toLowerCase();
      const isLive = travelApi?.status === 'live' && (provider === 'google' || provider === 'mapbox');
      const minutes = Number(travelApi?.travelMinutes);
      const travelText = (isLive && Number.isFinite(minutes) && minutes > 0)
        ? `${Math.round(minutes)} min`
        : '--';
      let rowLive = isLive;
      let securityMinutes = NaN;
      let securityEstimated = true;
      let walkMinutes = null;

      if (code === 'LGA') {
        const lga = await fetchLgaConditions();
        const mode = String(window.appState?.selections?.security || '').toLowerCase();
        const preferPre = mode.includes('pre') || mode.includes('clear');
        securityMinutes = Number(preferPre ? lga?.securityPrecheckMinutes : lga?.securityGeneralMinutes);
        walkMinutes = Number(lga?.walkToGateMinutes);
        securityEstimated = true;
      } else if (code === 'JFK') {
        // Airports list: show Terminal 4 default until a live multi-terminal JFK feed exists.
        const security = await fetchAirportSecurityEstimate('JFK', 'Terminal 4');
        securityMinutes = Number(security?.minutes);
        securityEstimated = security?.estimated !== false;
      } else {
        const security = await fetchAirportSecurityEstimate(code);
        securityMinutes = Number(security?.minutes);
        securityEstimated = security?.estimated !== false;
      }

      setAirportRowState(code, { travelText, isLive: rowLive });
      setAirportSecurityState(code, {
        minutes: securityMinutes,
        estimated: securityEstimated,
        walkMinutes: Number.isFinite(walkMinutes) ? walkMinutes : null
      });
    })
  );
}

function initializeAirportsConditions() {
  const refreshButton = document.getElementById('refreshAirportsButton');
  if (refreshButton) {
    refreshButton.addEventListener('click', () => {
      refreshAirportConditions();
    });
  }
  if (window.appState?.currentScreen === 'airports') {
    refreshAirportConditions();
  }
}

window.refreshAirportConditions = refreshAirportConditions;

function formatTime(date) {
  return date.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit'
  });
}

function formatFlightTimeForDisplay(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (/(am|pm)/i.test(value)) {
    return value.replace(/\s+/g, ' ').trim().toUpperCase();
  }
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return '';
  const hours24 = Number(match[1]);
  const minutes = match[2];
  if (!Number.isFinite(hours24) || hours24 < 0 || hours24 > 23) return '';
  const suffix = hours24 >= 12 ? 'PM' : 'AM';
  const hours12 = (hours24 % 12) || 12;
  return `${hours12}:${minutes} ${suffix}`;
}

async function calculateETA() {
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

  const form = window.appState?.form || {};
  const selectedAirport = form.airport || document.getElementById('airportInput')?.value || 'JFK';
  const selectedTerminal = form.terminal || document.getElementById('terminalInput')?.value || DEFAULT_TERMINAL_BY_AIRPORT[selectedAirport] || 'Terminal 4';
  const flightTimeValue = form.flightTime || document.getElementById('flightTime')?.value || '19:30';
  const [hours, minutes] = flightTimeValue.split(':').map(Number);

  const flight = new Date();
  flight.setHours(hours, minutes, 0, 0);

  const timing = minutesForSelection();
  const travelApi = await fetchTravelEstimate({
    airport: selectedAirport,
    terminal: selectedTerminal,
    origin: startLocationRaw,
    departAt: flight.toISOString()
  });
  const liveTravel = Number(travelApi?.travelMinutes);
  if (Number.isFinite(liveTravel) && liveTravel > 0) {
    timing.travel = Math.round(liveTravel);
    timing.total = timing.travel + timing.airport + timing.buffer;
  }
  let lgaConditions = null;
  if (selectedAirport === 'LGA') {
    lgaConditions = await fetchLgaConditions();
  }
  let jfkSecurityWait = null;
  if (selectedAirport === 'JFK') {
    const jfkSec = await fetchAirportSecurityEstimate('JFK', selectedTerminal);
    if (Number.isFinite(Number(jfkSec?.minutes))) {
      jfkSecurityWait = Math.round(Number(jfkSec.minutes));
    }
  }
  const securityMode = String(window.appState?.selections?.security || '').toLowerCase();
  const preferPrecheck = securityMode.includes('pre') || securityMode.includes('clear');
  const lgaSecurityMinutes = selectedAirport === 'LGA'
    ? Number(preferPrecheck ? lgaConditions?.securityPrecheckMinutes : lgaConditions?.securityGeneralMinutes)
    : null;
  const lgaWalkMinutes = selectedAirport === 'LGA' ? Number(lgaConditions?.walkToGateMinutes) : null;
  const leave = new Date(flight.getTime() - timing.total * 60000);

  const etaResult = {
    leaveBy: formatTime(leave),
    flightTime: formatTime(flight),
    airport: selectedAirport,
    terminal: selectedTerminal,
    origin: startLocationRaw,
    destination: destinationForSelection(selectedAirport, selectedTerminal),
    travel: timing.travel,
    airportTime: timing.airport,
    buffer: timing.buffer,
    total: timing.total,
    style: getActiveSelection('style'),
    travelProvider: travelApi?.provider || 'mock',
    travelStatus: travelApi?.status || 'fallback',
    travelSource: travelApi?.source || 'Backup estimate',
    travelTypical: Number.isFinite(Number(travelApi?.typicalMinutes)) ? Number(travelApi.typicalMinutes) : null,
    lgaSecurityWait: Number.isFinite(lgaSecurityMinutes) ? lgaSecurityMinutes : null,
    lgaWalkToGate: Number.isFinite(lgaWalkMinutes) ? lgaWalkMinutes : null,
    lgaConditionsStatus: selectedAirport === 'LGA' ? String(lgaConditions?.status || 'estimated') : null,
    jfkSecurityWait:
      selectedAirport === 'JFK' && jfkSecurityWait != null && Number.isFinite(jfkSecurityWait)
        ? jfkSecurityWait
        : null
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
    const travelSummary = Number.isFinite(Number(result.travel)) ? `${Math.round(Number(result.travel))} min` : '--';
    summaryEl.innerHTML = `
      <div>Flight: ${result.flightTime || '7:30 PM'} from ${result.airport || 'JFK'}</div>
      <div>Travel time: ${travelSummary}</div>
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
  const stateAbbrev = {
    'Alabama': 'AL', 'Alaska': 'AK', 'Arizona': 'AZ', 'Arkansas': 'AR', 'California': 'CA',
    'Colorado': 'CO', 'Connecticut': 'CT', 'Delaware': 'DE', 'Florida': 'FL', 'Georgia': 'GA',
    'Hawaii': 'HI', 'Idaho': 'ID', 'Illinois': 'IL', 'Indiana': 'IN', 'Iowa': 'IA',
    'Kansas': 'KS', 'Kentucky': 'KY', 'Louisiana': 'LA', 'Maine': 'ME', 'Maryland': 'MD',
    'Massachusetts': 'MA', 'Michigan': 'MI', 'Minnesota': 'MN', 'Mississippi': 'MS', 'Missouri': 'MO',
    'Montana': 'MT', 'Nebraska': 'NE', 'Nevada': 'NV', 'New Hampshire': 'NH', 'New Jersey': 'NJ',
    'New Mexico': 'NM', 'New York': 'NY', 'North Carolina': 'NC', 'North Dakota': 'ND', 'Ohio': 'OH',
    'Oklahoma': 'OK', 'Oregon': 'OR', 'Pennsylvania': 'PA', 'Rhode Island': 'RI', 'South Carolina': 'SC',
    'South Dakota': 'SD', 'Tennessee': 'TN', 'Texas': 'TX', 'Utah': 'UT', 'Vermont': 'VT',
    'Virginia': 'VA', 'Washington': 'WA', 'West Virginia': 'WV', 'Wisconsin': 'WI', 'Wyoming': 'WY',
    'District of Columbia': 'DC'
  };
  s = s.replace(/,\s*United States\s*$/i, '');
  s = s.replace(/,\s*USA\s*$/i, '');
  s = s.replace(/\s+United States\s*$/i, '');
  s = s.replace(/\s+USA\s*$/i, '');
  Object.entries(stateAbbrev).forEach(([full, abbr]) => {
    const re = new RegExp(`,\\s*${full}(?=,|$|\\s+\\d{5}(?:-\\d{4})?)`, 'gi');
    s = s.replace(re, `, ${abbr}`);
    const reNoComma = new RegExp(`\\b${full}(?=\\s+\\d{5}(?:-\\d{4})?$)`, 'gi');
    s = s.replace(reNoComma, abbr);
  });
  s = s.replace(/\s{2,}/g, ' ');
  s = s.replace(/\s+,/g, ',');
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
  const terminalLabel = (result.terminal || form.terminal || 'Terminal 4').trim();
  const scheduledFlightTime = formatFlightTimeForDisplay(result.flightTime || form.flightTime);
  const startForDisplay = formatAddressForDisplay(form.startLocation || '').trim();
  const flightMetaLines = [];
  if (scheduledFlightTime) {
    flightMetaLines.push(`Your flight departs at ${scheduledFlightTime}`);
  }
  flightMetaLines.push(`Domestic flight · ${airportLabel} · ${terminalLabel}`);
  if (startForDisplay) {
    flightMetaLines.push(`From ${startForDisplay}`);
  }
  const flightMetaMarkup = flightMetaLines
    .map((line) => `<div class="resultHtmlMetaLine">${escapeHtml(line)}</div>`)
    .join('');
  const isLga = String(result.airport || '').toUpperCase() === 'LGA';
  const isJfk = String(result.airport || '').toUpperCase() === 'JFK';
  const hasLgaSecurity = Number.isFinite(Number(result.lgaSecurityWait)) && Number(result.lgaSecurityWait) > 0;
  const hasJfkSecurity = Number.isFinite(Number(result.jfkSecurityWait)) && Number(result.jfkSecurityWait) > 0;
  const hasLgaWalk = Number.isFinite(Number(result.lgaWalkToGate)) && Number(result.lgaWalkToGate) > 0;
  const securityWait = isLga && hasLgaSecurity
    ? Math.round(Number(result.lgaSecurityWait))
    : isJfk && hasJfkSecurity
      ? Math.round(Number(result.jfkSecurityWait))
      : getSecurityWaitEstimate(result, selections);
  const walkToGateValue = isLga && hasLgaWalk
    ? `${Math.round(Number(result.lgaWalkToGate))} min`
    : '--';
  const securityTag = isLga ? 'Estimated' : 'Estimated';
  const walkTag = isLga ? 'Estimated' : 'Estimated';
  const travelDuration = Number.isFinite(Number(result.travel)) ? `${Math.round(Number(result.travel))} min` : '--';
  const trafficTag = (result.travelStatus === 'live' && ['google', 'mapbox'].includes(String(result.travelProvider || '').toLowerCase()))
    ? 'Live'
    : 'Estimated';
  const provider = String(result.travelProvider || '').toLowerCase();
  const trafficSource = provider === 'google'
    ? 'Live traffic data'
    : (provider === 'mapbox' ? 'Mapbox routing' : 'Backup estimate');

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
      <div class="resultHtmlMetaBlock">${flightMetaMarkup}</div>
    </div>
    <div class="resultBreakdownCard">
      <div class="resultBreakdownTitle">Trip breakdown</div>
      <div class="resultBreakdownRow"><span>Leave Home</span><strong>${escapeHtml(result.leaveBy || '5:42 PM')}</strong></div>
      <div class="resultBreakdownRow"><span>Travel Time</span><strong>${escapeHtml(travelDuration)}</strong></div>
      <div class="resultBreakdownRow"><span>Security</span><strong>${escapeHtml(securityWait)} min</strong></div>
      <div class="resultBreakdownRow"><span>Buffer</span><strong>${escapeHtml(result.buffer || 15)} min</strong></div>
    </div>
    <div class="resultLiveCard">
      <div class="resultLiveTitle">Live Conditions</div>
      <div class="resultLiveRow primary">
        <div class="resultLiveLabelWrap resultLiveLabelWrapTraffic">
          <div class="resultLiveLabelTopRow">
            <span class="resultLiveLabel">Traffic</span>
            <span class="resultLiveTag">${escapeHtml(trafficTag)}</span>
          </div>
          <span class="resultLiveSource">${escapeHtml(trafficSource)}</span>
        </div>
        <strong class="resultLiveValue">${escapeHtml(travelDuration)}</strong>
      </div>
      <div class="resultLiveRow">
        <div class="resultLiveLabelWrap">
          <span class="resultLiveLabel">Security wait</span>
          <span class="resultLiveTag">${escapeHtml(securityTag)}</span>
        </div>
        <strong class="resultLiveValue">${escapeHtml(securityWait)} min</strong>
      </div>
      <div class="resultLiveRow">
        <div class="resultLiveLabelWrap">
          <span class="resultLiveLabel">${isLga ? 'Walk to gate' : 'Airport status'}</span>
          <span class="resultLiveTag">${isLga ? escapeHtml(walkTag) : 'FAA'}</span>
        </div>
        <strong class="resultLiveValue text">${escapeHtml(isLga ? walkToGateValue : 'No advisory')}</strong>
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
  if (styleKey === 'Relaxed') return 'Moving at a comfortable pace 😊';
  if (total >= 125) return 'Moving at a comfortable pace 😊';
  if (total <= 85) return 'You should leave soon';
  return 'Comfortably timed 🙂';
}

function getSecurityWaitEstimate(result, selections) {
  const selected = (selections?.security || '').toLowerCase();
  if (selected.includes('clear')) return 6;
  if (selected.includes('pre')) return 8;
  if (selected.includes('standard')) return 15;
  return Math.max(8, Math.round((Number(result?.airportTime) || 35) * 0.4));
}
