let drugData = [], xmlData = null, selectedDrug = null;

const modeRadios = document.querySelectorAll('input[name="mode"]');
const lookupPanel = document.getElementById('lookup-panel');
const analysisPanel = document.getElementById('analysis-panel');
const xlsxUpload = document.getElementById('xlsx-upload');
const drugCount = document.getElementById('drug-count');
const drugInput = document.getElementById('drug-code-input');
const searchDrugBtn = document.getElementById('search-drug-btn');
const lookupResults = document.getElementById('lookup-results');
const xmlUpload = document.getElementById('xml-upload');
const xmlClaimCount = document.getElementById('xml-claim-count');
const analyzeBtn = document.getElementById('analyze-btn');
const analysisResults = document.getElementById('analysis-results');
const quantitySection = document.getElementById('quantity-section');
const quantityInput = document.getElementById('quantity-input');
const calculateBtn = document.getElementById('calculate-btn');
const calcOutput = document.getElementById('calc-output');
const exactToggle = document.getElementById('exact-search-toggle');

const DRUG_COLUMNS = [
  "Drug Code", "Package Name", "Dosage Form", "Package Size", "Package Price to Public",
  "Unit Price to Public", "Status", "Delete Effective Date",
  "UPP Scope", "Included in Thiqa/ ABM - other than 1&7- Drug Formulary",
  "Included In Basic Drug Formulary", "UPP Effective Date", "UPP Updated Date"
];

const DISPLAY_HEADERS = [
  "Code", "Package", "Form", "Package Size", "Package Price", "Unit Price", 
  "Status", "Delete Effective Date", "UPP Scope", "Included in Thiqa",
  "Included in DAMAN Basic", "Effective Date", "Updated Date"
];

// For XML Analysis (add Claim ID and Activity ID columns)
const XML_ACTIVITY_HEADERS = [
  "Claim ID", "Activity ID", "Activity Code", "Activity Net", "Activity Start", "Clinician"
];

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

function toggleModePanels() {
  const selected = document.querySelector('input[name="mode"]:checked').value;
  lookupPanel.style.display   = selected === 'lookup'   ? 'block' : 'none';
  analysisPanel.style.display = selected === 'analysis' ? 'block' : 'none';

  const hasDrugs = drugData.length > 0, hasXML = !!xmlData;

  drugInput.disabled = !hasDrugs || selected !== 'lookup';
  searchDrugBtn.disabled = !hasDrugs || selected !== 'lookup';
  analyzeBtn.disabled = !(hasDrugs && hasXML && selected === 'analysis');
  exactToggle.disabled = !hasDrugs || selected !== 'lookup';

  lookupResults.innerHTML = "";
  analysisResults.innerHTML = "";
  quantitySection.style.display= 'none';
  calcOutput.textContent = "";
  selectedDrug = null;
}

modeRadios.forEach(r => r.addEventListener('change', toggleModePanels));
toggleModePanels();

xlsxUpload.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  drugCount.textContent = 'Loading drug list...';
  const reader = new FileReader();
  reader.onload = (ev) => {
    const wb = XLSX.read(ev.target.result, { type: 'binary' });
    const sheet = wb.Sheets[wb.SheetNames[1]];
    const json = XLSX.utils.sheet_to_json(sheet);
    drugData = json
      .map((row) => {
        const norm = {};
        Object.keys(row).forEach((k) => {
          const key = k.trim();
          const val = row[k];
          const isDate = [
            'UPP Effective Date',
            'UPP Updated Date',
            'Delete Effective Date',
          ].includes(key);

          if (typeof val === 'boolean') {
            norm[key] = val ? 'Yes' : 'No';
          } else if (
            val === null ||
            val === undefined ||
            val.toString().trim() === ''
          ) {
            norm[key] = isDate ? 'NO DATE' : '';
          } else if (isDate && typeof val === 'number') {
            const d = XLSX.SSF.parse_date_code(val);
            const dd = String(d.d).padStart(2, '0');
            const mmm = MONTHS[d.m - 1];
            const yyyy = d.y;
            norm[key] = `${dd}-${mmm}-${yyyy}`;
          } else {
            norm[key] = val.toString().trim();
          }
        });
        return norm;
      })
      .filter((r) => r['Drug Code']);
    drugCount.textContent = `Loaded ${drugData.length} drug entries.`;
    toggleModePanels();
  };
  reader.readAsBinaryString(file);
});

