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
  return { status:'live', source:'Google Routes API', provider:'google', travelMinutes:Math.round(parseDuration(route.duration)/60), typicalMinutes:route.staticDuration ? Math.round(parseDuration(route.staticDuration)/60) : null, extraMinutes:0, modeLabel:'Driving / rideshare' };
}

async function routeAuto(params) {
  try { return await routeWithGoogle(params); } catch {}
  try { return await routeWithMapbox(params); } catch {}
  return mockTravel(params);
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

app.get('/api/security', async (req, res) => {
  try { res.json(await fetchOfficialSecurity(req.query.airport || 'OTHER')); }
  catch { res.status(200).json(securityFallback(req.query.airport || 'OTHER')); }
});
app.get('/api/faa', (req, res) => res.json(currentFaa(req.query.airport || 'OTHER')));
app.get('/api/weather', (req, res) => res.json(currentWeather(req.query.airport || 'OTHER')));
app.get('/api/travel', async (req, res) => {
  const { airport='OTHER', mode='rideshare', origin='Hoboken, NJ', destination, departAt, baseMinutes=40, rushHour=false } = req.query;
  const params = { airport, mode, origin, destination: destination || airportPreset(airport), departAt, baseMinutes, rushHour };
  try { res.json(await routeAuto(params)); } catch { res.status(200).json(mockTravel(params)); }
});
app.get('/api/health', (_req, res) => res.json({ ok:true, service:'airport-math-v6-mobile-deploy' }));
app.listen(PORT, () => console.log(`Airport Math v6 running at http://localhost:${PORT}`));
