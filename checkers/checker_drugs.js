// Ensure modals are hidden by default with CSS
(function() {
  const style = document.createElement('style');
  style.textContent = `.modal { display: none !important; position: fixed; z-index: 1000; left: 0; top: 0; width: 100%; height: 100%; overflow: auto; background-color: rgba(0,0,0,0.4); }`;
  document.head.appendChild(style);
})();

let drugData = [], xmlData = null, selectedDrug = null;
let currentModalIdx = null;
let claimsMapGlobal = {};
let lastXmlRows = [];
let lastXMLFileNameBase = "export";

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

// Updated headers and columns with Unit Price before Unit Markup
const DISPLAY_HEADERS = [
  "Code", "Package", "Form", "Package Size", 
  "Package Price", "Package Markup", "Unit Price", "Unit Markup", 
  "Status", "Delete Effective Date", "Included in Thiqa",
  "Included in DAMAN Basic", "Effective Date", "Updated Date"
];
const DRUG_COLUMNS = [
  "Drug Code", "Package Name", "Dosage Form", "Package Size", 
  "Package Price to Public", "Package Markup", "Unit Price to Public", "Unit Markup",
  "Status", "Delete Effective Date",
  "Included in Thiqa/ ABM - other than 1&7- Drug Formulary",
  "Included In Basic Drug Formulary", "UPP Effective Date", "UPP Updated Date"
];

// Add plan selector and export button if not present
if (!document.getElementById('inclusion-selector')) {
  const selector = document.createElement('div');
  selector.id = "inclusion-selector";
  selector.style.marginBottom = "18px";
  selector.innerHTML = `
    <label><input type="radio" name="inclusion" value="THIQA" checked> THIQA</label>
    <label><input type="radio" name="inclusion" value="DAMAN"> DAMAN</label>
  `;
  analysisPanel.insertBefore(selector, analysisPanel.firstChild);
}
if (!document.getElementById('export-invalids-btn')) {
  const btn = document.createElement('button');
  btn.id = 'export-invalids-btn';
  btn.textContent = 'Export Invalids';
  btn.style.marginBottom = "18px";
  btn.style.display = 'none';
  analysisPanel.insertBefore(btn, analysisPanel.children[1]);
}

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
  document.getElementById('export-invalids-btn').style.display = 'none';
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

    // Row click handler for quantity calculation
    const tableRows = lookupResults.querySelectorAll('table tbody tr');
    tableRows.forEach((tr, idx) => {
      tr.addEventListener('click', () => {
        selectedDrug = matches[idx];
        quantitySection.style.display = 'block';
        calculateBtn.disabled = false;
        calcOutput.textContent = '';
        quantityInput.value = '';
        // Highlight selected row
        tableRows.forEach(row => row.classList.remove('selected'));
        tr.classList.add('selected');
        // Update selected drug code display if needed
        // const selectedDrugCodeDiv = document.getElementById('selected-drug-code');
        // if (selectedDrugCodeDiv) selectedDrugCodeDiv.textContent = selectedDrug["Drug Code"] || "N/A";
      });
    });
  } else {
    lookupResults.innerHTML = `<p>No match found for: <strong>${query}</strong></p>`;
  }
});

// Table builder for lookup
function renderDrugTable(drugs) {
  let tableHTML = `<table><thead><tr>`;
  DISPLAY_HEADERS.forEach(h => tableHTML += `<th>${h}</th>`);
  tableHTML += `</tr></thead><tbody>`;

  drugs.forEach(row => {
    const status = (row["Status"]||"").toLowerCase();
    const statusActive = (status === "active" || status === "grace");
    const hasNo = [
      "Included in Thiqa/ ABM - other than 1&7- Drug Formulary",
      "Included In Basic Drug Formulary"
    ].some(col => (row[col]||"").toLowerCase()==="no");
    const rowClass = statusActive ? (hasNo ? "unknown" : "valid") : "invalid";

    tableHTML += `<tr class="${rowClass}">` +
      `<td>${row["Drug Code"]||"N/A"}</td>` +
      `<td>${row["Package Name"]||"N/A"}</td>` +
      `<td>${row["Dosage Form"]||"N/A"}</td>` +
      `<td>${row["Package Size"]||"N/A"}</td>` +
      `<td class="package-price">${row["Package Price to Public"]||"N/A"}</td>` +
      `<td>${row["Package Markup"]||"N/A"}</td>` +
      `<td class="unit-price">${row["Unit Price to Public"]||"N/A"}</td>` +
      `<td>${row["Unit Markup"]||"N/A"}</td>` +
      `<td>${row["Status"]||"N/A"}</td>` +
      `<td class="delete-effective-date">${!statusActive ? (row["Delete Effective Date"]||"NO DATE") : "N/A"}</td>` +
      `<td class="included-thiqa">${row["Included in Thiqa/ ABM - other than 1&7- Drug Formulary"]||"Unknown"}</td>` +
      `<td class="included-basic">${row["Included In Basic Drug Formulary"]||"Unknown"}</td>` +
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

// Allow Enter to trigger calculation
quantityInput && quantityInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    calculateBtn.click();
  }
});

