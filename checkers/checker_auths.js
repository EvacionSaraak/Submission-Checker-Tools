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
  const xlsDateStr = (row["Ordered On"] || "").split(' ')[0];
  const xmlDateStr = (start || "").split(' ')[0];

  const [dx, mx, yx] = xlsDateStr.split('/').map(Number);
  const [di, mi, yi] = xmlDateStr.split('/').map(Number);
  const xlsDate = isNaN(dx) ? null : new Date(yx, mx - 1, dx);
  const xmlDate = isNaN(di) ? null : new Date(yi, mi - 1, di);

  if (!xlsDate) remarks.push("Invalid XLSX Ordered On date");
  if (!xmlDate) remarks.push("Invalid XML Start date");
  if (xlsDate && xmlDate && xlsDate > xmlDate) remarks.push("Approval must be on or before procedure date");
  const status = (row.Status || row.status || "").toLowerCase();
  
  if (!status.includes("approved") && !status.includes("rejected")) remarks.push("Status not approved");
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
  const needsAuth= !/NOT\s+REQUIRED/i.test(rule.approval_details || "");

  if (!needsAuth && !authID) {
    return {
      claimId,
      memberId,
      id,
      code,
      description: rule.description || "",
      netTotal,
      qty,
      ordering,
      authID,
      start,
      xlsRow: {},
      denialCode: "",
      denialReason: "",
      remarks: []
    };
  }

  if (parseFloat(netTotal || "0") === 0) {
    return {
      claimId,
      memberId,
      id,
      code,
      description: rule.description || "",
      netTotal,
      qty,
      ordering,
      authID,
      start,
      xlsRow: {},
      denialCode: "",
      denialReason: "",
      remarks: []
    };
  }

  const rows = xlsxMap[authID] || [];
  const matchedRow = rows.find(r =>
    String(r["Item Code"] || "").trim() === code &&
    String(r["Card Number / DHA Member ID"] || "").trim() === memberId
  ) || {};

  const denialCode   = matchedRow["Denial Code (If any)"]   || "";
  const denialReason = matchedRow["Denial Reason (If any)"] || "";

  const remarks = [];

  if (matchedRow.AuthorizationID && (matchedRow.Status || matchedRow.status || "").toLowerCase().includes("rejected")) {
    // we have denialCode/denialReason columns for details
    remarks.push("Has authID but status is rejected");
  }

  if (!matchedRow.AuthorizationID) {
    remarks.push("No matching authorization row found in XLSX.");
  } else {
    ["Item Code", "Card Number / DHA Member ID", "Ordering Clinician", "Payer Share"].forEach(field => {
      const v = String(matchedRow[field] || "");
      if (v !== v.trim()) {
        remarks.push(`Extra whitespace in field: "${field}"`);
      }
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
    claimId,
    memberId,
    id,
    code,
    description: rule.description || "",
    netTotal,
    qty,
    ordering,
    authID,
    start,
    xlsRow: matchedRow,
    denialCode,
    denialReason,
    remarks
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

  // Claim ID (hide repeats)
  const cid = document.createElement("td");
  cid.textContent = (r.claimId === lastClaimId) ? "" : r.claimId;
  tr.appendChild(cid);

  // XML fields
  [r.memberId, r.id, r.code, r.description].forEach(val => {
    const td = document.createElement("td");
    td.textContent = val || "";
    tr.appendChild(td);
  });

  // Net Total
  const netTd = document.createElement("td");
  netTd.textContent = r.netTotal || "";
  tr.appendChild(netTd);

  // Payer Share
  const payerTd = document.createElement("td");
  payerTd.textContent = xls["Payer Share"] || "";
  tr.appendChild(payerTd);

  // Ordering Clinician, Auth ID
  [r.ordering, r.authID].forEach(val => {
    const td = document.createElement("td");
    td.textContent = val || "";
    tr.appendChild(td);
  });

  // Start Date (discard time)
  const startDateTd = document.createElement("td");
  startDateTd.textContent = r.start.split(' ')[0] || "";
  tr.appendChild(startDateTd);

  // Ordered On date (discard time)
  const orderedOnTd = document.createElement("td");
  orderedOnTd.textContent = (xls["Ordered On"] || "").split(' ')[0];
  tr.appendChild(orderedOnTd);

  // Status
  const statusTd = document.createElement("td");
  statusTd.textContent = xls["Status"] || xls.status || "";
  tr.appendChild(statusTd);

  // Denial Code / Reason
  const dc = document.createElement("td");
  dc.textContent = r.denialCode;
  tr.appendChild(dc);
  const dr = document.createElement("td");
  dr.textContent = r.denialReason;
  tr.appendChild(dr);

  // Remarks
  const remarksTd = document.createElement("td");
  remarksTd.innerHTML = (r.remarks || []).map(m => `<div>${m}</div>`).join("");
  tr.appendChild(remarksTd);

  return tr;
}

// === MAIN PROCESSING ===
// After renderResults, add this helper to wire up export and summary:
function postProcessResults(results) {
  const container = document.getElementById("results-container");
  container.innerHTML = "";

  const total = results.length;
  const invalidEntries = results.filter(r => r.remarks.length > 0);
  const invalidCount = invalidEntries.length;
  const validCount   = total - invalidCount;
  const pctValid     = total ? ((validCount / total) * 100).toFixed(1) : "0.0";

  // 1) Show summary
  const summary = document.createElement("div");
  summary.textContent = `Valid: ${validCount} / ${total} (${pctValid}% valid)`;
  container.appendChild(summary);

  // 2) If any invalid, show export button
  if (invalidCount > 0) {
    const btn = document.createElement("button");
    btn.textContent = `Export ${invalidCount} Invalid Entries`;
    btn.id = "exportInvalidBtn";
    btn.className = "btn btn-sm btn-outline-danger mt-2";
    container.appendChild(btn);

    btn.addEventListener("click", () => {
      // Build array of objects matching your table headers
      const headers = [
        "Claim ID","Member ID","Activity ID","Code","Description","Net Total",
        "Payer Share","Ordering Clinician","Auth ID","Start Date",
        "Ordered On","Status","Denial Code","Denial Reason","Remarks"
      ];

      const data = invalidEntries.map(r => {
        const x = r.xlsRow || {};
        return {
          "Claim ID": r.claimId,
          "Member ID": r.memberId,
          "Activity ID": r.id,
          "Code": r.code,
          "Description": r.description,
          "Net Total": r.netTotal,
          "Payer Share": x["Payer Share"] || "",
          "Ordering Clinician": r.ordering,
          "Auth ID": r.authID,
          "Start Date": r.start,
          "Ordered On": x["Ordered On"] || "",
          "Status": x["Status"] || x.status || "",
          "Denial Code": x["Denial Code (if any)"] || "",
          "Denial Reason": x["Denial Reason (if any)"] || "",
          "Remarks": r.remarks.join("; ")
        };
      });

      // Use SheetJS to export
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.json_to_sheet(data, { header: headers });
      XLSX.utils.book_append_sheet(wb, ws, "InvalidEntries");
      XLSX.writeFile(wb, `invalid_entries_${Date.now()}.xlsx`);
    });
  }
}

// Finally, modify your handleRun() to call postProcessResults after renderResults:
async function handleRun() {
  try {
    await loadAuthRules();
    const results = validateClaims(parsedXmlDoc, parsedXlsxData, authRules);
    renderResults(results);
    postProcessResults(results);
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
