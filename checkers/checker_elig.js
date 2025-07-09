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
  function excelDateToDDMMYYYY(excelDate) {
    if (!excelDate) return "";
    if (typeof excelDate === "string") {
      if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(excelDate)) {
        return excelDate.replace(
          /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/,
          (m, d, mth, y) => {
            const dd = d.padStart(2, "0");
            const mm = mth.padStart(2, "0");
            let yyyy = y.length === 2 ? "20" + y : y;
            if (yyyy.length === 4 && yyyy[0] === "0") yyyy = yyyy.slice(1);
            return `${dd}/${mm}/${yyyy}`;
          },
        );
      }
      if (/^\d{4}-\d{2}-\d{2}$/.test(excelDate)) {
        const [yyyy, mm, dd] = excelDate.split("-");
        return `${dd}/${mm}/${yyyy}`;
      }
      return excelDate;
    }
    const date = new Date(Math.round((excelDate - 25569) * 86400 * 1000));
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

// ✅ Modified parseXML to use parseDate for encounterStart
function parseXML(file) {
  return file.text().then(xmlText => {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlText, "application/xml");
    const claimNodes = xmlDoc.querySelectorAll('Claim');
    const claims = Array.from(claimNodes).map(claim => {
      const claimID = claim.querySelector('ID')?.textContent.trim() || '';
      const memberID = claim.querySelector('MemberID')?.textContent.trim() || '';
      const payerID = claim.querySelector('PayerID')?.textContent.trim() || '';
      const providerID = claim.querySelector('ProviderID')?.textContent.trim() || '';
      const encounterNodes = claim.querySelectorAll('Encounter');
      const encounters = Array.from(encounterNodes).map(enc => ({
        claimID,
        memberID,
        payerID,
        providerID,
        encounterStart: parseDate(enc.querySelector('Start')?.textContent.trim() || ''),
        clinician: enc.querySelector('Clinician')?.textContent.trim() || ''
      }));
      return { claimID, memberID, payerID, providerID, encounters };
    });
    const allEncounters = claims.flatMap(c => c.encounters);
    return { claimsCount: claims.length, encounters: allEncounters };
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
        let affiliatedPlan = "";
        let clinicianMismatch = false;
        let clinicianMismatchMsg = "";
        let memberID = (row["PatientCardID"] || "").toString().trim();

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
            if (!match) {
              remarks.push("Eligibility match is undefined.");
            } else {
              if (result.unknown) {
                remarks.push(
                  "Clinician mismatch - fallback eligibility used (marked unknown)",
                );
              }

              status = match["Status"] || "";
              if ((status || "").toLowerCase() !== "eligible")
                remarks.push(`Status not eligible (${status})`);

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

              const matchedGroup = validServices.find(
                (entry) =>
                  entry.cat === serviceCategory &&
                  (!entry.condition || entry.condition()),
              );

              if (!matchedGroup) {
                remarks.push(`Invalid Service Category: "${serviceCategory}"`);
              }

              const excelCard = (match["Card Number / DHA Member ID"] || "")
                .replace(/[-\s]/g, "")
                .trim();
              if (
                excelCard &&
                stripLeadingZero(row["PatientCardID"] || "") !==
                  stripLeadingZero(excelCard)
              ) {
                remarks.push(
                  "Card Number mismatch between XLS and Eligibility",
                );
              }

              const reportLic = (row["Clinician License"] || "").trim();
              const eligLic = (match["Clinician"] || "").trim();
              const reportName = (row["OrderDoctor"] || "").trim();
              const eligName = (match["Clinician Name"] || "").trim();

              if (reportLic && eligLic && reportLic !== eligLic) {
                clinicianMismatch = true;
                clinicianMismatchMsg = buildClinicianMismatchMsg(
                  reportLic,
                  eligLic,
                  reportName,
                  eligName,
                  "XLSX",
                  "Eligibility",
                );
              }
            }
          }
        }

        const formattedDate = (row["ClaimDate"] instanceof Date)
          ? excelDateToDDMMYYYY(row["ClaimDate"])
          : row["ClaimDate"];
        
        return {
          claimID: row["ClaimID"],
          memberID: row["PatientCardID"],
          payerID: row["Insurance Company"],
          affiliatedPlan,
          encounterStart: formattedDate,
          clinic: row["Clinic"] || "",
          details: match
            ? formatEligibilityDetailsModal(match, row["PatientCardID"])
            : formatReportDetailsModal(row, formattedDate),
          eligibilityRequestNumber:
            match?.["Eligibility Request Number"] || row["FileNo"] || null,
          status,
          remarks,
          match,
          unknown: clinicianMismatch && remarks.length === 0,
          clinicianMismatchMsg,
          serviceCategory: match?.["Service Category"] || "",
        };
      })
      .filter(Boolean); // remove skipped duplicates
  }

