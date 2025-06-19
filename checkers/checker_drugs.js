let drugData = [];
let xmlData = null;

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

// Mode switching
function toggleModePanels() {
  const selected = document.querySelector('input[name="mode"]:checked').value;
  lookupPanel.style.display = selected === 'lookup' ? 'block' : 'none';
  analysisPanel.style.display = selected === 'analysis' ? 'block' : 'none';
}
modeRadios.forEach(radio => radio.addEventListener('change', toggleModePanels));
toggleModePanels();

// Load shared XLSX drugs
xlsxUpload.addEventListener('change', e => {
  if (!e.target.files[0]) return;
  const reader = new FileReader();
  reader.onload = ev => {
    const workbook = XLSX.read(ev.target.result, { type: 'binary' });
    const sheet = workbook.Sheets[workbook.SheetNames[1]];
    const json = XLSX.utils.sheet_to_json(sheet);
    drugData = json.filter(row => row["Drug Code"]);

    drugCount.textContent = `Loaded ${drugData.length} drug entries.`;

    // Enable lookup input and search if lookup panel active
    if (document.querySelector('input[name="mode"]:checked').value === 'lookup') {
      drugInput.disabled = false;
      searchDrugBtn.disabled = false;
    }

    // Enable analyze if XML is loaded and mode is analysis
    if (xmlData && document.querySelector('input[name="mode"]:checked').value === 'analysis') {
      analyzeBtn.disabled = false;
    }
  };
  reader.readAsBinaryString(e.target.files[0]);
});

// Lookup search button
searchDrugBtn.addEventListener('click', () => {
  const code = drugInput.value.trim();
  if (!code) return;
  const matches = drugData.filter(row => row["Drug Code"] == code);
  lookupResults.innerHTML = matches.length
    ? buildDrugTable(matches)
    : `<p>No match found for drug code: <strong>${code}</strong></p>`;
});

// XML upload for analysis panel
xmlUpload.addEventListener('change', e => {
  if (!e.target.files[0]) return;
  // For now, simulate XML load as true
  xmlClaimCount.textContent = `XML loaded. Waiting on schema for processing.`;
  xmlData = true;

  // Enable analyze button only if drug data already loaded
  if (drugData.length > 0) {
    analyzeBtn.disabled = false;
  }
});

// Analyze button stub
analyzeBtn.addEventListener('click', () => {
  analysisResults.innerHTML = `<div class="error-box">XML Analysis is disabled until schema is available.</div>`;
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
    "Thiqa Included", "Basic Included", "Effective Date", "Updated Date", "Validity"
  ];

  // Helper to normalize Yes/No for Thiqa and Basic Formulary columns
  function yesNo(value) {
    if (!value) return "No";
    const val = String(value).trim().toLowerCase();
    if (["yes","y","true","1"].includes(val)) return "Yes";
    return "No";
  }

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
      let cell = row[col] || "";
      
      // Customize Thiqa and Basic Formulary columns
      if (col === "Included in Thiqa/ABM - other than 1&7- Drug Formulary") {
        cell = yesNo(cell);
      }
      if (col === "Included In Basic Drug Formulary") {
        cell = yesNo(cell);
      }

      table += `<td>${cell}</td>`;
    });
    table += `<td>${validityTag}</td>`;
    table += `</tr>`;
  });

  table += `</tbody></table>`;
  return table;
}

