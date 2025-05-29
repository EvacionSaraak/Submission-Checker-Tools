// checker_auths.js

// === GLOBAL STATE ===
let authRules = {};
let authRulesPromise = null;

// === UTILITIES ===
/**
 * Safe text getter for XML elements
 */
function getText(parent, tag) {
  const el = parent.querySelector(tag);
  return el && el.textContent ? el.textContent.trim() : "";
}

// === LOADERS ===
/**
 * Load and cache checker_auths.json into authRules map
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
 * Parse XML file into XML Document
 */
function parseXMLFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      const doc = new DOMParser().parseFromString(e.target.result, "application/xml");
      const err = doc.querySelector("parsererror");
      err ? reject("Invalid XML file") : resolve(doc);
    };
    reader.onerror = () => reject("Failed to read XML file");
    reader.readAsText(file);
  });
}

/**
 * Parse XLSX file and return JSON of HCPRequests sheet
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
        resolve(XLSX.utils.sheet_to_json(sheet, { defval: "" }));
      } catch {
        reject("Invalid XLSX file");
      }
    };
    reader.onerror = () => reject("Failed to read XLSX file");
    reader.readAsArrayBuffer(file);
  });
}

// === DATA TRANSFORM ===
/**
 * Build map of XLSX rows keyed by AuthorizationID
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
 * Approval requirement based on JSON policy
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
 * Exact field matching against XLSX row
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
  return remarks;
}

/**
 * Date and status validation
 */
function validateDateAndStatus(row, start) {
  const remarks = [];
  const xlsDate = row["Ordered On"] instanceof Date ? row["Ordered On"] : new Date(row["Ordered On"]);
  const xmlDate = new Date(start);
  if (!(xlsDate instanceof Date) || isNaN(xlsDate)) remarks.push("Invalid XLSX Ordered On date");
  if (!(xmlDate instanceof Date) || isNaN(xmlDate)) remarks.push("Invalid XML Start date");
  if (xlsDate >= xmlDate) remarks.push("Ordered On date must be before Activity Start date");
  const status = (row.status || "").toLowerCase();
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
 * Validate a single <Activity> element
 */
function validateActivity(activity, xlsxMap, memberId) {
  const id = getText(activity, "ID");
  const code = getText(activity, "Code");
  const description = authRules[code]?.description || "";
  const start = getText(activity, "Start");
  const qty = getText(activity, "Quantity");
  const netTotal = getText(activity, "NetTotal");
  const ordering = getText(activity, "OrderingClinician");
  const authID = getText(activity, "PriorAuthorizationID") || getText(activity, "PriorAuthorization");

  let remarks = validateApprovalRequirement(code, authID);
  let xlsRow = null;

  if (authID) {
    const rows = xlsxMap[authID] || [];
    if (!rows.length) {
      remarks.push(`AuthID ${authID} not in HCPRequests sheet`);
    } else {
      xlsRow = rows.find(r => (r.AuthorizationID || "") === authID && (r["Item Code"] || "") === code);
      if (!xlsRow) {
        remarks.push("No matching row for code/AuthID in XLSX");
      } else {
        const context = { memberId, code, qty, netTotal, ordering, authID };
        remarks = remarks.concat(validateXLSXMatch(xlsRow, context));
        remarks = remarks.concat(validateDateAndStatus(xlsRow, start));
      }
    }
  }

  return { id, code, description, start, qty, netTotal, ordering, authID, xlsRow, remarks };
}

/**
 * Iterate through all Claims and Activities
 */
function validateClaims(xmlDoc, xlsxData) {
  const results = [];
  const xlsxMap = mapXLSXData(xlsxData);
  const claims = Array.from(xmlDoc.getElementsByTagName("Claim"));

  claims.forEach(claim => {
    const claimId = getText(claim, "ID");
    const memberId = getText(claim, "MemberID");
    const activities = Array.from(claim.getElementsByTagName("Activity"));

    activities.forEach(activity => {
      const rec = validateActivity(activity, xlsxMap, memberId);
      results.push({ claimId, memberId, ...rec });
    });
  });

  return results;
}

// === RENDERER ===
/**
 * Render results table in #results (blanks repeated Claim IDs)
 * Applies classes from tables.css for valid/invalid rows
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

  // Header row
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
    // apply valid/invalid class
    tr.className = r.remarks.length ? 'invalid' : 'valid';

    // Claim cell
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
}

// === MAIN ENTRY ===
async function handleRun() {
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
    const results = validateClaims(xmlDoc, xlsxData);
    renderResults(results);
  } catch (err) {
    resultsDiv.textContent = `Error: ${err}`;
  }
}

document.getElementById("runButton").addEventListener("click", handleRun);
