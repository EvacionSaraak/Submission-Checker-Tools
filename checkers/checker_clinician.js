// checker_clinician.js

document.addEventListener('DOMContentLoaded', init);

function init() {
  document.getElementById('processButton').addEventListener('click', handleProcess);
  document.getElementById('xmlInput').addEventListener('change', e => loadFile(e.target.files[0], 'xml'));
  document.getElementById('excelInput').addEventListener('change', e => loadFile(e.target.files[0], 'excel'));
}

let xmlDoc = null;
let excelData = null;

function loadFile(file, type) {
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      if (type === 'xml') {
        xmlDoc = parseXML(e.target.result);
        console.log('XML loaded.');
      } else if (type === 'excel') {
        const data = new Uint8Array(e.target.result);
        excelData = await parseExcel(data);
        console.log('Excel loaded.');
      }
    } catch (err) {
      console.error(`Failed to load ${type} file:`, err);
    }
  };

  if (type === 'xml') {
    reader.readAsText(file);
  } else {
    reader.readAsArrayBuffer(file);
  }
}

function handleProcess() {
  if (!xmlDoc || !excelData) {
    alert('Please upload both XML and Excel files.');
    return;
  }

  const clinicianMap = buildClinicianMap(excelData);
  const claims = Array.from(xmlDoc.getElementsByTagName('Claim'));
  const activities = extractActivitiesRecursive(claims);
  const results = validateActivities(activities, clinicianMap);
  renderResults(results);
  logSummary(results);
}

function parseXML(xmlString) {
  const doc = new DOMParser().parseFromString(xmlString, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Invalid XML');
  return doc;
}

async function parseExcel(data) {
  const workbook = XLSX.read(data, { type: 'array' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet);
}

function buildClinicianMap(rows) {
  const map = new Map();
  for (const row of rows) {
    if (row['License Number']) {
      map.set(row['License Number'].trim(), {
        name: row['Clinician Name'] || 'N/A',
        category: row['Category'] || 'Unknown',
        privileges: row['Privileges'] || 'Unknown',
      });
    }
  }
  return map;
}

function extractActivitiesRecursive(claims) {
  const results = [];
  const traverse = (nodes) => {
    if (!nodes.length) return;
    for (const claim of nodes) {
      const activities = claim.getElementsByTagName('Activity');
      for (const act of activities) {
        results.push({
          claimId: claim.querySelector('ID')?.textContent.trim() ?? 'Unknown',
          ordering: act.querySelector('OrderingClinician')?.textContent.trim() ?? 'N/A',
          performing: act.querySelector('Clinician')?.textContent.trim() ?? 'N/A',
        });
      }
    }
  };
  traverse(claims);
  return results;
}

function validateActivities(activities, clinicianMap) {
  let validCount = 0;
  let invalidCount = 0;

  return activities.map(act => {
    const { ordering, performing } = act;
    const oData = clinicianMap.get(ordering);
    const pData = clinicianMap.get(performing);
    let validity = 'Valid';
    let remark = '';

    if (!oData || !pData) {
      validity = 'Invalid';
      remark = 'Clinician ID not found in Excel';
    } else if (ordering === performing) {
      remark = `Same ID: ${ordering}`;
    } else if (oData.category === pData.category) {
      remark = `Matched categories: ${oData.category}`;
    } else {
      validity = 'Invalid';
      remark = `Category mismatch: ${oData.category} vs ${pData.category}`;
    }

    if (validity === 'Valid') validCount++;
    else invalidCount++;

    return {
      claimId: act.claimId,
      ordering,
      performing,
      orderingName: oData?.name ?? 'N/A',
      performingName: pData?.name ?? 'N/A',
      orderingPriv: oData?.privileges ?? 'N/A',
      performingPriv: pData?.privileges ?? 'N/A',
      validity,
      remark
    };
  });
}

function renderResults(rows) {
  const table = document.createElement('table');
  table.innerHTML = `
    <thead><tr>
      <th>Claim ID</th>
      <th>Ordering Clinician</th>
      <th>Performing Clinician</th>
      <th>Ordering Name</th>
      <th>Performing Name</th>
      <th>Ordering Privileges</th>
      <th>Performing Privileges</th>
      <th>Validity</th>
      <th>Remarks</th>
    </tr></thead>
    <tbody>
      ${rows.map(r => `
        <tr class="${r.validity.toLowerCase()}">
          <td>${r.claimId}</td>
          <td>${r.ordering}</td>
          <td>${r.performing}</td>
          <td>${r.orderingName}</td>
          <td>${r.performingName}</td>
          <td>${r.orderingPriv}</td>
          <td>${r.performingPriv}</td>
          <td>${r.validity}</td>
          <td>${r.remark}</td>
        </tr>`).join('')}
    </tbody>
  `;

  const container = document.getElementById('results');
  container.innerHTML = '';
  container.appendChild(table);
}

function logSummary(rows) {
  const valid = rows.filter(r => r.validity === 'Valid').length;
  const invalid = rows.length - valid;
  console.log(`Total Activities: ${rows.length}`);
  console.log(`Valid: ${valid}`);
  console.log(`Invalid: ${invalid}`);
  if (invalid > 0) {
    console.log('Reasons for invalid entries:');
    rows.filter(r => r.validity !== 'Valid').forEach(r => {
      console.log(`Claim ${r.claimId}: ${r.remark}`);
    });
  }
}
