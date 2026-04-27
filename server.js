require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function airportPreset(airport) {
  const presets = {
    JFK: 'JFK Airport Departures, Queens, NY',
    LGA: 'LaGuardia Airport Departures, Queens, NY',
    EWR: 'Newark Liberty International Airport Departures, Newark, NJ',
    OTHER: 'Airport Departures'
  };
  return presets[airport] || presets.OTHER;
}

function terminalDestination(airport, terminal) {
  const code = String(airport || 'OTHER').toUpperCase();
  const term = String(terminal || '').trim();
  const map = {
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
  return map[code]?.[term] || airportPreset(code);
}

function mockTravel({ airport, mode, baseMinutes = 40, rushHour = false, provider = 'mock' }) {
  const base = Number(baseMinutes) || 40;
  const rush = rushHour === 'true' || rushHour === true;
  const extra = rush ? 10 : 5;
  const airportBump = airport === 'JFK' ? 12 : airport === 'EWR' ? 9 : airport === 'LGA' ? 4 : 0;
  const modeBump = mode === 'public' ? 12 : 0;
  return {
    status: 'fallback',
    source: 'Backup estimate',
    provider,
    travelMinutes: base + airportBump + modeBump,
    typicalMinutes: base + Math.max(0, airportBump - 3),
    extraMinutes: extra,
    modeLabel: mode === 'public' ? 'Public transit' : 'Driving / rideshare'
  };
}

async function geocodeMapbox(query) {
  const token = requireEnv('MAPBOX_ACCESS_TOKEN');
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?limit=1&access_token=${token}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Mapbox geocoding failed: ${res.status}`);
  const data = await res.json();
  const feature = data.features?.[0];
  if (!feature?.center) throw new Error(`No geocode result for: ${query}`);
  return { lng: feature.center[0], lat: feature.center[1] };
}

async function routeWithMapbox({ origin, destination, departAt }) {
  const token = requireEnv('MAPBOX_ACCESS_TOKEN');
  const [from, to] = await Promise.all([geocodeMapbox(origin), geocodeMapbox(destination)]);
  const coords = `${from.lng},${from.lat};${to.lng},${to.lat}`;
  const departParam = departAt ? `&depart_at=${encodeURIComponent(departAt)}` : '';
  const url = `https://api.mapbox.com/directions/v5/mapbox/driving-traffic/${coords}?alternatives=false&overview=false&access_token=${token}${departParam}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Mapbox directions failed: ${res.status}`);
  const data = await res.json();
  const route = data.routes?.[0];
  if (!route) throw new Error('No route returned from Mapbox');
  return { status:'live', source:'Mapbox Directions API', provider:'mapbox', travelMinutes:Math.round((route.duration||0)/60), typicalMinutes:null, extraMinutes:0, modeLabel:'Driving / rideshare' };
}

function parseDuration(value) {
  if (!value || typeof value !== 'string' || !value.endsWith('s')) return 0;
  return Number(value.slice(0, -1)) || 0;
}

async function routeWithGoogle({ origin, destination }) {
  const apiKey = requireEnv('GOOGLE_MAPS_API_KEY');
  const url = 'https://routes.googleapis.com/directions/v2:computeRoutes';
  const body = {
    origin: { address: origin },
    destination: { address: destination },
    travelMode: 'DRIVE',
    routingPreference: 'TRAFFIC_AWARE',
    computeAlternativeRoutes: false,
    routeModifiers: { avoidTolls: false, avoidHighways: false, avoidFerries: false }
  };
  const res = await fetch(url, {
    method:'POST',
    headers:{
      'Content-Type':'application/json',
      'X-Goog-Api-Key':apiKey,
      'X-Goog-FieldMask':'routes.duration,routes.staticDuration,routes.distanceMeters'
    },
    body:JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google Routes failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  const route = data.routes?.[0];
  if (!route) throw new Error('No route returned from Google');
  const travelMinutes = Math.round(parseDuration(route.duration) / 60);
  const staticMinutes = route.staticDuration ? Math.round(parseDuration(route.staticDuration) / 60) : null;
  console.log('[travel-debug] provider=google', {
    origin,
    destination,
    travelMinutes,
    staticDuration: staticMinutes
  });
  return { status:'live', source:'Google Routes API', provider:'google', travelMinutes, typicalMinutes:staticMinutes, extraMinutes:0, modeLabel:'Driving / rideshare' };
}

async function routeAuto(params) {
  try { return await routeWithGoogle(params); } catch {}
  try {
    const mapbox = await routeWithMapbox(params);
    console.log('[travel-debug] provider=mapbox', {
      origin: params.origin,
      destination: params.destination,
      travelMinutes: mapbox.travelMinutes,
      staticDuration: null
    });
    return mapbox;
  } catch {}
  const fallback = mockTravel(params);
  console.log('[travel-debug] provider=mock', {
    origin: params.origin,
    destination: params.destination,
    travelMinutes: fallback.travelMinutes,
    staticDuration: null
  });
  return fallback;
}

function securityFallback(airport) {
  const map = {
    JFK:{ status:'estimate', source:'Built-in fallback', regular:31, precheck:12, updatedAt:'—' },
    LGA:{ status:'estimate', source:'Built-in fallback', regular:21, precheck:8, updatedAt:'—' },
    EWR:{ status:'estimate', source:'Built-in fallback', regular:27, precheck:10, updatedAt:'—' },
    OTHER:{ status:'fallback', source:'Built-in fallback', regular:35, precheck:16, updatedAt:'—' }
  };
  return map[airport] || map.OTHER;
}

function parseAirportSecurityHtml(airport, html) {
  const $ = cheerio.load(html);
  const text = $('body').text().replace(/\s+/g, ' ').trim();
  let regular = null, precheck = null;
  const generalMatch = text.match(/General(?:\s+TSA|\s+Line)?[^0-9]{0,40}(\d{1,3})\s*min/i);
  const precheckMatch = text.match(/(?:TSA\s*Pre.?|PreCheck|Pre✓|PreCheck®)[^0-9]{0,40}(\d{1,3})\s*min/i);
  if (generalMatch) regular = Number(generalMatch[1]);
  if (precheckMatch) precheck = Number(precheckMatch[1]);
  const byTerminal = [];
  const terminalRegex = /(Terminal\s+[A-Z0-9]+|Gates?\s+\d{1,2}(?:-\d{1,2})?)[^\.]{0,90}?(\d{1,3})\s*min(?:[^\.]{0,40}?(?:TSA\s*Pre.?|PreCheck|Pre✓)[^0-9]{0,20}(\d{1,3})\s*min)?/gi;
  let t;
  while ((t = terminalRegex.exec(text)) !== null) {
    const label = t[1], reg = t[2], pre = t[3];
    byTerminal.push(pre ? `${label}: ${reg}m / Pre ${pre}m` : `${label}: ${reg}m`);
    if (regular === null && reg) regular = Number(reg);
    if (precheck === null && pre) precheck = Number(pre);
  }
  if (regular === null && precheck === null) throw new Error(`Could not parse security waits for ${airport}`);
  return { status:'live', source:airport === 'EWR' ? 'Newark Airport official site' : 'Official airport site', regular:regular ?? securityFallback(airport).regular, precheck:precheck ?? Math.max(4, (regular ?? 20) - 10), updatedAt:new Date().toISOString(), byTerminal:byTerminal.slice(0,4) };
}

async function fetchOfficialSecurity(airport) {
  const urls = { JFK:'https://www.jfkairport.com/', LGA:'https://www.laguardiaairport.com/', EWR:'https://www.newarkairport.com/' };
  const url = urls[airport];
  if (!url) return securityFallback(airport);
  const res = await fetch(url, { headers:{ 'User-Agent':'Mozilla/5.0 AirportMath/1.0', 'Accept':'text/html,application/xhtml+xml' } });
  if (!res.ok) throw new Error(`Security page fetch failed: ${res.status}`);
  return parseAirportSecurityHtml(airport, await res.text());
}

function currentFaa(airport) {
  const map = {
    JFK:{ status:'estimate', source:'Demo FAA layer', severity:'moderate', message:'Minor delay program pressure', extraMinutes:12 },
    LGA:{ status:'fallback', source:'No major advisory', severity:'low', message:'Normal ops', extraMinutes:0 },
    EWR:{ status:'live', source:'Demo FAA layer', severity:'low', message:'Minor flow management, still moving', extraMinutes:5 },
    OTHER:{ status:'fallback', source:'Static fallback', severity:'low', message:'No live airport source configured', extraMinutes:0 }
  };
  return map[airport] || map.OTHER;
}

function currentWeather(airport) {
  const map = {
    JFK:{ status:'estimate', source:'Demo weather layer', severity:'low', summary:'Breezy, manageable conditions', extraMinutes:4 },
    LGA:{ status:'fallback', source:'No weather penalty', severity:'low', summary:'No notable weather impact', extraMinutes:0 },
    EWR:{ status:'estimate', source:'Demo weather layer', severity:'moderate', summary:'Wind may slow airport flow a bit', extraMinutes:7 },
    OTHER:{ status:'fallback', source:'Static fallback', severity:'low', summary:'No live weather source configured', extraMinutes:0 }
  };
  return map[airport] || map.OTHER;
}

const LGA_CACHE_TTL_MS = 3 * 60 * 1000;
let lgaConditionsCache = {
  expiresAt: 0,
  payload: null
};

function lgaFallbackConditions() {
  return {
    airport: 'LGA',
    status: 'estimated',
    securityGeneralMinutes: 12,
    securityPrecheckMinutes: 3,
    walkToGateMinutes: 8,
    source: 'Estimated airport conditions',
    updatedAt: new Date().toISOString()
  };
}

function parseLgaConditionsHtml(html) {
  const $ = cheerio.load(html);
  const text = $('body').text().replace(/\s+/g, ' ').trim();
  const generalPatterns = [
    /General(?:\s+Line|\s+TSA|\s+Security|\s+Screening)?[^0-9]{0,60}(\d{1,3})\s*min/i,
    /Security(?:\s+Wait(?:\s+Time)?)?[^0-9]{0,40}General[^0-9]{0,40}(\d{1,3})\s*min/i
  ];
  const precheckPatterns = [
    /(?:TSA\s*Pre.?|PreCheck|Pre✓|PreCheck®)[^0-9]{0,60}(\d{1,3})\s*min/i,
    /Security(?:\s+Wait(?:\s+Time)?)?[^0-9]{0,40}(?:TSA\s*Pre.?|PreCheck)[^0-9]{0,40}(\d{1,3})\s*min/i
  ];
  const walkPatterns = [
    /Walk(?:\s+Times?)?\s+to\s+Gates?[^0-9]{0,60}(\d{1,3})\s*min/i,
    /Gates?[^0-9]{0,40}Walk(?:\s+Times?)?[^0-9]{0,40}(\d{1,3})\s*min/i,
    /Walk(?:\s+to)?[^0-9]{0,40}Gate[^0-9]{0,40}(\d{1,3})\s*min/i
  ];

  const matchAny = (patterns) => {
    for (const p of patterns) {
      const m = text.match(p);
      if (m) return m;
    }
    return null;
  };

  const generalMatch = matchAny(generalPatterns);
  const precheckMatch = matchAny(precheckPatterns);
  const walkMatch = matchAny(walkPatterns);

  const securityGeneralMinutes = generalMatch ? Number(generalMatch[1]) : null;
  const securityPrecheckMinutes = precheckMatch ? Number(precheckMatch[1]) : null;
  const walkToGateMinutes = walkMatch ? Number(walkMatch[1]) : null;

  if (
    securityGeneralMinutes === null &&
    securityPrecheckMinutes === null &&
    walkToGateMinutes === null
  ) {
    return null;
  }

  return {
    airport: 'LGA',
    status: 'live',
    securityGeneralMinutes,
    securityPrecheckMinutes,
    walkToGateMinutes,
    source: 'LaGuardia Airport',
    updatedAt: new Date().toISOString()
  };
}

function parseLgaTerminalBFromSecurityPage(html) {
  const $ = cheerio.load(html);
  const text = $('body').text().replace(/\s+/g, ' ').trim();

  const terminalBSliceMatch = text.match(/Terminal\s*B[\s\S]{0,1200}/i);
  const terminalBText = terminalBSliceMatch ? terminalBSliceMatch[0] : text;

  const generalPatterns = [
    /General(?:\s+Line|\s+TSA|\s+Security|\s+Screening)?[^0-9]{0,60}(\d{1,3})\s*min/i,
    /Terminal\s*B[^0-9]{0,120}General[^0-9]{0,60}(\d{1,3})\s*min/i
  ];
  const precheckPatterns = [
    /(?:TSA\s*Pre.?|PreCheck|Pre✓|PreCheck®)[^0-9]{0,60}(\d{1,3})\s*min/i,
    /Terminal\s*B[^0-9]{0,120}(?:TSA\s*Pre.?|PreCheck)[^0-9]{0,60}(\d{1,3})\s*min/i
  ];

  const matchAny = (patterns, haystack) => {
    for (const p of patterns) {
      const m = haystack.match(p);
      if (m) return m;
    }
    return null;
  };

  const generalMatch = matchAny(generalPatterns, terminalBText);
  const precheckMatch = matchAny(precheckPatterns, terminalBText);

  const securityGeneralMinutes = generalMatch ? Number(generalMatch[1]) : null;
  const securityPrecheckMinutes = precheckMatch ? Number(precheckMatch[1]) : null;

  return {
    securityGeneralMinutes,
    securityPrecheckMinutes
  };
}

async function fetchLgaConditionsLive() {
  const url = 'https://laguardiab.com/security-wait-time';
  console.log('[lga-debug] source URL attempted', { url });
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 AirportMath/1.0',
      'Accept': 'text/html,application/xhtml+xml'
    }
  });
  if (!res.ok) throw new Error(`LGA Terminal B fetch failed: ${res.status}`);
  const html = await res.text();
  const parsed = parseLgaTerminalBFromSecurityPage(html);
  console.log('[lga-debug] raw page/status response', {
    httpStatus: res.status,
    htmlLength: html.length
  });
  console.log('[lga-debug] parsed values', {
    terminalBGeneralMinutes: parsed?.securityGeneralMinutes ?? null,
    terminalBPrecheckMinutes: parsed?.securityPrecheckMinutes ?? null
  });

  const hasGeneral = Number.isFinite(parsed?.securityGeneralMinutes) && parsed.securityGeneralMinutes > 0;
  const hasPrecheck = Number.isFinite(parsed?.securityPrecheckMinutes) && parsed.securityPrecheckMinutes > 0;
  if (!hasGeneral || !hasPrecheck) {
    throw new Error('Unable to parse Terminal B security wait values');
  }

  return {
    airport: 'LGA',
    status: 'live',
    securityGeneralMinutes: parsed.securityGeneralMinutes,
    securityPrecheckMinutes: parsed.securityPrecheckMinutes,
    walkToGateMinutes: 8,
    source: 'LaGuardia Terminal B',
    updatedAt: new Date().toISOString()
  };
}