searchDrugBtn.addEventListener('click', () => {
  const query = drugInput.value.trim();
  if (!query) return;

  const lowerQuery = query.toLowerCase();
  const exact = exactToggle.checked;  // <-- read the checkbox

  // Reset UI & state
  lookupResults.innerHTML = '';
  selectedDrug = null;
  quantityInput.value = '';
  calcOutput.textContent = '';
  quantitySection.style.display = 'none';
  calculateBtn.disabled = true;

  // Filter using exact vs partial on Package Name
  const matches = drugData.filter(r => {
    const codeMatch = r["Drug Code"] === query;
    const pkg = (r["Package Name"] || '').toLowerCase();
    const nameMatch = exact
      ? pkg === lowerQuery      // exact on name
      : pkg.includes(lowerQuery); // partial on name
    return codeMatch || nameMatch;
  });

  if (matches.length) {
    const tableEl = buildDrugTable(matches);
    lookupResults.appendChild(tableEl);
  } else {
    lookupResults.innerHTML = `<p>No match found for: <strong>${query}</strong></p>`;
  }
});

calculateBtn.addEventListener('click', () => {
  const qty = parseFloat(quantityInput.value);
  if (isNaN(qty) || qty <= 0) {
    calcOutput.textContent = "Invalid quantity.";
    return;
  }
  if (!selectedDrug) {
    calcOutput.textContent = "No drug selected.";
    return;
  }
  const unitPrice = parseFloat(selectedDrug["Unit Price to Public"]);
  if (isNaN(unitPrice)) {
    calcOutput.textContent = "Invalid unit price.";
    return;
  }
  const total = qty * unitPrice;
  calcOutput.textContent = `Total: AED ${total.toFixed(2)}`;
});

// --- XML UPLOAD & ANALYSIS ---

xmlUpload.addEventListener('change', e => {
  if (!e.target.files[0]) return;
  const file = e.target.files[0];
  const reader = new FileReader();
  reader.onload = function(ev) {
    try {
      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(ev.target.result, "application/xml");
      if (xmlDoc.getElementsByTagName("parsererror").length) throw new Error("Invalid XML");
      xmlData = xmlDoc;
      const claimCount = xmlDoc.querySelectorAll('Claim').length;
      xmlClaimCount.textContent = `Loaded XML with ${claimCount} claims.`;
      if (drugData.length) analyzeBtn.disabled = false;
    } catch (err) {
      xmlData = null;
      xmlClaimCount.textContent = "Failed to parse XML.";
      analyzeBtn.disabled = true;
    }
    toggleModePanels();
  };
  reader.readAsText(file);
});

