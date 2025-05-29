// checker_auths.js

// === GLOBAL STATE ===
let authRules = {};
let authRulesPromise = null;
let xmlClaimCount = 0;
let xlsxAuthCount = 0;

// === UTILITIES ===

/**
 * Shows file status messages with different types (info, success, error)
 * @param {string} message - Status message
 * @param {string} type - Message type ('info', 'success', 'error')
 */
function showFileStatus(message, type = 'info') {
  const statusElement = document.getElementById('file-status');
  if (!statusElement) return;

  statusElement.textContent = message;
  statusElement.className = '';
  statusElement.classList.add(type);

  // Auto-clear non-error messages after 5 seconds
  if (type !== 'error') {
    setTimeout(() => {
      statusElement.textContent = '';
      statusElement.className = '';
    }, 5000);
  }
}

/**
 * Safely retrieves trimmed text content from a named child element of an XML parent.
 * @param {Element} parent - XML parent element
 * @param {string} tag - Tag name to search for
 * @returns {string}
 */
function getText(parent, tag) {
  const el = parent.querySelector(tag);
  return el && el.textContent ? el.textContent.trim() : "";
}

/**
 * Updates the status message and run button state based on loaded claim/auth counts
 */
function updateStatus() {
  const resultsDiv = document.getElementById("results");
  let messages = [];

  // XML status
  if (xmlClaimCount === -1) messages.push("XML file selected, awaiting processing...");
  else if (xmlClaimCount > 0) messages.push(`${xmlClaimCount} Claims Loaded`);
  else if (xmlClaimCount === 0) messages.push("No claims loaded");

  // XLSX status
  if (xlsxAuthCount === -1) messages.push("XLSX file selected, awaiting processing...");
  else if (xlsxAuthCount > 0) messages.push(`${xlsxAuthCount} Auths Loaded`);
  else if (xlsxAuthCount === 0) messages.push("No auths loaded");

  if (resultsDiv) {
    resultsDiv.textContent = messages.join(" | ");
  }

  const processBtn = document.getElementById("processBtn");
  if (processBtn) processBtn.disabled = !(xmlClaimCount > 0 && xlsxAuthCount > 0);
}

// === LOADERS ===

/**
 * Handles file input change events and reads the file
 * @param {Event} event - File input change event
 * @param {function} callback - Callback with file content
 */
function handleFileInputChange(event, callback) {
  const file = event.target.files[0];
  if (!file) {
    showFileStatus('No file selected.', 'error');
    return;
  }

  showFileStatus(`Loading file: ${file.name}`, 'info');

  const reader = new FileReader();

  reader.onload = (e) => {
    showFileStatus(`File loaded: ${file.name}`, 'success');
    callback(e.target.result);
  };

  reader.onerror = () => {
    showFileStatus(`Error loading file: ${file.name}`, 'error');
  };

  reader.readAsText(file);
}

/**
 * Loads authorization rules from JSON file
 * @param {string} url - URL to JSON rules file
 * @returns {Promise<void>}
 */
function loadAuthRules(url = "checker_auths.json") {
  if (!authRulesPromise) {
    authRulesPromise = fetch(url)
      .then(res => {
        if (!res.ok) throw new Error(`Failed to load ${url}`);
        return res.json();
      })
      .then(data => {
        authRules = data.reduce((map, entry) => {
          map[entry.code] = entry;
          return map;
        }, {});
      });
  }
  return authRulesPromise;
}

// === PARSERS ===

/**
 * Reads and parses an XML file
 * @param {File} file - XML file to parse
 * @returns {Promise<Document>}
 */
function parseXMLFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      const doc = new DOMParser().parseFromString(e.target.result, "application/xml");
      const err = doc.querySelector("parsererror");
      if (err) {
        xmlClaimCount = 0;
        updateStatus();
        return reject("Invalid XML file");
      }
      const claims = doc.querySelectorAll("Claim");
      xmlClaimCount = claims.length;
      updateStatus();
      resolve(doc);
    };
    reader.onerror = () => {
      xmlClaimCount = 0;
      updateStatus();
      reject("Failed to read XML file");
    };
    reader.readAsText(file);
  });
}

