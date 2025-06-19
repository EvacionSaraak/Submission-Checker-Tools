let drugData = [];
let xmlData = null;

const DISPLAY_COLUMNS = [
  "Drug Code",
  "Package Name",
  "Dosage Form",
  "Package Size",
  "Unit Price to Public",
  "Status",
  "UPP Scope",
  "Included in Thiqa/ ABM - other than 1&7- Drug Formulary",
  "Included In Basic Drug Formulary",
  "UPP Effective Date",
  "UPP Updated Date"
];

const DISPLAY_HEADERS = [
  "Code", "Package", "Form", "Size", "Unit Price", "Status", "Scope",
  "Included in Thiqa", "Included in Basic", "Effective Date", "Updated Date", "Validity"
];

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

  // Enable/disable inputs/buttons based on mode and data loaded
  if (selected === 'lookup') {
    drugInput.disabled = drugData.length === 0;
    searchDrugBtn.disabled = drugData.length === 0;
    analyzeBtn.disabled = true;
  } else if (selected === 'analysis') {
    analyzeBtn.disabled = !(drugData.length > 0 && xmlData !== null);
    drugInput.disabled = true;
    searchDrugBtn.disabled = true;
  }
}
modeRadios.forEach(radio => radio.addEventListener('change', toggleModePanels));
toggleModePanels();

// Shared XLSX upload for both modes
xlsxUpload.addEventListener('change', e => {
  if (!e.target.files[0]) return;

  drugCount.textContent = "Loading drug list..."; // ✅ Show loading message immediately

  const reader = new FileReader();

  reader.onload = ev => {
    const workbook = XLSX.read(ev.target.result, { type: 'binary' });
    const sheet = workbook.Sheets[workbook.SheetNames[1]]; // second sheet
    const json = XLSX.utils.sheet_to_json(sheet);

    // Normalize keys and values
    drugData = json.map(row => {
      const normalizedRow = {};
      Object.keys(row).forEach(key => {
        const cleanKey = key.trim();
        const rawValue = row[key];

        if (typeof rawValue === "boolean") {
          normalizedRow[cleanKey] = rawValue ? "Yes" : "No";
        } else if (rawValue === null || rawValue === undefined || rawValue === "") {
          normalizedRow[cleanKey] = "";
        } else {
          normalizedRow[cleanKey] = rawValue.toString().trim();
        }
      });
      return normalizedRow;
    }).filter(row => row["Drug Code"]);

    drugCount.textContent = `Loaded ${drugData.length} drug entries.`; // ✅ Replace with total count
    toggleModePanels();
  };

  reader.readAsBinaryString(e.target.files[0]);
});


// Lookup search button
searchDrugBtn.addEventListener('click', () => {
  const code = drugInput.value.trim();
  if (!code) return alert("Please enter a drug code");

  // Case-insensitive exact match
  const matches = drugData.filter(row => (row["Drug Code"] || "").toLowerCase() === code.toLowerCase());

  if (matches.length === 0) {
    lookupResults.innerHTML = `<p>No match found for drug code: <strong>${code}</strong></p>`;
    return;
  }

  // Log matched drug rows for debugging
  matches.forEach((drug, i) => console.log(`Matched Drug ${i + 1}:`, drug));

  lookupResults.innerHTML = buildDrugTable(matches);
});

// XML upload for analysis panel
xmlUpload.addEventListener('change', e => {
  if (!e.target.files[0]) return;

  // Placeholder for XML parsing (disabled for now)
  xmlClaimCount.textContent = `XML loaded. Waiting on schema for processing.`;
  xmlData = true;

  // Enable analyze button only if drugs loaded
  toggleModePanels();
});

// Analyze button stub
analyzeBtn.addEventListener('click', () => {
  analysisResults.innerHTML = `<div class="error-box">XML Analysis is disabled until schema is available.</div>`;
});

// Build Table function (unchanged from your original, with validity and classes)
function buildDrugTable(drugs) {
  let table = `<table><thead><tr>`;
  DISPLAY_HEADERS.forEach(name => {
    table += `<th>${name}</th>`;
  });
  table += `</tr></thead><tbody>`;

  drugs.forEach(row => {
    const statusRaw = (row["Status"] || "").toLowerCase();
    const statusActive = statusRaw === "active";

    const hasNoInRequired = [
      "UPP Scope",
      "Included in Thiqa/ABM - other than 1&7- Drug Formulary",
      "Included In Basic Drug Formulary"
    ].some(col => {
      const val = (row[col] || "").toString().trim().toLowerCase();
      return val === "no";
    });

    let rowClass = "invalid";
    let validityTag = `<span class="invalid" style="font-weight: bold;">Invalid</span>`;

    if (statusActive) {
      if (hasNoInRequired) {
        rowClass = "unknown";
        validityTag = `<span class="unknown" style="font-weight: bold;">Unknown</span>`;
      } else {
        rowClass = "valid";
        validityTag = `<span class="valid" style="font-weight: bold;">Valid</span>`;
      }
    }

    table += `<tr class="${rowClass}">`;

    DISPLAY_COLUMNS.forEach(col => {
      let cell = row[col];
    
      if (cell === null || cell === undefined) {
        cell = "";
      } else if (typeof cell === "boolean") {
        cell = cell ? "Yes" : "No";
      } else {
        cell = cell.toString().trim();
      }
    
      table += `<td>${cell}</td>`;
    });

    table += `<td>${validityTag}</td>`;
    table += `</tr>`;
  });

  table += `</tbody></table>`;
  return table;
}
