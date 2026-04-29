window.appState = {
  currentScreen: 'splash',
  form: {
    flightDate: '',
    flightTime: '19:30',
    flightType: 'Domestic',
    flightNumber: '',
    airport: 'JFK',
    terminal: 'Terminal 4',
    startLocation: ''
  },
  selections: {
    transport: 'Rideshare',
    luggage: 'Carry-on only',
    security: 'PreCheck',
    boarding: 'Head to gate',
    style: 'Balanced'
  },
  eta: {
    leaveBy: '5:42 PM',
    flightDate: '',
    flightTime: '7:30 PM',
    flightType: 'Domestic',
    flightDepartureAt: '',
    calculationMode: 'live',
    airport: 'JFK',
    travel: null,
    airportTime: 35,
    buffer: 15,
    total: 95,
    style: 'Balanced'
  }
};

window.stateApi = {
  setScreen(screenId) {
    window.appState.currentScreen = screenId;
  },
  setSelection(groupName, value) {
    window.appState.selections[groupName] = value;
  },
  getSelection(groupName) {
    return window.appState.selections[groupName] || '';
  },
  syncFormFromDom() {
    const flightDateEl = document.getElementById('flightDate');
    const flightEl = document.getElementById('flightTime');
    const flightTypeEl = document.getElementById('flightType');
    const flightNumberEl = document.getElementById('flightNumberInput');
    const airportEl = document.getElementById('airportInput');
    const terminalEl = document.getElementById('terminalInput');
    const startLocationEl = document.getElementById('startingLocationInput');

    if (flightDateEl) window.appState.form.flightDate = flightDateEl.value;
    if (flightEl) window.appState.form.flightTime = flightEl.value || '19:30';
    if (flightTypeEl) window.appState.form.flightType = flightTypeEl.value || 'Domestic';
    if (flightNumberEl) window.appState.form.flightNumber = flightNumberEl.value.trim();
    if (airportEl) window.appState.form.airport = airportEl.value || 'JFK';
    if (terminalEl) window.appState.form.terminal = terminalEl.value || 'Terminal 4';
    if (startLocationEl) {
      window.appState.form.startLocation = startLocationEl.value.trim();
    }
  },
  setEta(eta) {
    window.appState.eta = { ...window.appState.eta, ...eta };
  }
};