// XML UPLOAD & ANALYSIS
xmlUpload.addEventListener('change', e => {
  if (!e.target.files[0]) return;
  const file = e.target.files[0];
  lastXMLFileNameBase = file.name.replace(/\.[^/.]+$/, "");
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
    document.getElementById('export-invalids-btn').style.display = 'none';
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
    document.getElementById('export-invalids-btn').style.display = 'none';
    return;
  }
  lastXmlRows = xmlRows; // cache for re-render
  analysisResults.innerHTML = '';
  analysisResults.appendChild(renderClaimTableWithModals(xmlRows));
  updateExportInvalidsButton();
});

function isActivityValid(drugRow, inclusionType) {
  let status = (drugRow["Status"]||"").toLowerCase();
  if (status === "grace") status = "active";
  const statusActive = status === "active";
  let included = true;
  if (inclusionType === "THIQA") {
    included = (drugRow["Included in Thiqa/ ABM - other than 1&7- Drug Formulary"]||"").toLowerCase() === "yes";
  } else if (inclusionType === "DAMAN") {
    included = (drugRow["Included In Basic Drug Formulary"]||"").toLowerCase() === "yes";
  }
  return statusActive && included;
}

// --- EXPORT LOGIC WITH ORDERING ---
function gatherInvalidsForExport() {
  const inclusionType = getCurrentInclusion();
  let invalids = [];
  Object.entries(claimsMapGlobal).forEach(([claimId, activities]) => {
    activities.forEach(activity => {
      const drugRow = activity.drug;
      if (!isActivityValid(drugRow, inclusionType)) {
        invalids.push({
          ClaimID: claimId,
          ActivityID: activity.activityId,
          DrugCode: drugRow["Drug Code"] || "",
          Package: drugRow["Package Name"] || "",
          Form: drugRow["Dosage Form"] || "",
          PackageSize: drugRow["Package Size"] || "",
          PackagePrice: drugRow["Package Price to Public"] || "",
          PackageMarkup: drugRow["Package Markup"] || "",
          UnitPricePublic: drugRow["Unit Price to Public"] || "",
          UnitMarkup: drugRow["Unit Markup"] || "",
          Status: drugRow["Status"] || "",
          DeleteEffectiveDate: drugRow["Delete Effective Date"] || "",
          IncludedThiqa: drugRow["Included in Thiqa/ ABM - other than 1&7- Drug Formulary"] || "",
          IncludedDaman: drugRow["Included In Basic Drug Formulary"] || "",
          EffectiveDate: drugRow["UPP Effective Date"] || "",
          UpdatedDate: drugRow["UPP Updated Date"] || "",
          InvalidFor: inclusionType
        });
      }
    });
  });
  return invalids;
}

const exportHeaders = [
  "ClaimID", "ActivityID", "DrugCode", "Package", "Form", "PackageSize",
  "PackagePrice", "PackageMarkup", "UnitPricePublic", "UnitMarkup",
  "Status", "DeleteEffectiveDate", "IncludedThiqa", "IncludedDaman",
  "EffectiveDate", "UpdatedDate", "InvalidFor"
];

