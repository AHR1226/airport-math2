const app = document.getElementById('app');
const USE_HTML_RESULT = true;
const RECENT_ADDRESSES_KEY = 'eta_recent_addresses';
const HOME_ADDRESS_KEY = 'eta_home_address';
const WORK_ADDRESS_KEY = 'eta_work_address';
const SAVED_TRIPS_KEY = 'eta_saved_trips';
const SETTINGS_KEY = 'eta_user_settings';
const ETA_MONITOR_INTERVAL_MS = 2 * 60 * 1000;
const ETA_MONITOR_SIGNIFICANT_MINUTES = 5;
const LIVE_MODE_WINDOW_HOURS = 12;
const INTERNATIONAL_CARRY_ON_CHECK_IN_MINUTES = 25;
const INTERNATIONAL_BAG_DROP_CHECK_IN_MINUTES = 45;
const INTERNATIONAL_BAG_DROP_ONLY_CHECK_IN_MINUTES = 35;
const DOMESTIC_CHECKED_BAG_DROP_MINUTES = 15;
const DOMESTIC_BAG_DROP_MINUTES = 15;
const INTERNATIONAL_STANDARD_SECURITY_BUFFER_MINUTES = 10;
const INTERNATIONAL_PEAK_BUFFER_MINUTES = 15;
let etaMonitorTimerId = null;
let etaMonitorKey = '';
let etaMonitorInFlight = false;
let expandedSavedTripId = '';
const calculateManualOverrides = {
  homeAddress: false,
  airport: false,
  travelStyle: false
};

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
  if (s === 'Cutting it close') return 'Tight';
  if (s === 'No rush') return 'Relaxed';
  if (TRAVEL_STYLE_META[s]) return s;
  const lower = s.toLowerCase();
  if (lower.includes('tight') || lower.includes('cut')) return 'Tight';
  if (lower.includes('relaxed') || lower.includes('no rush')) return 'Relaxed';
  if (lower.includes('balanced')) return 'Balanced';
  return 'Balanced';
}

function defaultUserSettings() {
  return {
    homeAddress: getStoredAddress(HOME_ADDRESS_KEY),
    defaultAirport: 'JFK',
    travelStyle: 'Balanced',
    showPreferences: true,
    notifications: true
  };
}

function readUserSettings() {
  const defaults = defaultUserSettings();
  try {
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    const airport = ['JFK', 'LGA', 'EWR'].includes(parsed.defaultAirport)
      ? parsed.defaultAirport
      : defaults.defaultAirport;
    return {
      ...defaults,
      homeAddress: formatAddressForDisplay(parsed.homeAddress || defaults.homeAddress || '').trim(),
      defaultAirport: airport,
      travelStyle: normalizeTravelStyleKey(parsed.travelStyle || defaults.travelStyle),
      showPreferences: parsed.showPreferences !== false,
      notifications: parsed.notifications !== false
    };
  } catch {
    return defaults;
  }
}

function writeUserSettings(settings) {
  const next = {
    ...defaultUserSettings(),
    ...settings,
    homeAddress: formatAddressForDisplay(settings?.homeAddress || '').trim(),
    defaultAirport: ['JFK', 'LGA', 'EWR'].includes(settings?.defaultAirport) ? settings.defaultAirport : 'JFK',
    travelStyle: normalizeTravelStyleKey(settings?.travelStyle || 'Balanced'),
    showPreferences: settings?.showPreferences !== false,
    notifications: settings?.notifications !== false
  };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  setStoredAddress(HOME_ADDRESS_KEY, next.homeAddress);
  return next;
}

function setCalculateChipSelection(groupName, value) {
  const normalizedValue = String(value || '').trim();
  if (!normalizedValue) return;
  if (window.stateApi) window.stateApi.setSelection(groupName, normalizedValue);
  syncSelectionChipsToState({ [groupName]: normalizedValue });
}

function applyPreferenceVisibility(showPreferences) {
  const calculate = document.getElementById('calculate');
  if (!calculate) return;
  calculate.classList.toggle('hideCalculatePreferences', !showPreferences);
  if (!showPreferences) {
    const open = calculate.querySelector('.calcDecisionSection.isOpen');
    const title = open?.dataset?.calcTitle || '';
    if (['Airport flow', 'Who’s traveling', 'Timing style'].includes(title)) {
      setCalculateSectionOpen(0);
    }
  }
}

function applySavedSettingsToCalculate({ force = false } = {}) {
  const settings = readUserSettings();
  const startInput = document.getElementById('startingLocationInput');
  if (startInput && (force || !calculateManualOverrides.homeAddress)) {
    startInput.value = settings.homeAddress || '';
    if (window.appState?.form) window.appState.form.startLocation = settings.homeAddress || '';
  }

  const airportInput = document.getElementById('airportInput');
  if (airportInput && settings.defaultAirport && (force || !calculateManualOverrides.airport)) {
    airportInput.value = settings.defaultAirport;
    const terminalInput = document.getElementById('terminalInput');
    if (terminalInput) terminalInput.value = DEFAULT_TERMINAL_BY_AIRPORT[settings.defaultAirport] || terminalInput.value;
    if (window.appState?.form) {
      window.appState.form.airport = settings.defaultAirport;
      window.appState.form.terminal = DEFAULT_TERMINAL_BY_AIRPORT[settings.defaultAirport] || window.appState.form.terminal;
    }
    initializeAirportTerminalSelects();
  }

  if (settings.travelStyle && (force || !calculateManualOverrides.travelStyle)) {
    setCalculateChipSelection('style', settings.travelStyle);
  }
  applyPreferenceVisibility(settings.showPreferences);
  renderSavedLocationQuickChips();
}

function refreshSettingsUI() {
  const settings = readUserSettings();
  const homeInput = document.getElementById('settingsHomeAddressInput');
  const airportSelect = document.getElementById('settingsDefaultAirport');
  const styleSelect = document.getElementById('settingsDefaultTravelStyle');
  const prefsToggle = document.getElementById('settingsShowPreferences');
  const status = document.getElementById('settingsSaveStatus');
  if (homeInput) homeInput.value = settings.homeAddress;
  if (airportSelect) airportSelect.value = settings.defaultAirport;
  if (styleSelect) styleSelect.value = settings.travelStyle;
  if (prefsToggle) prefsToggle.checked = settings.showPreferences;
  if (status) status.textContent = '';
  syncSettingsTravelStyleUI();
}

function previewSettingsTravelStyle(value) {
  const valueEl = document.getElementById('settingsTravelStyleValue');
  const descEl = document.getElementById('settingsTravelStyleDesc');
  if (!valueEl || !descEl) return;
  const key = normalizeTravelStyleKey(value);
  const meta = TRAVEL_STYLE_META[key] || TRAVEL_STYLE_META.Balanced;
  valueEl.textContent = meta.label;
  descEl.textContent = meta.desc;
}

