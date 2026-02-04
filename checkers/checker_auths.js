(function() {
  try {
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
      // Preprocess XML to replace unescaped & with "and" for parseability
      const xmlContent = e.target.result.replace(/&(?!(amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;))/g, "and");
      const doc = new DOMParser().parseFromString(xmlContent, "application/xml");
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
  // Map rows by trimmed AuthorizationID for reliable lookups, but keep original raw value on each row
  return rows.reduce((map, row) => {
    const rawId = String(row.AuthorizationID || "");
    const id = rawId.trim();
    // keep the original raw value for detection of leading/trailing whitespace
    row._rawAuthorizationID = rawId;

    if (!id && !rawId) {
      // no auth ID present; still add under empty key to preserve behavior
      map[""] = map[""] || [];
      map[""].push(row);
      return map;
    }

    // Primary lookup key: trimmed ID
    map[id] = map[id] || [];
    map[id].push(row);

    // Also map the raw (untrimmed) key if different so we don't lose rows that may be looked up by raw values
    if (rawId && rawId !== id) {
      map[rawId] = map[rawId] || [];
      map[rawId].push(row);
    }

    return map;
  }, {});
}

// --- GROUPING LOGIC ---
function preprocessClaimCodeSums(results) {
  const claimCodeSums = {};
  results.forEach(r => {
    if (!claimCodeSums[r.claimId]) claimCodeSums[r.claimId] = {};
    if (!claimCodeSums[r.claimId][r.code])
      claimCodeSums[r.claimId][r.code] = { sumNet: 0, activities: [] };
    claimCodeSums[r.claimId][r.code].sumNet += parseFloat(r.netTotal || 0);
    claimCodeSums[r.claimId][r.code].activities.push(r);
  });
  return claimCodeSums;
}

// --- VALIDATIONS ---
function validateApprovalRequirement(code, authID) {
  const remarks = [];
  const rule = authRules[code] || {};
  const needsAuth = !/NOT\s+REQUIRED/i.test(rule.approval_details || "");
  if (needsAuth) {
    if (!authID) remarks.push(`Missing required AuthorizationID for ${code}`);
  } else {
    if (authID) remarks.push("AuthorizationID provided but not required");
  }
  return remarks;
}

// MODIFIED: returns clinicianMismatch flag and both clinician values
function validateXLSXMatch(row, { memberId, code, netTotal, ordering, authID }) {
  const remarks = [];
  let clinicianMismatch = false;
  let xmlClinician = ordering || "";
  let xlsClinician = (row["Ordering Clinician"] || "");
  if ((row["Card Number / DHA Member ID"] || "").trim() !== memberId.trim())
    remarks.push(`MemberID mismatch: XLSX=${row["Card Number / DHA Member ID"]}`);
  if ((row["Item Code"] || "").trim() !== code.trim())
    remarks.push(`Item Code mismatch: XLSX=${row["Item Code"]}`);
  const xOrdering = xlsClinician.trim().toUpperCase();
  if (xOrdering !== (xmlClinician || "").trim().toUpperCase())
    clinicianMismatch = true;
  if ((row.AuthorizationID || "").trim() !== authID.trim())
    remarks.push(`AuthorizationID mismatch: XLSX=${row.AuthorizationID}`);
  return { remarks, clinicianMismatch, xmlClinician, xlsClinician };
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
  
  const status = (row.Status || row.status || "").toLowerCase().trim();
  const isTotallyApproved = status === "totally approved";
  const isPartiallyApproved = status === "partially approved";
  
  // If status is "Totally Approved", override the date validation (don't push the remark)
  if (xlsDate && xmlDate && xlsDate > xmlDate && !isTotallyApproved) {
    remarks.push("Approval must be on or before procedure date");
  }
  
  // Accept "approved", "totally approved", or "rejected" as valid statuses
  const validStatuses = ["approved", "totally approved", "rejected"];
  const isValidStatus = validStatuses.some(validStatus => status === validStatus);
  
  // If status is "Partially Approved", treat it as unknown (not invalid).
  // This is a special case where the row is uncertain rather than definitively invalid.
  if (!isValidStatus && !isPartiallyApproved) {
    remarks.push("Invalid status (must be Approved, Totally Approved, or Rejected)");
  }
  
  return { remarks, isPartiallyApproved };
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

  // Capture raw XML Authorization value (do not trim) so we can detect leading whitespace
  const rawAuthEl = activityEl.querySelector("PriorAuthorizationID") || activityEl.querySelector("PriorAuthorization");
  const rawAuthText = rawAuthEl && rawAuthEl.textContent ? rawAuthEl.textContent : "";
  const authID   = rawAuthText.trim();

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
      remarks: [],
      unknown: false
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
      remarks: [],
      unknown: false
    };
  }

  // Try to find rows for this authID; mapXLSXData maps by trimmed AuthorizationID as primary key.
  const rows = xlsxMap[authID] || [];
  const matchedRow = rows.find(r =>
    String(r["Item Code"] || "").trim() === code &&
    String(r["Card Number / DHA Member ID"] || "").trim() === memberId
  ) || {};

  const denialCode   = matchedRow["Denial Code (If any)"]   || "";
  const denialReason = matchedRow["Denial Reason (If any)"] || "";

  const remarks = [];

  // If XML contained leading whitespace before the auth, flag it but continue other checks
  if (rawAuthText && rawAuthText.trim() && /^\s+/.test(rawAuthText)) {
    remarks.push("Leading whitespace in AuthorizationID");
  }

  if (matchedRow.AuthorizationID && (matchedRow.Status || matchedRow.status || "").toLowerCase().includes("rejected")) {
    remarks.push("Has authID but status is rejected");
  }

  let unknown = false;
  let clinicianMismatchMsg = "";

  if (!matchedRow.AuthorizationID) {
    if (authID) {
      remarks.push(`${authID} has no authorization for ${code}.`);
    } else {
      remarks.push(`Authorization required for ${code}.`);
    }
  } else {
    // Check for extra whitespace in common fields (including AuthorizationID on the XLSX row)
    ["Item Code", "Card Number / DHA Member ID", "Ordering Clinician", "Payer Share", "AuthorizationID"].forEach(field => {
      const v = String(matchedRow[field] || "");
      if (v !== v.trim()) {
        remarks.push(`Extra whitespace in field: "${field}"`);
      }
    });

    const context = { memberId, code, qty, netTotal, ordering, authID };
    const matchResult = validateXLSXMatch(matchedRow, context);
    remarks.push(...matchResult.remarks);
    if (matchResult.clinicianMismatch) {
      unknown = true;
      clinicianMismatchMsg = `Clinician mismatch: XML=[${matchResult.xmlClinician}], XLSX=[${matchResult.xlsClinician}]`;
      remarks.unshift(clinicianMismatchMsg);
    }
    const dateStatusResult = validateDateAndStatus(matchedRow, start);
    remarks.push(...dateStatusResult.remarks);
    if (dateStatusResult.isPartiallyApproved) {
      unknown = true;
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
      remarks,
      unknown
    };
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
    remarks,
    unknown: false
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
function buildResultsTable(results) {
  // Validate results is an array
  if (!Array.isArray(results)) {
    console.error('buildResultsTable: results is not an array:', results);
    const errorDiv = document.createElement('div');
    errorDiv.className = 'alert alert-danger';
    errorDiv.textContent = 'Error: Invalid results data structure';
    return errorDiv;
  }

  // Create container div
  const container = document.createElement('div');

  // Show "X loaded" count at the top
  const loadedMsg = document.createElement("div");
  loadedMsg.id = "loaded-count";
  loadedMsg.style.marginBottom = "10px";
  loadedMsg.style.fontWeight = "bold";
  loadedMsg.textContent = `${results.length} authorization activities loaded`;
  container.appendChild(loadedMsg);

  if (!results.length) {
    const noResultsMsg = document.createElement("div");
    noResultsMsg.className = "alert alert-info";
    noResultsMsg.style.marginTop = "10px";
    noResultsMsg.innerHTML = `
      <strong>No authorization activities found.</strong><br>
      This could mean:<br>
      • The XML file contains no claims with activities requiring authorization checks<br>
      • All activities in the XML are for codes that don't require authorization<br>
      <br>
      Claims loaded from XML: ${xmlClaimCount}<br>
      Authorization rows loaded from XLSX: ${xlsxAuthCount}
    `;
    container.appendChild(noResultsMsg);
    return container;
  }

  // Preprocess grouped claim/code sums
  const claimCodeSums = preprocessClaimCodeSums(results);

  const table = document.createElement("table");
  table.className = "table table-striped table-bordered";
  table.style.borderCollapse = "collapse";
  table.style.width = "100%";
  table.innerHTML = `
  <thead>
    <tr>
      <th style="padding:8px;border:1px solid #ccc">Claim ID</th>
      <th style="padding:8px;border:1px solid #ccc">Member ID</th>
      <th style="padding:8px;border:1px solid #ccc">Activity ID</th>
      <th style="padding:8px;border:1px solid #ccc">Code</th>
      <th style="padding:8px;border:1px solid #ccc">Auth ID</th>
      <th class="description-col" style="padding:8px;border:1px solid #ccc">Description</th>
      <th style="padding:8px;border:1px solid #ccc">Net Total</th>
      <th style="padding:8px;border:1px solid #ccc">Payer Share</th>
      <th style="padding:8px;border:1px solid #ccc">Status</th>
      <th style="padding:8px;border:1px solid #ccc">Remarks</th>
      <th style="padding:8px;border:1px solid #ccc">Details</th>
    </tr>
  </thead>`;

  const tbody = document.createElement("tbody");
  let lastClaim = null;

  results.forEach((result, idx) => {
    const codeGroup = claimCodeSums[result.claimId][result.code];
    const row = renderRow(result, lastClaim, idx, codeGroup);
    lastClaim = result.claimId;
    tbody.appendChild(row);
  });

  table.appendChild(tbody);
  container.appendChild(table);

  setTimeout(() => setupDetailsModal(results, claimCodeSums), 0);
  
  // Add MutationObserver to detect when filter hides/shows rows
  const observer = new MutationObserver(() => {
    fillMissingClaimIds();
  });
  
  if (tbody) {
    observer.observe(tbody, { 
      attributes: true, 
      attributeFilter: ['style'],
      subtree: true 
    });
  }
  
  // Fill immediately if filter is already active
  setTimeout(() => fillMissingClaimIds(), 0);
  
  return container;
}

// Helper function to fill missing Claim IDs when rows are filtered
function fillMissingClaimIds() {
  const table = document.querySelector('#results table');
  if (!table) return;
  
  const rows = Array.from(table.querySelectorAll('tbody tr'));
  
  rows.forEach(row => {
    const isHidden = row.style.display === 'none';
    const claimIdCell = row.querySelector('.claim-id-cell');
    const claimId = row.getAttribute('data-claim-id');
    
    if (!isHidden && claimIdCell && claimId) {
      if (claimIdCell.textContent.trim() === '') {
        // Empty cell - fill it in for visibility
        claimIdCell.textContent = claimId;
        claimIdCell.style.color = '#666';  // Gray color
        claimIdCell.style.fontStyle = 'italic';  // Italic style
      } else {
        // Has claim ID - original first row
        claimIdCell.style.color = '';  // Black color
        claimIdCell.style.fontStyle = '';  // Normal style
      }
    }
  });
}

// MODIFIED: set class to unknown if r.unknown
function renderRow(r, lastClaimId, idx, codeGroup) {
  const tr = document.createElement("tr");
  // Use Bootstrap classes for row coloring
  if (r.unknown) {
    tr.classList.add('table-warning'); // Yellow for unknown
  } else if (r.remarks && r.remarks.length > 0) {
    tr.classList.add('table-danger'); // Red for invalid
  } else {
    tr.classList.add('table-success'); // Green for valid
  }
  
  // Add data attribute for claim ID
  tr.setAttribute('data-claim-id', r.claimId || '');

  const xls = r.xlsRow || {};

  // Claim ID (hide repeats)
  const cid = document.createElement("td");
  cid.textContent = (r.claimId === lastClaimId) ? "" : r.claimId;
  cid.className = "nowrap-col claim-id-cell";
  cid.style.padding = "6px";
  cid.style.border = "1px solid #ccc";
  tr.appendChild(cid);

  // XML fields (memberId, id, code)
  [r.memberId, r.id, r.code].forEach(val => {
    const td = document.createElement("td");
    td.textContent = val || "";
    td.className = "nowrap-col";
    td.style.padding = "6px";
    td.style.border = "1px solid #ccc";
    tr.appendChild(td);
  });

  // Auth ID (always visible)
  const authTd = document.createElement("td");
  authTd.textContent = r.authID || "";
  authTd.className = "nowrap-col";
  authTd.style.padding = "6px";
  authTd.style.border = "1px solid #ccc";
  tr.appendChild(authTd);

  // Description (wrap allowed, class='description-col')
  const descTd = document.createElement("td");
  descTd.textContent = r.description || "";
  descTd.className = "description-col";
  descTd.style.padding = "6px";
  descTd.style.border = "1px solid #ccc";
  tr.appendChild(descTd);

  // Net Total (2 decimals, with source)
  const netTd = document.createElement("td");
  netTd.textContent = (parseFloat(r.netTotal || 0)).toFixed(2) + " (xml)";
  netTd.className = "nowrap-col";
  netTd.style.padding = "6px";
  netTd.style.border = "1px solid #ccc";
  tr.appendChild(netTd);

  // Payer Share (2 decimals, with source)
  const payerTd = document.createElement("td");
  payerTd.textContent = (parseFloat(xls["Payer Share"] || 0)).toFixed(2) + " (xlsx)";
  payerTd.className = "nowrap-col";
  payerTd.style.padding = "6px";
  payerTd.style.border = "1px solid #ccc";
  tr.appendChild(payerTd);

  // Status
  const statusTd = document.createElement("td");
  statusTd.textContent = xls["Status"] || xls.status || "";
  statusTd.className = "nowrap-col";
  statusTd.style.padding = "6px";
  statusTd.style.border = "1px solid #ccc";
  tr.appendChild(statusTd);

  // Remarks (summary only)
  const remarksTd = document.createElement("td");
  if (r.unknown && r.remarks && r.remarks.length) {
    remarksTd.textContent = r.remarks[0];
  } else if (r.remarks && r.remarks.length) {
    remarksTd.innerHTML = `<div>${r.remarks[0]}${r.remarks.length > 1 ? " (+)" : ""}</div>`;
    remarksTd.title = r.remarks.join('\n');
  } else {
    remarksTd.textContent = "";
  }
  remarksTd.className = "wrap-col description-col";
  remarksTd.style.padding = "6px";
  remarksTd.style.border = "1px solid #ccc";
  tr.appendChild(remarksTd);

  // Details button (opens modal)
  const detailsTd = document.createElement("td");
  detailsTd.style.padding = "6px";
  detailsTd.style.border = "1px solid #ccc";
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
      <div class="modal-content" id="modalContent">
        <span class="close" tabindex="0" role="button" aria-label="Close">&times;</span>
        <div id="modal-body"></div>
      </div>
    `;
    document.body.appendChild(modal);
  }
  const modalBody = modal.querySelector("#modal-body");
  const closeBtn = modal.querySelector(".close");
  const modalContent = modal.querySelector(".modal-content");

  // Draggable modal
  let isDragging = false, startX, startY, initialLeft, initialTop;
  modalContent.onmousedown = function(e) {
    if (!e.target.classList.contains('close')) {
      isDragging = true;
      modalContent.classList.add('draggable');
      startX = e.clientX;
      startY = e.clientY;
      const rect = modalContent.getBoundingClientRect();
      initialLeft = rect.left;
      initialTop = rect.top;
      document.body.style.userSelect = 'none';
      e.preventDefault();
    }
  };
  document.onmousemove = function(e) {
    if (isDragging) {
      let dx = e.clientX - startX, dy = e.clientY - startY;
      modalContent.style.position = 'fixed';
      modalContent.style.left = (initialLeft + dx) + 'px';
      modalContent.style.top = (initialTop + dy) + 'px';
      modalContent.style.margin = 0;
    }
  };
  document.onmouseup = function() {
    if (isDragging) {
      isDragging = false;
      modalContent.classList.remove('draggable');
      document.body.style.userSelect = '';
    }
  };

  closeBtn.onclick = () => {
    modal.style.display = "none";
    modalBody.innerHTML = "";
  };
  closeBtn.onkeydown = (e) => {
    if (["Escape", " ", "Enter"].includes(e.key)) {
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
      const idx = +this.dataset.resultIdx,
        claimId = this.dataset.claimId,
        code = this.dataset.code,
        r = results[idx],
        xls = r.xlsRow || {};
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
              <th></th>
            </tr>
          </table>
        ` : ""}
        <details>
          <summary>Full Row Data</summary>
          <pre id="licenseHistoryText">${JSON.stringify(r, null, 2)}</pre>
        </details>
      `;
      modal.style.display = "block";
      // Center modal if not dragged yet
      modalContent.style.position = '';
      modalContent.style.left = '';
      modalContent.style.top = '';
      modalContent.style.margin = '';
      setTimeout(() => { closeBtn.focus(); }, 0);
    };
  });
}

// === MAIN PROCESSING ===
function postProcessResults(results) {
  const container = document.getElementById("results");
  // DON'T clear container - table is already rendered by renderResults()

  const total = results.length;
  const invalidEntries = results.filter(r => !r.unknown && r.remarks.length > 0);
  const invalidCount = invalidEntries.length;
  const validCount   = total - invalidCount;
  const pctValid     = total ? ((validCount / total) * 100).toFixed(1) : "0.0";

  // 1) Show summary at the top (prepend before table)
  const summary = document.createElement("div");
  summary.className = "alert alert-info mb-3";
  summary.innerHTML = `<strong>Validation Summary:</strong> ${validCount} valid / ${total} total (${pctValid}% valid)`;
  container.insertBefore(summary, container.firstChild);

  // 2) If any invalid, show export button (add to summary)
  if (invalidCount > 0) {
    const btn = document.createElement("button");
    btn.textContent = `Export ${invalidCount} Invalid Entries`;
    btn.id = "exportInvalidBtn";
    btn.className = "btn btn-sm btn-danger ms-3";
    summary.appendChild(btn);

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

/********************
 * UNIFIED ENTRY POINT *
 ********************/
// Simplified entry point for unified checker - reads files, validates, renders
async function runAuthsCheck() {
  const xmlFileInput = document.getElementById('xmlInput');
  const xlsxFileInput = document.getElementById('xlsxInput');
  const statusDiv = document.getElementById('uploadStatus');
  
  // Clear status
  if (statusDiv) statusDiv.textContent = '';
  
  // Get XML file - try input element first, then fall back to unified cache
  let xmlFile = xmlFileInput?.files?.[0];
  if (!xmlFile && window.unifiedCheckerFiles && window.unifiedCheckerFiles.xml) {
    xmlFile = window.unifiedCheckerFiles.xml;
    console.log('[AUTHS] Using XML file from unified cache:', xmlFile.name);
  }
  
  // Get XLSX file - try input element first, then fall back to unified cache
  let xlsxFile = xlsxFileInput?.files?.[0];
  if (!xlsxFile && window.unifiedCheckerFiles && window.unifiedCheckerFiles.auth) {
    xlsxFile = window.unifiedCheckerFiles.auth;
    console.log('[AUTHS] Using Auth file from unified cache:', xlsxFile.name);
  }
  
  // Validate files are uploaded
  if (!xmlFile) {
    if (statusDiv) statusDiv.textContent = 'Please select an XML file first.';
    return null;
  }
  if (!xlsxFile) {
    if (statusDiv) statusDiv.textContent = 'Please select an authorization XLSX file first.';
    return null;
  }
  
  try {
    if (statusDiv) statusDiv.textContent = 'Processing...';
    
    // Load authorization rules
    await loadAuthRules();
    
    // Parse XML file
    const xmlDoc = await parseXMLFile(xmlFile);
    if (!xmlDoc) {
      throw new Error('Failed to parse XML file');
    }
    
    // Parse XLSX file
    const xlsxData = await parseXLSXFile(xlsxFile);
    if (!Array.isArray(xlsxData)) {
      throw new Error('Invalid authorization file structure - expected array of rows');
    }
    
    // Validate claims against authorizations
    const results = validateClaims(xmlDoc, xlsxData, authRules);
    console.log('[DEBUG] Auth validation complete:', {
      resultsCount: results.length,
      xmlClaimCount,
      xlsxAuthCount,
      hasAuthRules: Object.keys(authRules).length > 0
    });
    
    // Build and return table
    const tableElement = buildResultsTable(results);
    postProcessResults(results);
    
    if (statusDiv) statusDiv.textContent = `Processed ${results.length} authorization activities`;
    
    return tableElement;
  } catch (error) {
    console.error('Authorization check error:', error);
    if (statusDiv) statusDiv.textContent = 'Processing failed: ' + error.message;
    const errorDiv = document.createElement('div');
    errorDiv.className = 'error';
    errorDiv.style.cssText = 'color: red; padding: 20px; border: 1px solid red; margin: 10px;';
    errorDiv.innerHTML = `<strong>Authorization Checker Error:</strong><br>${error.message}`;
    return errorDiv;
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

document.addEventListener('DOMContentLoaded', function() {
  try {
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
            try {
              parsedXmlDoc = await parseXMLFile(currentXmlFile);
            } catch (e) { parsedXmlDoc = null; }
          } else if (id === "xlsxInput") {
            currentXlsxFile = file;
            xlsxAuthCount = -1;
            try {
              parsedXlsxData = await parseXLSXFile(currentXlsxFile);
            } catch (e) { parsedXlsxData = null; }
          }
          updateStatus();
        });
      }
    });
  } catch (error) {
    console.error('[AUTHS] DOMContentLoaded initialization error:', error);
  }
});

    // Expose function globally for unified checker
    window.runAuthsCheck = runAuthsCheck;

  } catch (error) {
    console.error('[CHECKER-ERROR] Failed to load checker:', error);
    console.error(error.stack);
  }
})();
