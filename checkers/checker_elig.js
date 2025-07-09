// checker_elig.js

window.addEventListener("DOMContentLoaded", () => {
  // Input/group selectors
  const xmlInput = document.getElementById("xmlFileInput");
  const xlsInput = document.getElementById("xlsxFileInput");
  const eligInput = document.getElementById("eligibilityFileInput");
  const xmlGroup = document.getElementById("xmlReportInputGroup");
  const xlsGroup = document.getElementById("xlsxReportInputGroup");
  const eligGroup = document.getElementById("eligibilityInputGroup");
  const processBtn = document.getElementById("processBtn");
  const status = document.getElementById("uploadStatus");

  // Radio selectors
  const xmlRadio = document.querySelector(
    'input[name="reportSource"][value="xml"]',
  );
  const xlsRadio = document.querySelector(
    'input[name="reportSource"][value="xlsx"]',
  );

  // Data holders
  let xmlData = null;
  let xlsData = null;
  let eligData = null;
  let insuranceLicenses = null;
  let filteredXlsData = null; // new cache variable

  // Excel date number to DD/MM/YYYY string
// Excel date (number), string, or Date → "DD/MM/YYYY"
function excelDateToDDMMYYYY(excelDate) {
  if (!excelDate) return "";

  // 🆕 If it's already a JS Date, format it directly
  if (excelDate instanceof Date) {
    const dd = String(excelDate.getDate()).padStart(2, "0");
    const mm = String(excelDate.getMonth() + 1).padStart(2, "0");
    const yyyy = excelDate.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
  }

  // If it's a string (already in DD/MM/YYYY or ISO), leave or reformat
  if (typeof excelDate === "string") {
    if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(excelDate)) {
      // already DD/MM[/YYYY]
      return excelDate.replace(
        /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/,
        (_, d, mth, y) => {
          const dd = d.padStart(2, "0");
          const mm = mth.padStart(2, "0");
          let yyyy = y.length === 2 ? "20" + y : y;
          if (yyyy.length === 4 && yyyy[0] === "0") yyyy = yyyy.slice(1);
          return `${dd}/${mm}/${yyyy}`;
        }
      );
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(excelDate)) {
      // ISO YYYY-MM-DD
      const [yyyy, mm, dd] = excelDate.split("-");
      return `${dd}/${mm}/${yyyy}`;
    }
    return excelDate;
  }

  // Otherwise, treat as an Excel serial number
  const date = new Date(Math.round((excelDate - 25569) * 86400 * 1000));
  if (isNaN(date.getTime())) return "";

  const userTimezoneOffset = date.getTimezoneOffset() * 60000;
  const dateUTC = new Date(date.getTime() + userTimezoneOffset);
  const dd = String(dateUTC.getDate()).padStart(2, "0");
  const mm = String(dateUTC.getMonth() + 1).padStart(2, "0");
  const yyyy = dateUTC.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

  function swapInputGroups() {
    if (xmlRadio.checked) {
      xmlGroup.style.display = "";
      xlsGroup.style.display = "none";
    } else {
      xmlGroup.style.display = "none";
      xlsGroup.style.display = "";
    }
    updateStatus();
  }
  xmlRadio.addEventListener("change", swapInputGroups);
  xlsRadio.addEventListener("change", swapInputGroups);

  eligGroup.style.display = "";

  fetch("insurance_licenses.json")
    .then((r) => r.json())
    .then((json) => {
      insuranceLicenses = json;
      updateStatus();
    })
    .catch(() => {
      insuranceLicenses = null;
    });

// ✅ Modified parseExcel to normalize ClaimDate for report rows
async function parseExcel(file, range = 0) {
  const reader = new FileReader();
  return new Promise((resolve, reject) => {
    reader.onload = e => {
      try {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: 'array' });
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        if (!worksheet) throw new Error('No worksheet found in uploaded file.');
        const json = XLSX.utils.sheet_to_json(worksheet, { defval: '', range });

        // Normalize ClaimDate field if present
        json.forEach(row => {
          if (row["ClaimDate"]) {
            const parsed = parseDate(row["ClaimDate"]);
            if (parsed) row["ClaimDate"] = parsed;
          }
        });

        resolve(json);
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

// ✅ Modified parseXML with per‑claim + per‑encounter logging
function parseXML(file) {
  return file.text().then(xmlText => {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlText, "application/xml");
    const claimNodes = xmlDoc.querySelectorAll('Claim');

    const claims = Array.from(claimNodes).map((claim, ci) => {
      const claimID    = claim.querySelector('ID')?.textContent.trim() || '';
      const memberID   = claim.querySelector('MemberID')?.textContent.trim() || '';
      const payerID    = claim.querySelector('PayerID')?.textContent.trim() || '';
      const providerID = claim.querySelector('ProviderID')?.textContent.trim() || '';

      // Collect clinicians from all <Activity> under this claim
      const clinicians = new Set();
      claim.querySelectorAll('Activity').forEach(act => {
        const c = act.querySelector('Clinician')?.textContent.trim();
        if (c) clinicians.add(c);
      });
      const multipleClinicians = clinicians.size > 1;
      const claimClinician     = clinicians.size === 1 ? [...clinicians][0] : null;

      // Build an array of encounters, each with claimID, memberID, etc.
      const encounters = Array.from(claim.querySelectorAll('Encounter')).map(enc => {
        const rawStart = enc.querySelector('Start')?.textContent.trim() || '';
        const startDate = parseDate(rawStart);
        console.log(`⦿ Claim[${ci}] ${claimID} → Encounter Start raw="${rawStart}" parsed=`, startDate);
        return {
          claimID,
          memberID,           // ← ensure this is here
          payerID,
          providerID,
          encounterStart: startDate || rawStart,
          claimClinician,
          multipleClinicians
        };
      });

      return { claimID, encounters };
    });

    // Flatten all encounters into a single array
    return {
      claimsCount: claims.length,
      encounters: claims.flatMap(c => c.encounters)
    };
  });
}

  function stripLeadingZero(x) {
    x = (x || "").replace(/[-\s]/g, "").trim();
    return x.startsWith("0") ? x.substring(1) : x;
  }
  
  function findEligibilityMatchesByCard(memberID, eligRows) {
    const cardCol = "Card Number / DHA Member ID";
    const checkID = stripLeadingZero(memberID);
    return eligRows.filter((row) => {
      let xlsCard = (row[cardCol] || "").replace(/[-\s]/g, "").trim();
      if (xlsCard.startsWith("0")) xlsCard = xlsCard.substring(1);
      return xlsCard && xlsCard === checkID;
    });
  }

  // --- Modified validateXlsWithEligibility ---
  function validateXlsWithEligibility(reportRows, eligRows) {
    if (reportRows.length > 0) {
      console.log("Parsed headers (xls):", Object.keys(reportRows[0]));
      console.log("First parsed row (xls):", reportRows[0]);
    } else {
      console.log("No rows to parse in XLS.");
    }
  
    console.log(`Processing ${reportRows.length} XLS report row(s)`);
  
    const seenClaimIDs = new Set();
  
    return reportRows
      .map((row) => {
        const claimID = row["ClaimID"];
        if (seenClaimIDs.has(claimID)) return null;
        seenClaimIDs.add(claimID);
  
        const remarks = [];
        let match = null;
        let status = "";
        let clinicianMismatch = false;
        let clinicianMismatchMsg = "";
        let memberID = (row["PatientCardID"] || "").toString().trim();
        const reportInsurer = (row["Insurance Company"] || "").trim();
  
        if (memberID.startsWith("0")) {
          remarks.push("Member ID starts with 0 (invalid)");
        }
  
        if (/VVIP/i.test(memberID)) {
          status = "VVIP";
        } else {
          const result = findBestEligibilityMatch(
            memberID,
            row["ClaimDate"] || "",
            (row["Clinician License"] || "").trim(),
            eligRows,
          );
  
          if (!result) {
            remarks.push("No eligibility rows found for card number");
          } else if (result.error) {
            remarks.push(result.error);
          } else {
            match = result.match;
  
            // Status check
            status = match["Status"] || "";
            if (status.toLowerCase() !== "eligible") {
              remarks.push(`Status not eligible (${status})`);
            }
  
            // --- NEW: Insurance Company vs Package Name ---
            const eligPackage = (match["Package Name"] || "").trim();
            if (reportInsurer && eligPackage) {
              const r = reportInsurer.toLowerCase();
              const e = eligPackage.toLowerCase();
              if (!(e.includes(r) || r.includes(e))) {
                remarks.push(
                  `Insurance Company mismatch (XLS: "${reportInsurer}", Elig Package: "${eligPackage}")`
                );
              }
            }
  
            // Service Category check
            const serviceCategory = (match["Service Category"] || "").trim();
            const consultationStatus = (match["Consultation Status"] || "")
              .trim()
              .toLowerCase();
            const validServices = [
              { cat: "Dental Services", group: "Dental" },
              { cat: "Physiotherapy", group: "Physiotherapy" },
              { cat: "Other OP Services", group: "OtherOP" },
              {
                cat: "Consultation",
                group: "Consultation",
                condition: () => consultationStatus === "elective",
              },
            ];
            if (
              !validServices.find(
                (entry) =>
                  entry.cat === serviceCategory &&
                  (!entry.condition || entry.condition())
              )
            ) {
              remarks.push(`Invalid Service Category: "${serviceCategory}"`);
            }
  
            // Card Number match
            const excelCard = (match["Card Number / DHA Member ID"] || "")
              .replace(/[-\s]/g, "")
              .trim();
            if (
              excelCard &&
              stripLeadingZero(row["PatientCardID"] || "") !==
                stripLeadingZero(excelCard)
            ) {
              remarks.push("Card Number mismatch between XLS and Eligibility");
            }
  
            // Clinician license mismatch
            const reportLic = (row["Clinician License"] || "").trim();
            const eligLic = (match["Clinician"] || "").trim();
            if (reportLic && eligLic && reportLic !== eligLic) {
              clinicianMismatch = true;
              clinicianMismatchMsg = buildClinicianMismatchMsg(
                reportLic,
                eligLic,
                (row["OrderDoctor"] || "").trim(),
                (match["Clinician Name"] || "").trim(),
                "XLSX",
                "Eligibility"
              );
            }
          }
        }
  
        // unknown = clinician mismatch if no other remarks
        const unknown = clinicianMismatch && remarks.length === 0;
  
        const formattedDate =
          row["ClaimDate"] instanceof Date
            ? excelDateToDDMMYYYY(row["ClaimDate"])
            : row["ClaimDate"];
  
        return {
          claimID,
          memberID,
          // Show this new column in output
          insuranceCompany: reportInsurer,
          affiliatedPlan: "",
          encounterStart: formattedDate,
          clinic: row["Clinic"] || "",
          packageName: match?.["Package Name"] || "",
          details: match
            ? formatEligibilityDetailsModal(match, row["PatientCardID"])
            : formatReportDetailsModal(row, formattedDate),
          eligibilityRequestNumber:
            match?.["Eligibility Request Number"] || row["FileNo"] || null,
          status,
          remarks,
          match,
          unknown,
          clinicianMismatchMsg,
          serviceCategory: match?.["Service Category"] || "",
        };
      })
      .filter(Boolean); // remove skipped duplicates
  }

// --- Modified validateXmlWithEligibility ---
function validateXmlWithEligibility(xmlPayload, eligRows) {
  const { encounters } = xmlPayload;
  const seenClaimIDs = new Set();

  return encounters
    .map(enc => {
      // Destructure memberID (and other fields) out of each encounter
      const {
        claimID,
        memberID,
        encounterStart,
        claimClinician,
        multipleClinicians
      } = enc;

      if (seenClaimIDs.has(claimID)) return null;
      seenClaimIDs.add(claimID);

      const remarks = [];
      let match = null;
      let status = "";
      let clinicianMismatch = false;
      let clinicianMismatchMsg = "";

      // Flag if the claim had multiple clinicians
      if (multipleClinicians) {
        remarks.push("Multiple clinicians in claim activities");
      }

      // Use the parsed memberID here
      if (!memberID) {
        remarks.push("MemberID missing in XML");
      }

      // Only attempt eligibility lookup if we have a memberID
      if (memberID) {
        const result = findBestEligibilityMatch(
          memberID,
          encounterStart || "",
          claimClinician || "",
          eligRows
        );

        if (!result) {
          remarks.push("No eligibility rows found for card number");
        } else if (result.error) {
          remarks.push(result.error);
        } else {
          match = result.match;
          status = match["Status"] || "";
          if (status.toLowerCase() !== "eligible") {
            remarks.push(`Status not eligible (${status})`);
          }

          const eligClin = (match["Clinician"] || "").trim();
          if (claimClinician && eligClin && claimClinician !== eligClin) {
            clinicianMismatch = true;
            clinicianMismatchMsg = buildClinicianMismatchMsg(
              claimClinician,
              eligClin,
              "", // no encounter-level provider name
              match["Clinician Name"] || "",
              "XML Activities",
              "Eligibility"
            );
          }
        }
      }

      // Treat clinician mismatch as unknown if no other remarks
      const unknown = clinicianMismatch && remarks.length === 0;
      if (unknown) {
        remarks.push("Clinician mismatch (treated as unknown)");
      }

      const formattedDate = 
        encounterStart instanceof Date
          ? excelDateToDDMMYYYY(encounterStart)
          : encounterStart;

      return {
        claimID,
        memberID,
        encounterStart: formattedDate,
        details: match ? formatEligibilityDetailsModal(match, memberID) : "",
        eligibilityRequestNumber: match?.["Eligibility Request Number"] || null,
        status,
        remarks,
        unknown,
        clinicianMismatchMsg
      };
    })
    .filter(Boolean);
}

  function buildClinicianMismatchMsg(
    reportLicense,
    eligLicense,
    reportClinician,
    eligClinician,
    reportSourceLabel,
    eligSourceLabel,
  ) {
    const safeText = (str) => str || "Unknown";

    const rLic = safeText(reportLicense),
      eLic = safeText(eligLicense),
      rName = safeText(reportClinician),
      eName = safeText(eligClinician);

    const makeBadge = (lic, label, name) =>
      `
      <span class="tooltip-parent">
        <span class="license-badge">${lic}</span>
        <span class="tooltip-text">${label}: ${name}</span>
      </span>
    `.trim();

    const reportBadge = makeBadge(rLic, reportSourceLabel, rName);
    const eligBadge = makeBadge(eLic, eligSourceLabel, eName);

    return `Clinician license mismatch: ${reportBadge} vs. ${eligBadge}`;
  }

  function formatEligibilityDetailsModal(match, memberID) {
    const fields = [
      { label: "Member ID", value: memberID || "" },
      {
        label: "Eligibility Request Number",
        value: match["Eligibility Request Number"] || "",
      },
      { label: "Payer Name", value: match["Payer Name"] || "" },
      { label: "Package Name", value: match["Package Name"] || "" },
      { label: "Service Category", value: match["Service Category"] || "" },
      {
        label: "Consultation Status",
        value: match["Consultation Status"] || "",
      },
      { label: "Clinician", value: match["Clinician"] || "" },
      { label: "Clinician Name", value: match["Clinician Name"] || "" },
      {
        label: "Authorization Number",
        value: match["Authorization Number"] || "",
      },
      { label: "EID", value: match["EID"] || "" },
      { label: "Member Name", value: match["Member Name"] || "" },
      { label: "Ordered On", value: match["Ordered On"] || "" },
      { label: "Answered On", value: match["Answered On"] || "" },
      {
        label: "EffectiveDate",
        value: match["EffectiveDate"] || match["Effective Date"] || "",
      },
      {
        label: "ExpiryDate",
        value: match["ExpiryDate"] || match["Expiry Date"] || "",
      },
      { label: "Package Name", value: match["Package Name"] || "" },
      {
        label: "Network Billing Reference",
        value: match["Network Billing Reference"] || "",
      },
    ];
    let table = '<table class="shared-table details-table"><tbody>';
    fields.forEach((f) => {
      table += `<tr><th>${f.label}</th><td>${f.value}</td></tr>`;
    });
    table += "</tbody></table>";
    return table;
  }

  function formatReportDetailsModal(row, formattedDate) {
    const fields = [
      { label: "Institution", value: row["Institution"] },
      { label: "ClaimID", value: row["ClaimID"] },
      { label: "ClaimDate", value: formattedDate || row["ClaimDate"] },
      { label: "OrderDoctor", value: row["OrderDoctor"] },
      { label: "Clinic", value: row["Clinic"] },
      { label: "Insurance Company", value: row["Insurance Company"] },
      { label: "PatientCardID", value: row["PatientCardID"] },
      { label: "FileNo", value: row["FileNo"] },
      { label: "Clinician License", value: row["Clinician License"] },
      {
        label: "Opened by/Registration Staff name",
        value: row["Opened by/Registration Staff name"],
      },
    ];
    let table = '<table class="shared-table details-table"><tbody>';
    fields.forEach((f) => {
      table += `<tr><th>${f.label}</th><td>${f.value}</td></tr>`;
    });
    table += "</tbody></table>";
    return table;
  }

  // Updated table header to include "Insurance Company"
  function buildTableContainer(containerId = "results") {
    const c = document.getElementById(containerId);
    c.innerHTML = `<table class="shared-table">
        <thead><tr>
          <th>#</th>
          <th>ID</th>
          <th>MemberID</th>
          <th>Insurance Company</th>
          <th>Package Name</th>
          <th>Encounter Start</th>
          <th>Eligibility Details</th>
          <th>Status</th>
          <th>Service Category</th>
          <th>Clinic</th>
          <th>Remarks</th>
        </tr></thead>
        <tbody></tbody>
      </table>`;
    return c.querySelector("tbody");
  }
  function setupModal(containerId = "results") {
    const c = document.getElementById(containerId);
    if (!c.querySelector("#eligibilityModal")) {
      c.insertAdjacentHTML(
        "beforeend",
        `
        <div id="eligibilityModal" class="modal" style="display:none;">
          <div class="modal-content">
            <span class="close">&times;</span>
            <div id="modalContent" style="white-space: normal;"></div>
          </div>
        </div>
      `,
      );
    }
    const modal = c.querySelector("#eligibilityModal");
    const modalContent = modal.querySelector("#modalContent");
    const closeBtn = modal.querySelector(".close");
    closeBtn.addEventListener("click", () => (modal.style.display = "none"));
    window.addEventListener("click", (e) => {
      if (e.target === modal) modal.style.display = "none";
    });
    return { modal, modalContent };
  }

  function renderResults(results, containerId = "results") {
    const tbody = buildTableContainer(containerId);
    const modalElements = setupModal(containerId);
    if (results.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:#888;">No matching rows found.</td></tr>`;
      return;
    }
    results.forEach((r, i) => {
      const row = createRow(r, i, modalElements);
      tbody.appendChild(row);
    });
  }

  // Updated createRow to render the new insuranceCompany field
  function createRow(r, index, { modal, modalContent }) {
    const row = document.createElement("tr");
    if (r.unknown) {
      row.classList.add("unknown");
    } else if (r.remarks.length) {
      row.classList.add("invalid");
    } else {
      row.classList.add("valid");
    }
  
    // Details button
    const btn = document.createElement("button");
    btn.textContent = r.eligibilityRequestNumber || "No Request";
    btn.disabled = !r.eligibilityRequestNumber && !r.details;
    btn.className = "details-btn";
    btn.addEventListener("click", () => {
      if (!r.details) return;
      modalContent.innerHTML = r.details;
      modal.style.display = "block";
    });
    const tdBtn = document.createElement("td");
    tdBtn.appendChild(btn);
  
    // Prepare remarks cell HTML
    let remarksCellHtml;
    if (r.unknown && r.clinicianMismatchMsg) {
      remarksCellHtml =
        r.clinicianMismatchMsg +
        '<br><span style="font-size:90%;color:#888;">(treated as unknown, marked valid)</span>';
    } else if (r.clinicianMismatchMsg) {
      remarksCellHtml = r.remarks.join("\n") + "<br>" + r.clinicianMismatchMsg;
    } else {
      remarksCellHtml = r.unknown
        ? "Clinician mismatch (treated as unknown, marked valid)"
        : r.remarks.join("\n");
    }
  
    row.innerHTML = `
      <td>${index + 1}</td>
      <td class="wrap-col">${r.claimID}</td>
      <td class="wrap-col">${r.memberID}</td>
      <td class="wrap-col">${r.insuranceCompany || ""}</td>
      <td class="wrap-col">${r.packageName || ""}</td> <!-- 🆕 -->
      <td>${r.encounterStart || ""}</td>
      <td>${r.encounterStart || ""}</td>
      <td></td>
      <td>${r.status || ""}</td>
      <td>${r.serviceCategory || ""}</td>
      <td>${r.clinic || ""}</td>
      <td style="white-space: pre-line;">${remarksCellHtml}</td>
    `;
  
    // Replace the empty cell with our details button
    row.querySelector("td:nth-child(6)").replaceWith(tdBtn);
  
    return row;
  }

// ✅ Enhanced parseDate with ambiguity handling (X/Y/Z)
// Parses a date string, number, or Date object to a JS Date or null if invalid
// --- Enhanced parseDate to handle "DD/MM/YYYY HH:mm" and "DD-MM-YYYY HH:mm:ss" ---
function parseDate(value) {
  if (value == null) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'number') {
    const jsDate = new Date(Math.round((value - 25569) * 86400 * 1000));
    return isNaN(jsDate) ? null : jsDate;
  }
  if (typeof value !== 'string') return null;

  // 1) Try "DD/MM/YYYY HH:mm" or "DD-MM-YYYY HH:mm:ss"
  let m = value.match(
    /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/
  );
  if (m) {
    let [ , d, mth, y, h, mi, s ] = m.map((v, i) => i>0 ? parseInt(v,10) : v);
    if (String(m[3]).length === 2) y += 2000;
    const date = new Date(y, mth-1, d, h, mi, s||0);
    if (!isNaN(date)) return date;
  }

  // 2) Existing handlers (ambiguous X/Y/Z etc.)...
  let parts = value.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (parts) {
    let [ , x, y, z ] = parts.map(v=>parseInt(v,10));
    let day, month;
    if (x>12 && y<=12) { day=x; month=y; }
    else if (y>12 && x<=12) { day=y; month=x; }
    else { day=x; month=y; }
    if (month<1||month>12||day<1||day>31) return null;
    const year = z<100?2000+z:z;
    const d0 = new Date(year, month-1, day);
    if (!isNaN(d0)) return d0;
  }

  // 3) DD‑MMM‑YYYY with optional time
  let named = value.match(
    /^(\d{1,2})-([A-Za-z]{3})-(\d{4})(?:\s+(\d{2}):(\d{2}):(\d{2}))?$/
  );
  if (named) {
    const dd = String(named[1]).padStart(2,'0');
    const mmm= named[2].toLowerCase();
    const yyyy= named[3];
    const hh = named[4]||'00', mi = named[5]||'00', ss = named[6]||'00';
    const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
    const mm = months.indexOf(mmm);
    if (mm>=0) {
      const d1 = new Date(`${yyyy}-${String(mm+1).padStart(2,'0')}-${dd}T${hh}:${mi}:${ss}`);
      if (!isNaN(d1)) return d1;
    }
  }

  // 4) Fallback ISO
  const iso = new Date(value);
  return isNaN(iso) ? null : iso;
}

// Normalize date to 00:00:00 time (strip time)
// Normalize a Date to midnight (strip time)
function normalizeDateOnly(date) {
  if (!(date instanceof Date)) return null;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

// Compare two dates ignoring time (returns true if same calendar day)
// Returns true if two dates fall on the same calendar day
function isSameDate(date1, date2) {
  const d1 = normalizeDateOnly(date1);
  const d2 = normalizeDateOnly(date2);
  return d1 && d2 && d1.getTime() === d2.getTime();
}

// Returns true if date1 ≤ date2 (comparing only the calendar day)
function isOnOrBefore(date1, date2) {
  const d1 = normalizeDateOnly(date1);
  const d2 = normalizeDateOnly(date2);
  return d1 && d2 && d1.getTime() <= d2.getTime();
}

// Returns true if claimDate is within [eligibilityStart, eligibilityEnd]
function isWithinEligibilityPeriod(claimDate, eligibilityStart, eligibilityEnd) {
  const c = normalizeDateOnly(claimDate);
  const start = normalizeDateOnly(eligibilityStart);
  const end = normalizeDateOnly(eligibilityEnd);
  return c && start && end && c.getTime() >= start.getTime() && c.getTime() <= end.getTime();
}

// Modified findBestEligibilityMatch with debug logs and relaxed date filtering
function findBestEligibilityMatch(memberID, claimDateStr, clinicianID, eligRows) {
  const claimDate = parseDate(claimDateStr);
  if (!claimDate) return null;

  const memberIDNorm = stripLeadingZero(memberID);
  const filteredElig = eligRows.filter(erow => {
    let xlsCard = (erow['Card Number / DHA Member ID'] || '').replace(/[-\s]/g, '').trim();
    if (xlsCard.startsWith('0')) xlsCard = xlsCard.substring(1);
    return xlsCard === memberIDNorm;
  });
  if (!filteredElig.length) return null;

  // Match eligibility rows on or before the claim date
  const sameDateMatches = filteredElig.filter(erow => {
    const eligDate = parseDate(
      erow['EffectiveDate'] ||
      erow['Effective Date'] ||
      erow['Ordered On'] ||
      erow['Answered On'] ||
      ''
    );
    if (!eligDate) return false;
    // Use date‐only comparison
    return isOnOrBefore(eligDate, claimDate);
  });

  if (!sameDateMatches.length) {
    return { error: "No eligibility was taken on or before this date" };
  }

  const finalMatches = sameDateMatches;

  // Try exact clinician match
  for (const erow of finalMatches) {
    if (erow['Clinician']?.trim() === clinicianID) {
      return { match: erow, unknown: false };
    }
  }

  // Fallback to first row (unknown clinician)
  return { match: finalMatches[0], unknown: true };
}

// Validate specified date fields in data array.
function validateDatesInData(data, dateFields, dataLabel = "") {
  const invalidDates = [];

  data.forEach((row, idx) => {
    dateFields.forEach((field) => {
      const val = row[field];
      if (val) {
        const parsed = parseDate(val);
        if (!parsed) {
          invalidDates.push({
            dataLabel,
            rowIndex: idx,
            field,
            value: val,
          });
        } else {
          row[field] = parsed;
        }
      }
    });
  });

  return invalidDates;
}

  // Modified updateStatus function to show filtered count for XLS report rows
  function updateStatus() {
    const usingXml = xmlRadio.checked;
    const xmlLoaded = !!xmlData;
    const xlsLoaded = !!xlsData;
    const eligLoaded = !!eligData;
    const licensesLoaded = !!insuranceLicenses;
    const msgs = [];

    if (usingXml && xmlLoaded) {
      const claimIDs = new Set(
        (xmlData.encounters || []).map((r) => r.claimID),
      );
      const count = claimIDs.size;
      msgs.push(`${count} unique Claim ID${count !== 1 ? "s" : ""} loaded`);
    }

    if (!usingXml && xlsLoaded) {
      const claimIDs = new Set((xlsData || []).map((r) => r["ClaimID"]));
      const count = claimIDs.size;
      msgs.push(`${count} unique XLS Claim ID${count !== 1 ? "s" : ""} loaded`);
    }

    if (eligLoaded) {
      const count = eligData.length || 0;
      msgs.push(`${count} Eligibility row${count !== 1 ? "s" : ""} loaded`);
    }

    if (licensesLoaded) {
      msgs.push("Insurance Licenses loaded");
    }

    status.textContent = msgs.join(", ");
    processBtn.disabled = !(
      (usingXml && xmlLoaded && eligLoaded) ||
      (!usingXml && xlsLoaded && eligLoaded)
    );
  }

// ✅ Modified xmlInput handler to show logs per claim when the file is loaded
xmlInput.addEventListener("change", async (e) => {
  status.textContent = "Loading XML…";
  processBtn.disabled = true;
  try {
    xmlData = await parseXML(e.target.files[0]);

    console.log(`✔ Loaded XML: ${xmlData.claimsCount} Claim(s), ${xmlData.encounters.length} Encounter(s) total.`);

    // If you also want a summary per claim:
    const byClaim = xmlData.encounters.reduce((acc, enc) => {
      (acc[enc.claimID] = acc[enc.claimID] || []).push(enc);
      return acc;
    }, {});
    Object.entries(byClaim).forEach(([cid, encs]) => {
      console.log(`→ ClaimID ${cid} has ${encs.length} encounter(s).`);
    });

    const invalids = validateDatesInData(xmlData.encounters, ["encounterStart"], "XML");
    if (invalids.length) {
      console.warn("Invalid encounterStart dates in XML:", invalids);
      status.textContent = `Warning: ${invalids.length} invalid dates in XML file. Check console.`;
    }
  } catch (err) {
    status.textContent = `XML Error: ${err.message}`;
    xmlData = null;
  }
  updateStatus();
});

xlsInput.addEventListener("change", async (e) => {
  status.textContent = "Loading XLS…";
  processBtn.disabled = true;
  try {
    xlsData = await parseExcel(e.target.files[0], 0);
    const invalids = validateDatesInData(xlsData, ["ClaimDate"], "XLS");
    if (invalids.length) {
      console.warn("Invalid dates found in XLS report:", invalids);
      status.textContent = `Warning: ${invalids.length} invalid date(s) in XLS report. Check console.`;
    }
  } catch (err) {
    status.textContent = `XLS Error: ${err.message}`;
    xlsData = null;
  }
  updateStatus();
});

eligInput.addEventListener("change", async (e) => {
  status.textContent = "Loading Eligibility XLSX…";
  processBtn.disabled = true;
  try {
    eligData = await parseExcel(e.target.files[0], 1);
    const dateFields = ["Ordered On", "EffectiveDate", "Effective Date", "Answered On"];
    const invalids = validateDatesInData(eligData, dateFields, "Eligibility XLSX");
    if (invalids.length) {
      console.warn("Invalid dates found in Eligibility XLSX:", invalids);
      status.textContent = `Warning: ${invalids.length} invalid date(s) in Eligibility XLSX. Check console.`;
    }
  } catch (err) {
    status.textContent = `Eligibility XLSX Error: ${err.message}`;
    eligData = null;
  }
  updateStatus();
});


  processBtn.addEventListener("click", async () => {
    if (xmlRadio.checked) {
      if (!xmlData || !eligData) {
        alert("Please upload both XML report and Eligibility XLSX.");
        return;
      }
      processBtn.disabled = true;
      status.textContent = "Validating…";
      try {
        const results = validateXmlWithEligibility(
          xmlData,
          eligData,
          insuranceLicenses,
        );
        renderResults(results);
        const validCount = results.filter(
          (r) => r.unknown || r.remarks.length === 0,
        ).length;
        const totalCount = results.length;
        const percent =
          totalCount > 0 ? Math.round((validCount / totalCount) * 100) : 0;
        status.textContent = `Valid: ${validCount} / ${totalCount} (${percent}%)`;
        console.log(`Results: ${validCount} valid out of ${totalCount}`);
      } catch (err) {
        status.textContent = `Validation error: ${err.message}`;
        console.error(err);
      }
      processBtn.disabled = false;
    } else {
      if (!xlsData || !eligData) {
        alert("Please upload both XLS report and Eligibility XLSX.");
        return;
      }
      processBtn.disabled = true;
      status.textContent = "Validating…";
      try {
        const results = validateXlsWithEligibility(xlsData, eligData);
        renderResults(results);
        const validCount = results.filter(
          (r) => r.unknown || r.remarks.length === 0,
        ).length;
        const totalCount = results.length;
        const percent =
          totalCount > 0 ? Math.round((validCount / totalCount) * 100) : 0;
        status.textContent = `Valid: ${validCount} / ${totalCount} (${percent}%)`;
        console.log(`Results: ${validCount} valid out of ${totalCount}`);
      } catch (err) {
        status.textContent = `Validation error: ${err.message}`;
        console.error(err);
      }
      processBtn.disabled = false;
    }
  });

  swapInputGroups();
});
