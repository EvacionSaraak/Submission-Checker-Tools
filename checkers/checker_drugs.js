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

const DISPLAY_HEADERS = [
  "Code", "Package", "Form", "Package Size", "Package Price", "Unit Price",
  "Status", "Delete Effective Date", "UPP Scope", "Included in Thiqa",
  "Included in DAMAN Basic", "Effective Date", "Updated Date"
];
const DRUG_COLUMNS = [
  "Drug Code", "Package Name", "Dosage Form", "Package Size", "Package Price to Public",
  "Unit Price to Public", "Status", "Delete Effective Date",
  "UPP Scope", "Included in Thiqa/ ABM - other than 1&7- Drug Formulary",
  "Included In Basic Drug Formulary", "UPP Effective Date", "UPP Updated Date"
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

// Drug XLSX upload
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
      .map(row => {
        const norm = {};
        Object.keys(row).forEach(k => {
          const key = k.trim();
          const val = row[k];
          const isDate = ['UPP Effective Date', 'UPP Updated Date', 'Delete Effective Date'].includes(key);
          if (typeof val === 'boolean') norm[key] = val ? 'Yes' : 'No';
          else if (val === null || val === undefined || val.toString().trim() === '')
            norm[key] = isDate ? 'NO DATE' : '';
          else if (isDate && typeof val === 'number') {
            const d = XLSX.SSF.parse_date_code(val);
            norm[key] = `${String(d.d).padStart(2, '0')}-${MONTHS[d.m - 1]}-${d.y}`;
          } else norm[key] = val.toString().trim();
        });
        return norm;
      })
      .filter(r => r['Drug Code']);
    drugCount.textContent = `Loaded ${drugData.length} drug entries.`;
    toggleModePanels();
  };
  reader.readAsBinaryString(file);
});

// Lookup Drug Search
searchDrugBtn && searchDrugBtn.addEventListener('click', () => {
  const query = drugInput.value.trim();
  if (!query) return;
  const lowerQuery = query.toLowerCase();
  const exact = exactToggle.checked;

  lookupResults.innerHTML = '';
  selectedDrug = null;
  quantityInput.value = '';
  calcOutput.textContent = '';
  quantitySection.style.display = 'none';
  calculateBtn.disabled = true;

  const matches = drugData.filter(r => {
    const codeMatch = r["Drug Code"] === query;
    const pkg = (r["Package Name"] || '').toLowerCase();
    const nameMatch = exact
      ? pkg === lowerQuery
      : pkg.includes(lowerQuery);
    return codeMatch || nameMatch;
  });

  if (matches.length) {
    lookupResults.appendChild(renderDrugTable(matches));
  } else {
    lookupResults.innerHTML = `<p>No match found for: <strong>${query}</strong></p>`;
  }
});

// Lookup Table Builder
function renderDrugTable(drugs) {
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
  return container;
}

// Quantity calculator
calculateBtn && calculateBtn.addEventListener('click', () => {
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

// XML UPLOAD & ANALYSIS
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
      xmlClaimCount.textContent = `Loaded XML with ${xmlDoc.querySelectorAll('Claim').length} claims.`;
    } catch (err) {
      xmlData = null;
      xmlClaimCount.textContent = "Failed to parse XML.";
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
  // Build a map of drug codes to drug rows for quick lookup
  const drugMap = {};
  drugData.forEach(d => { drugMap[d["Drug Code"]] = d; });

  // Collect all activities, grouped by claim
  const claims = Array.from(xmlData.getElementsByTagName('Claim'));
  let xmlRows = [];
  claims.forEach(claim => {
    const claimID = (claim.getElementsByTagName('ID')[0] || {}).textContent || 'N/A';
    const activities = Array.from(claim.getElementsByTagName('Activity'));
    activities.forEach(activity => {
      const code = (activity.getElementsByTagName('Code')[0] || {}).textContent || '';
      const drug = drugMap[code];
      if (!drug) return;
      xmlRows.push({
        claimId: claimID,
        activityId: (activity.getElementsByTagName('ID')[0] || {}).textContent || '',
        drug
      });
    });
  });

  if (!xmlRows.length) {
    analysisResults.innerHTML = `<div class="error-box">No activities matched any codes from the uploaded drug list.</div>`;
    return;
  }
  analysisResults.innerHTML = '';
  analysisResults.appendChild(renderClaimTableWithModals(xmlRows));
});