function stripCountryFromPlaceName(name) {
  if (!name || typeof name !== 'string') return name;
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
  let normalized = name
    .replace(/,\s*United States\s*$/i, '')
    .replace(/,\s*USA\s*$/i, '')
    .replace(/\s+United States\s*$/i, '')
    .replace(/\s+USA\s*$/i, '')
    .trim();
  Object.entries(stateAbbrev).forEach(([full, abbr]) => {
    const re = new RegExp(`,\\s*${full}(?=,|$|\\s+\\d{5}(?:-\\d{4})?)`, 'gi');
    normalized = normalized.replace(re, `, ${abbr}`);
    const reNoComma = new RegExp(`\\b${full}(?=\\s+\\d{5}(?:-\\d{4})?$)`, 'gi');
    normalized = normalized.replace(reNoComma, abbr);
  });
  normalized = normalized.replace(/\s{2,}/g, ' ').replace(/\s+,/g, ',');
  return normalized;
}

async function reverseGeocodeMapbox(lat, lng) {
  const token = process.env.MAPBOX_ACCESS_TOKEN;
  if (!token) return '';
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return '';
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(String(lng))},${encodeURIComponent(String(lat))}.json?types=address,place,locality,neighborhood&limit=1&access_token=${token}`;
  const res = await fetch(url);
  if (!res.ok) return '';
  const data = await res.json();
  const label = data.features?.[0]?.place_name || '';
  return stripCountryFromPlaceName(label);
}

app.get('/api/places-suggest', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 3) return res.json({ suggestions: [], source: 'skip' });
  const token = process.env.MAPBOX_ACCESS_TOKEN;
  if (!token) return res.json({ suggestions: [], source: 'local-only' });
  try {
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json?autocomplete=true&limit=5&proximity=-73.9857,40.7484&country=US&access_token=${token}`;
    const mapRes = await fetch(url);
    if (!mapRes.ok) return res.json({ suggestions: [], source: 'mapbox-error' });
    const data = await mapRes.json();
    const suggestions = (data.features || [])
      .map((f) => stripCountryFromPlaceName(f.place_name))
      .filter((name) => typeof name === 'string' && name.trim());
    return res.json({ suggestions, source: 'mapbox' });
  } catch {
    return res.json({ suggestions: [], source: 'mapbox-exception' });
  }
});

