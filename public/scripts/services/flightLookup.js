/**
 * Flight lookup service v1 — mock-backed, API-ready.
 * Not loaded by the app currently; wire via `<script>` when re-enabling autofill.
 * Served path would be `/scripts/services/flightLookup.js`.
 * Mirror: `src/services/flightLookup.js` (keep in sync until a bundler owns one path).
 */
(function (global) {
  const US_IATA = new Set([
    'ALB', 'ATL', 'AUS', 'BDL', 'BNA', 'BOI', 'BOS', 'BUF', 'BUR', 'BWI', 'CHS', 'CLE', 'CLT', 'CMH', 'CVG',
    'DAY', 'DCA', 'DEN', 'DFW', 'DSM', 'DTW', 'EWR', 'FLL', 'HNL', 'HOU', 'IAD', 'IAH', 'IND', 'JAX', 'JFK',
    'LAS', 'LAX', 'LGA', 'MCI', 'MCO', 'MDW', 'MEM', 'MIA', 'MKE', 'MSP', 'MSN', 'MSY', 'OAK', 'OKC', 'OMA',
    'ONT', 'ORD', 'ORF', 'PBI', 'PDX', 'PHL', 'PHX', 'PIT', 'PVD', 'RDU', 'RIC', 'SAN', 'SAT', 'SEA', 'SFO',
    'SJC', 'SLC', 'SMF', 'SNA', 'STL', 'TPA', 'TUS'
  ]);

  function isUSAirport(code) {
    if (code == null || String(code).trim() === '') return false;
    return US_IATA.has(String(code).trim().toUpperCase());
  }

  /**
   * If arrival is missing, returns null (caller should not overwrite user flight type).
   * @param {string} departureAirport
   * @param {string} [arrivalAirport]
   * @returns {'domestic' | 'international' | null}
   */
  function classifyFlightType(departureAirport, arrivalAirport) {
    if (!arrivalAirport || !String(arrivalAirport).trim()) return null;
    const dep = String(departureAirport || '').trim().toUpperCase();
    const arr = String(arrivalAirport || '').trim().toUpperCase();
    if (!dep || !arr) return null;
    if (isUSAirport(dep) && isUSAirport(arr)) return 'domestic';
    return 'international';
  }

  function normalizeFlightNumber(raw) {
    return String(raw || '').replace(/\s+/g, '').toUpperCase();
  }

  function buildNormalizedFlight({
    flightNumber,
    flightDate,
    airline,
    departureAirport,
    arrivalAirport,
    departureTime,
    terminal,
    gate,
    status,
    source
  }) {
    const flightType = classifyFlightType(departureAirport, arrivalAirport);
    return {
      flightNumber: String(flightNumber || '').trim(),
      flightDate: String(flightDate || '').trim(),
      airline: airline || undefined,
      departureAirport: String(departureAirport || '').trim().toUpperCase(),
      arrivalAirport: arrivalAirport ? String(arrivalAirport).trim().toUpperCase() : undefined,
      departureTime: String(departureTime || '').trim(),
      terminal: terminal || undefined,
      gate: gate || undefined,
      flightType: flightType == null ? undefined : flightType,
      status: status || undefined,
      source: source || 'mock'
    };
  }

  /**
   * May 27 test cases (any year): DL123, AA142, B61234, BA178 — all depart JFK for NYC-app compatibility.
   */
  function mockRegistryEntry(partial, requestDate) {
    const flightDate = String(requestDate || partial.flightDate || '').trim();
    return buildNormalizedFlight({
      ...partial,
      flightDate,
      source: 'mock'
    });
  }

  const FLIGHT_SPECS = [
    {
      numbers: ['DL123', 'DL0123'],
      spec: {
        flightNumber: 'DL 123',
        airline: 'Delta',
        departureAirport: 'JFK',
        arrivalAirport: 'LAX',
        departureTime: '08:15',
        terminal: 'Terminal 4',
        gate: 'B32',
        status: 'scheduled'
      }
    },
    {
      numbers: ['AA142', 'AA0142'],
      spec: {
        flightNumber: 'AA 142',
        airline: 'American',
        departureAirport: 'JFK',
        arrivalAirport: 'ORD',
        departureTime: '10:45',
        terminal: 'Terminal 8',
        gate: 'C12',
        status: 'scheduled'
      }
    },
    {
      numbers: ['B61234'],
      spec: {
        flightNumber: 'B6 1234',
        airline: 'JetBlue',
        departureAirport: 'JFK',
        arrivalAirport: 'BOS',
        departureTime: '16:20',
        terminal: 'Terminal 5',
        gate: 'M7',
        status: 'boarding'
      }
    },
    {
      numbers: ['BA178', 'BA0178'],
      spec: {
        flightNumber: 'BA 178',
        airline: 'British Airways',
        departureAirport: 'JFK',
        arrivalAirport: 'LHR',
        departureTime: '21:30',
        terminal: 'Terminal 7',
        gate: '1',
        status: 'delayed'
      }
    }
  ];

  function monthDayFromIso(dateStr) {
    const d = String(dateStr || '').trim();
    if (d.length >= 10) return d.slice(5, 10);
    return d;
  }

  function isMay27(dateStr) {
    return monthDayFromIso(dateStr) === '05-27';
  }

  function mockLookup(flightNumber, flightDate) {
    const fn = normalizeFlightNumber(flightNumber);
    if (!fn || !flightDate) return null;
    if (!isMay27(flightDate)) return null;

    const entry = FLIGHT_SPECS.find((row) => row.numbers.some((n) => normalizeFlightNumber(n) === fn));
    if (!entry) return null;
    return mockRegistryEntry(entry.spec, flightDate);
  }

  /**
   * Future: replace body with API fetch; keep this function signature.
   * @param {{ flightNumber: string, flightDate: string }} params ISO date YYYY-MM-DD
   * @returns {Promise<{ ok: true, flight: object } | { ok: false, message: string, code?: string }>}
   */
  async function lookupFlight({ flightNumber, flightDate } = {}) {
    await new Promise((resolve) => setTimeout(resolve, 420));

    /*
    const res = await fetch('/api/flight-lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flightNumber, flightDate })
    });
    const data = await res.json();
    if (!data?.ok) return { ok: false, message: data?.message || 'Flight not found', code: data?.code };
    return { ok: true, flight: normalizeApiFlight(data.flight) };
    */

    const flight = mockLookup(flightNumber, flightDate);
    if (!flight) {
      return {
        ok: false,
        message: "We couldn't find that flight. You can still enter details manually.",
        code: 'NOT_FOUND'
      };
    }
    return { ok: true, flight };
  }

  global.FlightLookup = {
    lookupFlight,
    classifyFlightType,
    normalizeFlightNumber
  };
})(typeof window !== 'undefined' ? window : globalThis);
