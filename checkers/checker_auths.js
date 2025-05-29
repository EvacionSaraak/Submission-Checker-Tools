// checker_auths.js

// === GLOBAL STATE ===
// Stores the authorization rules loaded from checker_auths.json
let authRules = {};
// Promise to avoid fetching rules multiple times
let authRulesPromise = null;
// Counts for loaded claims and auths, used for status display and validation gating
let xmlClaimCount = 0;
let xlsxAuthCount = 0;

console.log("[checker_auths.js] Script loaded and global state initialized");

// === UTILITIES ===

/**
 * Utility: Safely retrieves trimmed text content from a named child element of an XML parent.
 * @param {Element} parent - XML parent element
 * @param {string} tag - Tag name to search for
 * @returns {string}
 */
function getText(parent, tag) {
  const el = parent.querySelector(tag);
  return el && el.textContent ? el.textContent.trim() : "";
}

// UI Utility: Updates the status message and run button state based on loaded claim/auth counts
function updateStatus() {
  const resultsDiv = document.getElementById("results");
  let messages = [];
  if (xmlClaimCount > 0) messages.push(`${xmlClaimCount} Claims Loaded`);
  if (xlsxAuthCount > 0) messages.push(`${xlsxAuthCount} Auths Loaded`);
  if (resultsDiv) resultsDiv.textContent = messages.join(" | ");
  const processBtn = document.getElementById("processBtn");
  if (processBtn) processBtn.disabled = !(xmlClaimCount && xlsxAuthCount);
}

// === LOADERS ===

/**
 * Loads checker_auths.json and builds a map of rules by code.
 * Caches the result to avoid duplicate fetches.
 * @param {string} url
 * @returns {Promise<void>}
 */
function loadAuthRules(url = "checker_auths.json") {
  if (!authRulesPromise) {
    console.log("[loadAuthRules] Fetching rules from:", url);
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
        console.log("[loadAuthRules] Rules loaded:", Object.keys(authRules).length, "codes");
      });
  }
  return authRulesPromise;
}

// === PARSERS ===

/**
 * Reads an XML file and parses it to a DOM Document.
 * Also updates xmlClaimCount and status.
 * @param {File} file
 * @returns {Promise<Document>}
 */
function parseXMLFile(file) {
  console.log("[parseXMLFile] Reading XML file:", file.name);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      const doc = new DOMParser().parseFromString(e.target.result, "application/xml");
      const err = doc.querySelector("parsererror");
      if (err) {
        console.error("[parseXMLFile] Invalid XML file");
        xmlClaimCount = 0;
        updateStatus();
        return reject("Invalid XML file");
      }
      const claims = doc.querySelectorAll("Claim");
      xmlClaimCount = claims.length;
      console.log("[parseXMLFile] Parsed XML, claim count:", xmlClaimCount);
      updateStatus();
      resolve(doc);
    };
    reader.onerror = () => {
      console.error("[parseXMLFile] Failed to read XML file");
      xmlClaimCount = 0;
      updateStatus();
      reject("Failed to read XML file");
    };
    reader.readAsText(file);
  });
}

/**
 * Reads an XLSX file and parses it into an array of JSON rows from the HCPRequests sheet.
 * Also updates xlsxAuthCount and status.
 * @param {File} file
 * @returns {Promise<Array>}
 */
function parseXLSXFile(file) {
  console.log("[parseXLSXFile] Reading XLSX file:", file.name);
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
        console.log("[parseXLSXFile] Parsed XLSX, auth count:", xlsxAuthCount, "sheet:", sheetName);
        updateStatus();
        resolve(rows);
      } catch (err) {
        console.error("[parseXLSXFile] Invalid XLSX file:", err);
        xlsxAuthCount = 0;
        updateStatus();
        reject("Invalid XLSX file");
      }
    };
    reader.onerror = () => {
      console.error("[parseXLSXFile] Failed to read XLSX file");
      xlsxAuthCount = 0;
      updateStatus();
      reject("Failed to read XLSX file");
    };
    reader.readAsArrayBuffer(file);
  });
}

// === DATA TRANSFORM ===

/**
 * Maps rows from XLSX by AuthorizationID for fast lookup.
 * @param {Array} rows
 * @returns {Object}
 */
