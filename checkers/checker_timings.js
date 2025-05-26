document.addEventListener('DOMContentLoaded', init);

function init() {
  document.getElementById('xmlFileInput')
    .addEventListener('change', handleFileChange);
}

async function handleFileChange(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const xmlText = await file.text();
    const xmlDoc = parseXML(xmlText);
    const claims = extractClaims(xmlDoc);
    renderResults(claims);
  } catch (err) {
    renderMessage(`Error: ${err.message}`);
  }
}

function parseXML(xmlString) {
  const doc = new DOMParser().parseFromString(xmlString, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Invalid XML');
  return doc;
}

function extractClaims(xmlDoc) {
  return Array.from(xmlDoc.getElementsByTagName('Claim')).map(el => {
    const get = sel => el.querySelector(sel)?.textContent.trim() ?? 'N/A';
    const enc = el.querySelector('Encounter');
    const start = enc?.querySelector('Start')?.textContent.trim() ?? 'N/A';
    const end   = enc?.querySelector('End')?.textContent.trim()   ?? 'N/A';
    const patient = enc?.querySelector('PatientID')?.textContent.trim() ?? 'N/A';
    const act = el.querySelector('Activity');
    return {
      id:     get('ID'),
      start, end, patient,
      doctor: act?.querySelector('Clinician')?.textContent.trim() ?? 'N/A',
      amount: get('Net'),
      valid:  validateEncounter(start, end,
               enc?.querySelector('StartType')?.textContent.trim(),
               enc?.querySelector('EndType')?.textContent.trim())
    };
  });
}

function validateEncounter(s, e, st, et) {
  if (!s || !e) return 'Invalid (missing)';
  if (st !== '1' || et !== '1') return 'Invalid (type)';
  const sd = parseDateTime(s), ed = parseDateTime(e);
  if (!sd || !ed) return 'Invalid (format)';
  if (!isSameDay(sd, ed)) return 'Invalid (date)';
  if (!(sd < ed)) return 'Invalid (order)';
  const diff = (ed - sd) / 1000 / 60;
  if (diff < 10) return 'Invalid (<10m)';
  if (diff > 240) return 'Invalid (>4h)';
  return 'Valid';
}

function parseDateTime(dt) {
  const [date, time] = dt.split(' ');
  if (!date || !time) return null;
  const [d,m,y] = date.split('/').map(Number);
  const [h,mm]  = time.split(':').map(Number);
  if ([d,m,y,h,mm].some(isNaN)) return null;
  return new Date(y, m - 1, d, h, mm);
}

function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
         a.getMonth() === b.getMonth() &&
         a.getDate() === b.getDate();
}

function renderResults(claims) {
  if (!claims.length) return renderMessage('No <code>&lt;Claim&gt;</code> found.');
  const rows = claims.map(c => `
    <tr>
      <td>${c.id}</td>
      <td>${c.start}</td>
      <td>${c.end}</td>
      <td>${c.patient}</td>
      <td>${c.doctor}</td>
      <td>${c.amount}</td>
      <td>${c.valid}</td>
    </tr>
  `).join('');
  document.getElementById('tableContainer').innerHTML = `
    <table border="1" cellpadding="5" cellspacing="0">
      <thead><tr>
        <th>Claim ID</th><th>Start Date & Time</th><th>End Date & Time</th>
        <th>Patient ID</th><th>Doctor</th><th>Total Amount</th><th>Validity</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderMessage(msg) {
  document.getElementById('tableContainer').innerHTML = `<p>${msg}</p>`;
}
