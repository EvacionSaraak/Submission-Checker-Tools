// checker_clinician.js

document.addEventListener('DOMContentLoaded', init);

function init() {
  document.getElementById('xmlFileInput').addEventListener('change', handleFiles);
  document.getElementById('excelFileInput').addEventListener('change', handleFiles);
}

let xmlDoc = null;
let excelData = null;

function handleFiles() {
  const xmlFile = document.getElementById('xmlFileInput').files[0];
  const excelFile = document.getElementById('excelFileInput').files[0];

  if (xmlFile && excelFile) {
    Promise.all([xmlFile.text(), readExcel(excelFile)])
      .then(([xmlText, excelJson]) => {
        xmlDoc = parseXML(xmlText);
        excelData = excelJson;
        const claims = extractClaims(xmlDoc);
        renderResults(claims);
      })
      .catch(err => renderMessage(`Error: ${err.message}`));
  }
}

function parseXML(xmlString) {
  const doc = new DOMParser().parseFromString(xmlString, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Invalid XML');
  return doc;
}

function readExcel(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      const workbook = XLSX.read(e.target.result, { type: 'binary' });
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const json = XLSX.utils.sheet_to_json(sheet, { defval: '' });
      resolve(json);
    };
    reader.onerror = reject;
    reader.readAsBinaryString(file);
  });
}

function extractClaims(xmlDoc) {
  return Array.from(xmlDoc.getElementsByTagName('Claim')).map(el => {
    const activity = el.querySelector('Activity');
    const orderingId = activity?.querySelector('OrderingClinician')?.textContent.trim() ?? 'N/A';
    const performingId = activity?.querySelector('Clinician')?.textContent.trim() ?? 'N/A';

    const orderingInfo = findClinician(orderingId);
    const performingInfo = findClinician(performingId);

    const isSameId = orderingId === performingId;
    const isSameCategory = orderingInfo?.Category === performingInfo?.Category;

    let valid = 'Valid';
    let remarks = '';

    if (!isSameId && !isSameCategory) {
      valid = 'Invalid';
      remarks = `Mismatch: ${orderingInfo?.Category ?? 'N/A'} vs ${performingInfo?.Category ?? 'N/A'}`;
    }

    return {
      id: el.querySelector('ID')?.textContent.trim() ?? 'N/A',
      orderingId,
      orderingName: orderingInfo?.Name ?? 'N/A',
      orderingPriv: orderingInfo?.Privileges ?? 'N/A',
      performingId,
      performingName: performingInfo?.Name ?? 'N/A',
      performingPriv: performingInfo?.Privileges ?? 'N/A',
      valid,
      remarks
    };
  });
}

function findClinician(id) {
  return excelData.find(row => row['License Number']?.toString().trim() === id);
}

function renderResults(claims) {
  if (!claims.length) return renderMessage('No <code>&lt;Claim&gt;</code> found.');

  const rows = claims.map(c => `
    <tr class="${c.valid === 'Valid' ? 'valid' : 'invalid'}">
      <td>${c.id}</td>
      <td>${c.orderingId}</td>
      <td>${c.orderingName}</td>
      <td>${c.orderingPriv}</td>
      <td>${c.performingId}</td>
      <td>${c.performingName}</td>
      <td>${c.performingPriv}</td>
      <td>${c.valid}</td>
      <td>${c.remarks}</td>
    </tr>
  `).join('');

  document.getElementById('results').innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Claim ID</th>
          <th>Ordering Clinician ID</th>
          <th>Ordering Name</th>
          <th>Ordering Privileges</th>
          <th>Performing Clinician ID</th>
          <th>Performing Name</th>
          <th>Performing Privileges</th>
          <th>Status</th>
          <th>Remarks</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderMessage(msg) {
  document.getElementById('results').innerHTML = `<p>${msg}</p>`;
}