function initializeSettingsUI() {
  const form = document.getElementById('settingsForm');
  if (!form || form.dataset.settingsReady === 'true') return;
  form.dataset.settingsReady = 'true';
  refreshSettingsUI();
  document.getElementById('settingsDefaultTravelStyle')?.addEventListener('change', (event) => {
    previewSettingsTravelStyle(event.target?.value);
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const settings = writeUserSettings({
      homeAddress: document.getElementById('settingsHomeAddressInput')?.value || '',
      defaultAirport: document.getElementById('settingsDefaultAirport')?.value || 'JFK',
      travelStyle: document.getElementById('settingsDefaultTravelStyle')?.value || 'Balanced',
      showPreferences: document.getElementById('settingsShowPreferences')?.checked !== false,
      notifications: readUserSettings().notifications
    });
    calculateManualOverrides.homeAddress = false;
    calculateManualOverrides.airport = false;
    calculateManualOverrides.travelStyle = false;
    applySavedSettingsToCalculate({ force: true });
    refreshSettingsUI();
    const status = document.getElementById('settingsSaveStatus');
    if (status) status.textContent = 'Settings saved';
    if (window.appState) {
      window.appState.settings = settings;
    }
  });
}

function syncSettingsTravelStyleUI() {
  const valueEl = document.getElementById('settingsTravelStyleValue');
  const descEl = document.getElementById('settingsTravelStyleDesc');
  if (!valueEl || !descEl) return;
  const key = readUserSettings().travelStyle;
  const meta = TRAVEL_STYLE_META[key] || TRAVEL_STYLE_META.Balanced;
  valueEl.textContent = meta.label;
  descEl.textContent = meta.desc;
}

window.syncSettingsTravelStyleUI = syncSettingsTravelStyleUI;

if (window.navigationApi) {
  window.navigationApi.init();
}
initializeSettingsUI();
applySavedSettingsToCalculate({ force: true });
if (window.selectionsApi) {
  window.selectionsApi.init();
}
initializeFlightDateInput();
initializeAirportTerminalSelects();
initializeStartingLocationAutocomplete();
initializeUseCurrentLocationAction();
initializeSavedLocationsUI();
initializeCalculateProgressiveFlow();
applyPreferenceVisibility(readUserSettings().showPreferences);
initializeCalculateDefaultOverrideTracking();
if (window.syncSettingsTravelStyleUI) {
  window.syncSettingsTravelStyleUI();
}
initializeAirportsConditions();
if (typeof window.show === 'function') {
  const baseShow = window.show;
  window.show = (id) => {
    if (id !== 'result') stopEtaMonitoring();
    const shown = baseShow(id);
    if (id === 'trips') renderTripsList();
    if (id === 'calculate') {
      applySavedSettingsToCalculate();
      updateCalculateProgressiveUI();
    }
    if (id === 'settings') refreshSettingsUI();
    return shown;
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

function initializeCalculateProgressiveFlow() {
  const calculate = document.getElementById('calculate');
  if (!calculate || calculate.dataset.progressiveReady === 'true') return;
  calculate.dataset.progressiveReady = 'true';

  const sections = [...calculate.querySelectorAll('.calcDecisionSection')];
  sections.forEach((section, index) => {
    const title = section.querySelector('h2');
    if (!title) return;
    section.dataset.calcIndex = String(index);
    section.dataset.calcTitle = title.textContent.trim();

    const header = document.createElement('div');
    header.className = 'calcAccordionHeader';
    const titleText = title.textContent.trim();
    header.innerHTML = `
      <span class="calcAccordionText">
        <span class="calcAccordionTitle">${escapeHtml(titleText)}</span>
        <span class="calcAccordionSummary" data-calc-summary></span>
        <span class="calcAccordionErrorHint" data-calc-error-hint hidden></span>
      </span>
      <button type="button" class="calcAccordionToggle" aria-label="Toggle ${escapeHtml(titleText)} section">
        <span class="calcAccordionChevron" aria-hidden="true"></span>
      </button>
    `;

    const body = document.createElement('div');
    body.className = 'calcAccordionBody';
    const bodyInner = document.createElement('div');
    bodyInner.className = 'calcAccordionBodyInner';

    let node = title.nextSibling;
    while (node) {
      const next = node.nextSibling;
      bodyInner.appendChild(node);
      node = next;
    }
    body.appendChild(bodyInner);
    title.replaceWith(header);
    section.appendChild(body);

    header.addEventListener('click', () => toggleCalculateSection(index));
  });

  calculate.addEventListener('change', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    updateCalculateProgressiveUI();
  });

  calculate.addEventListener('input', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    updateCalculateProgressiveUI();
  });

  calculate.addEventListener('blur', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    updateCalculateProgressiveUI();
  }, true);

  document.addEventListener('eta:selectionchange', () => {
    updateCalculateProgressiveUI();
  });

  setCalculateSectionOpen(0);
  updateCalculateProgressiveUI();
}

function initializeCalculateDefaultOverrideTracking() {
  const startInput = document.getElementById('startingLocationInput');
  const airportInput = document.getElementById('airportInput');
  if (startInput && startInput.dataset.overrideReady !== 'true') {
    startInput.dataset.overrideReady = 'true';
    startInput.addEventListener('input', () => {
      calculateManualOverrides.homeAddress = true;
    });
  }
  if (airportInput && airportInput.dataset.overrideReady !== 'true') {
    airportInput.dataset.overrideReady = 'true';
    airportInput.addEventListener('change', () => {
      calculateManualOverrides.airport = true;
    });
  }
  document.addEventListener('eta:selectionchange', (event) => {
    if (event.detail?.groupName === 'style') {
      calculateManualOverrides.travelStyle = true;
    }
  });
}

function toggleCalculateSection(index) {
  const section = document.querySelectorAll('#calculate .calcDecisionSection')[index];
  if (section?.classList.contains('isOpen')) {
    setCalculateSectionOpen(-1);
    return;
  }
  setCalculateSectionOpen(index);
}

function setCalculateSectionOpen(index) {
  const sections = [...document.querySelectorAll('#calculate .calcDecisionSection')];
  sections.forEach((section, sectionIndex) => {
    const isOpen = sectionIndex === index;
    const body = section.querySelector('.calcAccordionBody');
    const toggle = section.querySelector('.calcAccordionToggle');
    section.classList.toggle('isOpen', isOpen);
    toggle?.setAttribute('aria-expanded', String(isOpen));
    if (body) {
      body.style.maxHeight = isOpen ? `${body.scrollHeight}px` : '0px';
      body.style.opacity = isOpen ? '1' : '0';
    }
  });
}

function getCalculateSectionByTitle(title) {
  return [...document.querySelectorAll('#calculate .calcDecisionSection')]
    .find((section) => section.dataset.calcTitle === title) || null;
}

function setCalculateSectionValidationError(title, message = '') {
  const section = getCalculateSectionByTitle(title);
  if (!section) return;
  const hint = section.querySelector('[data-calc-error-hint]');
  const nextMessage = String(message || '').trim();
  section.classList.toggle('hasValidationError', Boolean(nextMessage));
  section.dataset.validationError = nextMessage;
  if (hint) {
    hint.textContent = nextMessage;
    hint.hidden = !nextMessage;
  }
}

function clearCalculateSectionValidationError(title) {
  setCalculateSectionValidationError(title, '');
}

