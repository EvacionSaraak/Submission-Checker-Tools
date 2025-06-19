let drugData = [];
let xmlData = null;

// Get elements
const modeRadios = document.querySelectorAll('input[name="mode"]');
const lookupPanel = document.getElementById('lookup-panel');
const analysisPanel = document.getElementById('analysis-panel');

const xlsxLookup = document.getElementById('xlsx-lookup');
const drugCountLookup = document.getElementById('lookup-drug-count');
const drugInput = document.getElementById('drug-code-input');
const searchDrugBtn = document.getElementById('search-drug-btn');
const lookupResults = document.getElementById('lookup-results');

const xlsxAnalysis = document.getElementById('xlsx-analysis');
const drugCountAnalysis = document.getElementById('analysis-drug-count');
const xmlUpload = document.getElementById('xml-upload');
const xmlClaimCount = document.getElementById('xml-claim-count');
const analyzeBtn = document.getElementById('analyze-btn');
const analysisResults = document.getElementById('analysis-results');

// --- Mode Switching ---
function toggleModePanels() {
  const selected = document.querySelector('input[name="mode"]:checked').value;
  lookupPanel.style.display = selected === 'lookup' ? 'block' : 'none';
  analysisPanel.style.display = selected === 'analysis' ? 'block' : 'none';
}
modeRadios.forEach(radio => radio.addEventListener('change', toggleModePanels));
toggleModePanels(); // Initial state

// --- XLSX Parsing ---
function parseDrugsFromXLSX(file, displayTarget, enableInputCallback) {
  const reader = new FileReader();
  reader.onload = e => {
    const workbook = XLSX.read(e.target.result, { type: 'binary' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json(sheet);
    drugData = json.filter(row => row["Drug Code"]);
    displayTarget.textContent = `Loaded ${drugData.length} drug entries.`;
    enableInputCallback(true);
  };
  reader.readAsBinaryString(file);
}

// --- Drug Lookup ---
xlsxLookup.addEventListener('change', e => {
  if (e.target.files[0]) {
    parseDrugsFromXLSX(e.target.files[0], drugCountLookup, (enable) => {
      drugInput.disabled = !enable;
      searchDrugBtn.disabled = !enable;
    });
  }
});

searchDrugBtn.addEventListener('click', () => {
  const code = drugInput.value.trim();
  const matches = drugData.filter(row => row["Drug Code"] == code);
  if (matches.length > 0) {
    lookupResults.innerHTML = buildDrugTable(matches);
  } else {
    lookupResults.innerHTML = `<p>No match found for drug code: <strong>${code}</strong></p>`;
  }
});

// --- XML Analysis (placeholder until schema is defined) ---
xlsxAnalysis.addEventListener('change', e => {
  if (e.target.files[0]) {
    parseDrugsFromXLSX(e.target.files[0], drugCountAnalysis, tryEnableAnalyze);
  }
});

xmlUpload.addEventListener('change', e => {
  if (e.target.files[0]) {
    xmlClaimCount.textContent = `XML loaded. Waiting on schema for processing.`;
    xmlData = true; // Simulate that XML is loaded
    tryEnableAnalyze();
  }
});

function tryEnableAnalyze() {
  if (drugData.length > 0 && xmlData) {
    analyzeBtn.disabled = false;
  }
}

analyzeBtn.addEventListener('click', () => {
  analysisResults.innerHTML = `<div class="error-box">XML Analysis feature is currently disabled until schema is available.</div>`;
});

// --- Table Builder ---
function buildDrugTable(drugs) {
  const headers = [
    "Drug Code", "Package Name", "Dosage Form", "Package Size",
    "Unit Price to Public", "Status", "UPP Scope",
    "Included in Thiqa/ABM - other than 1&7- Drug Formulary",
    "Included In Basic Drug Formulary",
    "UPP Effective Date", "UPP Updated Date"
  ];

  const displayNames = [
    "Code", "Package", "Form", "Size", "Unit Price", "Status", "Scope",
    "Thiqa Included", "Basic Included", "Effective Date", "Last Updated Date", "Validity"
  ];

  let table = `<table><thead><tr>`;
  displayNames.forEach(name => table += `<th>${name}</th>`);
  table += `</tr></thead><tbody>`;

  drugs.forEach(row => {
    const status = (row["Status"] || "").toLowerCase();
    const isValid = status === "active";
    const validityTag = isValid
      ? `<span class="valid" style="font-weight: bold;">Valid</span>`
      : `<span class="invalid" style="font-weight: bold;">Invalid</span>`;

    table += `<tr class="${isValid ? 'valid' : 'invalid'}">`;
    headers.forEach(col => {
      table += `<td>${row[col] || ''}</td>`;
    });
    table += `<td>${validityTag}</td>`;
    table += `</tr>`;
  });

  table += `</tbody></table>`;
  return table;
}