function mapXLSXData(rows) {
  console.log("[mapXLSXData] Mapping XLSX data by AuthorizationID");
  return rows.reduce((map, row) => {
    const id = row.AuthorizationID || "";
    map[id] = map[id] || [];
    map[id].push(row);
    return map;
  }, {});
}

// === VALIDATORS ===

/**
 * Checks if a code requires approval and if so, whether an AuthorizationID is present.
 * @param {string} code
 * @param {string} authID
 * @returns {Array<string>} remarks
 */
function validateApprovalRequirement(code, authID) {
  const remarks = [];
  const rule = authRules[code];
  if (!rule) {
    remarks.push("Code not found in checker_auths.json");
    console.warn("[validateApprovalRequirement] Code not found:", code);
    return remarks;
  }
  const needsAuth = !/NOT\s+REQUIRED/i.test(rule.approval_details || "");
  if (needsAuth) {
    if (!authID) remarks.push("Missing required AuthorizationID");
  } else {
    remarks.push("No authorization required for this code");
    if (authID) remarks.push("AuthorizationID provided but not required");
  }
  console.log("[validateApprovalRequirement] code:", code, "authID:", authID, "remarks:", remarks);
  return remarks;
}

/**
 * Checks that all fields in the activity context match the corresponding XLSX row fields.
 * @param {Object} row - XLSX data row
 * @param {Object} context - Activity context
 * @returns {Array<string>} remarks
 */
function validateXLSXMatch(row, { memberId, code, qty, netTotal, ordering, authID }) {
  const remarks = [];
  if ((row["Card Number / DHA Member ID"] || "") !== memberId)
    remarks.push(`MemberID mismatch: XLSX=${row["Card Number / DHA Member ID"] || ""}`);
  if ((row["Item Code"] || "") !== code)
    remarks.push(`Item Code mismatch: XLSX=${row["Item Code"] || ""}`);
  if (String(row["Item Amount"] || "") !== qty)
    remarks.push(`Qty mismatch: XLSX=${row["Item Amount"] || ""}`);
  if (String(row["Payer Share"] || "") !== netTotal)
    remarks.push(`Payer Share mismatch: XLSX=${row["Payer Share"] || ""}`);
  if ((row["Ordering Clinician"] || "") !== ordering)
    remarks.push(`Ordering Clinician mismatch: XLSX=${row["Ordering Clinician"] || ""}`);
  if ((row.AuthorizationID || "") !== authID)
    remarks.push(`AuthorizationID mismatch: XLSX=${row.AuthorizationID || ""}`);
  console.log("[validateXLSXMatch] context:", context, "remarks:", remarks);
  return remarks;
}

/**
 * Checks date consistency and approval status between XML and XLSX data.
 * @param {Object} row - XLSX data row
 * @param {string} start - XML Activity Start date
 * @returns {Array<string>} remarks
 */
function validateDateAndStatus(row, start) {
  const remarks = [];
  // Extract date only (ignore time)
  const xlsDateStr = (row["Ordered On"] || "").split(' ')[0];
  const xmlDateStr = (start || "").split(' ')[0];
  const xlsParts = xlsDateStr.split('/'); // dd/MM/yyyy
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
  console.log("[validateDateAndStatus] Ordered On:", xlsDateStr, "Start:", xmlDateStr, "remarks:", remarks);
  return remarks;
}

/**
 * Validates an individual Activity element against rules and XLSX data.
 * @param {Element} activity - XML Activity DOM element
 * @param {Object} xlsxMap - Map of XLSX rows by AuthorizationID
 * @param {string} memberId - Current claim's member ID
 * @param {Object} authRules - Map of rules by code (pass in global authRules)
 * @returns {Object}
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
    // else: valid, do not add remarks
  } else {
    const rows = xlsxMap[authID] || [];
    if (!rows.length) {
      remarks.push(`AuthID ${authID} not in HCPRequests sheet`);
      console.warn("[validateActivity] No rows in XLSX for authID:", authID);
    } else {
      const xlsRow = rows.find(r => (r.AuthorizationID || "") === authID && (r["Item Code"] || "") === code);
      if (!xlsRow) {
        remarks.push("No matching row for code/AuthID in XLSX");
        console.warn("[validateActivity] No matching XLSX row for authID/code:", authID, code);
      } else {
        const context = { memberId, code, qty, netTotal, ordering, authID };
        remarks = remarks.concat(validateXLSXMatch(xlsRow, context));
        remarks = remarks.concat(validateDateAndStatus(xlsRow, start));
        return { id, code, description, start, qty, netTotal, ordering, authID, xlsRow, remarks };
      }
    }
  }

  // Always return, even if no authID or xlsRow
  return { id, code, description, start, qty, netTotal, ordering, authID, xlsRow: null, remarks };
}
/**
 * Iterates through all claims and activities, running validation and collecting results.
 * @param {Document} xmlDoc - Parsed XML DOM
 * @param {Array} xlsxData - XLSX data rows
 * @param {Object} authRules - Map of rules by code
 * @returns {Array<Object>}
 */
