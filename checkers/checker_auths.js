// === GLOBAL STATE ===
let authRules = {}, authRulesPromise = null, xmlClaimCount = 0, xlsxAuthCount = 0;
let currentXmlFile = null, currentXlsxFile = null, parsedXmlDoc = null, parsedXlsxData = null;

// === UTILITIES ===
const getText = (parent, tag) => (parent.querySelector(tag)?.textContent || "").trim();
function updateStatus() {
  const resultsDiv = document.getElementById("results");
  let messages = [];
  if (xmlClaimCount === -1) messages.push("XML file selected, awaiting processing...");
  else if (xmlClaimCount > 0) messages.push(`${xmlClaimCount} Claims Loaded`);
  else if (xmlClaimCount === 0) messages.push("No claims loaded");
  if (xlsxAuthCount === -1) messages.push("XLSX file selected, awaiting processing...");
  else if (xlsxAuthCount > 0) messages.push(`${xlsxAuthCount} Auths Loaded`);
  else if (xlsxAuthCount === 0) messages.push("No auths loaded");
  if (resultsDiv) resultsDiv.textContent = messages.join(" | ");
  const processBtn = document.getElementById("processBtn");
  if (processBtn) processBtn.disabled = !(xmlClaimCount > 0 && xlsxAuthCount > 0);
}

// === LOADERS ===
function loadAuthRules(url = "checker_auths.json") {
  if (!authRulesPromise) authRulesPromise = fetch(url)
    .then(res => { if (!res.ok) throw new Error(`Failed to load ${url}`); return res.json(); })
    .then(data => { authRules = data.reduce((map, entry) => (map[entry.code] = entry, map), {}); });
  return authRulesPromise;
}
function parseXMLFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      const doc = new DOMParser().parseFromString(e.target.result, "application/xml");
      if (doc.querySelector("parsererror")) { xmlClaimCount = 0; updateStatus(); return reject("Invalid XML file"); }
      xmlClaimCount = doc.querySelectorAll("Claim").length; updateStatus(); resolve(doc);
    };
    reader.onerror = () => { xmlClaimCount = 0; updateStatus(); reject("Failed to read XML file"); };
    reader.readAsText(file);
  });
}
function parseXLSXFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const wb = XLSX.read(new Uint8Array(e.target.result), { type: "array" });
        const sheetName = wb.SheetNames.includes("HCPRequests") ? "HCPRequests" : wb.SheetNames[1] || wb.SheetNames[0];
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: "" });
        xlsxAuthCount = rows.length; updateStatus(); resolve(rows);
      } catch { xlsxAuthCount = 0; updateStatus(); reject("Invalid XLSX file"); }
    };
    reader.onerror = () => { xlsxAuthCount = 0; updateStatus(); reject("Failed to read XLSX file"); };
    reader.readAsArrayBuffer(file);
  });
}
const mapXLSXData = rows => rows.reduce((map, row) => {
  const id = row.AuthorizationID || ""; map[id] = map[id] || []; map[id].push(row); return map;
}, {});

// --- GROUPING LOGIC ---
function preprocessClaimCodeSums(results) {
  const claimCodeSums = {};
  results.forEach(r => {
    if (!claimCodeSums[r.claimId]) claimCodeSums[r.claimId] = {};
    if (!claimCodeSums[r.claimId][r.code]) claimCodeSums[r.claimId][r.code] = { sumNet: 0, sumPayer: 0, activities: [] };
    claimCodeSums[r.claimId][r.code].sumNet += parseFloat(r.netTotal || 0);
    claimCodeSums[r.claimId][r.code].sumPayer += parseFloat(r.xlsRow?.["Payer Share"] || 0);
    claimCodeSums[r.claimId][r.code].activities.push(r);
  });
  return claimCodeSums;
}