app.get('/api/reverse-geocode', async (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.json({ address: '', source: 'invalid-coordinates' });
  }
  try {
    const address = await reverseGeocodeMapbox(lat, lng);
    if (!address) return res.json({ address: '', source: 'unavailable' });
    return res.json({ address, source: 'mapbox' });
  } catch {
    return res.json({ address: '', source: 'unavailable' });
  }
});

app.get('/api/lga-conditions', async (_req, res) => {
  console.log('[lga-debug] LGA CONDITIONS REQUESTED');
  const now = Date.now();
  if (lgaConditionsCache.payload && now < lgaConditionsCache.expiresAt) {
    console.log('[lga-debug] cache hit', {
      status: lgaConditionsCache.payload.status,
      updatedAt: lgaConditionsCache.payload.updatedAt
    });
    return res.json(lgaConditionsCache.payload);
  }
  try {
    const live = await fetchLgaConditionsLive();
    console.log('[lga-debug] fetch success', {
      parsedSecurityGeneralMinutes: live.securityGeneralMinutes,
      parsedSecurityPrecheckMinutes: live.securityPrecheckMinutes,
      parsedWalkToGateMinutes: live.walkToGateMinutes,
      fallbackUsed: false
    });
    console.log('[lga-debug] final status returned', {
      status: live.status,
      source: live.source
    });
    lgaConditionsCache = {
      expiresAt: now + LGA_CACHE_TTL_MS,
      payload: live
    };
    return res.json(live);
  } catch (error) {
    console.log('[lga-debug] fetch failure', {
      reason: error?.message || 'unknown'
    });
    const fallback = lgaFallbackConditions();
    console.log('[lga-debug] fetch fallback', {
      securityGeneralMinutes: fallback.securityGeneralMinutes,
      securityPrecheckMinutes: fallback.securityPrecheckMinutes,
      walkToGateMinutes: fallback.walkToGateMinutes,
      fallbackUsed: true,
      finalStatus: fallback.status
    });
    lgaConditionsCache = {
      expiresAt: now + LGA_CACHE_TTL_MS,
      payload: fallback
    };
    return res.json(fallback);
  }
});

