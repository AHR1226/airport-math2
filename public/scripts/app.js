const app = document.getElementById('app');
const USE_HTML_RESULT = true;
const RECENT_ADDRESSES_KEY = 'eta_recent_addresses';
const HOME_ADDRESS_KEY = 'eta_home_address';
const WORK_ADDRESS_KEY = 'eta_work_address';
const ETA_MONITOR_INTERVAL_MS = 2 * 60 * 1000;
const ETA_MONITOR_SIGNIFICANT_MINUTES = 5;
let etaMonitorTimerId = null;
let etaMonitorKey = '';
let etaMonitorInFlight = false;

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

// JFK/EWR security minutes: terminal-aware fallbacks are served from GET /api/security (see server.js).
// Live JFK/EWR wait-time parsing is not enabled yet; the client only passes terminal and displays ESTIMATED.
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
initializeFlightDateInput();
initializeAirportTerminalSelects();
initializeStartingLocationAutocomplete();
initializeUseCurrentLocationAction();
initializeSavedLocationsUI();
if (window.syncSettingsTravelStyleUI) {
  window.syncSettingsTravelStyleUI();
}
initializeAirportsConditions();
if (typeof window.show === 'function') {
  const baseShow = window.show;
  window.show = (id) => {
    if (id !== 'result') stopEtaMonitoring();
    return baseShow(id);
  };
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopEtaMonitoring();
    return;
  }
  const latest = getLatestEtaResult();
  if (window.appState?.currentScreen === 'result' && latest) {
    syncEtaMonitoring(latest);
  }
});

function initializeFlightDateInput() {
  const input = document.getElementById('flightDate');
  if (!input) return;
  const today = formatDateInputValue(new Date());
  if (!input.value) input.value = window.appState?.form?.flightDate || today;
  if (window.appState?.form) window.appState.form.flightDate = input.value;
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

  const applyStartingLocation = (value) => {
    input.value = value;
    if (window.appState) window.appState.form.startLocation = value;
    clearStartingLocationValidation();
    closeSuggestions();
  };

  const renderSuggestionButton = (label) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'locationSuggestionItem';
    button.textContent = label;
    button.addEventListener('mousedown', (event) => {
      event.preventDefault();
      applyStartingLocation(button.textContent || '');
    });
    return button;
  };

  const openSuggestions = ({ recentItems = [], suggestionItems = [] }) => {
    if (!recentItems.length && !suggestionItems.length) {
      closeSuggestions();
      return;
    }

    suggestionsEl.innerHTML = '';
    if (recentItems.length) {
      const labelEl = document.createElement('div');
      labelEl.className = 'locationSuggestionsLabel';
      labelEl.textContent = 'Recent';
      suggestionsEl.appendChild(labelEl);
      recentItems.forEach((item) => {
        suggestionsEl.appendChild(renderSuggestionButton(item));
      });
    }
    const dedupedSuggestions = suggestionItems.filter(
      (item) => !recentItems.some((recent) => recent.toLowerCase() === item.toLowerCase())
    );
    dedupedSuggestions.forEach((item) => {
      suggestionsEl.appendChild(renderSuggestionButton(item));
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
    const recentItems = getRecentAddresses();
    if (query.length < 3) {
      openSuggestions({ recentItems, suggestionItems: [] });
      return;
    }
    const seq = ++suggestSeq;
    const localMatches = LOCAL_ADDRESS_SUGGESTIONS.filter((item) => item.toLowerCase().includes(query));
    const remote = await fetchMapboxSuggestions(raw);
    if (seq !== suggestSeq) return;
    openSuggestions({
      recentItems,
      suggestionItems: mergeSuggestions(remote, localMatches)
    });
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
    scheduleSuggestions();
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

function getStoredAddress(key) {
  return formatAddressForDisplay(localStorage.getItem(key) || '').trim();
}

function setStoredAddress(key, value) {
  const cleaned = formatAddressForDisplay(String(value || '')).trim();
  if (!cleaned) {
    localStorage.removeItem(key);
    return '';
  }
  localStorage.setItem(key, cleaned);
  return cleaned;
}

function getRecentAddresses() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_ADDRESSES_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    const out = [];
    const seen = new Set();
    parsed.forEach((entry) => {
      const normalized = formatAddressForDisplay(String(entry || '')).trim();
      const key = normalized.toLowerCase();
      if (!normalized || seen.has(key)) return;
      seen.add(key);
      out.push(normalized);
    });
    return out.slice(0, 3);
  } catch {
    return [];
  }
}

function pushRecentAddress(address) {
  const next = formatAddressForDisplay(String(address || '')).trim();
  if (!next) return;
  const existing = getRecentAddresses();
  const deduped = [next, ...existing.filter((item) => item.toLowerCase() !== next.toLowerCase())].slice(0, 3);
  localStorage.setItem(RECENT_ADDRESSES_KEY, JSON.stringify(deduped));
}

function renderSavedLocationQuickChips() {
  const wrap = document.getElementById('savedLocationQuickChips');
  const input = document.getElementById('startingLocationInput');
  if (!wrap || !input) return;
  const home = getStoredAddress(HOME_ADDRESS_KEY);
  const work = getStoredAddress(WORK_ADDRESS_KEY);
  const chips = [];
  if (home) chips.push({ label: 'Home', value: home });
  if (work) chips.push({ label: 'Work', value: work });
  wrap.innerHTML = '';
  if (!chips.length) {
    wrap.hidden = true;
    return;
  }
  chips.forEach(({ label, value }) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'savedLocationQuickChip';
    btn.textContent = label;
    btn.addEventListener('click', () => {
      input.value = value;
      if (window.appState) window.appState.form.startLocation = value;
      clearStartingLocationValidation();
      input.focus();
    });
    wrap.appendChild(btn);
  });
  wrap.hidden = false;
}

