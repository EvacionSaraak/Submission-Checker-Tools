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

// === GROUPED SUMS LOGIC ===

/**
 * Returns an array of grouped activity sums by code for a given claim's activities.
 * Each object has: code, sumNet, sumPayer, rows (activities), and formatting tags.
 */
function groupActivitiesByCode(activities) {
  const codeMap = {};
  activities.forEach((activity) => {
    const code = activity.code;
    if (!codeMap[code]) codeMap[code] = { code, sumNet: 0, sumPayer: 0, rows: [] };
    // Track original values for bracketed source
    const netVal = parseFloat(activity.netTotal || 0);
    const payerVal = parseFloat(activity.xlsRow?.["Payer Share"] || 0);
    codeMap[code].sumNet += netVal;
    codeMap[code].sumPayer += payerVal;
    codeMap[code].rows.push({
      activityID: activity.id,
      netTotal: netVal,
      payerShare: payerVal,
      netSource: "xml",
      payerSource: "xlsx"
    });
  });
  return Object.values(codeMap);
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
 * Renders validation results in a table with details modal
 * @param {Array} results - Validation results
 */
function renderResults(results) {
  const container = document.getElementById("results");
  container.innerHTML = "";

  if (!results.length) {
    container.textContent = "✅ No activities to validate.";
    return;
  }

  // Preprocess claimCodeSums ahead of rendering
  const claimCodeSums = preprocessClaimCodeSums(results);

  const table = document.createElement("table");
  table.innerHTML = `
  <thead>
    <tr>
      <th>Claim ID</th>
      <th>Member ID</th>
      <th>Activity ID</th>
      <th>Code</th>
      <th>Auth ID</th>
      <th class="description-col">Description</th>
      <th>Net Total</th>
      <th>Payer Share</th>
      <th>Status</th>
      <th>Remarks</th>
      <th>Details</th>
    </tr>
  </thead>`;

  const tbody = document.createElement("tbody");
  let lastClaim = null;

  results.forEach((result, idx) => {
    // Attach grouped info to result for this row for later use
    const codeGroup = claimCodeSums[result.claimId][result.code];
    const row = renderRow(result, lastClaim, idx, codeGroup);
    lastClaim = result.claimId;
    tbody.appendChild(row);
  });

  table.appendChild(tbody);
  container.appendChild(table);

  setupDetailsModal(results, claimCodeSums);
}

function renderRow(r, lastClaimId, idx, codeGroup) {
  const tr = document.createElement("tr");
  tr.className = r.remarks.length ? 'invalid' : 'valid';

  const xls = r.xlsRow || {};

  // Claim ID (hide repeats)
  const cid = document.createElement("td");
  cid.textContent = (r.claimId === lastClaimId) ? "" : r.claimId;
  cid.className = "nowrap-col";
  tr.appendChild(cid);

  // XML fields (memberId, id, code)
  [r.memberId, r.id, r.code].forEach(val => {
    const td = document.createElement("td");
    td.textContent = val || "";
    td.className = "nowrap-col";
    tr.appendChild(td);
  });

  // Auth ID (always visible)
  const authTd = document.createElement("td");
  authTd.textContent = r.authID || "";
  authTd.className = "nowrap-col";
  tr.appendChild(authTd);

  // Description (wrap allowed, class='description-col')
  const descTd = document.createElement("td");
  descTd.textContent = r.description || "";
  descTd.className = "description-col";
  tr.appendChild(descTd);

  // Net Total (as 2 decimals, with source)
  const netTd = document.createElement("td");
  netTd.textContent = (parseFloat(r.netTotal || 0)).toFixed(2) + " (xml)";
  netTd.className = "nowrap-col";
  tr.appendChild(netTd);

  // Payer Share (as 2 decimals, with source)
  const payerTd = document.createElement("td");
  payerTd.textContent = (parseFloat(xls["Payer Share"] || 0)).toFixed(2) + " (xlsx)";
  payerTd.className = "nowrap-col";
  tr.appendChild(payerTd);

  // Status
  const statusTd = document.createElement("td");
  statusTd.textContent = xls["Status"] || xls.status || "";
  statusTd.className = "nowrap-col";
  tr.appendChild(statusTd);

  // Remarks (summary only)
  const remarksTd = document.createElement("td");
  if (r.remarks && r.remarks.length) {
    remarksTd.innerHTML = `<div>${r.remarks[0]}${r.remarks.length > 1 ? " (+)" : ""}</div>`;
    remarksTd.title = r.remarks.join('\n');
  } else {
    remarksTd.textContent = "";
  }
  remarksTd.className = "wrap-col remarks-col";
  tr.appendChild(remarksTd);

  // Details button (opens modal)
  const detailsTd = document.createElement("td");
  const detailsBtn = document.createElement("button");
  detailsBtn.textContent = "View";
  detailsBtn.className = "details-btn";
  detailsBtn.setAttribute("data-result-idx", idx);
  detailsBtn.setAttribute("data-claim-id", r.claimId);
  detailsBtn.setAttribute("data-code", r.code);
  detailsBtn.style.padding = "2px 10px";
  detailsBtn.style.fontSize = "13px";
  detailsBtn.style.borderRadius = "4px";
  detailsBtn.style.border = "1px solid #bbb";
  detailsBtn.style.background = "#f6f8fa";
  detailsBtn.style.cursor = "pointer";
  detailsBtn.onmouseover = function() {
    this.style.background = "#eaeaea";
  };
  detailsBtn.onmouseout = function() {
    this.style.background = "#f6f8fa";
  };
  detailsTd.appendChild(detailsBtn);
  tr.appendChild(detailsTd);

  // Optionally, add a badge if this code is grouped in this claim
  if (codeGroup && codeGroup.activities.length > 1) {
    tr.setAttribute("data-grouped", "true");
    tr.style.fontWeight = "bold";
    tr.title = `Grouped: ${codeGroup.activities.length} activities for code ${r.code} in claim ${r.claimId}`;
  }

  return tr;
}

function setupDetailsModal(results, claimCodeSums) {
  let modal = document.getElementById("details-modal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "details-modal";
    modal.className = "modal";
    modal.innerHTML = `
      <div class="modal-content">
        <span class="close" tabindex="0" role="button" aria-label="Close">&times;</span>
        <div id="modal-body"></div>
      </div>
    `;
    document.body.appendChild(modal);
  }
  const modalBody = modal.querySelector("#modal-body");
  const closeBtn = modal.querySelector(".close");

  closeBtn.onclick = () => {
    modal.style.display = "none";
    modalBody.innerHTML = "";
  };
  closeBtn.onkeydown = (e) => {
    if (e.key === "Escape" || e.key === " " || e.key === "Enter") {
      modal.style.display = "none";
      modalBody.innerHTML = "";
    }
  };
  window.addEventListener("keydown", (event) => {
    if (modal.style.display === "block" && event.key === "Escape") {
      modal.style.display = "none";
      modalBody.innerHTML = "";
    }
  });
  window.onclick = event => {
    if (event.target === modal) {
      modal.style.display = "none";
      modalBody.innerHTML = "";
    }
  };

  document.querySelectorAll(".details-btn").forEach(btn => {
    btn.onclick = function() {
      const idx = parseInt(this.getAttribute("data-result-idx"), 10);
      const claimId = this.getAttribute("data-claim-id");
      const code = this.getAttribute("data-code");
      const r = results[idx];
      const xls = r.xlsRow || {};

      // Use the preprocessed claimCodeSums
      const codeGroup = claimCodeSums[claimId][code];

      modalBody.innerHTML = `
        <h3 style="margin-top:0;">Details for Claim ID: ${r.claimId}, Activity ID: ${r.id}</h3>
        <table class="modal-license-table">
          <tr><th>Ordering Clinician</th><td>${r.ordering || ""}</td></tr>
          <tr><th>Auth ID</th><td>${r.authID || ""}</td></tr>
          <tr><th>Start Date</th><td>${r.start ? r.start.split(' ')[0] : ""} <span style="color:#888;">(xml)</span></td></tr>
          <tr><th>Ordered On</th><td>${(xls["Ordered On"] || "").split(' ')[0]} <span style="color:#888;">(xlsx)</span></td></tr>
          <tr><th>Denial Code</th><td>${r.denialCode || ""}</td></tr>
          <tr><th>Denial Reason</th><td>${r.denialReason || ""}</td></tr>
          <tr><th>All Remarks</th><td>${(r.remarks || []).map(m => `<div>${m}</div>`).join("") || ""}</td></tr>
        </table>
        ${codeGroup && codeGroup.activities.length > 1 ? `
          <h4 style="margin-top:2em;">Grouped Calculation for Code <b>${codeGroup.activities[0].code}</b> (this claim)</h4>
          <table class="modal-license-table">
            <tr>
              <th>Activity ID</th>
              <th>Net Total</th>
              <th>Payer Share</th>
            </tr>
            ${codeGroup.activities.map(act => `
              <tr>
                <td>${act.id}</td>
                <td>${parseFloat(act.netTotal || 0).toFixed(2)} <span style="color:#888;">(xml)</span></td>
                <td>${parseFloat(act.xlsRow?.["Payer Share"] || 0).toFixed(2)} <span style="color:#888;">(xlsx)</span></td>
              </tr>
            `).join("")}
            <tr>
              <th>Total</th>
              <th>${codeGroup.sumNet.toFixed(2)} <span style="color:#888;">(xml)</span></th>
              <th>${codeGroup.sumPayer.toFixed(2)} <span style="color:#888;">(xlsx)</span></th>
            </tr>
          </table>
          <div style="margin-top:1em;">
            <b>Comparison:</b>
            <span>${codeGroup.sumNet.toFixed(2)} (Net, xml) vs. ${codeGroup.sumPayer.toFixed(2)} (Payer Share, xlsx)</span>
          </div>
        ` : ""}
        <details>
          <summary>Full Row Data</summary>
          <pre id="licenseHistoryText">${JSON.stringify(r, null, 2)}</pre>
        </details>
      `;
      modal.style.display = "block";
      setTimeout(() => { closeBtn.focus(); }, 0);
    };
  });
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