/**
 * Reads and parses an XLSX file
 * @param {File} file - XLSX file to parse
 * @returns {Promise<Array>}
 */
function parseXLSXFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const wb = XLSX.read(new Uint8Array(e.target.result), { type: "array" });
        const sheetName = wb.SheetNames.includes("HCPRequests")
          ? "HCPRequests"
          : wb.SheetNames[1] || wb.SheetNames[0];
        const sheet = wb.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
        xlsxAuthCount = rows.length;
        updateStatus();
        resolve(rows);
      } catch (err) {
        xlsxAuthCount = 0;
        updateStatus();
        reject("Invalid XLSX file");
      }
    };
    reader.onerror = () => {
      xlsxAuthCount = 0;
      updateStatus();
      reject("Failed to read XLSX file");
    };
    reader.readAsArrayBuffer(file);
  });
}

// === DATA TRANSFORM ===

/**
 * Maps XLSX rows by AuthorizationID for fast lookup
 * @param {Array} rows - XLSX data rows
 * @returns {Object}
 */
function mapXLSXData(rows) {
  return rows.reduce((map, row) => {
    const id = row.AuthorizationID || "";
    map[id] = map[id] || [];
    map[id].push(row);
    return map;
  }, {});
}

// === VALIDATORS ===

/**
 * Checks if a code requires approval
 * @param {string} code - Activity code
 * @param {string} authID - Authorization ID
 * @returns {Array<string>} remarks
 */
function validateApprovalRequirement(code, authID) {
  const remarks = [];
  const rule = authRules[code];
  if (!rule) {
    remarks.push("Code not found in checker_auths.json");
    return remarks;
  }
  const needsAuth = !/NOT\s+REQUIRED/i.test(rule.approval_details || "");
  if (needsAuth) {
    if (!authID) remarks.push("Missing required AuthorizationID");
  } else {
    remarks.push("No authorization required for this code");
    if (authID) remarks.push("AuthorizationID provided but not required");
  }
  return remarks;
}

/**
 * Validates field matches between XLSX and XML data
 * @param {Object} row - XLSX data row
 * @param {Object} context - Activity context
 * @returns {Array<string>} remarks
 */
function validateXLSXMatch(row, { memberId, code, qty, netTotal, ordering, authID }) {
  const remarks = [];
  if ((row["Card Number / DHA Member ID"] || "") !== memberId) remarks.push(`MemberID mismatch: XLSX=${row["Card Number / DHA Member ID"] || ""}`);
  if ((row["Item Code"] || "") !== code) remarks.push(`Item Code mismatch: XLSX=${row["Item Code"] || ""}`);
  if (String(row["Item Amount"] || "") !== qty) remarks.push(`Qty mismatch: XLSX=${row["Item Amount"] || ""}`);
  if (String(row["Payer Share"] || "") !== netTotal) remarks.push(`Payer Share mismatch: XLSX=${row["Payer Share"] || ""}`);
  if ((row["Ordering Clinician"] || "") !== ordering) remarks.push(`Ordering Clinician mismatch: XLSX=${row["Ordering Clinician"] || ""}`);
  if ((row.AuthorizationID || "") !== authID) remarks.push(`AuthorizationID mismatch: XLSX=${row.AuthorizationID || ""}`);
  return remarks;
}

/**
 * Validates date consistency and approval status
 * @param {Object} row - XLSX data row
 * @param {string} start - Activity start date
 * @returns {Array<string>} remarks
 */