function revealCalculateValidationTarget({
  missingField,
  targetCardTitle,
  message,
  focusTarget
}) {
  const section = getCalculateSectionByTitle(targetCardTitle);
  if (!section) return;
  const sectionIndex = Number(section.dataset.calcIndex);
  setCalculateSectionValidationError(targetCardTitle, message);
  if (Number.isFinite(sectionIndex)) setCalculateSectionOpen(sectionIndex);
  window.requestAnimationFrame(() => {
    section.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (focusTarget && typeof focusTarget.focus === 'function') {
      setTimeout(() => focusTarget.focus({ preventScroll: true }), 260);
    }
  });
  console.log('[calculate-validation-error]', {
    missingField,
    targetCard: targetCardTitle,
    actionTaken: 'expanded + scrolled'
  });
}

function updateCalculateProgressiveUI() {
  const sections = [...document.querySelectorAll('#calculate .calcDecisionSection')];
  sections.forEach((section) => {
    const summary = section.querySelector('[data-calc-summary]');
    if (summary) summary.textContent = getCalculateSectionSummary(section.dataset.calcTitle || '');
    const body = section.querySelector('.calcAccordionBody');
    if (body && section.classList.contains('isOpen')) body.style.maxHeight = `${body.scrollHeight}px`;
  });
}

function getCalculateSectionSummary(title) {
  const airport = document.getElementById('airportInput')?.value || 'JFK';
  const date = buildFlightDepartureDate(
    document.getElementById('flightDate')?.value,
    document.getElementById('flightTime')?.value
  );
  const dateLabel = date instanceof Date && !Number.isNaN(date.getTime())
    ? date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : 'Date';
  const timeLabel = formatFlightTimeForDisplay(document.getElementById('flightTime')?.value || '19:30') || '7:30 PM';
  const flightType = normalizeFlightType(document.getElementById('flightType')?.value || 'Domestic');
  const origin = formatAddressForDisplay(document.getElementById('startingLocationInput')?.value || '').trim();
  const originLabel = getOriginSummaryLabel(origin);

  if (title === 'Flight') return `${airport} · ${dateLabel} · ${timeLabel} · ${flightType}`;
  if (title === 'Getting there') return `${originLabel} · ${getActiveSelection('transport') || 'Rideshare'}`;
  if (title === 'Airport flow') {
    const security = getActiveSelection('security') || 'PreCheck';
    return [
      getActiveSelection('luggage') || 'Carry-on only',
      security === 'Standard' ? 'Standard security' : security,
      formatBoardingSelectionLabel(getActiveSelection('boarding') || 'Head to gate')
    ].join(' · ');
  }
  if (title === 'Who’s traveling') return getActiveSelection('complexity') || 'Just me';
  if (title === 'Timing style') return getActiveSelection('style') || 'Balanced';
  return '';
}

function formatBoardingSelectionLabel(value) {
  return String(value || '').trim() === 'Grab food' ? 'Hudson News' : String(value || '').trim();
}

function getOriginSummaryLabel(origin) {
  if (!origin) return 'Origin';
  const normalized = origin.toLowerCase();
  if (normalized.includes('home')) return 'Home';
  if (normalized.includes('work')) return 'Work';
  return origin.split(',')[0] || origin;
}

function isCalculateSectionComplete(section) {
  const title = section.dataset.calcTitle || '';
  if (title === 'Flight') {
    return Boolean(
      document.getElementById('airportInput')?.value
      && document.getElementById('flightDate')?.value
      && document.getElementById('flightTime')?.value
      && document.getElementById('flightType')?.value
    );
  }
  if (title === 'Getting there') {
    return Boolean((document.getElementById('startingLocationInput')?.value || '').trim());
  }
  return true;
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

  if (airportSelect.dataset.terminalReady === 'true') {
    syncTerminalOptions();
    return;
  }
  airportSelect.dataset.terminalReady = 'true';
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
  const input = document.getElementById('startingLocationInput');
  if (el) {
    el.textContent = '';
    el.hidden = true;
  }
  if (input) {
    input.removeAttribute('aria-invalid');
    input.removeAttribute('aria-describedby');
  }
  clearCalculateSectionValidationError('Getting there');
}