// Modal per claim implementation
function renderClaimTableWithModals(xmlRows) {
  // Group activities by claimId
  const claimsMap = {};
  xmlRows.forEach(row => {
    if (!claimsMap[row.claimId]) claimsMap[row.claimId] = [];
    claimsMap[row.claimId].push(row);
  });

  // Main table with one row per claim
  let tableHTML = '<table><thead><tr><th>Claim ID</th><th>Number of Activities</th><th>Actions</th></tr></thead><tbody>';
  Object.keys(claimsMap).forEach((claimId, idx) => {
    const activities = claimsMap[claimId];

    // Determine claim row class based on activities
    let claimClass = "valid"; // default
    for (const activity of activities) {
      const drugRow = activity.drug;
      const status = (drugRow["Status"]||"").toLowerCase();
      const statusActive = status === "active";
      const hasNo = [
        "UPP Scope",
        "Included in Thiqa/ ABM - other than 1&7- Drug Formulary",
        "Included In Basic Drug Formulary"
      ].some(col => (drugRow[col]||"").toLowerCase()==="no");

      if (!statusActive) {
        claimClass = "invalid";
        break; // invalid takes precedence
      } else if (claimClass === "valid" && hasNo) {
        claimClass = "unknown"; // only set if not already invalid
      }
    }

    tableHTML += `<tr class="${claimClass}"> 
      <td>${claimId}</td>
      <td>${activities.length}</td>
      <td>
        <button class="details-btn" data-modal="modal-claim-${idx}">Show Activities</button>
        <div id="modal-claim-${idx}" class="modal">
          <div class="modal-content">
            <span class="close" data-modal-close="modal-claim-${idx}">&times;</span>
            <h4>Activities for Claim ${claimId}</h4>
            ${renderActivitiesTable(activities)}
          </div>
        </div>
      </td>
    </tr>`;
  });
  tableHTML += '</tbody></table>';

  // Attach to DOM and setup modal listeners
  const container = document.createElement('div');
  container.innerHTML = tableHTML;
  setTimeout(() => setupModalListeners(container), 0); // Ensure elements exist when listeners are attached
  return container;
}
function renderActivitiesTable(activities) {
  // Only the activity table, for the modal
  let html = `<table><thead><tr>
    <th>Activity ID</th>
    <th>Code</th>
    <th>Package</th>
    <th>Form</th>
    <th>Package Size</th>
    <th>Package Price</th>
    <th>Unit Price</th>
    <th>Status</th>
    <th>Delete Effective Date</th>
    <th>UPP Scope</th>
    <th>Included in Thiqa</th>
    <th>Included in DAMAN Basic</th>
    <th>Effective Date</th>
    <th>Updated Date</th>
  </tr></thead><tbody>`;
  activities.forEach(row => {
    const drugRow = row.drug;
    const status = (drugRow["Status"]||"").toLowerCase();
    const statusActive = status === "active";
    const hasNo = [
      "UPP Scope",
      "Included in Thiqa/ ABM - other than 1&7- Drug Formulary",
      "Included In Basic Drug Formulary"
    ].some(col => (drugRow[col]||"").toLowerCase()==="no");
    const rowClass = statusActive ? (hasNo ? "unknown" : "valid") : "invalid";

    html += `<tr class="${rowClass}">` +
      `<td>${row.activityId}</td>` +
      `<td>${drugRow["Drug Code"]||"N/A"}</td>` +
      `<td>${drugRow["Package Name"]||"N/A"}</td>` +
      `<td>${drugRow["Dosage Form"]||"N/A"}</td>` +
      `<td>${drugRow["Package Size"]||"N/A"}</td>` +
      `<td>${drugRow["Package Price to Public"]||"N/A"}</td>` +
      `<td>${drugRow["Unit Price to Public"]||"N/A"}</td>` +
      `<td>${drugRow["Status"]||"N/A"}</td>` +
      `<td>${!statusActive ? (drugRow["Delete Effective Date"]||"NO DATE") : "N/A"}</td>` +
      `<td>${drugRow["UPP Scope"]||"Unknown"}</td>` +
      `<td>${drugRow["Included in Thiqa/ ABM - other than 1&7- Drug Formulary"]||"Unknown"}</td>` +
      `<td>${drugRow["Included In Basic Drug Formulary"]||"Unknown"}</td>` +
      `<td>${drugRow["UPP Effective Date"]||"NO DATE"}</td>` +
      `<td>${drugRow["UPP Updated Date"]||"NO DATE"}</td>` +
    `</tr>`;
  });
  html += '</tbody></table>';
  return html;
}

function setupModalListeners(container) {
  // Open modal and auto-size to table
  container.querySelectorAll('.details-btn').forEach(btn => {
    btn.addEventListener('click', function() {
      const modalId = btn.getAttribute('data-modal');
      const modal = container.querySelector(`#${modalId}`);
      if (modal) {
        modal.style.display = 'block';
        // Auto-size modal-content to fit table
        const modalContent = modal.querySelector('.modal-content');
        const innerTable = modalContent.querySelector('table');
        if (innerTable) {
          // Reset width/height first
          modalContent.style.width = '';
          modalContent.style.height = '';
          // Get real table size
          const tableRect = innerTable.getBoundingClientRect();
          // Add padding for modal-content
          modalContent.style.width = (tableRect.width + 40) + 'px';
          modalContent.style.height = (tableRect.height + 60) + 'px';
        }
      }
    });
  });
  // Close modal
  container.querySelectorAll('.close').forEach(btn => {
    btn.addEventListener('click', function() {
      const modalId = btn.getAttribute('data-modal-close');
      const modal = container.querySelector(`#${modalId}`);
      if (modal) modal.style.display = 'none';
    });
  });
  // Close when clicking outside modal-content
  container.querySelectorAll('.modal').forEach(modal => {
    modal.addEventListener('click', function(event) {
      if (event.target === modal) {
        modal.style.display = 'none';
      }
    });
  });
}