function validateDateAndStatus(row, start) {
  const remarks = [];
  const xlsDateStr = (row["Ordered On"] || "").split(' ')[0];
  const xmlDateStr = (start || "").split(' ')[0];
  const xlsParts = xlsDateStr.split('/');
  const xmlParts = xmlDateStr.split('/');
  const xlsDate = new Date(`${xlsParts[2]}-${xlsParts[1].padStart(2,'0')}-${xlsParts[0].padStart(2,'0')}`);
  const xmlDate = new Date(`${xmlParts[2]}-${xmlParts[1].padStart(2,'0')}-${xmlParts[0].padStart(2,'0')}`);

  if (!(xlsDate instanceof Date) || isNaN(xlsDate)) remarks.push("Invalid XLSX Ordered On date");
  if (!(xmlDate instanceof Date) || isNaN(xmlDate)) remarks.push("Invalid XML Start date");
  if (!isNaN(xlsDate) && !isNaN(xmlDate) && xlsDate >= xmlDate)
    remarks.push("Ordered On date must be before Activity Start date");

  const status = (row.status || row.Status || "").toLowerCase();
  if (!status.includes("approved")) {
    if (status.includes("rejected")) {
      remarks.push(`Rejected: Code=${row["Denial Code (if any)"] || 'N/A'} Reason=${row["Denial Reason (if any)"] || 'N/A'}`);
    } else {
      remarks.push("Status not approved");
    }
  }
  return remarks;
}

/**
 * Validates an individual Activity element
 * @param {Element} activity - XML Activity element
 * @param {Object} xlsxMap - XLSX data mapped by AuthorizationID
 * @param {string} memberId - Member ID
 * @param {Object} authRules - Authorization rules
 * @returns {Object} Validation result
 */
function validateActivity(activity, xlsxMap, memberId, authRules) {
  const id = getText(activity, "ID");
  const code = getText(activity, "Code");
  const rule = authRules[code];
  const description = rule?.description || "";
  const start = getText(activity, "Start");
  const qty = getText(activity, "Quantity");
  const netTotal = getText(activity, "NetTotal");
  const ordering = getText(activity, "OrderingClinician");
  const authID = getText(activity, "PriorAuthorizationID") || getText(activity, "PriorAuthorization");

  let remarks = [];

  // Determine if auth is required for this code
  const authRequired = !!(rule && rule.authRequired);

  // Main validation logic for auth
  if (!authID) {
    if (authRequired) {
      remarks.push("Missing AuthorizationID for code requiring auth");
    }
  } else {
    const rows = xlsxMap[authID] || [];
    if (!rows.length) {
      remarks.push(`AuthID ${authID} not in HCPRequests sheet`);
    } else {
      const xlsRow = rows.find(r => (r.AuthorizationID || "") === authID && (r["Item Code"] || "") === code);
      if (!xlsRow) {
        remarks.push("No matching row for code/AuthID in XLSX");
      } else {
        const context = { memberId, code, qty, netTotal, ordering, authID };
        remarks = remarks.concat(validateXLSXMatch(xlsRow, context));
        remarks = remarks.concat(validateDateAndStatus(xlsRow, start));
        return { id, code, description, start, qty, netTotal, ordering, authID, xlsRow, remarks };
      }
    }
  }

  return { id, code, description, start, qty, netTotal, ordering, authID, xlsRow: null, remarks };
}

/**
 * Validates all claims and activities
 * @param {Document} xmlDoc - Parsed XML document
 * @param {Array} xlsxData - XLSX data rows
 * @param {Object} authRules - Authorization rules
 * @returns {Array<Object>} Validation results
 */
function validateClaims(xmlDoc, xlsxData, authRules) {
  const results = [];
  const xlsxMap = mapXLSXData(xlsxData);
  const claims = Array.from(xmlDoc.getElementsByTagName("Claim"));

  claims.forEach(claim => {
    const claimId = getText(claim, "ID");
    const memberId = getText(claim, "MemberID");
    const activities = Array.from(claim.getElementsByTagName("Activity"));

    activities.forEach(activity => {
      const rec = validateActivity(activity, xlsxMap, memberId, authRules);
      results.push({ claimId, memberId, ...rec });
    });
  });

  return results;
}

// === RENDERERS ===

/**
 * Renders validation results in a table
 * @param {Array} results - Validation results
 */
