const app = document.getElementById('app');
const USE_HTML_RESULT = true;
if (window.navigationApi) {
  window.navigationApi.init();
}
if (window.selectionsApi) {
  window.selectionsApi.init();
}
function getActiveSelection(groupName) {
  if (window.selectionsApi) {
    return window.selectionsApi.getActive(groupName);
  }
  if (window.stateApi) {
    return window.stateApi.getSelection(groupName);
  }
  const group = document.querySelector(`[data-group="${groupName}"]`);
  return group?.querySelector('.chip.active')?.textContent.trim() || '';
}

function minutesForSelection() {
  const transport = getActiveSelection('transport');
  const luggage = getActiveSelection('luggage');
  const security = getActiveSelection('security');
  const boarding = getActiveSelection('boarding');
  const style = getActiveSelection('style');

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

  if (style === 'Cut it close') buffer -= 10;
  if (style === 'No rush') buffer += 25;

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

  container.innerHTML = `
    <button class="resultHtmlEdit" onclick="show('calculate')">Edit</button>
    <div class="resultHtmlCard">
      <div class="resultHtmlEyebrow">Leave by</div>
      <div class="resultHtmlTime">${escapeHtml(result.leaveBy || '5:42 PM')}</div>
      <div class="resultHtmlFlight">Flight ${escapeHtml(result.flightTime || '7:30 PM')} from ${escapeHtml(result.airport || form.airport || 'JFK')}</div>
      <div class="resultHtmlGrid">
        <div class="resultHtmlItem"><span>Travel</span><strong>${escapeHtml(result.travel || 45)} min</strong></div>
        <div class="resultHtmlItem"><span>Airport</span><strong>${escapeHtml(result.airportTime || 35)} min</strong></div>
        <div class="resultHtmlItem"><span>Buffer</span><strong>${escapeHtml(result.buffer || 15)} min</strong></div>
        <div class="resultHtmlItem"><span>Total</span><strong>${escapeHtml(result.total || 95)} min</strong></div>
      </div>
      <div class="resultHtmlMeta">
        <div>Style: ${escapeHtml(result.style || selections.style || 'Balanced')}</div>
        <div>Transport: ${escapeHtml(selections.transport || 'Rideshare')}</div>
        <div>Luggage: ${escapeHtml(selections.luggage || 'Carry-on only')}</div>
        <div>Security: ${escapeHtml(selections.security || 'PreCheck')}</div>
        <div>Before boarding: ${escapeHtml(selections.boarding || 'Head to gate')}</div>
      </div>
    </div>
  `;
}