function validateClaims(xmlDoc, xlsxData, authRules) {
  console.log("[validateClaims] Starting validation...");
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

  console.log("[validateClaims] Validation complete. Total results:", results.length);
  return results;
}

// === RENDERER ===

/**
 * Renders the validation results as a table in the page.
 * Applies CSS classes for valid/invalid rows.
 * @param {Array} results
 */
function renderResults(results) {
  const container = document.getElementById("results");
  container.innerHTML = "";

  if (!results.length) {
    container.textContent = "✅ No activities to validate.";
    console.log("[renderResults] No validation results to render.");
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

    // Claim cell (blank for repeated claimId)
    const claimCell = document.createElement("td");
    claimCell.textContent = r.claimId === lastClaim ? "" : r.claimId;
    lastClaim = r.claimId;
    tr.appendChild(claimCell);

    // Member, Activity, Code, Description
    [r.memberId, r.id, r.code, r.description]
      .forEach(val => { const td = document.createElement("td"); td.textContent = val || ""; tr.appendChild(td); });

    // Qty, Net Total, Ordering, Auth, Start
    [r.qty, r.netTotal, r.ordering, r.authID, r.start]
      .forEach(val => { const td = document.createElement("td"); td.textContent = val || ""; tr.appendChild(td); });

    // XLSX fields or placeholders
    if (r.xlsRow) {
      [r.xlsRow["Ordered On"], r.xlsRow.status,
       r.xlsRow["Denial Code (if any)"], r.xlsRow["Denial Reason (if any)"]]
        .forEach(val => { const td = document.createElement("td"); td.textContent = val || ""; tr.appendChild(td); });
    } else {
      for (let i = 0; i < 4; i++) tr.appendChild(document.createElement("td"));
    }

    // Remarks
    const remTd = document.createElement("td");
    remTd.innerHTML = r.remarks.map(m => `<div>${m}</div>`).join("");
    tr.appendChild(remTd);
    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  container.appendChild(table);
  console.log("[renderResults] Rendered results table with", results.length, "rows.");
}

// === MAIN ENTRY ===

/**
 * Main runner: Loads files, triggers validation, renders results, and manages state.
 */
async function handleRun() {
  // Reset counts and status for a new run
  xmlClaimCount = 0;
  xlsxAuthCount = 0;
  updateStatus();

  const xmlFile = document.getElementById("xmlInput").files[0];
  const xlsxFile = document.getElementById("xlsxInput").files[0];
  const resultsDiv = document.getElementById("results");

  if (!xmlFile || !xlsxFile) {
    resultsDiv.textContent = "Please upload both XML and XLSX files.";
    console.warn("[handleRun] Missing file(s)");
    return;
  }

  try {
    console.log("[handleRun] Starting process...");
    await loadAuthRules();
    const [xmlDoc, xlsxData] = await Promise.all([
      parseXMLFile(xmlFile),
      parseXLSXFile(xlsxFile)
    ]);
    const results = validateClaims(xmlDoc, xlsxData);
    renderResults(results);
    console.log("[handleRun] Process complete.");
  } catch (err) {
    resultsDiv.textContent = `Error: ${err}`;
    console.error("[handleRun] Error during processing:", err);
  }
}

// Attach main run handler to button
document.getElementById("runButton").addEventListener("click", handleRun);

// Optional: Reset counts and status when file inputs change
["xmlInput", "xlsxInput"].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener("change", () => {
    if (id === "xmlInput") xmlClaimCount = 0;
    if (id === "xlsxInput") xlsxAuthCount = 0;
    updateStatus();
    console.log("[input change] File input changed:", id);
  });
});

console.log("[checker_auths.js] All handlers attached.");