function renderResults(results) {
  const container = document.getElementById("results");
  container.innerHTML = "";

  if (!results.length) {
    container.textContent = "✅ No activities to validate.";
    return;
  }

  const table = document.createElement("table");
  table.className = "styled-table";

  // Table header
  table.innerHTML = `
  <thead>
    <tr>
      <th>Claim ID</th>
      <th>Member ID</th>
      <th>Activity ID</th>
      <th>Code</th>
      <th>Description</th>
      <th>Qty</th>
      <th>Net Total</th>
      <th>Ordering Clinician</th>
      <th>Auth ID</th>
      <th>Start Date</th>
      <th>Ordered On</th>
      <th>Status</th>
      <th>Denial Code</th>
      <th>Denial Reason</th>
      <th>Remarks</th>
    </tr>
  </thead>`;

  const tbody = document.createElement("tbody");
  let lastClaim = null;

  results.forEach(r => {
    const tr = document.createElement("tr");
    tr.className = r.remarks.length ? 'invalid' : 'valid';

    // Claim ID cell (only show if different from last)
    const claimCell = document.createElement("td");
    claimCell.textContent = (r.claimId === lastClaim) ? "" : r.claimId;
    lastClaim = r.claimId;
    tr.appendChild(claimCell);

    // Member ID, Activity ID, Code, Description
    [r.memberId, r.id, r.code, r.description].forEach(val => {
      const td = document.createElement("td");
      td.textContent = val || "";
      tr.appendChild(td);
    });

    // Qty, Net Total, Ordering Clinician, Auth ID, Start Date
    [r.qty, r.netTotal, r.ordering, r.authID, r.start].forEach(val => {
      const td = document.createElement("td");
      td.textContent = val || "";
      tr.appendChild(td);
    });

    // From XLSX row: Ordered On, Status, Denial Code, Denial Reason
    const xlsRow = r.xlsRow || {};
    const orderedOn = xlsRow["Ordered On"] || xlsRow["OrderedOn"] || "";
    const status = xlsRow.status || xlsRow.Status || "";
    const denialCode = xlsRow["Denial Code (if any)"] || "";
    const denialReason = xlsRow["Denial Reason (if any)"] || "";

    [orderedOn, status, denialCode, denialReason].forEach(val => {
      const td = document.createElement("td");
      td.textContent = val || "";
      tr.appendChild(td);
    });

    // Remarks (join all remarks as a single string)
    const remarksCell = document.createElement("td");
    remarksCell.textContent = r.remarks.length ? r.remarks.join("; ") : "OK";
    tr.appendChild(remarksCell);

    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  container.appendChild(table);
}

// === MAIN PROCESSING ===

/**
 * Processes authorization file content
 * @param {string} fileContent - File content to process
 */
function processAuthsFileContent(fileContent) {
  try {
    const authsData = JSON.parse(fileContent);
    showFileStatus('Authorization data parsed successfully.', 'success');
    const validationResults = validateAuthsData(authsData);
    renderAuthsResults(validationResults);
  } catch (error) {
    showFileStatus('Failed to process authorization data: ' + error.message, 'error');
  }
}

/**
 * Main runner function
 */
async function handleRun() {
  xmlClaimCount = 0;
  xlsxAuthCount = 0;
  updateStatus();

  const xmlFile = document.getElementById("xmlInput").files[0];
  const xlsxFile = document.getElementById("xlsxInput").files[0];
  const resultsDiv = document.getElementById("results");

  if (!xmlFile || !xlsxFile) {
    resultsDiv.textContent = "Please upload both XML and XLSX files.";
    return;
  }

  try {
    await loadAuthRules();
    const [xmlDoc, xlsxData] = await Promise.all([
      parseXMLFile(xmlFile),
      parseXLSXFile(xlsxFile)
    ]);
    const results = validateClaims(xmlDoc, xlsxData, authRules);
    renderResults(results);
  } catch (err) {
    resultsDiv.textContent = `Error: ${err}`;
  }
}

// === EVENT LISTENERS ===

// Set up file input change handlers
document.getElementById('file-input').addEventListener('change', (event) => {
  handleFileInputChange(event, processAuthsFileContent);
});

// Set up main run button handler
document.getElementById("runButton").addEventListener("click", handleRun);

// Set up file input change handlers for XML/XLSX
["xmlInput", "xlsxInput"].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener("change", () => {
    if (id === "xmlInput") xmlClaimCount = -1;
    if (id === "xlsxInput") xlsxAuthCount = -1;
    updateStatus();
  });
});