analyzeBtn.addEventListener('click', () => {
  if (!xmlData || !drugData.length) {
    analysisResults.innerHTML = `<div class="error-box">Please upload both a valid XML and XLSX before analysis.</div>`;
    return;
  }
  // Build a Set of all valid drug codes
  const validCodes = new Set(drugData.map(d => d["Drug Code"]));

  // Find all Claims
  const claims = Array.from(xmlData.getElementsByTagName('Claim'));
  let xmlRows = [];
  claims.forEach(claim => {
    const claimID = (claim.getElementsByTagName('ID')[0] || {}).textContent || 'N/A';
    const activities = Array.from(claim.getElementsByTagName('Activity'));
    activities.forEach(activity => {
      const code = (activity.getElementsByTagName('Code')[0] || {}).textContent || '';
      if (!validCodes.has(code)) return;
      xmlRows.push({
        claimId: claimID,
        activityId: (activity.getElementsByTagName('ID')[0] || {}).textContent || '',
        code,
        net: (activity.getElementsByTagName('Net')[0] || {}).textContent || '',
        start: (activity.getElementsByTagName('Start')[0] || {}).textContent || '',
        clinician: (activity.getElementsByTagName('Clinician')[0] || {}).textContent || ''
      });
    });
  });

  if (!xmlRows.length) {
    analysisResults.innerHTML = `<div class="error-box">No activities matched any codes from the uploaded drug list.</div>`;
    return;
  }

  // Build table
  let tableHTML = `<table><thead><tr>`;
  XML_ACTIVITY_HEADERS.forEach(h => tableHTML += `<th>${h}</th>`);
  tableHTML += `</tr></thead><tbody>`;
  xmlRows.forEach(row => {
    tableHTML += `<tr>` +
      `<td>${row.claimId}</td>` +
      `<td>${row.activityId}</td>` +
      `<td>${row.code}</td>` +
      `<td>${row.net}</td>` +
      `<td>${row.start}</td>` +
      `<td>${row.clinician}</td>` +
    `</tr>`;
  });
  tableHTML += `</tbody></table>`;
  analysisResults.innerHTML = tableHTML;
});

function buildDrugTable(drugs) {
  let tableHTML = `<table><thead><tr>`;
  DISPLAY_HEADERS.forEach(h => tableHTML += `<th>${h}</th>`);
  tableHTML += `</tr></thead><tbody>`;

  drugs.forEach(row => {
    const status = (row["Status"]||"").toLowerCase();
    const statusActive = status === "active";
    const hasNo = [
      "UPP Scope",
      "Included in Thiqa/ ABM - other than 1&7- Drug Formulary",
      "Included In Basic Drug Formulary"
    ].some(col => (row[col]||"").toLowerCase()==="no");
    const rowClass = statusActive ? (hasNo ? "unknown" : "valid") : "invalid";

    tableHTML += `<tr class="${rowClass}">` +
      `<td>${row["Drug Code"]||"N/A"}</td>` +
      `<td>${row["Package Name"]||"N/A"}</td>` +
      `<td>${row["Dosage Form"]||"N/A"}</td>` +
      `<td>${row["Package Size"]||"N/A"}</td>` +
      `<td>${row["Package Price to Public"]||"N/A"}</td>` +
      `<td>${row["Unit Price to Public"]||"N/A"}</td>` +
      `<td>${row["Status"]||"N/A"}</td>` +
      `<td>${!statusActive ? (row["Delete Effective Date"]||"NO DATE") : "N/A"}</td>` +
      `<td>${row["UPP Scope"]||"Unknown"}</td>` +
      `<td>${row["Included in Thiqa/ ABM - other than 1&7- Drug Formulary"]||"Unknown"}</td>` +
      `<td>${row["Included In Basic Drug Formulary"]||"Unknown"}</td>` +
      `<td>${row["UPP Effective Date"]||"NO DATE"}</td>` +
      `<td>${row["UPP Updated Date"]||"NO DATE"}</td>` +
    `</tr>`;
  });
  tableHTML += `</tbody></table>`;
  
  const container = document.createElement('div');
  container.innerHTML = tableHTML;
  
  const rows = container.querySelectorAll('tbody tr');
  rows.forEach((row, i) => {
    row.addEventListener('click', () => {
      rows.forEach(r => r.classList.remove('selected-row'));
      row.classList.add('selected-row');
      selectedDrug = drugs[i];
      quantitySection.style.display = 'block';
      calculateBtn.disabled = false;
      quantityInput.value = '';
      calcOutput.textContent = '';
      document.getElementById('selected-drug-code').textContent =
        selectedDrug["Drug Code"] || 'N/A';
    });
  });
  return container;
}
