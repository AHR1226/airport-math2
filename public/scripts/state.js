window.appState = {
  currentScreen: 'splash',
  form: {
    flightTime: '19:30',
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
    flightTime: '7:30 PM',
    airport: 'JFK',
    travel: 45,
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
    const flightEl = document.getElementById('flightTime');
    const airportEl = document.getElementById('airportInput');
    const terminalEl = document.getElementById('terminalInput');
    const startLocationEl = document.getElementById('startingLocationInput');

    if (flightEl) window.appState.form.flightTime = flightEl.value || '19:30';
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
