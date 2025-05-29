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

function validateApprovalRequirement(code, authID) {
  const remarks = [];
  const rule = authRules[code] || {};
  const needsAuth = !/NOT\s+REQUIRED/i.test(rule.approval_details || "");
  if (needsAuth) {
    if (!authID) remarks.push("Missing required AuthorizationID");
  } else {
    if (authID) remarks.push("AuthorizationID provided but not required");
  }
  return remarks;
}

function validateXLSXMatch(row, { memberId, code, qty, netTotal, ordering, authID }) {
  const remarks = [];
  if ((row["Card Number / DHA Member ID"] || "").trim() !== memberId.trim()) remarks.push(`MemberID mismatch: XLSX=${row["Card Number / DHA Member ID"]}`);
  if ((row["Item Code"] || "").trim() !== code.trim()) remarks.push(`Item Code mismatch: XLSX=${row["Item Code"]}`);

  // Compute expected total = xml netTotal * qty
  const unitNet = parseFloat(netTotal || "0");
  const quantity = parseFloat(qty || "0");
  const expectedTotal = (unitNet * quantity).toFixed(2);
  const xlsxPayerShare = parseFloat(row["Payer Share"] || "0").toFixed(2);
  if (expectedTotal !== xlsxPayerShare)
    remarks.push(
      `Total mismatch: expected ${expectedTotal} ` +
      `(net ${unitNet} × qty ${quantity}), ` +
      `XLSX Payer Share=${row["Payer Share"]}`
    );
  
  const xOrdering = (row["Ordering Clinician"] || "").trim().toUpperCase();
  if (xOrdering !== (ordering || "").trim().toUpperCase()) remarks.push(`Ordering Clinician mismatch: XLSX=${row["Ordering Clinician"]}`);
  if ((row.AuthorizationID || "").trim() !== authID.trim()) remarks.push(`AuthorizationID mismatch: XLSX=${row.AuthorizationID}`);
  return remarks;
}

function validateDateAndStatus(row, start) {
  const remarks = [];

  // Parse XLSX Ordered On date and time (ignore seconds)
  const [xlsDatePart, xlsTimePart = ""] = (row["Ordered On"] || "").split(' ');
  const [dx, mx, yx] = xlsDatePart.split('/');
  const [hx, minx] = xlsTimePart.split(':') || [];
  const xlsDate = new Date(`${yx}-${mx.padStart(2,'0')}-${dx.padStart(2,'0')}T${(hx||"00").padStart(2,'0')}:${(minx||"00").padStart(2,'0')}`);

  // Parse XML Start date and time (ignore seconds)
  const [xmlDatePart, xmlTimePart = ""] = (start || "").split(' ');
  const [di, mi, yi] = xmlDatePart.split('/');
  const [hi, mini] = xmlTimePart.split(':') || [];
  const xmlDate = new Date(`${yi}-${mi.padStart(2,'0')}-${di.padStart(2,'0')}T${(hi||"00").padStart(2,'0')}:${(mini||"00").padStart(2,'0')}`);

  if (isNaN(xlsDate))      remarks.push("Invalid XLSX Ordered On date/time");
  if (isNaN(xmlDate))      remarks.push("Invalid XML Start date/time");
  if (!isNaN(xlsDate) && !isNaN(xmlDate) && xlsDate >= xmlDate)
    remarks.push("Procedure was done before Approval Ordering date. Please check Effective Date on OpenJet.");

  const status = (row.status || row.Status || "").toLowerCase();
  if (!status.includes("approved")) {
    if (status.includes("rejected")) {
      remarks.push(
        `Rejected: Code=${row["Denial Code (if any)"]||'N/A'} ` +
        `Reason=${row["Denial Reason (if any)"]||'N/A'}`
      );
    } else {
      remarks.push("Status not approved");
    }
  }

  return remarks;
}


function logInvalidRow(xlsRow, context, remarks) {
  if (remarks.length) {
    console.group(`Validation errors for AuthorizationID: ${context.authID}, Code: ${context.code}`);
    console.log("XLSX Row Data:", xlsRow);
    console.log("XML Context Data:", context);
    console.log("Remarks:", remarks);
    console.groupEnd();
  }
}