function initializeSavedLocationsUI() {
  const homeRow = document.getElementById('settingsSavedHomeRow');
  const workRow = document.getElementById('settingsSavedWorkRow');
  const homeValue = document.getElementById('settingsSavedHomeValue');
  const workValue = document.getElementById('settingsSavedWorkValue');

  const refresh = () => {
    const home = getStoredAddress(HOME_ADDRESS_KEY);
    const work = getStoredAddress(WORK_ADDRESS_KEY);
    if (homeValue) homeValue.textContent = home || 'Not set';
    if (workValue) workValue.textContent = work || 'Not set';
    renderSavedLocationQuickChips();
  };

  const promptForAddress = (key, label) => {
    const current = getStoredAddress(key);
    const next = window.prompt(`Set ${label} address`, current || '');
    if (next === null) return;
    setStoredAddress(key, next);
    refresh();
  };

  homeRow?.addEventListener('click', () => promptForAddress(HOME_ADDRESS_KEY, 'Home'));
  workRow?.addEventListener('click', () => promptForAddress(WORK_ADDRESS_KEY, 'Work'));
  refresh();
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
  const minutesText = formatDurationMinutes(minutes);
  const walkText = formatDurationMinutes(walkMinutes);
  const walkSuffix =
  walkMinutes == null
    ? ''
    : ` · ${walkText} to gate`;
  securityEl.textContent = `${minutesText} security${walkSuffix}${estimated ? ' (estimated)' : ''}`;
  securityEl.classList.toggle('estimated', Boolean(estimated));
}