// === VALIDATIONS ===
function validateApprovalRequirement(code, authID) {
  const remarks = [], rule = authRules[code] || {}, needsAuth = !/NOT\s+REQUIRED/i.test(rule.approval_details || "");
  if (needsAuth && !authID) remarks.push("Missing required AuthorizationID");
  else if (!needsAuth && authID) remarks.push("AuthorizationID provided but not required");
  return remarks;
}
function validateXLSXMatch(row, { memberId, code, netTotal, ordering, authID }) {
  const remarks = [];
  if ((row["Card Number / DHA Member ID"] || "").trim() !== memberId.trim()) remarks.push(`MemberID mismatch: XLSX=${row["Card Number / DHA Member ID"]}`);
  if ((row["Item Code"] || "").trim() !== code.trim()) remarks.push(`Item Code mismatch: XLSX=${row["Item Code"]}`);
  const unitNet = parseFloat(netTotal || "0"), xlsxPayerShare = parseFloat(row["Payer Share"] || "0");
  if (unitNet.toFixed(2) !== xlsxPayerShare.toFixed(2))
    remarks.push(`Net/Payer Mismatch: Net ${unitNet.toFixed(2)} (xml) vs XLSX Payer Share ${xlsxPayerShare.toFixed(2)}`);
  const xOrdering = (row["Ordering Clinician"] || "").trim().toUpperCase();
  if (xOrdering !== (ordering || "").trim().toUpperCase()) remarks.push(`Ordering Clinician mismatch: XLSX=${row["Ordering Clinician"]}`);
  if ((row.AuthorizationID || "").trim() !== authID.trim()) remarks.push(`AuthorizationID mismatch: XLSX=${row.AuthorizationID}`);
  return remarks;
}
function validateDateAndStatus(row, start) {
  const remarks = [];
  const xlsDateStr = (row["Ordered On"] || "").split(' ')[0], xmlDateStr = (start || "").split(' ')[0];
  const [dx, mx, yx] = xlsDateStr.split('/').map(Number), [di, mi, yi] = xmlDateStr.split('/').map(Number);
  const xlsDate = isNaN(dx) ? null : new Date(yx, mx - 1, dx), xmlDate = isNaN(di) ? null : new Date(yi, mi - 1, di);
  if (!xlsDate) remarks.push("Invalid XLSX Ordered On date");
  if (!xmlDate) remarks.push("Invalid XML Start date");
  if (xlsDate && xmlDate && xlsDate > xmlDate) remarks.push("Approval must be on or before procedure date");
  const status = (row.Status || row.status || "").toLowerCase();
  if (!status.includes("approved") && !status.includes("rejected")) remarks.push("Status not approved");
  return remarks;
}
function logInvalidRow(xlsRow, context, remarks) {
  if (remarks.length) { console.group(`Validation errors for AuthorizationID: ${context.authID}, Code: ${context.code}`); console.log("XLSX Row Data:", xlsRow); console.log("XML Context Data:", context); console.log("Remarks:", remarks); console.groupEnd(); }
}
function validateActivity(activityEl, xlsxMap, claimId, memberId) {
  const id = getText(activityEl, "ID"), code = getText(activityEl, "Code"), start = getText(activityEl, "Start"),
    netTotal = getText(activityEl, "Net") || getText(activityEl, "NetTotal"), qty = getText(activityEl, "Quantity") || "1",
    ordering = getText(activityEl, "OrderingClinician"), authID = getText(activityEl, "PriorAuthorizationID") || getText(activityEl, "PriorAuthorization"),
    rule = authRules[code] || {}, needsAuth = !/NOT\s+REQUIRED/i.test(rule.approval_details || "");
  if (!needsAuth && !authID) return { claimId, memberId, id, code, description: rule.description || "", netTotal, qty, ordering, authID, start, xlsRow: {}, denialCode: "", denialReason: "", remarks: [] };
  if (parseFloat(netTotal || "0") === 0) return { claimId, memberId, id, code, description: rule.description || "", netTotal, qty, ordering, authID, start, xlsRow: {}, denialCode: "", denialReason: "", remarks: [] };
  const rows = xlsxMap[authID] || [], matchedRow = rows.find(r => String(r["Item Code"] || "").trim() === code && String(r["Card Number / DHA Member ID"] || "").trim() === memberId) || {};
  const denialCode = matchedRow["Denial Code (If any)"] || "", denialReason = matchedRow["Denial Reason (If any)"] || "";
  const remarks = [];
  if (matchedRow.AuthorizationID && (matchedRow.Status || matchedRow.status || "").toLowerCase().includes("rejected")) remarks.push("Has authID but status is rejected");
  if (!matchedRow.AuthorizationID) remarks.push("No matching authorization row found in XLSX.");
  else {
    ["Item Code", "Card Number / DHA Member ID", "Ordering Clinician", "Payer Share"].forEach(field => {
      const v = String(matchedRow[field] || ""); if (v !== v.trim()) remarks.push(`Extra whitespace in field: "${field}"`);
    });
    const context = { memberId, code, qty, netTotal, ordering, authID };
    remarks.push(...validateXLSXMatch(matchedRow, context), ...validateDateAndStatus(matchedRow, start));
  }
  if (remarks.length) logInvalidRow(matchedRow, { claimId, memberId, id, code, netTotal, qty, ordering, authID, start }, remarks);
  return { claimId, memberId, id, code, description: rule.description || "", netTotal, qty, ordering, authID, start, xlsRow: matchedRow, denialCode, denialReason, remarks };
}
function validateClaims(xmlDoc, xlsxData) {
  const xlsxMap = mapXLSXData(xlsxData), results = [];
  Array.from(xmlDoc.getElementsByTagName("Claim")).forEach(claimEl => {
    const cid = getText(claimEl, "ID"), mid = getText(claimEl, "MemberID");
    Array.from(claimEl.getElementsByTagName("Activity")).forEach(a => results.push(validateActivity(a, xlsxMap, cid, mid)));
  });
  return results;
}