function exportInvalidsXLSX(invalids, fileNameBase) {
  if (invalids.length === 0) {
    alert('No invalids to export!');
    return;
  }
  const ws = XLSX.utils.json_to_sheet(invalids, { header: exportHeaders });
  ws['!freeze'] = { xSplit: 0, ySplit: 1 };
  ws['!panes'] = [{ ySplit: 1, topLeftCell: 'A2', activePane: 'bottomLeft', state: 'frozen' }];
  fitToContents(ws, invalids);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Invalids");
  XLSX.writeFile(wb, `${fileNameBase}_INVALIDS.xlsx`);
}

function fitToContents(ws, data) {
  if (!data || !data.length) return;
  const headers = Object.keys(data[0]);
  ws['!cols'] = headers.map(h => {
    const maxLen = Math.max(
      h.length,
      ...data.map(row => (row[h] ? row[h].toString().length : 0))
    );
    return { wch: maxLen + 2 }; // +2 for padding
  });
}

document.getElementById('export-invalids-btn').addEventListener('click', function() {
  const invalids = gatherInvalidsForExport();
  exportInvalidsXLSX(invalids, lastXMLFileNameBase);
});

function updateExportInvalidsButton() {
  const invalids = gatherInvalidsForExport();
  document.getElementById('export-invalids-btn').style.display = invalids.length > 0 ? '' : 'none';
}

// Modal per claim implementation
function renderClaimTableWithModals(xmlRows) {
  // Group activities by claimId
  const claimsMap = {};
  xmlRows.forEach(row => {
    if (!claimsMap[row.claimId]) claimsMap[row.claimId] = [];
    claimsMap[row.claimId].push(row);
  });
  claimsMapGlobal = claimsMap; // for modal refresh

  const inclusionType = getCurrentInclusion();

  // Main table with one row per claim
  let tableHTML = '<table><thead><tr><th>Claim ID</th><th>Number of Activities</th><th>Actions</th></tr></thead><tbody>';
  Object.keys(claimsMap).forEach((claimId, idx) => {
    const activities = claimsMap[claimId];
    // Set claim row to invalid if any activity is invalid
    let claimClass = "valid";
    for (const activity of activities) {
      if (!isActivityValid(activity.drug, inclusionType)) {
        claimClass = "invalid";
        break;
      }
    }
    tableHTML += `<tr class="${claimClass}">
      <td>${claimId}</td>
      <td>${activities.length}</td>
      <td>
        <button class="details-btn" data-modal="modal-claim-${idx}" data-idx="${idx}">Show Activities</button>
        <div id="modal-claim-${idx}" class="modal">
          <div class="modal-content">
            <span class="close" data-modal-close="modal-claim-${idx}">&times;</span>
            <h4>Activities for Claim ${claimId}</h4>
            <div class="modal-table-container">
              ${renderActivitiesTable(activities, inclusionType)}
            </div>
          </div>
        </div>
      </td>
    </tr>`;
  });
  tableHTML += '</tbody></table>';

  const container = document.createElement('div');
  container.innerHTML = tableHTML;

  // Safety: Hide all modals after DOM insertion
  container.querySelectorAll('.modal').forEach(modal => {
    modal.style.display = 'none';
  });

  setTimeout(() => setupModalListeners(container), 0);
  return container;
}