function showStartingLocationValidation(message) {
  const el = document.getElementById('startingLocationValidation');
  const input = document.getElementById('startingLocationInput');
  if (el) {
    el.textContent = message;
    el.hidden = false;
  }
  if (input) {
    input.setAttribute('aria-invalid', 'true');
    input.setAttribute('aria-describedby', 'startingLocationValidation');
  }
  setCalculateSectionValidationError('Getting there', 'Address required');
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
  renderSavedLocationQuickChips();
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

function normalizeFlightType(raw) {
  return String(raw || '').trim().toLowerCase() === 'international'
    ? 'International'
    : 'Domestic';
}

function isPeakDepartureWindow(departureDate) {
  if (!(departureDate instanceof Date) || Number.isNaN(departureDate.getTime())) return false;
  const day = departureDate.getDay();
  const hour = departureDate.getHours();
  const isFridayAfterThree = day === 5 && hour >= 15;
  const isSundayAfternoonEvening = day === 0 && hour >= 12 && hour <= 21;
  const isWeekdayMorning = day >= 1 && day <= 5 && hour >= 6 && hour < 9;
  return isFridayAfterThree || isSundayAfternoonEvening || isWeekdayMorning;
}

function buildInternationalTimingAdjustments({ isInternational, luggage, security, departureDate }) {
  const peakWindow = isPeakDepartureWindow(departureDate);
  if (!isInternational) {
    return {
      peakWindow,
      internationalBuffer: 0,
      luggageBuffer: 0,
      securityBuffer: 0,
      peakBuffer: 0,
      reasons: []
    };
  }

  const checkInMinutes = luggage === 'Checking bags'
    ? INTERNATIONAL_BAG_DROP_CHECK_IN_MINUTES
    : luggage === 'Bag drop'
      ? INTERNATIONAL_BAG_DROP_ONLY_CHECK_IN_MINUTES
      : INTERNATIONAL_CARRY_ON_CHECK_IN_MINUTES;
  const securityBuffer = security === 'Standard' ? INTERNATIONAL_STANDARD_SECURITY_BUFFER_MINUTES : 0;
  const peakBuffer = peakWindow ? INTERNATIONAL_PEAK_BUFFER_MINUTES : 0;
  const reasons = [
    {
      label: luggage === 'Checking bags' || luggage === 'Bag drop'
        ? 'International bag drop/check-in'
        : 'International check-in',
      minutes: checkInMinutes
    }
  ];
  if (securityBuffer) reasons.push({ label: 'Security cushion', minutes: securityBuffer });
  if (peakBuffer) reasons.push({ label: 'Peak travel window', minutes: peakBuffer });

  return {
    peakWindow,
    internationalBuffer: checkInMinutes,
    luggageBuffer: 0,
    securityBuffer,
    peakBuffer,
    reasons
  };
}

function minutesForSelection(options = {}) {
  const transport = getActiveSelection('transport');
  const luggage = getActiveSelection('luggage');
  const security = getActiveSelection('security');
  const boarding = getActiveSelection('boarding');
  const complexity = getActiveSelection('complexity') || 'Just me';
  const style = normalizeTravelStyleKey(getActiveSelection('style'));
  const flightType = normalizeFlightType(
    options.flightType
    || window.appState?.form?.flightType
    || document.getElementById('flightType')?.value
    || 'Domestic'
  );
  const isInternational = flightType === 'International';
  const departureDate = options.departureDate || null;

  const rulesResult = window.AirportMathTimingRules?.calculate({
    transport,
    luggage,
    security,
    boarding,
    complexity,
    style,
    flightType,
    departureDate
  });
  if (!rulesResult) {
    throw new Error('AirportMath timing rules engine is not loaded.');
  }

  const layers = rulesResult.layers || {};
  const travel = Math.max(0, Math.round(Number(layers.travelTime) || 0));
  const airport = Math.max(0, Math.round(
    (Number(layers.airportProcessingTime) || 0)
    + (Number(layers.securityTime) || 0)
    + (Number(layers.terminalFlowTime) || 0)
    + (Number(layers.behavioralTime) || 0)
    + (Number(layers.preferenceTime) || 0)
  ));
  const buffer = Math.round(Number(layers.confidenceBufferTime) || 0);
  const timingAdjustmentReasons = (rulesResult.rows || []).map((row) => ({
    label: row.label,
    minutes: row.minutes,
    layer: row.layer,
    visible: row.visible !== false
  }));
  const internationalBuffer = timingAdjustmentReasons
    .filter((row) => String(row.label || '').toLowerCase().includes('international'))
    .reduce((sum, row) => sum + Math.max(0, Math.round(Number(row.minutes) || 0)), 0);
  const luggageBuffer = timingAdjustmentReasons
    .filter((row) => String(row.label || '').toLowerCase().includes('bag drop'))
    .reduce((sum, row) => sum + Math.max(0, Math.round(Number(row.minutes) || 0)), 0);
  const securityBuffer = Math.max(0, Math.round(Number(layers.securityTime) || 0));
  const peakBuffer = timingAdjustmentReasons
    .filter((row) => String(row.label || '').toLowerCase().includes('peak travel window'))
    .reduce((sum, row) => sum + Math.max(0, Math.round(Number(row.minutes) || 0)), 0);

  return {
    travel,
    airport,
    buffer,
    total: travel + airport + buffer,
    flightType,
    isInternational,
    baseAirportBuffer: airport,
    baseBuffer: buffer,
    luggageSelection: luggage,
    securityStatus: security,
    travelStyle: style,
    travelComplexity: complexity,
    peakWindow: isPeakDepartureWindow(departureDate),
    internationalBuffer,
    luggageBuffer,
    securityBuffer,
    peakBuffer,
    timingAdjustmentReasons,
    timingLayers: layers,
    timingRulesDebug: rulesResult.debug
  };
}

function getTravelComplexityMinutes(complexity, isInternational) {
  const key = String(complexity || 'Just me').trim().toLowerCase();
  const values = {
    'family / children': isInternational ? 40 : 25,
    'traveling with pets': isInternational ? 35 : 20,
    'group travel': isInternational ? 30 : 15
  };
  return values[key] || 0;
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

function normalizeTravelApiMode(transportMode) {
  const key = String(transportMode || '').trim().toLowerCase();
  if (key.includes('transit') || key.includes('public')) return 'public';
  if (key.includes('drive') || key.includes('park')) return 'driving';
  if (key.includes('drop-off') || key.includes('dropoff')) return 'dropoff';
  return 'rideshare';
}

function fallbackTravelEstimateMinutes({ airport, transportMode, timingTravel }) {
  const timingMinutes = Math.round(Number(timingTravel) || 0);
  if (timingMinutes > 0) return timingMinutes;

  const airportCode = String(airport || 'OTHER').trim().toUpperCase();
  const airportFallbacks = {
    JFK: 55,
    LGA: 35,
    EWR: 45,
    OTHER: 45
  };
  const apiMode = normalizeTravelApiMode(transportMode);
  const modeAdjustment = apiMode === 'public'
    ? 15
    : apiMode === 'dropoff'
      ? -5
      : 0;

  return Math.max(20, (airportFallbacks[airportCode] || airportFallbacks.OTHER) + modeAdjustment);
}

async function fetchTravelEstimate({ airport, terminal, origin, departAt, transportMode }) {
  const destination = destinationForSelection(airport, terminal);
  const params = new URLSearchParams({
    airport: String(airport || 'JFK'),
    terminal: String(terminal || ''),
    mode: normalizeTravelApiMode(transportMode),
    origin: String(origin || ''),
    destination,
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
  const fromSettings = readUserSettings().homeAddress;
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
  if (!(departureDate instanceof Date) || Number.isNaN(departureDate.getTime())) {
    console.log('[mode-debug]', {
      now: now.toISOString(),
      departureDatetime: null,
      hoursUntilDeparture: null,
      mode: 'live'
    });
    return 'live';
  }
  const hoursUntilDeparture = (departureDate.getTime() - now.getTime()) / (60 * 60 * 1000);
  let mode = 'live';
  if (hoursUntilDeparture < 0) {
    mode = 'past_flight';
  } else if (hoursUntilDeparture > LIVE_MODE_WINDOW_HOURS) {
    mode = 'planning';
  }
  console.log('[mode-debug]', {
    now: now.toISOString(),
    departureDatetime: departureDate.toISOString(),
    hoursUntilDeparture: Math.round(hoursUntilDeparture * 100) / 100,
    mode
  });
  return mode;
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
    const input = document.getElementById('startingLocationInput');
    const message = 'Add where you are leaving from to calculate your ETA.';
    showStartingLocationValidation(message);
    revealCalculateValidationTarget({
      missingField: 'origin address',
      targetCardTitle: 'Getting there',
      message: 'Address required',
      focusTarget: input
    });
    return;
  }
  clearStartingLocationValidation();
  pushRecentAddress(startLocationRaw);

  const form = window.appState?.form || {};
  const selectedAirport = form.airport || document.getElementById('airportInput')?.value || 'JFK';
  const selectedTerminal = form.terminal || document.getElementById('terminalInput')?.value || DEFAULT_TERMINAL_BY_AIRPORT[selectedAirport] || 'Terminal 4';
  const flightDateValue = form.flightDate || document.getElementById('flightDate')?.value || formatDateInputValue(new Date());
  const flightTimeValue = form.flightTime || document.getElementById('flightTime')?.value || '19:30';
  const selectedFlightType = normalizeFlightType(form.flightType || document.getElementById('flightType')?.value || 'Domestic');
  const flightNumberValue = String(form.flightNumber || document.getElementById('flightNumberInput')?.value || '').trim();
  const flight = buildFlightDepartureDate(flightDateValue, flightTimeValue) || new Date();
  const calculationMode = getDepartureCalculationMode(flight);
  const isLiveMode = calculationMode === 'live';
  const isPlanningMode = calculationMode === 'planning';

  const timing = minutesForSelection({
    flightType: selectedFlightType,
    departureDate: flight
  });
  const selectedTransport = getActiveSelection('transport');
  const selectedDestination = destinationForSelection(selectedAirport, selectedTerminal);
  const travelApi = isLiveMode
    ? await fetchTravelEstimate({
      airport: selectedAirport,
      terminal: selectedTerminal,
      origin: startLocationRaw,
      departAt: flight.toISOString(),
      transportMode: selectedTransport
    })
    : {
      travelMinutes: timing.travel,
      provider: 'planning',
      status: 'estimated',
      source: 'Typical planning estimate',
      typicalMinutes: timing.travel
    };
  const liveTravel = Number(travelApi?.travelMinutes);
  const routeApiDuration = Number.isFinite(liveTravel) && liveTravel > 0 ? Math.round(liveTravel) : null;
  const routeApiStaticDuration = Number.isFinite(Number(travelApi?.typicalMinutes))
    ? Math.round(Number(travelApi.typicalMinutes))
    : null;
  const fallbackDuration = fallbackTravelEstimateMinutes({
    airport: selectedAirport,
    transportMode: selectedTransport,
    timingTravel: timing.travel
  });
  const finalTravelTime = routeApiDuration || fallbackDuration;
  const usedTravelFallback = !routeApiDuration;
  const travelTimeSource = routeApiDuration
    ? `${travelApi?.provider || 'route'} ${travelApi?.status || 'duration'} duration`
    : 'fallback duration';
  if (Number.isFinite(finalTravelTime) && finalTravelTime > 0) {
    timing.travel = Math.round(finalTravelTime);
    timing.total = timing.travel + timing.airport + timing.buffer;
    if (timing.timingLayers) timing.timingLayers.travelTime = timing.travel;
    if (timing.timingRulesDebug?.layerTotals) {
      timing.timingRulesDebug.layerTotals.travelTime = timing.travel;
      timing.timingRulesDebug.finalRecommendationMinutes = timing.total;
    }
  }
  console.log('[travel-time-debug]', {
    selectedTransportMode: selectedTransport || 'Rideshare',
    originAddress: startLocationRaw,
    destinationAirportTerminal: selectedDestination,
    routeApiProvider: travelApi?.provider || null,
    routeApiStatus: travelApi?.status || null,
    routeApiSource: travelApi?.source || null,
    routeApiDuration,
    routeApiStaticDuration,
    fallbackDuration,
    travelTimeSource,
    finalTravelTimeMinutes: timing.travel
  });
  console.log('[eta-rules-debug]', timing.timingRulesDebug);
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
    savedTripId: '',
    leaveBy: formatTime(leave),
    flightDate: flightDateValue,
    flightTime: formatTime(flight),
    flightType: selectedFlightType,
    flightDepartureAt: flight.toISOString(),
    flightNumber: flightNumberValue,
    calculationMode,
    isPlanningMode,
    isLiveMode,
    airport: selectedAirport,
    terminal: selectedTerminal,
    origin: startLocationRaw,
    destination: selectedDestination,
    travel: timing.travel,
    airportTime: timing.airport,
    buffer: timing.buffer,
    total: timing.total,
    timingAdjustmentReasons: timing.timingAdjustmentReasons,
    timingLayers: timing.timingLayers,
    timingRulesDebug: timing.timingRulesDebug,
    style: getActiveSelection('style'),
    complexity: getActiveSelection('complexity') || 'Just me',
    transportMode: selectedTransport || null,
    securityStatusLabel: selectedSecurityStatus,
    travelProvider: usedTravelFallback ? 'estimated' : (travelApi?.provider || 'mock'),
    travelStatus: usedTravelFallback ? 'estimated' : (travelApi?.status || 'fallback'),
    travelSource: usedTravelFallback ? 'Estimated travel fallback' : (travelApi?.source || 'Backup estimate'),
    travelTimeSource,
    travelTypical: Number.isFinite(Number(travelApi?.typicalMinutes)) ? Number(travelApi.typicalMinutes) : (usedTravelFallback ? timing.travel : null),
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
      ? 'Estimating typical traffic patterns'
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

  // TEMP: loading screen visibility delay for UI refinement
  setTimeout(() => {
    show('result');
    renderResult();
  }, 2500);
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
      <div>Travel to airport: ${travelSummary}</div>
      <div>Airport time: ${formatDurationMinutes(result.airportTime || 35)}</div>
      <div>Time at airport: ${formatDurationMinutes(getAirportTimingMinutes(result))}</div>
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

function readSavedTrips() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SAVED_TRIPS_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeSavedTrips(trips) {
  localStorage.setItem(SAVED_TRIPS_KEY, JSON.stringify(Array.isArray(trips) ? trips : []));
}

function clonePlain(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function getTripKey({ eta, form }) {
  return [
    eta?.flightDepartureAt || `${eta?.flightDate || form?.flightDate || ''}-${eta?.flightTime || form?.flightTime || ''}`,
    eta?.airport || form?.airport || '',
    eta?.terminal || form?.terminal || '',
    eta?.origin || form?.startLocation || ''
  ].join('|');
}

function buildTripFromCurrentResult() {
  if (window.stateApi) window.stateApi.syncFormFromDom();
  const eta = getLatestEtaResult();
  const form = clonePlain(window.appState?.form);
  const selections = clonePlain(window.appState?.selections);
  const nowIso = new Date().toISOString();
  const gateArrivalTarget = getGateArrivalTarget(eta, eta.flightType || form.flightType);
  const airportArrivalTime = getAirportArrivalTime(eta);
  const key = getTripKey({ eta, form });
  const existing = readSavedTrips().find((trip) => trip.key === key);

  return {
    id: existing?.id || `trip_${Date.now()}`,
    key,
    createdAt: existing?.createdAt || nowIso,
    updatedAt: nowIso,
    mode: eta.calculationMode || 'planning',
    status: getTripStatus(eta),
    form,
    selections,
    eta: { ...clonePlain(eta), savedTripId: existing?.id || '' },
    milestones: {
      leaveHome: eta.leaveBy || '',
      arriveAtAirport: formatMilestoneTime(airportArrivalTime),
      getToGateBy: formatMilestoneTime(gateArrivalTarget),
      flightDeparts: formatMilestoneTime(parseFlightDepartureDate(eta))
    }
  };
}

function saveCurrentTrip(button, event) {
  event?.preventDefault();
  event?.stopPropagation();
  const trip = buildTripFromCurrentResult();
  const trips = readSavedTrips();
  const existingIndex = trips.findIndex((item) => item.key === trip.key);
  if (existingIndex >= 0) {
    trips[existingIndex] = { ...trips[existingIndex], ...trip };
  } else {
    trips.unshift(trip);
  }
  trip.eta.savedTripId = trip.id;
  if (window.stateApi) window.stateApi.setEta({ savedTripId: trip.id });
  localStorage.setItem('etaResult', JSON.stringify({ ...getLatestEtaResult(), savedTripId: trip.id }));
  writeSavedTrips(trips);
  renderTripsList();
  if (button) {
    button.textContent = '✓ Saved trip';
    button.classList.add('isSaved');
    button.disabled = true;
    button.setAttribute('aria-label', 'Trip saved');
  }
}

function renderTripsList() {
  const container = document.getElementById('tripsList');
  if (!container) return;
  const trips = readSavedTrips()
    .map((trip) => ({ ...trip, status: getTripStatus(trip.eta) }))
    .sort((a, b) => {
      const aTime = new Date(a.eta?.flightDepartureAt || 0).getTime();
      const bTime = new Date(b.eta?.flightDepartureAt || 0).getTime();
      return a.status === 'completed' ? bTime - aTime : aTime - bTime;
    });

  if (!trips.length) {
    container.innerHTML = `
      <div class="appCard tripsEmptyCard">
        <div class="rowTitle">No saved trips yet</div>
        <div class="rowSub">Calculate an ETA, then save it here for later.</div>
      </div>
    `;
    return;
  }

  const upcoming = trips.filter((trip) => trip.status !== 'completed');
  const past = trips.filter((trip) => trip.status === 'completed');
  container.innerHTML = `
    ${renderTripsSection('Upcoming Trips', upcoming)}
    ${renderTripsSection('Past Trips', past)}
  `;
}

function renderTripsSection(title, trips) {
  if (!trips.length) return '';
  return `
    <div class="sectionLabel">${escapeHtml(title)}</div>
    ${trips.map(renderTripCard).join('')}
  `;
}

function renderTripCard(trip) {
  const eta = trip.eta || {};
  const form = trip.form || {};
  const airport = eta.airport || form.airport || 'JFK';
  const flightDate = parseFlightDepartureDate(eta);
  const dateLabel = formatTripDateLabel(flightDate);
  const flightTime = formatMilestoneTime(flightDate) || eta.flightTime || '7:30 PM';
  const isExpanded = expandedSavedTripId === trip.id;
  const expandedResult = isExpanded
    ? buildResultHtml(
      {
        ...eta,
        savedTripId: trip.id,
        transportMode: eta.transportMode || trip.selections?.transport || null
      },
      {
        form,
        embedded: true,
        tripId: trip.id
      }
    )
    : '';

  return `
    <article class="appCard tripsCard tripsCardSaved${isExpanded ? ' isExpanded' : ''}">
      <button type="button" class="tripsCardHeader" onclick="toggleSavedTrip('${escapeHtml(trip.id)}')" aria-expanded="${escapeHtml(String(isExpanded))}">
        <div>
          <div class="tripsAirportCode">${escapeHtml(airport)} · ${escapeHtml(dateLabel)}</div>
          <div class="tripsAirportName">${escapeHtml(flightTime)} flight</div>
        </div>
        <span class="tripsCardChevron" aria-hidden="true"></span>
      </button>
      ${isExpanded ? `<div class="tripsExpandedResult">${expandedResult}</div>` : ''}
    </article>
  `;
}

function toggleSavedTrip(id) {
  expandedSavedTripId = expandedSavedTripId === id ? '' : id;
  renderTripsList();
  if (expandedSavedTripId) {
    window.requestAnimationFrame(() => {
      document.querySelector('#trips .tripsCardSaved.isExpanded')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
}

function openSavedTrip(id) {
  const trip = readSavedTrips().find((item) => item.id === id);
  if (!trip) return;
  restoreTripState(trip);
  show('result');
  renderResult();
}

function editSavedTrip(id) {
  const trip = readSavedTrips().find((item) => item.id === id);
  if (!trip) return;
  restoreTripState(trip);
  show('calculate');
  updateCalculateProgressiveUI();
}

function restoreTripState(trip) {
  if (!window.appState) return;
  window.appState.form = { ...window.appState.form, ...(trip.form || {}) };
  window.appState.selections = { ...window.appState.selections, ...(trip.selections || {}) };
  window.appState.eta = { ...window.appState.eta, ...(trip.eta || {}), savedTripId: trip.id };
  localStorage.setItem('etaResult', JSON.stringify(window.appState.eta));
  syncFormToDom(window.appState.form);
  syncSelectionChipsToState(window.appState.selections);
}

function syncFormToDom(form) {
  const mappings = {
    flightDate: 'flightDate',
    flightTime: 'flightTime',
    flightType: 'flightType',
    flightNumber: 'flightNumberInput',
    airport: 'airportInput',
    terminal: 'terminalInput',
    startLocation: 'startingLocationInput'
  };
  Object.entries(mappings).forEach(([key, id]) => {
    const el = document.getElementById(id);
    if (el && form?.[key] != null) el.value = form[key];
  });
  initializeAirportTerminalSelects();
}

function syncSelectionChipsToState(selections) {
  Object.entries(selections || {}).forEach(([groupName, value]) => {
    const group = document.querySelector(`[data-group="${groupName}"]`);
    if (!group) return;
    const normalizedValue = normalizeSelectionValueForMatching(groupName, value);
    group.querySelectorAll('.chip').forEach((chip) => {
      const explicit = chip.getAttribute('data-selection');
      const label = chip.querySelector('.styleChipLabel')?.textContent || chip.textContent;
      const chipValue = String(explicit || label || '').trim();
      chip.classList.toggle('active', normalizeSelectionValueForMatching(groupName, chipValue) === normalizedValue);
    });
  });
}

function normalizeSelectionValueForMatching(groupName, value) {
  const raw = String(value || '').trim();
  if (groupName === 'boarding' && raw === 'Grab food') return 'Hudson News';
  return raw;
}

function getTripStatus(eta) {
  const flightDate = parseFlightDepartureDate(eta);
  if (!(flightDate instanceof Date) || Number.isNaN(flightDate.getTime())) return 'upcoming';
  const now = new Date();
  const sameDay = flightDate.toDateString() === now.toDateString();
  if (flightDate.getTime() < now.getTime()) return 'completed';
  return sameDay ? 'active_today' : 'upcoming';
}

function formatTripDateLabel(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return 'Saved trip';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function isResultSavedTrip(result) {
  if (String(result?.savedTripId || '').trim()) return true;
  const key = getTripKey({ eta: result, form: window.appState?.form || {} });
  return readSavedTrips().some((trip) => trip.key === key);
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

  container.innerHTML = buildResultHtml(result);
}

function buildResultHtml(result, options = {}) {
  const form = options.form || window.appState?.form || {};
  const embedded = Boolean(options.embedded);
  const tripId = String(options.tripId || result.savedTripId || '').trim();
  const airportLabel = (result.airport || form.airport || 'JFK').trim();
  const terminalLabel = (result.terminal || form.terminal || 'Terminal 4').trim();
  const scheduledFlightTime = formatFlightTimeForDisplay(result.flightTime || form.flightTime);
  const flightType = normalizeFlightType(result.flightType || form.flightType || 'Domestic');
  const flightNumber = String(result.flightNumber || form.flightNumber || '').trim().toUpperCase();
  const startForDisplay = formatAddressForDisplay(result.origin || form.startLocation || '').trim();
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
  const isSavedTrip = isResultSavedTrip(result);
  const urgency = getUrgencyPresentation(result);
  const showUrgencyDebug = shouldShowUrgencyDebug();
  const monitorUpdatedLabel = formatMonitorUpdatedLabel(result.monitorUpdatedAt);
  const modeContextLine = getCalculationModeContextLine(result);
  const calculationMode = String(result.calculationMode || '').trim();
  const isPlanningMode = calculationMode === 'planning';
  const breakdownTitle = isPlanningMode
    ? 'Planned Timing Breakdown'
    : calculationMode === 'live'
      ? 'Live Timing Breakdown'
      : 'Trip Breakdown';
  const flightDepartureDate = parseFlightDepartureDate(result);
  const flightDepartureTime = formatMilestoneTime(flightDepartureDate) || scheduledFlightTime || '7:30 PM';
  const gateArrivalTarget = getGateArrivalTarget(result, flightType);
  const gateArrivalTime = formatMilestoneTime(gateArrivalTarget) || '--';
  const flightDateContext = formatFlightDateContext(result);
  const heroFlightSubject = flightNumber ? `${flightNumber} flight` : `${flightType.toLowerCase()} flight`;
  const heroFlightDepartLine = `Your ${heroFlightSubject} departs at ${scheduledFlightTime || '7:30 PM'}`;
  const planningHeroDepartLine = `Departs ${scheduledFlightTime || '7:30 PM'}${flightDateContext ? ` · ${flightDateContext}` : ''}`;
  const heroFlightMetaLine = isPlanningMode
    ? `${airportLabel} · ${terminalLabel}`
    : `${airportLabel} · ${terminalLabel} · Gate`;
  const planningHeroDetailsLine = `${flightType} flight · ${heroFlightMetaLine}`;
  const heroOriginPrefix = getTransportOriginPrefix(result.transportMode);
  const heroOriginLine = (heroOriginPrefix && startForDisplay) ? `${heroOriginPrefix} ${startForDisplay}` : '';
  const heroMetaBlockClass = isPlanningMode
    ? 'resultHtmlMetaBlock resultHtmlMetaBlock--planning'
    : 'resultHtmlMetaBlock';
  const isLga = String(result.airport || '').toUpperCase() === 'LGA';
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
  const arriveAtAirportTime = formatMilestoneTime(getAirportArrivalTime(result)) || '--';
  const airportTimingDuration = formatDurationMinutes(getAirportTimingMinutes(result));
  const trafficTag = (result.travelStatus === 'live' && ['google', 'mapbox'].includes(String(result.travelProvider || '').toLowerCase()))
    ? 'Live'
    : 'Estimated';
  const provider = String(result.travelProvider || '').toLowerCase();
  const trafficTagLabel = provider === 'google' ? 'GOOGLE ROUTES' : trafficTag.toUpperCase();
  const conditionsTitle = isPlanningMode ? 'Estimated Conditions' : 'Live Conditions';
  const conditionsTrafficTagLabel = isPlanningMode ? 'ROUTES EST.' : trafficTagLabel;
  const conditionsTrafficTagClass = isPlanningMode ? 'resultLiveTag--estimated' : 'resultLiveTag--traffic';
  const conditionsSecurityTagLabel = isPlanningMode ? 'TSA EST.' : securityTag;
  const conditionsSecurityTagClass = isPlanningMode ? 'resultLiveTag--estimated' : 'resultLiveTag--security';
  const conditionsAirportTagLabel = isPlanningMode ? 'FAA EST.' : (isLga ? walkTag : 'FAA');
  const conditionsAirportTagClass = isPlanningMode ? 'resultLiveTag--estimated' : 'resultLiveTag--faa';
  const conditionsWeatherTagLabel = isPlanningMode ? 'WEATHER EST.' : 'Clear';
  const conditionsWeatherTagClass = isPlanningMode ? 'resultLiveTag--estimated' : 'resultLiveTag--clear';
  const timingReasonRows = renderTimingReasonRows(result.timingAdjustmentReasons);
  const actionsHtml = embedded
    ? `<button class="resultHtmlEdit" onclick="editSavedTrip('${escapeHtml(tripId)}')">Edit</button>`
    : `
        <button type="button" class="resultHtmlEdit resultHtmlSaveTrip${isSavedTrip ? ' isSaved' : ''}" ${isSavedTrip ? 'disabled aria-label="Trip saved"' : 'onclick="saveCurrentTrip(this, event)"'}>${isSavedTrip ? '✓ Saved trip' : 'Save trip'}</button>
        <button class="resultHtmlEdit" onclick="show('calculate')">Edit</button>
      `;

  return `
    <div class="resultHtmlHeader">
      <h2 class="resultHtmlTitle">${embedded ? 'Trip detail' : 'Your ETA'}</h2>
      <div class="resultHtmlActions">
        ${actionsHtml}
      </div>
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
      <div class="${escapeHtml(heroMetaBlockClass)}">
        ${isPlanningMode ? `
        <div class="resultHtmlMetaLine resultHtmlMetaLine--departure">${escapeHtml(planningHeroDepartLine)}</div>
        <div class="resultHtmlMetaLine resultHtmlMetaLine--flightType">${escapeHtml(planningHeroDetailsLine)}</div>
        ${heroOriginLine ? `<div class="resultHtmlMetaLine resultHtmlMetaLine--origin">${escapeHtml(heroOriginLine)}</div>` : ''}
        ` : `
        <div class="resultHtmlMetaLine">${escapeHtml(heroFlightDepartLine)}</div>
        <div class="resultHtmlMetaLine">${escapeHtml(heroFlightMetaLine)}</div>
        ${heroOriginLine ? `<div class="resultHtmlMetaLine">${escapeHtml(heroOriginLine)}</div>` : ''}
        `}
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
      <div class="resultBreakdownTitle">${escapeHtml(breakdownTitle)}</div>
      <div class="resultBreakdownRow"><span>Leave Home</span><strong>${escapeHtml(result.leaveBy || '5:42 PM')}</strong></div>
      <div class="resultBreakdownRow"><span>Arrive at airport</span><strong>${escapeHtml(arriveAtAirportTime)}</strong></div>
      <div class="resultBreakdownRow resultBreakdownRow--support"><span>Travel to airport</span><strong>${escapeHtml(travelDuration)}</strong></div>
      <div class="resultBreakdownRow"><span>Time at airport</span><strong>${escapeHtml(airportTimingDuration)}</strong></div>
      ${timingReasonRows}
      <div class="resultBreakdownRow"><span>Get to gate by</span><strong>${escapeHtml(gateArrivalTime)}</strong></div>
      <div class="resultBreakdownRow"><span>Flight departs</span><strong>${escapeHtml(flightDepartureTime)}</strong></div>
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
      <div class="resultLiveTitle">${escapeHtml(conditionsTitle)}</div>
      <div class="resultLiveRow primary">
        <div class="resultLiveLabelWrap resultLiveLabelWrapTraffic">
          <div class="resultLiveLabelTopRow">
            <span class="resultLiveLabel">Traffic</span>
            <span class="resultLiveTag ${escapeHtml(conditionsTrafficTagClass)}">${escapeHtml(conditionsTrafficTagLabel)}</span>
          </div>
        </div>
        <strong class="resultLiveValue">${escapeHtml(travelDuration)}</strong>
      </div>
      <div class="resultLiveRow">
        <div class="resultLiveLabelWrap">
          <span class="resultLiveLabel">Security wait</span>
          <span class="resultLiveTag ${escapeHtml(conditionsSecurityTagClass)}">${escapeHtml(conditionsSecurityTagLabel)}</span>
        </div>
        <strong class="resultLiveValue">${escapeHtml(hasResolvedSecurity ? formatDurationMinutes(securityWait) : '--')}</strong>
      </div>
      <div class="resultLiveRow">
        <div class="resultLiveLabelWrap">
          <span class="resultLiveLabel">${isLga ? 'Walk to gate' : 'Airport status'}</span>
          <span class="resultLiveTag ${escapeHtml(conditionsAirportTagClass)}">${escapeHtml(conditionsAirportTagLabel)}</span>
        </div>
        <strong class="resultLiveValue text">${escapeHtml(isLga ? walkToGateValue : 'No advisory')}</strong>
      </div>
      <div class="resultLiveRow">
        <div class="resultLiveLabelWrap">
          <span class="resultLiveLabel">Weather</span>
          <span class="resultLiveTag ${escapeHtml(conditionsWeatherTagClass)}">${escapeHtml(conditionsWeatherTagLabel)}</span>
        </div>
        <strong class="resultLiveValue text">${escapeHtml('No delays')}</strong>
      </div>
    </div>
  `;
}

function renderTimingReasonRows(reasons) {
  if (!Array.isArray(reasons)) return '';
  const rows = aggregateTimingReasonRows(reasons);
  if (!rows.length) return '';

  return rows.map((item) => {
    return `
        <div class="resultBreakdownRow resultBreakdownRow--support resultBreakdownRow--timingReason">
          <span>${escapeHtml(item.label)}</span>
          <strong>${escapeHtml(formatSignedMinutes(item.minutes))}</strong>
        </div>
      `;
  }).join('');
}

function aggregateTimingReasonRows(reasons) {
  const groups = new Map();
  reasons
    .filter((item) => item?.visible !== false && Number.isFinite(Number(item?.minutes)) && String(item?.label || '').trim())
    .forEach((item) => {
      const group = getTimingReasonGroup(item.label);
      const current = groups.get(group.key) || {
        label: group.label,
        minutes: 0,
        order: group.order
      };
      current.minutes += Math.round(Number(item.minutes));
      groups.set(group.key, current);
    });

  combineInternationalBagTiming(groups);

  return Array.from(groups.values())
    .filter((item) => item.minutes !== 0 || isZeroMinuteTimingReason(item.label))
    .sort((a, b) => a.order - b.order);
}

function combineInternationalBagTiming(groups) {
  const internationalCheckIn = groups.get('international-check-in');
  const bagHandling = groups.get('bag-handling');
  if (!internationalCheckIn || !bagHandling) return;

  groups.set('international-bag-drop-check-in', {
    label: 'International bag drop/check-in',
    minutes: internationalCheckIn.minutes + bagHandling.minutes,
    order: 10
  });
  groups.delete('international-check-in');
  groups.delete('bag-handling');
}

function getTimingReasonGroup(label) {
  const normalized = String(label || '').trim().toLowerCase();
  if (normalized.includes('international bag drop')) {
    return { key: 'international-bag-drop-check-in', label: 'International bag drop/check-in', order: 10 };
  }
  if (normalized.includes('international check-in')) {
    return { key: 'international-check-in', label: 'International check-in', order: 10 };
  }
  if (normalized.includes('checked') || normalized.includes('bag drop')) {
    return { key: 'bag-handling', label: 'Bag drop', order: 20 };
  }
  if (normalized.includes('standard security') || normalized.includes('security cushion')) {
    return { key: 'standard-security', label: 'Standard security', order: 30 };
  }
  if (normalized.includes('clear')) {
    return { key: 'clear-precheck', label: 'CLEAR + PreCheck', order: 30 };
  }
  if (normalized.includes('precheck')) {
    return { key: 'precheck', label: 'PreCheck', order: 30 };
  }
  if (normalized.includes('terminal navigation') || normalized.includes('airport baseline')) {
    return { key: 'terminal-navigation', label: 'Terminal navigation', order: 40 };
  }
  if (normalized.includes('boarding time') || normalized.includes('boarding buffer') || normalized.includes('base timing cushion')) {
    return { key: 'boarding-time', label: 'Boarding time', order: 50 };
  }
  if (normalized.includes('peak travel window')) {
    return { key: 'peak-travel-window', label: 'Peak travel window', order: 60 };
  }
  if (normalized.includes('hudson') || normalized.includes('grab food')) {
    return { key: 'hudson-news-stop', label: 'Hudson News stop', order: 70 };
  }
  if (normalized.includes('family')) {
    return { key: 'family-children', label: 'Family / children', order: 75 };
  }
  if (normalized.includes('pets')) {
    return { key: 'traveling-with-pets', label: 'Traveling with pets', order: 75 };
  }
  if (normalized.includes('group travel')) {
    return { key: 'group-travel', label: 'Group travel', order: 75 };
  }
  if (normalized.includes('lounge')) {
    return { key: 'lounge-time', label: 'Lounge time', order: 80 };
  }
  if (normalized.includes('relaxed')) {
    return { key: 'relaxed-travel-style', label: 'Relaxed travel style', order: 90 };
  }
  if (normalized.includes('tight')) {
    return { key: 'tight-travel-style', label: 'Tight travel style', order: 90 };
  }
  return {
    key: normalized || 'airport-timing',
    label: formatTimingReasonLabel(label),
    order: 100
  };
}

function isZeroMinuteTimingReason(label) {
  const normalized = String(label || '').trim().toLowerCase();
  return normalized === 'precheck';
}

function formatSignedMinutes(minutes) {
  const rounded = Math.round(Number(minutes));
  if (!Number.isFinite(rounded)) return '--';
  const sign = rounded > 0 ? '+' : '';
  return `${sign}${formatDurationMinutes(Math.abs(rounded))}`;
}

function getAirportTimingMinutes(result) {
  const airportTime = Number(result?.airportTime);
  const buffer = Number(result?.buffer);
  const safeAirportTime = Number.isFinite(airportTime) && airportTime >= 0 ? airportTime : 0;
  const safeBuffer = Number.isFinite(buffer) && buffer >= 0 ? buffer : 0;
  return safeAirportTime + safeBuffer;
}

function getAirportArrivalTime(result) {
  const leaveDate = parseClockTimeToday(result?.leaveBy);
  const travelMinutes = Number(result?.travel);
  if (!leaveDate || !Number.isFinite(travelMinutes) || travelMinutes < 0) return null;
  return new Date(leaveDate.getTime() + Math.round(travelMinutes) * 60000);
}

function formatMilestoneTime(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  return formatTime(date);
}

function getGateArrivalTarget(result, flightType) {
  const flightDate = parseFlightDepartureDate(result);
  if (!(flightDate instanceof Date) || Number.isNaN(flightDate.getTime())) return null;
  const leadMinutes = getGateArrivalLeadMinutes(result, flightType);
  return new Date(flightDate.getTime() - leadMinutes * 60000);
}

function getGateArrivalLeadMinutes(result, flightType) {
  if (normalizeFlightType(flightType || result?.flightType) !== 'International') return 30;
  const reasons = Array.isArray(result?.timingAdjustmentReasons) ? result.timingAdjustmentReasons : [];
  const hasExtendedAirportNeeds = reasons.some((item) => {
    const label = String(item?.label || '').toLowerCase();
    return (
      label.includes('checked')
      || label.includes('security')
      || label.includes('peak')
    );
  });
  return hasExtendedAirportNeeds ? 60 : 45;
}

function formatTimingReasonLabel(label) {
  const normalized = String(label || '').trim().toLowerCase();
  if (normalized.includes('international check-in')) return 'International check-in';
  if (normalized.includes('checked-bag')) return 'Checked bags';
  if (normalized.includes('security cushion')) return 'Security cushion';
  if (normalized.includes('peak travel window')) return 'Peak travel window';
  return String(label || '').trim();
}

function formatFlightDateContext(result) {
  const flightDate = parseFlightDepartureDate(result);
  if (!(flightDate instanceof Date) || Number.isNaN(flightDate.getTime())) return '';
  return flightDate.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric'
  });
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
      pillCopy: 'Estimating typical traffic patterns',
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