// --- Modified validateXmlWithEligibility ---
function validateXmlWithEligibility(xmlPayload, eligRows, insuranceLicenses) {
  const { encounters } = xmlPayload;
  const seenClaimIDs = new Set();

  return encounters
    .map((encounter) => {
      const claimID = encounter.claimID;
      if (seenClaimIDs.has(claimID)) return null;
      seenClaimIDs.add(claimID);

      const remarks = [];
      let match = null;
      let status = "";
      let affiliatedPlan = "";
      let clinicianMismatch = false;
      let clinicianMismatchMsg = "";
      let memberID = (encounter.memberID || "").toString().trim();

      if (memberID.startsWith("0")) {
        remarks.push("Member ID starts with 0 (invalid)");
      }

      if (/VVIP/i.test(memberID)) {
        status = "VVIP";
      } else {
        const result = findBestEligibilityMatch(
          memberID,
          encounter.encounterStart || "",
          (encounter.clinician || "").trim(),
          eligRows,
        );
        if (!result) {
          remarks.push("No eligibility rows found for card number");
        } else if (result.error) {
          remarks.push(result.error);
        } else {
          match = result.match;
          if (!match) {
            remarks.push("Eligibility match is undefined.");
          } else {
            if (result.unknown) {
              remarks.push(
                "Clinician mismatch - fallback eligibility used (marked unknown)",
              );
            }

            status = match["Status"] || "";
            if ((status || "").toLowerCase() !== "eligible")
              remarks.push(`Status not eligible (${status})`);

            const excelCard = (match["Card Number / DHA Member ID"] || "")
              .replace(/[-\s]/g, "")
              .trim();
            if (
              excelCard &&
              stripLeadingZero(encounter.memberID || "") !==
                stripLeadingZero(excelCard)
            ) {
              remarks.push(
                "Card Number mismatch between XML and Eligibility",
              );
            }

            const reportLic = (encounter.clinician || "").trim();
            const eligLic = (match["Clinician"] || "").trim();
            const reportName = "";
            const eligName = (match["Clinician Name"] || "").trim();

            if (reportLic && eligLic && reportLic !== eligLic) {
              clinicianMismatch = true;
              clinicianMismatchMsg = buildClinicianMismatchMsg(
                reportLic,
                eligLic,
                reportName,
                eligName,
                "XML",
                "Eligibility",
              );
            }

            const excelProviderLicense = (
              match["Provider License"] || ""
            ).trim();
            const claimProviderID = (encounter.providerID || "").trim();
            if (
              claimProviderID &&
              excelProviderLicense &&
              claimProviderID !== excelProviderLicense
            ) {
              remarks.push(
                `ProviderID does not match Provider License in eligibility (XML: "${claimProviderID}", Excel: "${excelProviderLicense}")`,
              );
            }
          }
        }
      }

      // 🆕 Format encounterStart date for display
      const formattedDate =
        encounter.encounterStart instanceof Date
          ? excelDateToDDMMYYYY(encounter.encounterStart)
          : encounter.encounterStart;

      return {
        claimID: encounter.claimID,
        memberID: encounter.memberID,
        payerID: encounter.payerID,
        affiliatedPlan,
        encounterStart: formattedDate,
        clinic: encounter.clinic || '',
        details: match
          ? formatEligibilityDetailsModal(match, encounter.memberID)
          : "",
        eligibilityRequestNumber:
          match?.["Eligibility Request Number"] || null,
        status,
        remarks,
        match,
        unknown: clinicianMismatch && remarks.length === 0,
        clinicianMismatchMsg,
      };
    })
    .filter(Boolean); // remove skipped duplicates
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

  function buildTableContainer(containerId = "results") {
    const c = document.getElementById(containerId);
    c.innerHTML = `<table class="shared-table">
        <thead><tr>
          <th>#</th>
          <th>ID</th>
          <th>MemberID</th>
          <th>PayerID & Plan</th>
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

  function createRow(r, index, { modal, modalContent }) {
    const row = document.createElement("tr");
    if (r.unknown) {
      row.classList.add("unknown");
    } else if (r.remarks.length) {
      row.classList.add("invalid");
    } else {
      row.classList.add("valid");
    }

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

    let payerIDPlan = r.payerID || "";
    if (r.affiliatedPlan) {
      payerIDPlan += ` (${r.affiliatedPlan})`;
    }

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
      <td class="wrap-col">${payerIDPlan}</td>
      <td>${r.encounterStart || ""}</td>
      <td></td>
      <td>${r.status || ""}</td>
      <td>${r.serviceCategory || ""}</td>
      <td>${r.clinic || ""}</td>
      <td style="white-space: pre-line;">${remarksCellHtml}</td>
    `;

    row.querySelector("td:nth-child(6)").replaceWith(tdBtn);
    return row;
  }

// ✅ Enhanced parseDate with ambiguity handling (X/Y/Z)
// Parses a date string, number, or Date object to a JS Date or null if invalid
function parseDate(value) {
  if (value === null || value === undefined) return null;

  if (value instanceof Date) return value;

  if (typeof value === 'number') {
    // Excel serial date (days since 1899-12-31)
    const jsDate = new Date(Math.round((value - 25569) * 86400 * 1000));
    return !isNaN(jsDate.getTime()) ? jsDate : null;
  }

  if (typeof value !== 'string') return null;

  // Try to parse dd/mm/yyyy or mm/dd/yyyy with - or /
  let parts = value.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (parts) {
    let [ , x, y, z ] = parts.map(v => parseInt(v, 10));
    let day, month;

    if (x > 12 && y <= 12) { day = x; month = y; }
    else if (y > 12 && x <= 12) { day = y; month = x; }
    else { day = x; month = y; }

    const year = z < 100 ? 2000 + z : z;
    const d = new Date(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T00:00:00`);
    if (!isNaN(d.getTime())) return d;
  }

  // Try dd-MMM-yyyy with optional time, e.g. 11-jan-1900 or 11-jan-1900 13:45:00
  let namedMonth = value.match(/^(\d{1,2})-([a-zA-Z]{3})-(\d{4})(?:\s+(\d{2}):(\d{2}):(\d{2}))?$/);
  if (namedMonth) {
    const day = namedMonth[1].padStart(2, '0');
    const mmm = namedMonth[2].toLowerCase();
    const year = namedMonth[3];
    const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
    const mm = months.indexOf(mmm) + 1;
    if (mm === 0) return null;
    const hh = namedMonth[4] || '00';
    const mi = namedMonth[5] || '00';
    const ss = namedMonth[6] || '00';
    const d = new Date(`${year}-${String(mm).padStart(2, '0')}-${day}T${hh}:${mi}:${ss}`);
    if (!isNaN(d.getTime())) return d;
  }

  // Try ISO date parsing fallback
  const iso = new Date(value);
  return !isNaN(iso.getTime()) ? iso : null;
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

xmlInput.addEventListener("change", async (e) => {
  status.textContent = "Loading XML…";
  processBtn.disabled = true;
  try {
    xmlData = await parseXML(e.target.files[0]);
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