function validateActivity(activityEl, xlsxMap, claimId, memberId) {
  const id       = getText(activityEl, "ID");
  const code     = getText(activityEl, "Code");
  const start    = getText(activityEl, "Start");
  const netTotal = getText(activityEl, "Net") || getText(activityEl, "NetTotal");
  const qty      = getText(activityEl, "Quantity") || "1";
  const ordering = getText(activityEl, "OrderingClinician");
  const authID   = getText(activityEl, "PriorAuthorizationID") || getText(activityEl, "PriorAuthorization");
  const rule     = authRules[code] || {};
  const needsAuth = !/NOT\s+REQUIRED/i.test(rule.approval_details || "");

  if (!needsAuth && !authID) {
    return { claimId, memberId, id, code,
      description: rule.description||"",
      netTotal, qty, ordering, authID, start,
      xlsRow:{}, remarks:[] };
  }

  if (parseFloat(netTotal || "0") === 0) {
    return { claimId, memberId, id, code,
      description: rule.description||"",
      netTotal, qty, ordering, authID, start,
      xlsRow:{}, remarks:[] };
  }

  const rows = xlsxMap[authID] || [];
  const matchedRow = rows.find(r =>
    String(r["Item Code"]||"").trim() === code &&
    String(r["Card Number / DHA Member ID"]||"").trim() === memberId
  ) || null;

  const remarks = [];

  if (matchedRow && authID) {
    const status = (matchedRow["Status"]||matchedRow.status||"").toLowerCase();
    if (status.includes("rejected"))
      remarks.push("Activity has AuthorizationID but status is rejected");
  }

  if (!matchedRow) {
    remarks.push("No matching authorization row found in XLSX.");
  } else {
    ["Item Code","Card Number / DHA Member ID","Ordering Clinician","Payer Share"].forEach(f => {
      const v = String(matchedRow[f]||"");
      if (v !== v.trim())
        remarks.push(`Extra whitespace in field: "${f}"`);
    });

    const context = { memberId, code, qty, netTotal, ordering, authID };
    remarks.push(...validateXLSXMatch(matchedRow, context));
    remarks.push(...validateDateAndStatus(matchedRow, start));
  }

  if (remarks.length) {
    console.group(`Errors for AuthID=${authID}, Code=${code}`);
    console.log("Activity:", { claimId, memberId, id, code, netTotal, qty, ordering, authID, start });
    console.log("XLSX row:", matchedRow);
    console.log("Remarks:", remarks);
    console.groupEnd();
  }

  return {
    claimId, memberId, id, code,
    description: rule.description||"",
    netTotal, qty, ordering, authID, start,
    xlsRow: matchedRow||{}, remarks
  };
}

function validateClaims(xmlDoc, xlsxData) {
  const xlsxMap = mapXLSXData(xlsxData);
  const results = [];
  const claims = Array.from(xmlDoc.getElementsByTagName("Claim"));

  claims.forEach(claimEl => {
    const cid = getText(claimEl, "ID");
    const mid = getText(claimEl, "MemberID");
    const acts = Array.from(claimEl.getElementsByTagName("Activity"));
    acts.forEach(a => results.push(validateActivity(a, xlsxMap, cid, mid)));
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
      <th>Net Total</th>
      <th>Payer Share</th>
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

  results.forEach(result => {
    const row = renderRow(result, lastClaim);
    lastClaim = result.claimId;
    tbody.appendChild(row);
  });

  table.appendChild(tbody);
  container.appendChild(table);
}

function renderRow(r, lastClaimId) {
  const tr = document.createElement("tr");
  tr.className = r.remarks.length ? 'invalid' : 'valid';

  const xls = r.xlsRow || {};

  // Claim ID
  const claimCell = document.createElement("td");
  claimCell.textContent = (r.claimId === lastClaimId) ? "" : (r.claimId || "");
  tr.appendChild(claimCell);

  // Static XML fields with fallback
  [r.memberId, r.id, r.code, r.description].forEach(val => {
    const td = document.createElement("td");
    td.textContent = val ?? "";  // fallback to empty string
    tr.appendChild(td);
  });

  // Net Total
  const netTotalTd = document.createElement("td");
  netTotalTd.textContent = r.netTotal ?? "";
  tr.appendChild(netTotalTd);

  // Payer Share
  const payerShareTd = document.createElement("td");
  payerShareTd.textContent = xls["Payer Share"] ?? "";
  tr.appendChild(payerShareTd);

  // Ordering Clinician, Auth ID, Start Date
  [r.ordering, r.authID, r.start].forEach(val => {
    const td = document.createElement("td");
    td.textContent = val ?? "";
    tr.appendChild(td);
  });

  // XLSX fields (ordered on, status, denial code, denial reason)
  ["Ordered On", "Status", "Denial Code (if any)", "Denial Reason (if any)"].forEach(field => {
    const td = document.createElement("td");
    td.textContent = xls[field] ?? "";
    tr.appendChild(td);
  });

  // Remarks
  const remarksTd = document.createElement("td");
  remarksTd.innerHTML = (r.remarks || []).map(msg => `<div>${msg}</div>`).join("");
  tr.appendChild(remarksTd);

  return tr;
}


// === MAIN PROCESSING ===

async function handleRun() {
  try {
    await loadAuthRules();
    const results = validateClaims(parsedXmlDoc, parsedXlsxData, authRules);
    renderResults(results);
  } catch (err) {
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
          // Parse just for claim count
          try {
            parsedXmlDoc = await parseXMLFile(currentXmlFile);
          } catch (e) { parsedXmlDoc = null; }
        } else if (id === "xlsxInput") {
          currentXlsxFile = file;
          xlsxAuthCount = -1;
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