// === RENDERERS ===
function renderResults(results) {
  const container = document.getElementById("results");
  container.innerHTML = "";
  container.insertAdjacentHTML("beforeend", `<div id="loaded-count" class="loaded-count">${results.length} loaded</div>`);
  if (!results.length) { container.textContent = "✅ No activities to validate."; return; }
  const claimCodeSums = preprocessClaimCodeSums(results), table = document.createElement("table");
  table.innerHTML = `<thead><tr>
    <th>Claim ID</th><th>Member ID</th><th>Activity ID</th><th>Code</th>
    <th>Auth ID</th><th class="description-col">Description</th>
    <th>Net Total</th><th>Payer Share</th><th>Status</th>
    <th>Remarks</th><th>Details</th></tr></thead>`;
  const tbody = document.createElement("tbody");
  let lastClaim = null;
  results.forEach((result, idx) => {
    const codeGroup = claimCodeSums[result.claimId][result.code];
    tbody.appendChild(renderRow(result, lastClaim, idx, codeGroup));
    lastClaim = result.claimId;
  });
  table.appendChild(tbody); container.appendChild(table); setupDetailsModal(results, claimCodeSums);
}
function renderRow(r, lastClaimId, idx, codeGroup) {
  const tr = document.createElement("tr");
  tr.className = r.remarks.length ? 'invalid' : 'valid';
  const xls = r.xlsRow || {};
  const makeTd = (val, cl = "nowrap-col") => { const td = document.createElement("td"); td.textContent = val || ""; td.className = cl; return td; };
  tr.appendChild(makeTd((r.claimId === lastClaimId) ? "" : r.claimId));
  [r.memberId, r.id, r.code].forEach(val => tr.appendChild(makeTd(val)));
  tr.appendChild(makeTd(r.authID, "nowrap-col"));
  const descTd = makeTd(r.description, "description-col"); tr.appendChild(descTd);
  tr.appendChild(makeTd((parseFloat(r.netTotal || 0)).toFixed(2) + " (xml)"));
  tr.appendChild(makeTd((parseFloat(xls["Payer Share"] || 0)).toFixed(2) + " (xlsx)"));
  tr.appendChild(makeTd(xls["Status"] || xls.status || ""));
  const remarksTd = document.createElement("td");
  remarksTd.className = "wrap-col remarks-col";
  remarksTd.innerHTML = r.remarks && r.remarks.length ? `<div>${r.remarks[0]}${r.remarks.length > 1 ? " (+)" : ""}</div>` : "";
  if (r.remarks && r.remarks.length) remarksTd.title = r.remarks.join('\n');
  tr.appendChild(remarksTd);
  const detailsTd = document.createElement("td");
  const detailsBtn = document.createElement("button");
  detailsBtn.textContent = "View";
  detailsBtn.className = "details-btn";
  detailsBtn.dataset.resultIdx = idx;
  detailsBtn.dataset.claimId = r.claimId;
  detailsBtn.dataset.code = r.code;
  detailsTd.appendChild(detailsBtn);
  tr.appendChild(detailsTd);
  if (codeGroup && codeGroup.activities.length > 1) {
    tr.setAttribute("data-grouped", "true");
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
    modal.innerHTML = `<div class="modal-content">
        <span class="close" tabindex="0" role="button" aria-label="Close">&times;</span>
        <div id="modal-body"></div>
      </div>`;
    document.body.appendChild(modal);
  }
  const modalBody = modal.querySelector("#modal-body"), closeBtn = modal.querySelector(".close");
  closeBtn.onclick = () => { modal.style.display = "none"; modalBody.innerHTML = ""; };
  closeBtn.onkeydown = e => { if (["Escape", " ", "Enter"].includes(e.key)) { modal.style.display = "none"; modalBody.innerHTML = ""; } };
  window.addEventListener("keydown", e => { if (modal.style.display === "block" && e.key === "Escape") { modal.style.display = "none"; modalBody.innerHTML = ""; } });
  window.onclick = e => { if (e.target === modal) { modal.style.display = "none"; modalBody.innerHTML = ""; } };
  document.querySelectorAll(".details-btn").forEach(btn => {
    btn.onclick = function() {
      const idx = +this.dataset.resultIdx, claimId = this.dataset.claimId, code = this.dataset.code, r = results[idx], xls = r.xlsRow || {};
      const codeGroup = claimCodeSums[claimId][code];
      modalBody.innerHTML = `
        <h3 style="margin-top:0;">Details for Claim ID: ${r.claimId}, Activity ID: ${r.id}</h3>
        <table class="modal-license-table">
          <tr><th>Ordering Clinician</th><td>${r.ordering || ""}</td></tr>
          <tr><th>Auth ID</th><td>${r.authID || ""}</td></tr>
          <tr><th>Start Date</th><td>${r.start ? r.start.split(' ')[0] : ""} <span class="source-note">(xml)</span></td></tr>
          <tr><th>Ordered On</th><td>${(xls["Ordered On"] || "").split(' ')[0]} <span class="source-note">(xlsx)</span></td></tr>
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
                <td>${parseFloat(act.netTotal || 0).toFixed(2)} <span class="source-note">(xml)</span></td>
                <td>${parseFloat(act.xlsRow?.["Payer Share"] || 0).toFixed(2)} <span class="source-note">(xlsx)</span></td>
              </tr>
            `).join("")}
            <tr>
              <th>Total</th>
              <th>${codeGroup.sumNet.toFixed(2)} <span class="source-note">(xml)</span></th>
              <th>${codeGroup.sumPayer.toFixed(2)} <span class="source-note">(xlsx)</span></th>
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
      modal.style.display = "block"; setTimeout(() => { closeBtn.focus(); }, 0);
    };
  });
}

// === MAIN ===
async function handleRun() {
  try {
    await loadAuthRules();
    const results = validateClaims(parsedXmlDoc, parsedXlsxData, authRules);
    renderResults(results);
    // postProcessResults(results); // Uncomment if you want summary/export
  } catch (err) { console.error("Processing error:", err); }
}
document.addEventListener('DOMContentLoaded', () => {
  const processBtn = document.getElementById('processBtn');
  if (processBtn) processBtn.addEventListener('click', handleRun);
  ["xmlInput", "xlsxInput"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("change", async e => {
      const file = e.target.files[0];
      if (!file) return;
      if (id === "xmlInput") { currentXmlFile = file; xmlClaimCount = -1; try { parsedXmlDoc = await parseXMLFile(currentXmlFile); } catch { parsedXmlDoc = null; } }
      else if (id === "xlsxInput") { currentXlsxFile = file; xlsxAuthCount = -1; try { parsedXlsxData = await parseXLSXFile(currentXlsxFile); } catch { parsedXlsxData = null; } }
      updateStatus();
    });
  });
});