// Updated activities table for modal
function renderActivitiesTable(activities, inclusionType) {
  let html = `<table class="analysis-results"><thead><tr>
    <th>Activity ID</th>
    <th>Code</th>
    <th>Package</th>
    <th>Form</th>
    <th>Package Size</th>
    <th class="package-price">Package Price</th>
    <th>Package Markup</th>
    <th class="unit-price">Unit Price</th>
    <th>Unit Markup</th>
    <th>Status</th>
    <th class="delete-effective-date">Delete Effective Date</th>
    <th class="included-thiqa">Included in Thiqa</th>
    <th class="included-basic">Included in DAMAN Basic</th>
    <th>Effective Date</th>
    <th>Updated Date</th>
  </tr></thead><tbody>`;

  activities.forEach(row => {
    const drugRow = row.drug;
    let status = (drugRow["Status"] || "").toLowerCase();
    if (status === "grace") status = "active";
    const statusActive = status === "active";

    let isValid = true;
    if (inclusionType === "THIQA") {
      isValid = (drugRow["Included in Thiqa/ ABM - other than 1&7- Drug Formulary"] || "").toLowerCase() === "yes";
    } else if (inclusionType === "DAMAN") {
      isValid = (drugRow["Included In Basic Drug Formulary"] || "").toLowerCase() === "yes";
    }

    const rowClass = (statusActive && isValid) ? "valid" : "invalid";

    html += `<tr class="${rowClass}">` +
      `<td>${row.activityId}</td>` +
      `<td>${drugRow["Drug Code"] || "N/A"}</td>` +
      `<td>${drugRow["Package Name"] || "N/A"}</td>` +
      `<td>${drugRow["Dosage Form"] || "N/A"}</td>` +
      `<td>${drugRow["Package Size"] || "N/A"}</td>` +
      `<td class="package-price">${drugRow["Package Price to Public"] || "N/A"}</td>` +
      `<td>${drugRow["Package Markup"] || "N/A"}</td>` +
      `<td class="unit-price">${drugRow["Unit Price to Public"] || "N/A"}</td>` +
      `<td>${drugRow["Unit Markup"] || "N/A"}</td>` +
      `<td>${drugRow["Status"] || "N/A"}</td>` +
      `<td class="delete-effective-date">${!statusActive ? (drugRow["Delete Effective Date"] || "NO DATE") : "N/A"}</td>` +
      `<td class="included-thiqa">${drugRow["Included in Thiqa/ ABM - other than 1&7- Drug Formulary"] || "Unknown"}</td>` +
      `<td class="included-basic">${drugRow["Included In Basic Drug Formulary"] || "Unknown"}</td>` +
      `<td>${drugRow["UPP Effective Date"] || "NO DATE"}</td>` +
      `<td>${drugRow["UPP Updated Date"] || "NO DATE"}</td>` +
    `</tr>`;
  });

  html += '</tbody></table>';
  return html;
}

function getCurrentInclusion() {
  return document.querySelector('input[name="inclusion"]:checked').value;
}

function setupModalListeners(container) {
  container.querySelectorAll('.details-btn').forEach(btn => {
    btn.addEventListener('click', function() {
      const modalId = btn.getAttribute('data-modal');
      const idx = btn.getAttribute('data-idx');
      const modal = container.querySelector(`#${modalId}`);
      if (modal) {
        modal.style.display = 'block';
        currentModalIdx = idx;
        refreshModalActivities(modal, idx);
      }
    });
  });
  // Close modal
  container.querySelectorAll('.close').forEach(btn => {
    btn.addEventListener('click', function() {
      const modalId = btn.getAttribute('data-modal-close');
      const modal = container.querySelector(`#${modalId}`);
      if (modal) modal.style.display = 'none';
      currentModalIdx = null;
    });
  });
  // Close when clicking outside modal-content
  container.querySelectorAll('.modal').forEach(modal => {
    modal.addEventListener('click', function(event) {
      if (event.target === modal) {
        modal.style.display = 'none';
        currentModalIdx = null;
      }
    });
  });
}

// Redraw claim table and modal activities on inclusion radio change
document.querySelectorAll('input[name="inclusion"]').forEach(radio => {
  radio.addEventListener('change', () => {
    if (lastXmlRows.length > 0) {
      analysisResults.innerHTML = '';
      analysisResults.appendChild(renderClaimTableWithModals(lastXmlRows));
      updateExportInvalidsButton();
    }
    if (currentModalIdx !== null) {
      const modal = document.getElementById(`modal-claim-${currentModalIdx}`);
      if (modal && modal.style.display === 'block') {
        refreshModalActivities(modal, currentModalIdx);
      }
    }
  });
});

function refreshModalActivities(modal, idx) {
  const inclusionType = getCurrentInclusion();
  let claimId = null;
  const h4 = modal.querySelector('h4');
  if (h4) {
    const m = h4.textContent.match(/Claim (.+)$/);
    if (m) claimId = m[1];
  }
  if (!claimId || !claimsMapGlobal[claimId]) return;
  const activities = claimsMapGlobal[claimId];
  const modalTableContainer = modal.querySelector('.modal-table-container');
  if (modalTableContainer) {
    modalTableContainer.innerHTML = renderActivitiesTable(activities, inclusionType);
  }
}
