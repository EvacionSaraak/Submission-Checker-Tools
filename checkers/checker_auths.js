// === GLOBAL STATE ===
let authRules = {};
let authRulesPromise = null;
let xmlClaimCount = 0;
let xlsxAuthCount = 0;

// === FILE HANDLING STATE ===
let currentXmlFile = null;
let currentXlsxFile = null;

// Enhanced file input change handlers for auto-run
let parsedXmlDoc = null;
let parsedXlsxData = null;

// === UTILITIES ===

function showFileStatus(message, type = 'info') {
  const statusElement = document.getElementById('file-status');
  if (!statusElement) return;

  statusElement.textContent = message;
  statusElement.className = '';
  statusElement.classList.add(type);

  if (type !== 'error') {
    setTimeout(() => {
      statusElement.textContent = '';
      statusElement.className = '';
    }, 5000);
  }
}

function getText(parent, tag) {
  const el = parent.querySelector(tag);
  return el && el.textContent ? el.textContent.trim() : "";
}

function updateStatus() {
  const resultsDiv = document.getElementById("results");
  let messages = [];

  if (xmlClaimCount === -1) messages.push("XML file selected, awaiting processing...");
  else if (xmlClaimCount > 0) messages.push(`${xmlClaimCount} Claims Loaded`);
  else if (xmlClaimCount === 0) messages.push("No claims loaded");

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
function validateXLSXMatch(row, { memberId, code, qty, netTotal, ordering, clinician, authID }) {
  const remarks = [];
  if ((row["Card Number / DHA Member ID"] || "") !== memberId) remarks.push(`MemberID mismatch: XLSX=${row["Card Number / DHA Member ID"] || ""}`);
  if ((row["Item Code"] || "") !== code) remarks.push(`Item Code mismatch: XLSX=${row["Item Code"] || ""}`);
  if (String(row["Item Amount"] || "") !== qty) remarks.push(`Qty mismatch: XLSX=${row["Item Amount"] || ""}`);
  if (String(row["Payer Share"] || "") !== netTotal) remarks.push(`Payer Share mismatch: XLSX=${row["Payer Share"] || ""}`);
  if ((row["Ordering Clinician"] || "") !== ordering) remarks.push(`Ordering Clinician mismatch: XLSX=${row["Ordering Clinician"] || ""}`);
  if ((row["Performing Clinician"] || "") !== clinician) remarks.push(`Clinician mismatch: XLSX=${row["Performing Clinician"] || ""}`);
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
 * Logs invalid XLSX rows with all comparison data to console for debugging
 * @param {Object} xlsRow - The XLSX data row object
 * @param {Object} context - The XML context data used for comparison
 * @param {Array<string>} remarks - The mismatch remarks from validation
 */
function logInvalidRow(xlsRow, context, remarks) {
  if (remarks.length > 0) {
    console.group(`Validation errors for AuthorizationID: ${context.authID}, Item Code: ${context.code}`);
    console.log("XLSX Row Data:", xlsRow);
    console.log("XML Context Data:", context);
    console.log("Remarks:", remarks);
    console.groupEnd();
  }
}

/**
 * Validates an individual Activity element against XLSX data and rules
 * @param {Element} activity - XML Activity element
 * @param {Object} xlsxMap - XLSX data mapped by AuthorizationID
 * @param {string} memberId - Member ID from XML claim
 * @param {Object} authRules - Authorization rules
 * @returns {Object} Validation result with remarks
 */
function validateActivity(activity, xlsxMap, memberId, authRules) {
  const id = getText(activity, "ID");
  const code = getText(activity, "Code");
  const rule = authRules[code];
  const description = rule?.description || "";
  const start = getText(activity, "Start");
  const qty = getText(activity, "Quantity");
  const netTotal = getText(activity, "Net"); // Use "Net" from XML (not NetTotal, corrected)
  const ordering = getText(activity, "OrderingClinician");
  const authID = getText(activity, "PriorAuthorizationID") || getText(activity, "PriorAuthorization");

  let remarks = [];

  // Check if authorization is required for this code
  const authRequired = !!(rule && rule.authRequired);

  if (!authID) {
    if (authRequired) {
      remarks.push("Missing AuthorizationID for code requiring auth");
    }
  } else {
    const rows = xlsxMap[authID] || [];
    if (!rows.length) {
      remarks.push(`AuthID ${authID} not in XLSX data`);
    } else {
      // Find matching XLSX row by AuthorizationID and Item Code
      const xlsRow = rows.find(r => (r.AuthorizationID || "") === authID && (r["Item Code"] || "") === code);
      if (!xlsRow) {
        remarks.push("No matching XLSX row for code/AuthID");
      } else {
        const context = { memberId, code, qty, netTotal, ordering, authID };
        
        // Validate XLSX row against XML context
        const remarksFromMatch = validateXLSXMatch(xlsRow, context);
        // Log all invalid rows with full data if any mismatch
        logInvalidRow(xlsRow, context, remarksFromMatch);
        remarks = remarks.concat(remarksFromMatch);

        // Also validate date and status
        const remarksFromDate = validateDateAndStatus(xlsRow, start);
        remarks = remarks.concat(remarksFromDate);

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
      td.textContent = val;
      tr.appendChild(td);
    });

    // Qty, Net Total, Ordering Clinician, Auth ID, Start Date
    [r.qty, r.netTotal, r.ordering, r.authID, r.start].forEach(val => {
      const td = document.createElement("td");
      td.textContent = val;
      tr.appendChild(td);
    });

    // Ordered On, Status, Denial Code, Denial Reason
    const xls = r.xlsRow || {};
    ["Ordered On", "Status", "Denial Code (if any)", "Denial Reason (if any)"].forEach(field => {
      const td = document.createElement("td");
      td.textContent = xls[field] || "";
      tr.appendChild(td);
    });

    // Remarks
    const remarksTd = document.createElement("td");
    remarksTd.innerHTML = r.remarks.map(msg => `<div>${msg}</div>`).join("");
    tr.appendChild(remarksTd);

    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  container.appendChild(table);
}

// === MAIN PROCESSING ===

async function handleRun() {
  if (!parsedXmlDoc || !parsedXlsxData) {
    showFileStatus('Please upload both XML and XLSX files.', 'error');
    return;
  }
  try {
    showFileStatus('Processing files...', 'info');
    await loadAuthRules();
    const results = validateClaims(parsedXmlDoc, parsedXlsxData, authRules);
    renderResults(results);
    showFileStatus('Processing complete!', 'success');
  } catch (err) {
    showFileStatus(`Error: ${err.message || err}`, 'error');
    console.error("Processing error:", err);
  }
}


// === EVENT LISTENERS ===

document.addEventListener('DOMContentLoaded', function() {
  // Main processing button (optional, still supported)
  const processBtn = document.getElementById('processBtn');
  if (processBtn) {
    processBtn.addEventListener('click', handleRun);
  }

  ["xmlInput", "xlsxInput"].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener("change", async (event) => {
        const file = event.target.files[0];
        if (!file) return;
  
        if (id === "xmlInput") {
          currentXmlFile = file;
          xmlClaimCount = -1;
          showFileStatus(`XML file selected: ${file.name}`, 'info');
          // Parse just for claim count
          try {
            parsedXmlDoc = await parseXMLFile(currentXmlFile);
          } catch (e) { parsedXmlDoc = null; }
        } else if (id === "xlsxInput") {
          currentXlsxFile = file;
          xlsxAuthCount = -1;
          showFileStatus(`XLSX file selected: ${file.name}`, 'info');
          // Parse just for auth count
          try {
            parsedXlsxData = await parseXLSXFile(currentXlsxFile);
          } catch (e) { parsedXlsxData = null; }
        }
        updateStatus();
      });
    }
  });
});