app.get('/api/security', async (req, res) => {
  try { res.json(await fetchOfficialSecurity(req.query.airport || 'OTHER')); }
  catch { res.status(200).json(securityFallback(req.query.airport || 'OTHER')); }
});
app.get('/api/faa', (req, res) => res.json(currentFaa(req.query.airport || 'OTHER')));
app.get('/api/weather', (req, res) => res.json(currentWeather(req.query.airport || 'OTHER')));
app.get('/api/travel', async (req, res) => {
  const {
    airport='OTHER',
    terminal='',
    mode='rideshare',
    origin='Hoboken, NJ',
    destination,
    departAt,
    baseMinutes=40,
    rushHour=false
  } = req.query;
  const resolvedDestination = destination || terminalDestination(airport, terminal);
  const params = { airport, terminal, mode, origin, destination: resolvedDestination, departAt, baseMinutes, rushHour };
  console.log('[travel-debug] request', {
    origin,
    destination: resolvedDestination,
    airport,
    terminal,
    mode
  });
  try { res.json(await routeAuto(params)); } catch { res.status(200).json(mockTravel(params)); }
});
app.get('/api/health', (_req, res) => res.json({ ok:true, service:'airport-math-v6-mobile-deploy' }));
app.listen(PORT, () => console.log(`Airport Math v6 running at http://localhost:${PORT}`));