async function fetchAirportSecurityEstimate(airportCode, terminalLabel, securityStatus) {
  try {
    const code = String(airportCode || '').toUpperCase();
    const resolvedTerminal = String(terminalLabel || '').trim();
    const resolvedStatus = String(securityStatus || window.appState?.selections?.security || '').trim();
    const params = new URLSearchParams({ airport: code || 'OTHER' });
    if ((code === 'JFK' || code === 'EWR') && resolvedTerminal) {
      params.set('terminal', resolvedTerminal);
    }
    if (code === 'LGA' && resolvedTerminal) {
      params.set('terminal', resolvedTerminal);
    }
    if (resolvedStatus) {
      params.set('securityStatus', resolvedStatus);
    }
    const res = await fetch(`/api/security?${params.toString()}`);
    if (!res.ok) return null;
    const data = await res.json();
    const minutes = Number(data?.minutes);
    const status = String(data?.status || 'estimated');
    const source = String(data?.source || 'Security fallback');
    return {
      minutes: Number.isFinite(minutes) ? minutes : NaN,
      status,
      source,
      airport: String(data?.airport || code),
      terminal: String(data?.terminal || resolvedTerminal),
      securityStatus: String(data?.securityStatus || resolvedStatus),
      regularMinutes: Number.isFinite(Number(data?.regularMinutes)) ? Number(data.regularMinutes) : null,
      precheckMinutes: Number.isFinite(Number(data?.precheckMinutes)) ? Number(data.precheckMinutes) : null
    };
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
        ? formatDurationMinutes(minutes)
        : '--';
      let rowLive = isLive;
      let securityMinutes = NaN;
      let securityEstimated = true;
      let walkMinutes = null;
      const preferredSecurityStatus = String(window.appState?.selections?.security || 'PreCheck');

      if (code === 'LGA') {
        const lga = await fetchLgaConditions();
        const security = await fetchAirportSecurityEstimate('LGA', terminal, preferredSecurityStatus);
        securityMinutes = Number(security?.minutes);
        walkMinutes = Number(lga?.walkToGateMinutes);
        securityEstimated = String(security?.status || 'estimated') !== 'live';
      } else if (code === 'JFK') {
        // Airports list: show Terminal 4 default until a live multi-terminal JFK feed exists.
        const security = await fetchAirportSecurityEstimate('JFK', 'Terminal 4', preferredSecurityStatus);
        securityMinutes = Number(security?.minutes);
        securityEstimated = String(security?.status || 'estimated') !== 'live';
      } else if (code === 'EWR') {
        // Airports list: use Terminal A fallback until a stable live Newark endpoint is available.
        const security = await fetchAirportSecurityEstimate('EWR', 'Terminal A', preferredSecurityStatus);
        securityMinutes = Number(security?.minutes);
        securityEstimated = String(security?.status || 'estimated') !== 'live';
      } else {
        const security = await fetchAirportSecurityEstimate(code, terminal, preferredSecurityStatus);
        securityMinutes = Number(security?.minutes);
        securityEstimated = String(security?.status || 'estimated') !== 'live';
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

function formatDateInputValue(date) {
  const d = date instanceof Date ? date : new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function buildFlightDepartureDate(flightDateValue, flightTimeValue) {
  const dateValue = String(flightDateValue || formatDateInputValue(new Date())).trim();
  const timeValue = String(flightTimeValue || '19:30').trim();
  const [year, month, day] = dateValue.split('-').map(Number);
  const [hours, minutes] = timeValue.split(':').map(Number);
  if (
    !Number.isFinite(year)
    || !Number.isFinite(month)
    || !Number.isFinite(day)
    || !Number.isFinite(hours)
    || !Number.isFinite(minutes)
  ) {
    return null;
  }
  return new Date(year, month - 1, day, hours, minutes, 0, 0);
}

function getDepartureCalculationMode(departureDate, now = new Date()) {
  if (!(departureDate instanceof Date) || Number.isNaN(departureDate.getTime())) return 'live';
  if (departureDate.getTime() < now.getTime()) return 'past_flight';
  const departureDay = formatDateInputValue(departureDate);
  const today = formatDateInputValue(now);
  if (departureDay > today) return 'planning';
  return 'live';
}

function getEstimatedSecurityForPlanning(airport, securityStatus) {
  const airportCode = String(airport || '').toUpperCase();
  const selected = String(securityStatus || '').toLowerCase();
  const regularByAirport = { JFK: 31, LGA: 21, EWR: 27 };
  const precheckByAirport = { JFK: 12, LGA: 8, EWR: 10 };
  const regular = regularByAirport[airportCode] ?? 35;
  const precheck = precheckByAirport[airportCode] ?? 16;
  const minutes = selected.includes('clear')
    ? Math.max(3, Math.round(precheck * 0.6))
    : selected.includes('pre')
      ? precheck
      : regular;
  return {
    minutes,
    status: 'estimated',
    source: 'Planning estimate',
    terminal: '',
    airport: airportCode,
    securityStatus: securityStatus || ''
  };
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
    showStartingLocationValidation('Add where you are leaving from to calculate your ETA.');
    return;
  }
  clearStartingLocationValidation();
  pushRecentAddress(startLocationRaw);

  const form = window.appState?.form || {};
  const selectedAirport = form.airport || document.getElementById('airportInput')?.value || 'JFK';
  const selectedTerminal = form.terminal || document.getElementById('terminalInput')?.value || DEFAULT_TERMINAL_BY_AIRPORT[selectedAirport] || 'Terminal 4';
  const flightDateValue = form.flightDate || document.getElementById('flightDate')?.value || formatDateInputValue(new Date());
  const flightTimeValue = form.flightTime || document.getElementById('flightTime')?.value || '19:30';
  const flightNumberValue = String(form.flightNumber || document.getElementById('flightNumberInput')?.value || '').trim();
  const flight = buildFlightDepartureDate(flightDateValue, flightTimeValue) || new Date();
  const calculationMode = getDepartureCalculationMode(flight);
  const isLiveMode = calculationMode === 'live';
  const isPlanningMode = calculationMode === 'planning';

  const timing = minutesForSelection();
  const selectedTransport = getActiveSelection('transport');
  const travelApi = isLiveMode
    ? await fetchTravelEstimate({
      airport: selectedAirport,
      terminal: selectedTerminal,
      origin: startLocationRaw,
      departAt: flight.toISOString()
    })
    : {
      travelMinutes: timing.travel,
      provider: 'planning',
      status: 'estimated',
      source: 'Typical planning estimate',
      typicalMinutes: timing.travel
    };
  const liveTravel = Number(travelApi?.travelMinutes);
  if (Number.isFinite(liveTravel) && liveTravel > 0) {
    timing.travel = Math.round(liveTravel);
    timing.total = timing.travel + timing.airport + timing.buffer;
  }
  let lgaConditions = null;
  if (isLiveMode && selectedAirport === 'LGA') {
    lgaConditions = await fetchLgaConditions();
  }
  const selectedSecurityStatus = getActiveSelection('security') || window.appState?.selections?.security || 'Security';
  const resolvedSecurity = isLiveMode
    ? await fetchAirportSecurityEstimate(selectedAirport, selectedTerminal, selectedSecurityStatus)
    : {
      ...getEstimatedSecurityForPlanning(selectedAirport, selectedSecurityStatus),
      terminal: selectedTerminal
    };
  const resolvedSecurityMinutes = Number(resolvedSecurity?.minutes);
  const lgaWalkMinutes = selectedAirport === 'LGA' ? Number(lgaConditions?.walkToGateMinutes) : null;
  const leave = new Date(flight.getTime() - timing.total * 60000);

  const etaResult = {
    leaveBy: formatTime(leave),
    flightDate: flightDateValue,
    flightTime: formatTime(flight),
    flightDepartureAt: flight.toISOString(),
    flightNumber: flightNumberValue,
    calculationMode,
    isPlanningMode,
    isLiveMode,
    airport: selectedAirport,
    terminal: selectedTerminal,
    origin: startLocationRaw,
    destination: destinationForSelection(selectedAirport, selectedTerminal),
    travel: timing.travel,
    airportTime: timing.airport,
    buffer: timing.buffer,
    total: timing.total,
    style: getActiveSelection('style'),
    transportMode: selectedTransport || null,
    securityStatusLabel: selectedSecurityStatus,
    travelProvider: travelApi?.provider || 'mock',
    travelStatus: travelApi?.status || 'fallback',
    travelSource: travelApi?.source || 'Backup estimate',
    travelTypical: Number.isFinite(Number(travelApi?.typicalMinutes)) ? Number(travelApi.typicalMinutes) : null,
    securityResolvedMinutes: Number.isFinite(resolvedSecurityMinutes) ? Math.round(resolvedSecurityMinutes) : null,
    securityResolvedStatus: String(resolvedSecurity?.status || 'estimated'),
    securityResolvedSource: String(resolvedSecurity?.source || 'Security fallback'),
    securityResolvedTerminal: String(resolvedSecurity?.terminal || selectedTerminal || ''),
    securityResolvedAirport: String(resolvedSecurity?.airport || selectedAirport || ''),
    securityResolvedSelection: String(resolvedSecurity?.securityStatus || selectedSecurityStatus || ''),
    lgaSecurityWait: Number.isFinite(resolvedSecurityMinutes) && selectedAirport === 'LGA' ? Math.round(resolvedSecurityMinutes) : null,
    lgaWalkToGate: Number.isFinite(lgaWalkMinutes) ? lgaWalkMinutes : null,
    lgaConditionsStatus: selectedAirport === 'LGA' ? String(lgaConditions?.status || 'estimated') : null,
    jfkSecurityWait: Number.isFinite(resolvedSecurityMinutes) && selectedAirport === 'JFK' ? Math.round(resolvedSecurityMinutes) : null,
    ewrSecurityWait: Number.isFinite(resolvedSecurityMinutes) && selectedAirport === 'EWR' ? Math.round(resolvedSecurityMinutes) : null,
    monitorMessage: isPlanningMode
      ? 'Using typical traffic patterns'
      : calculationMode === 'past_flight'
        ? 'This flight time has passed'
        : 'Monitoring live traffic...',
    monitorUpdatedAt: null
  };

  if (window.stateApi) {
    window.stateApi.setEta(etaResult);
  }

  localStorage.setItem('etaResult', JSON.stringify(etaResult));

  show('loading');

  setTimeout(() => {
    show('result');
    renderResult();
  }, 1200);
}

function renderResult() {
  const result = getLatestEtaResult();

  const leaveEl = document.getElementById('dynamicLeaveBy');
  const summaryEl = document.getElementById('dynamicSummary');

  if (leaveEl) leaveEl.textContent = result.leaveBy || '5:42 PM';

  if (summaryEl) {
    const travelSummary = formatDurationMinutes(result.travel);
    summaryEl.innerHTML = `
      <div>Flight: ${result.flightTime || '7:30 PM'} from ${result.airport || 'JFK'}</div>
      <div>Travel time: ${travelSummary}</div>
      <div>Airport time: ${formatDurationMinutes(result.airportTime || 35)}</div>
      <div>Buffer: ${formatDurationMinutes(result.buffer || 15)}</div>
      <div>Total planning window: ${formatDurationMinutes(result.total || 95)}</div>
    `;
  }

  renderHtmlResult(result);
  syncEtaMonitoring(result);
}

function getLatestEtaResult() {
  const stored = JSON.parse(localStorage.getItem('etaResult') || '{}');
  return {
    ...stored,
    ...(window.appState?.eta || {})
  };
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
  const airportLabel = (result.airport || form.airport || 'JFK').trim();
  const terminalLabel = (result.terminal || form.terminal || 'Terminal 4').trim();
  const scheduledFlightTime = formatFlightTimeForDisplay(result.flightTime || form.flightTime);
  const flightNumber = String(result.flightNumber || form.flightNumber || '').trim().toUpperCase();
  const startForDisplay = formatAddressForDisplay(form.startLocation || '').trim();
  const transportMode = String(result.transportMode || '').trim();
  const pickupForUber = formatAddressForDisplay(result.origin || form.startLocation || '').trim();
  const destinationForUber = formatAddressForDisplay(
    result.destination || destinationForSelection(airportLabel, terminalLabel)
  ).trim();
  const dropoffNickname = `${airportLabel} ${terminalLabel}`.trim();
  const uberDeepLink = buildUberDeepLink({
    pickupAddress: pickupForUber,
    dropoffAddress: destinationForUber,
    dropoffNickname,
    clientId: getUberClientId()
  });
  const hasValidUberLink = isValidUberDeepLink(uberDeepLink);
  const showUberCta = (
    isRideshareTransportMode(transportMode)
    && Boolean(pickupForUber)
    && Boolean(destinationForUber)
    && hasValidUberLink
  );
  const urgency = getUrgencyPresentation(result);
  const showUrgencyDebug = shouldShowUrgencyDebug();
  const monitorUpdatedLabel = formatMonitorUpdatedLabel(result.monitorUpdatedAt);
  const modeContextLine = getCalculationModeContextLine(result);
  const heroFlightDepartLine = flightNumber
    ? `Your ${flightNumber} flight departs at ${scheduledFlightTime || '7:30 PM'}`
    : `Your domestic flight departs at ${scheduledFlightTime || '7:30 PM'}`;
  const heroFlightMetaLine = `${airportLabel} · ${terminalLabel} · Gate`;
  const heroOriginPrefix = getTransportOriginPrefix(result.transportMode);
  const heroOriginLine = (heroOriginPrefix && startForDisplay) ? `${heroOriginPrefix} ${startForDisplay}` : '';
  const isLga = String(result.airport || '').toUpperCase() === 'LGA';
  const securityBreakdownLabel = String(result.securityStatusLabel || selections.security || 'Security').trim() || 'Security';
  const hasResolvedSecurity = Number.isFinite(Number(result.securityResolvedMinutes)) && Number(result.securityResolvedMinutes) >= 0;
  const hasLgaWalk = Number.isFinite(Number(result.lgaWalkToGate)) && Number(result.lgaWalkToGate) > 0;
  const securityWait = hasResolvedSecurity
    ? Math.round(Number(result.securityResolvedMinutes))
    : null;
  const walkToGateValue = isLga && hasLgaWalk
    ? `${Math.round(Number(result.lgaWalkToGate))} min`
    : '--';
  const securityTag = String(result.securityResolvedStatus || '').toLowerCase() === 'live'
    ? 'Live'
    : 'TSA Estimated';
  const walkTag = isLga ? 'Estimated' : 'Estimated';
  const travelDuration = formatDurationMinutes(result.travel);
  const trafficTag = (result.travelStatus === 'live' && ['google', 'mapbox'].includes(String(result.travelProvider || '').toLowerCase()))
    ? 'Live'
    : 'Estimated';
  const provider = String(result.travelProvider || '').toLowerCase();
  const trafficTagLabel = provider === 'google' ? 'GOOGLE ROUTES' : trafficTag.toUpperCase();

  container.innerHTML = `
    <div class="resultHtmlHeader">
      <h2 class="resultHtmlTitle">Your ETA</h2>
      <button class="resultHtmlEdit" onclick="show('calculate')">Edit</button>
    </div>
    <div class="resultHeroCard">
      <div class="resultHtmlEyebrow">${escapeHtml(urgency.leaveLabel)}</div>
      <div class="resultHeroClock" aria-hidden="true">
        <svg viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="9"></circle>
          <path d="M12 7v5l3 2"></path>
        </svg>
      </div>
      <div class="resultHtmlTime">${escapeHtml(result.leaveBy || '5:42 PM')}</div>
      <div class="resultHtmlMetaBlock">
        <div class="resultHtmlMetaLine">${escapeHtml(heroFlightDepartLine)}</div>
        <div class="resultHtmlMetaLine">${escapeHtml(heroFlightMetaLine)}</div>
        ${heroOriginLine ? `<div class="resultHtmlMetaLine">${escapeHtml(heroOriginLine)}</div>` : ''}
      </div>
      <div class="resultHtmlStatus ${escapeHtml(urgency.statusClassName)}" aria-live="polite">
        <span class="resultHtmlStatusDot" aria-hidden="true"></span>
        <span>${escapeHtml(urgency.pillCopy)}</span>
      </div>
      ${urgency.helperCopy ? `<div class="resultUrgencyHelper">${escapeHtml(urgency.helperCopy)}</div>` : ''}
      ${modeContextLine ? `<div class="resultModeContext">${escapeHtml(modeContextLine)}</div>` : ''}
      ${showUrgencyDebug ? `<div class="resultUrgencyDebug">DEBUG · ${escapeHtml(urgency.urgencyState)} · Cushion ${escapeHtml(formatDebugMinutes(urgency.remainingCushionMinutes))} · ${escapeHtml(String(urgency.reason || 'n/a'))}</div>` : ''}
      <div class="resultMonitorUpdated">${escapeHtml(monitorUpdatedLabel)}</div>
    </div>
    <div class="resultBreakdownCard">
      <div class="resultBreakdownTitle">Trip breakdown</div>
      <div class="resultBreakdownRow"><span>Leave Home</span><strong>${escapeHtml(result.leaveBy || '5:42 PM')}</strong></div>
      <div class="resultBreakdownRow"><span>Travel Time</span><strong>${escapeHtml(travelDuration)}</strong></div>
      <div class="resultBreakdownRow"><span>${escapeHtml(securityBreakdownLabel)}</span><strong>${escapeHtml(hasResolvedSecurity ? formatDurationMinutes(securityWait) : '--')}</strong></div>
      <div class="resultBreakdownRow"><span>Buffer</span><strong>${escapeHtml(formatDurationMinutes(result.buffer || 15))}</strong></div>
    </div>
    ${showUberCta ? `
    <a class="resultUberCard" href="${escapeHtml(uberDeepLink)}" target="_blank" rel="noopener noreferrer" onclick="onUberLinkClick(this.href)">
      <div class="resultUberCardHeader">
        <span class="resultUberCardLogo" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <rect x="3.5" y="3.5" width="17" height="17" rx="5"></rect>
            <path d="M8 9v6"></path>
            <path d="M16 9v6"></path>
            <path d="M8 15h8"></path>
          </svg>
        </span>
        <div class="resultUberCardTitle">Ride ready</div>
      </div>
      <div class="resultUberCardAction">Continue in Uber <span aria-hidden="true">→</span></div>
    </a>
    ` : ''}
    <div class="resultLiveCard">
      <div class="resultLiveTitle">Live Conditions</div>
      <div class="resultLiveRow primary">
        <div class="resultLiveLabelWrap resultLiveLabelWrapTraffic">
          <div class="resultLiveLabelTopRow">
            <span class="resultLiveLabel">Traffic</span>
            <span class="resultLiveTag resultLiveTag--traffic">${escapeHtml(trafficTagLabel)}</span>
          </div>
        </div>
        <strong class="resultLiveValue">${escapeHtml(travelDuration)}</strong>
      </div>
      <div class="resultLiveRow">
        <div class="resultLiveLabelWrap">
          <span class="resultLiveLabel">Security wait</span>
          <span class="resultLiveTag resultLiveTag--security">${escapeHtml(securityTag)}</span>
        </div>
        <strong class="resultLiveValue">${escapeHtml(hasResolvedSecurity ? formatDurationMinutes(securityWait) : '--')}</strong>
      </div>
      <div class="resultLiveRow">
        <div class="resultLiveLabelWrap">
          <span class="resultLiveLabel">${isLga ? 'Walk to gate' : 'Airport status'}</span>
          <span class="resultLiveTag resultLiveTag--faa">${isLga ? escapeHtml(walkTag) : 'FAA'}</span>
        </div>
        <strong class="resultLiveValue text">${escapeHtml(isLga ? walkToGateValue : 'No advisory')}</strong>
      </div>
      <div class="resultLiveRow">
        <div class="resultLiveLabelWrap">
          <span class="resultLiveLabel">Weather</span>
          <span class="resultLiveTag resultLiveTag--clear">Clear</span>
        </div>
        <strong class="resultLiveValue text">${escapeHtml('No delays')}</strong>
      </div>
    </div>
  `;
}

function getUrgencyPresentation(result) {
  const now = new Date();
  const flightDate = parseFlightDepartureDate(result) || parseClockTimeToday(result?.flightTime);
  const leaveDate = parseClockTimeToday(result?.leaveBy);
  const calculationMode = String(result?.calculationMode || getDepartureCalculationMode(flightDate, now));
  const minutesUntilFlight = flightDate
    ? Math.round((flightDate.getTime() - now.getTime()) / 60000)
    : null;

  const travelMinutes = Number.isFinite(Number(result?.travel)) ? Math.round(Number(result.travel)) : 0;
  const securityMinutes = Number.isFinite(Number(result?.securityResolvedMinutes))
    ? Math.round(Number(result.securityResolvedMinutes))
    : 0;
  const walkMinutes = Number.isFinite(Number(result?.lgaWalkToGate)) ? Math.round(Number(result.lgaWalkToGate)) : 0;
  const bufferMinutes = Number.isFinite(Number(result?.buffer)) ? Math.round(Number(result.buffer)) : 0;
  const boardingCutoffAllowance = Number.isFinite(Number(result?.boardingCutoffAllowance))
    ? Math.max(0, Math.round(Number(result.boardingCutoffAllowance)))
    : Math.max(
      0,
      Math.round((Number(result?.airportTime) || 0) - securityMinutes - walkMinutes)
    );
  const totalTripMinutesRemaining = travelMinutes + securityMinutes + walkMinutes + bufferMinutes + boardingCutoffAllowance;
  const remainingCushionMinutes = Number.isFinite(minutesUntilFlight)
    ? Math.round(minutesUntilFlight - totalTripMinutesRemaining)
    : null;
  const flightTimePassed = Boolean(flightDate && flightDate.getTime() < now.getTime());
  const leaveTimePassed = Boolean(leaveDate && leaveDate.getTime() <= now.getTime());

  let urgencyState = 'SAFE';
  let reason = 'cushion_over_30';
  if (calculationMode === 'past_flight' || flightTimePassed) {
    urgencyState = 'past_flight';
    reason = 'flight_time_passed';
    console.log('[urgency-debug] past flight time detected', {
      selectedFlightTime: result?.flightTime || null,
      selectedDepartureAt: result?.flightDepartureAt || null,
      remainingCushionMinutes: Number.isFinite(remainingCushionMinutes) ? remainingCushionMinutes : null
    });
  } else if (calculationMode === 'planning') {
    urgencyState = 'planning';
    reason = 'future_flight_planning_mode';
  } else if (leaveTimePassed) {
    urgencyState = 'CRITICAL';
    reason = 'leave_time_passed';
  } else if (!Number.isFinite(remainingCushionMinutes)) {
    urgencyState = 'SAFE';
    reason = 'missing_time_inputs_default_safe';
  } else if (remainingCushionMinutes < 10) {
    urgencyState = 'CRITICAL';
    reason = 'cushion_under_10';
  } else if (remainingCushionMinutes <= 30) {
    urgencyState = 'CAUTION';
    reason = 'cushion_between_10_and_30';
  }

  const copyByState = {
    SAFE: {
      leaveLabel: 'LEAVE AT',
      pillCopy: 'Monitoring live traffic',
      statusClassName: 'resultHtmlStatus--safe'
    },
    CAUTION: {
      leaveLabel: 'LEAVE SOON',
      pillCopy: 'Traffic could impact arrival',
      statusClassName: 'resultHtmlStatus--caution'
    },
    CRITICAL: {
      leaveLabel: 'LEAVE NOW',
      pillCopy: 'Arrival window at risk',
      statusClassName: 'resultHtmlStatus--critical'
    },
    past_flight: {
      leaveLabel: 'CHECK FLIGHT TIME',
      pillCopy: 'This flight time has passed',
      helperCopy: 'Are you planning a future flight?',
      statusClassName: 'resultHtmlStatus--pastFlight'
    },
    planning: {
      leaveLabel: 'PLANNED DEPARTURE',
      pillCopy: 'Using typical traffic patterns',
      statusClassName: 'resultHtmlStatus--safe'
    }
  };
  const selectedCopy = copyByState[urgencyState] || copyByState.SAFE;

  console.log('[urgency-debug]', {
    remainingCushionMinutes: Number.isFinite(remainingCushionMinutes) ? remainingCushionMinutes : null,
    urgencyState,
    reason
  });

  return {
    ...selectedCopy,
    urgencyState,
    remainingCushionMinutes,
    reason
  };
}

function parseFlightDepartureDate(result) {
  const explicit = String(result?.flightDepartureAt || '').trim();
  if (explicit) {
    const parsed = new Date(explicit);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  if (result?.flightDate && result?.flightTime) {
    return buildFlightDepartureDate(result.flightDate, result.flightTime);
  }
  return null;
}

function getCalculationModeContextLine(result) {
  const mode = String(result?.calculationMode || '').trim();
  if (mode === 'planning') return 'Estimated for your selected departure date';
  if (mode === 'live') return 'Using live traffic + airport conditions';
  return '';
}

function shouldShowUrgencyDebug() {
  try {
    const params = new URLSearchParams(window.location.search || '');
    return params.get('debug') === '1';
  } catch {
    return false;
  }
}

function formatDebugMinutes(value) {
  const mins = Number(value);
  if (!Number.isFinite(mins)) return '--';
  return `${Math.round(mins)} min`;
}

function getTransportContextLine(mode) {
  const key = String(mode || '').toLowerCase();
  if (!key) return '';
  if (key.includes('rideshare')) return 'Rideshare timing reflects live traffic conditions';
  if (key.includes('transit')) return 'Transit timing includes extra transfer buffer';
  if (key.includes('drive')) return 'Driving timing may include parking buffer';
  return '';
}

function getTransportOriginPrefix(mode) {
  const key = String(mode || '').toLowerCase();
  if (key.includes('rideshare')) return 'Rideshare from';
  if (key.includes('drive')) return 'Drive from';
  if (key.includes('transit')) return 'Take transit from';
  if (key.includes('drop-off') || key.includes('dropoff')) return 'Get dropped off from';
  return 'Rideshare from';
}

function formatMonitorUpdatedLabel(updatedAt) {
  if (!updatedAt) return 'Updated just now';
  const stamp = new Date(updatedAt);
  if (Number.isNaN(stamp.getTime())) return 'Monitoring live traffic...';
  const mins = Math.max(0, Math.round((Date.now() - stamp.getTime()) / 60000));
  if (mins <= 0) return 'Updated just now';
  if (mins === 1) return 'Updated 1 min ago';
  return `Updated ${mins} min ago`;
}

function formatDurationMinutes(value) {
  const minutesRaw = Number(value);
  if (!Number.isFinite(minutesRaw) || minutesRaw < 0) return '--';
  if (minutesRaw === 0) return '0 min';
  const totalMins = Math.round(minutesRaw);
  if (totalMins < 60) return `${totalMins} min`;
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  if (mins === 0) return `${hours} hr`;
  return `${hours} hr ${mins} min`;
}

function isRideshareTransportMode(mode) {
  return String(mode || '').toLowerCase().includes('rideshare');
}

function buildUberDeepLink({ pickupAddress, dropoffAddress, dropoffNickname, clientId }) {
  const pickup = String(pickupAddress || '').trim();
  const dropoff = String(dropoffAddress || '').trim();
  const dropoffName = String(dropoffNickname || '').trim();
  const uberClientId = String(clientId || '').trim();
  if (!pickup || !dropoff) return '';
  const params = new URLSearchParams();
  params.set('pickup[formatted_address]', pickup);
  params.set('pickup[nickname]', 'Pickup');
  params.set('dropoff[formatted_address]', dropoff);
  if (dropoffName) params.set('dropoff[nickname]', dropoffName);
  if (uberClientId) params.set('client_id', uberClientId);
  const href = `https://m.uber.com/ul/?action=setPickup&${params.toString()}`;
  return href;
}

function isValidUberDeepLink(url) {
  const href = String(url || '').trim();
  if (!href) return false;
  if (href === '#' || href === 'undefined' || href === 'null') return false;
  return href.startsWith('https://m.uber.com/ul/?action=setPickup');
}

function onUberLinkClick(uberHref) {
  console.log('Uber href:', uberHref);
  console.log('Uber clicked:', uberHref);
  return true;
}

function getUberClientId() {
  const fromConfig = window.__APP_CONFIG__?.UBER_CLIENT_ID || window.__APP_CONFIG__?.uberClientId;
  const fromWindow = window.UBER_CLIENT_ID;
  const fromState = window.appState?.uberClientId;
  return String(fromConfig || fromWindow || fromState || '').trim();
}

function buildEtaMonitorKey(result) {
  const airport = String(result?.airport || '').trim().toUpperCase();
  const terminal = String(result?.terminal || '').trim();
  const origin = String(result?.origin || '').trim();
  const destination = String(result?.destination || '').trim();
  const flightTime = String(result?.flightDepartureAt || result?.flightTime || '').trim();
  if (!airport || !origin || !destination) return '';
  return [airport, terminal, origin, destination, flightTime].join('|');
}

function syncEtaMonitoring(result) {
  if (!result) {
    stopEtaMonitoring();
    return;
  }
  if (String(result.calculationMode || '') !== 'live') {
    stopEtaMonitoring();
    return;
  }
  if (window.appState?.currentScreen !== 'result' || document.hidden) {
    stopEtaMonitoring();
    return;
  }
  const key = buildEtaMonitorKey(result);
  if (!key) {
    stopEtaMonitoring();
    return;
  }
  if (etaMonitorTimerId && etaMonitorKey === key) return;
  stopEtaMonitoring();
  etaMonitorKey = key;
  etaMonitorTimerId = window.setInterval(() => {
    refreshEtaMonitoring();
  }, ETA_MONITOR_INTERVAL_MS);
}

function stopEtaMonitoring() {
  if (etaMonitorTimerId) {
    window.clearInterval(etaMonitorTimerId);
  }
  etaMonitorTimerId = null;
  etaMonitorKey = '';
  etaMonitorInFlight = false;
}

function parseClockTimeToday(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  const twelve = value.match(/^(\d{1,2}):(\d{2})\s*([AP]M)$/i);
  if (twelve) {
    let h = Number(twelve[1]);
    const m = Number(twelve[2]);
    const mer = twelve[3].toUpperCase();
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    if (h === 12) h = 0;
    if (mer === 'PM') h += 12;
    const d = new Date();
    d.setHours(h, m, 0, 0);
    return d;
  }
  const twentyFour = value.match(/^(\d{1,2}):(\d{2})$/);
  if (twentyFour) {
    const h = Number(twentyFour[1]);
    const m = Number(twentyFour[2]);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    const d = new Date();
    d.setHours(h, m, 0, 0);
    return d;
  }
  return null;
}

function upsertEtaResult(patch) {
  const current = getLatestEtaResult();
  const merged = { ...current, ...patch };
  if (window.stateApi) {
    window.stateApi.setEta(merged);
  }
  localStorage.setItem('etaResult', JSON.stringify(merged));
}

async function refreshEtaMonitoring() {
  if (etaMonitorInFlight) return;
  if (window.appState?.currentScreen !== 'result' || document.hidden) {
    stopEtaMonitoring();
    return;
  }
  const result = getLatestEtaResult();
  if (String(result.calculationMode || '') !== 'live') {
    stopEtaMonitoring();
    return;
  }
  const origin = String(result.origin || '').trim();
  const airport = String(result.airport || '').trim().toUpperCase();
  if (!origin || !airport) {
    stopEtaMonitoring();
    return;
  }
  etaMonitorInFlight = true;
  try {
    const live = await fetchTravelEstimate({
      airport,
      terminal: result.terminal || '',
      origin,
      departAt: new Date().toISOString()
    });
    const latestTravel = Number(live?.travelMinutes);
    const currentTravel = Number(result.travel);
    if (!Number.isFinite(latestTravel) || latestTravel <= 0 || !Number.isFinite(currentTravel) || currentTravel <= 0) {
      upsertEtaResult({
        monitorMessage: 'Monitoring live traffic...',
        monitorUpdatedAt: new Date().toISOString()
      });
      renderResult();
      return;
    }

    const roundedTravel = Math.round(latestTravel);
    const delta = roundedTravel - Math.round(currentTravel);
    const nowIso = new Date().toISOString();
    if (Math.abs(delta) < ETA_MONITOR_SIGNIFICANT_MINUTES) {
      upsertEtaResult({
        monitorMessage: 'You\'re still on schedule',
        monitorUpdatedAt: nowIso
      });
      renderResult();
      return;
    }

    const airportTime = Number(result.airportTime) || 35;
    const buffer = Number(result.buffer) || 15;
    const nextTotal = roundedTravel + airportTime + buffer;
    const priorLeaveDate = parseClockTimeToday(result.leaveBy);
    const nextLeaveDate = priorLeaveDate ? new Date(priorLeaveDate.getTime() - (delta * 60000)) : null;
    const nextLeaveBy = nextLeaveDate ? formatTime(nextLeaveDate) : result.leaveBy;
    const message = delta > 0
      ? `Traffic increased by ${delta} min. Leave ${delta} min earlier to stay on track.`
      : `Traffic eased by ${Math.abs(delta)} min. You're still on schedule.`;

    upsertEtaResult({
      travel: roundedTravel,
      total: nextTotal,
      leaveBy: nextLeaveBy,
      travelProvider: live?.provider || result.travelProvider || 'mock',
      travelStatus: live?.status || result.travelStatus || 'fallback',
      travelSource: live?.source || result.travelSource || 'Backup estimate',
      travelTypical: Number.isFinite(Number(live?.typicalMinutes)) ? Number(live.typicalMinutes) : result.travelTypical,
      monitorMessage: message,
      monitorUpdatedAt: nowIso
    });
    renderResult();
  } catch {
    upsertEtaResult({
      monitorMessage: 'Monitoring live traffic...',
      monitorUpdatedAt: new Date().toISOString()
    });
    renderResult();
  } finally {
    etaMonitorInFlight = false;
  }
}

