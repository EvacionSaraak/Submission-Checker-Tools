// checker_elig.js

window.addEventListener("DOMContentLoaded", () => {
  // Input/group selectors
  const xmlInput = document.getElementById("xmlFileInput");
  const reportInput = document.getElementById("reportFileInput");
  const eligInput = document.getElementById("eligibilityFileInput");
  const xmlGroup = document.getElementById("xmlReportInputGroup");
  const reportGroup = document.getElementById("reportInputGroup");
  const eligGroup = document.getElementById("eligibilityInputGroup");
  const processBtn = document.getElementById("processBtn");
  const status = document.getElementById("uploadStatus");

  // Radio selectors
  const xmlRadio = document.querySelector('input[name="reportSource"][value="xml"]',);
  const xlsRadio = document.querySelector('input[name="reportSource"][value="xls"]',);

  // Data holders
  let xmlData = null;
  let xlsData = null;
  let csvData = null;
  let eligData = null;
  let insuranceLicenses = null;
  let filteredXlsData = null; // new cache variable

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

function normalizeMemberID(id) {
  if (!id) return "";
  return String(id)
    .replace(/[^a-z0-9]/gi, "") // Remove all non-alphanumeric
    .replace(/^0+/, "")         // Remove leading zeros
    .toUpperCase();             // Standardize case
}

// Helper function to check if eligibility status is valid (only "Eligible" allowed)
function isEligibilityStatusValid(status) {
  if (!status) return false;
  const normalizedStatus = status.trim().toLowerCase();
  return normalizedStatus === 'eligible';
}

  function swapInputGroups() {
    if (xmlRadio.checked) {
      xmlGroup.style.display = "";
      reportGroup.style.display = "none";
    } else {
      xmlGroup.style.display = "none";
      reportGroup.style.display = "";
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

// 1) parseCsvAsXlsx — convert the CSV to an in-memory workbook and map Insta fields
// Updated parseCsvAsXlsx — dynamically locate the “MemberID” column by header text
// parseCsvAsXlsx — now maps all necessary columns including MemberID, Clinician License, Insurance Company, etc.
async function parseCsvAsXlsx(file) {
  console.log("-------------PARSING AS CSV, CONVERTING TO XLSX-------------");
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const csvText = e.target.result;
        const workbook = XLSX.read(csvText, { type: 'string' });
        const sheet    = workbook.Sheets[workbook.SheetNames[0]];
        const allRows  = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
        const dataRows = allRows.slice(3); // skip 3 metadata lines

        if (dataRows.length < 2) return resolve([]);

        const [headers, ...values] = dataRows;
        // find indices
        const indexOf = key => headers.findIndex(h => new RegExp(key, 'i').test(h));
        const idx = {
          ClaimID:             indexOf('Pri\\. Claim No'),
          MemberID:            indexOf('Patient Insurance Card No'),
          ClaimDate:           indexOf('Encounter Date'),
          ClinicianLicense:    indexOf('Clinician License'),
          InsuranceCompany:    indexOf('Pri\\. Payer Name'),
          Clinic:              indexOf('Department'),
          Status:              indexOf('Codification Status'),
          PackageName:         indexOf('Pri\\. Plan Name'),
        };

        const mapped = values.map((rowArr, i) => ({
          ClaimID:            rowArr[idx.ClaimID]?.toString().trim() || "",
          MemberID:           rowArr[idx.MemberID]?.toString().trim()  || "",
          ClaimDate:          parseDate(rowArr[idx.ClaimDate])        || null,
          "Clinician License": rowArr[idx.ClinicianLicense]?.toString().trim() || "",
          "Insurance Company": rowArr[idx.InsuranceCompany]?.toString().trim() || "",
          Clinic:             rowArr[idx.Clinic]?.toString().trim()   || "",
          Status:             rowArr[idx.Status]?.toString().trim()   || "",
          "Package Name":     rowArr[idx.PackageName]?.toString().trim() || "",
        }));

        // 🔥 DEBUG: first mapped entry
        console.log("DEBUG mapped first row:", mapped[0]);

        resolve(mapped);
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

// ✅ Modified parseExcel to normalize ClaimDate for report rows
async function parseExcel(file, range = 0) {
  console.log("-------------PARSING AS XLSX-------------");
  const reader = new FileReader();
  return new Promise((resolve, reject) => {
    reader.onload = e => {
      try {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: 'array' });
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        if (!worksheet) throw new Error('No worksheet found in uploaded file.');
        
        // First get all headers to detect MemberID column
        const allHeaders = XLSX.utils.sheet_to_json(worksheet, { header: 1, range: 0 })[0];
        const memberIdHeader = allHeaders.find(h => 
          h && typeof h === 'string' && 
          /(member|card|patient|id)/i.test(h.replace(/[^a-z]/gi, ''))
          || "MemberID";)

        const json = XLSX.utils.sheet_to_json(worksheet, { 
          defval: '', 
          range,
          header: allHeaders // Use detected headers
        });

        // Normalize data with proper MemberID
        json.forEach(row => {
          if (row["ClaimDate"]) {
            row["ClaimDate"] = parseDate(row["ClaimDate"]);
          }
          // Ensure MemberID exists and is string
          row["MemberID"] = String(row[memberIdHeader] || "").trim();
        });

        console.log("First parsed row:", json[0]);
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

// 2) validateInstaWithEligibility — match each Insta row against eligData
// validateInstaWithEligibility — ensure memberID is set from instaRows before matching
// The Insta validate function remains the same—now row.MemberID will be correctly populated
// validateInstaWithEligibility — match eligibility by Card Number / DHA Member ID vs row.MemberID
// validateInstaWithEligibility — now normalizes insurance names before comparing
// In validateInstaWithEligibility, format encounterStart date
function validateInstaWithEligibility(instaRows, eligData) {
  const results = [];
  const eligByCard = {};
  const seenClaimIDs = new Set(); // Deduplication tracker

  eligData.forEach(e => {
    let card = (e['Card Number / DHA Member ID'] || '').toString().replace(/[-\s]/g, '').trim();
    if (card.startsWith('0')) card = card.slice(1);
    (eligByCard[card] = eligByCard[card] || []).push(e);
  });

  function normalizeInsurer(name) {
    if (!name) return '';
    const key = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  
    const aliases = {
      // THIQA variations
      'thiqanationalhealthinsurancecompanydaman': 'thiqa',
      'damanthiqá': 'thiqa',
      'damanthiqa': 'thiqa',
      'thiqa': 'thiqa',
  
      // DAMAN variations
      'damanenhanced': 'daman',
      'daman-nationalhealthinsurancecodamanpjsc': 'daman',
      'damannationalinsuranceco': 'daman',
      'damannationalinsurancecodamanpjsc': 'daman',
      'damannationalhealthinsurancecodamanpjsc': 'daman',
      'damannationalhealthinsurancecompany': 'daman',
      'damannationalhealthinsuranceco': 'daman',
      'damannationalhealthinsurancecodamandamanpjsc': 'daman',
      'damannationalhealthinsurancecompanydaman': 'daman',
  
      // NAS variations
      'nasadministrationservicesllc': 'nas',
      'nasadministrationserviceslimited': 'nas',
    };
  
    if (key.includes('daman')) return 'daman';
    if (key.includes('thiqa')) return 'thiqa';
    if (key.includes('nas')) return 'nas';
  
    return aliases[key] || key;
  }

  instaRows.forEach(row => {
    const claimID = (row.ClaimID || '').toString().trim();
    if (!claimID || seenClaimIDs.has(claimID)) return; // Skip duplicates
    seenClaimIDs.add(claimID);
  
    let memberID = (row.MemberID || '').toString().replace(/[-\s]/g, '').trim();
    if (memberID.startsWith('0')) memberID = memberID.slice(1);
  
    const eligRows = eligByCard[memberID] || [];
    const remarks = [];
    let match = null, unknown = false;
  
    // Parse the claim date here:
    const cDate = row.ClaimDate instanceof Date ? row.ClaimDate : parseDate(row.ClaimDate);
  
    if (!eligRows.length) {
      remarks.push("No eligibility found for MemberID/Card Number");
    } else {
      const best = findBestEligibilityMatch(memberID, cDate, row["Clinician License"], eligRows);
  
      if (!best || best.error) {
        remarks.push(best?.error || "No matching eligibility on or before claim date");
      } else {
        match = best.match;
        unknown = best.unknown;
  
        const st = (match['Status'] || "").toLowerCase();
        if (st !== "eligible") {
          remarks.push(`Status not eligible (${match['Status']})`);
        }
  
        const start = match['EffectiveDate'] || match['Effective Date'] || match['Ordered On'];
        const end   = match['Answered On'];
        if (start && end && !isWithinEligibilityPeriod(cDate, parseDate(start), parseDate(end))) {
          remarks.push("Claim date outside eligibility period");
        }
  
        const insCsv = normalizeInsurer(row["Insurance Company"]);
        const insElig = normalizeInsurer(match["Payer Name"]);
        if (insCsv && insElig && insCsv !== insElig) {
          remarks.push(`Insurance Company mismatch (CSV: "${row["Insurance Company"]}", Elig: "${match["Payer Name"]}")`);
        }
      }
    }
  
    results.push({
      claimID: row.ClaimID,
      memberID,
      insuranceCompany: row["Insurance Company"],
      packageName: row["Package Name"],
      encounterStart: cDate ? excelDateToDDMMYYYY(cDate) : row.ClaimDate,
      clinicianID: row["Clinician License"],
      status: match?.['Status'] || "",
      clinic: row.Clinic,
      remarks,
      unknown,
      eligibilityRequestNumber: match?.["Eligibility Request Number"] || "",
      serviceCategory: (match?.["Service Category"] || "").trim(),
      details: match ? formatEligibilityDetailsModal(match, memberID) : ""
    });
  });
  return results;
}
  
  // --- Modified validateClinicProWithEligibility ---
function validateClinicProWithEligibility(reportRows, eligRows) {
  const seenClaimIDs = new Set();
  const usedEligSet = new Set();

  // Enhanced eligibility mapping - handles multiple ID formats
  const eligByCard = {};
  eligRows.forEach((e, idx) => {
    // Try multiple possible ID fields
    const cardKeys = [
      "Card Number / DHA Member ID",
      "MemberID",
      "PatientCardID",
      "InsuranceCardNo"
    ];
    
    let cardNumber = "";
    for (const key of cardKeys) {
      const val = e[key];
      if (val && typeof val === 'string' && val.trim()) {
        cardNumber = val.replace(/[-\s]/g, "").replace(/^0+/, "").trim();
        break;
      }
    }

    if (cardNumber) {
      (eligByCard[cardNumber] = eligByCard[cardNumber] || []).push({ ...e, __rowIndex: idx });
    }
  });

  return reportRows
    .map((row) => {
      const claimID = row["ClaimID"];
      if (!claimID || seenClaimIDs.has(claimID)) return null;
      seenClaimIDs.add(claimID);

      // Enhanced MemberID extraction
      let memberID = (row["MemberID"] || "").toString().replace(/[-\s]/g, "").trim();
      const originalMemberID = memberID;
      
      const remarks = [];
      let match = null;
      let status = "";
      let clinicianMismatch = false;
      let clinicianMismatchMsg = "";
      const reportInsurer = (row["Insurance Company"] || "").trim();

      if (!memberID) {
        remarks.push("MemberID missing in report row");
      } else {
        if (memberID.startsWith("0")) {
          memberID = memberID.substring(1);
          remarks.push("Stripped leading zero from MemberID");
        }

        const cDate = row["ClaimDate"];
        const clinicianID = (row["Clinician License"] || "").trim();

        // Enhanced matching logic
        const eligList = eligByCard[memberID] || [];
        const bestMatch = eligList.find((e) => {
          const key = `${memberID}::${e["Eligibility Request Number"]}`;
          if (usedEligSet.has(key)) return false;
          
          const eligClin = (e["Clinician"] || "").trim();
          const date = parseDate(cDate);
          const start = parseDate(e["EffectiveDate"] || e["Ordered On"]);
          const end = parseDate(e["Answered On"] || e["ExpiryDate"]);
          
          return (!clinicianID || clinicianID === eligClin) &&
                 (!date || !start || date >= start) &&
                 (!date || !end || date <= end);
        });

        if (!bestMatch) {
          remarks.push("No matching eligibility found for MemberID");
        } else {
          match = bestMatch;
          const matchKey = `${memberID}::${match["Eligibility Request Number"]}`;
          usedEligSet.add(matchKey);
          status = match["Status"] || "";
          if (status.toLowerCase() !== "eligible") {
            remarks.push(`Status not eligible (${status})`);
          }

          // Insurance company check
          const eligInsurer = (match["Payer Name"] || "").trim();
          if (
            reportInsurer &&
            eligInsurer &&
            !eligInsurer.toLowerCase().includes(reportInsurer.toLowerCase()) &&
            !reportInsurer.toLowerCase().includes(eligInsurer.toLowerCase())
          ) {
            remarks.push(`Insurance Company mismatch (XLS: "${reportInsurer}", Elig: "${eligInsurer}")`);
          }

          // Service Category check
          const svc = (match["Service Category"] || "").trim();
          const consultStatus = (match["Consultation Status"] || "").trim().toLowerCase();
          const isValid =
            (svc === "Consultation" && consultStatus === "elective") ||
            svc === "Dental Services" ||
            svc === "Physiotherapy" ||
            svc === "Other OP Services";

          if (!isValid) {
            remarks.push(`Invalid Service Category: "${svc}"`);
          }

          // Card mismatch check
          const rawEligCard = (match["Card Number / DHA Member ID"] || "").replace(/[-\s]/g, "").trim();
          if (stripLeadingZero(rawEligCard) !== stripLeadingZero(originalMemberID)) {
            remarks.push("Card Number mismatch between XLS and Eligibility");
          }

          // Clinician mismatch check
          const eligLic = (match["Clinician"] || "").trim();
          const reportLic = (row["Clinician License"] || "").trim();
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

      const unknown = clinicianMismatch && remarks.length === 0;
      if (unknown) {
        remarks.push("Clinician mismatch (treated as unknown)");
      }

      const formattedDate =
        row["ClaimDate"] instanceof Date
          ? excelDateToDDMMYYYY(row["ClaimDate"])
          : row["ClaimDate"];

      return {
        claimID,
        memberID: originalMemberID,
        insuranceCompany: reportInsurer,
        affiliatedPlan: "",
        encounterStart: formattedDate,
        clinic: row["Clinic"] || "",
        packageName: match?.["Package Name"] || "",
        details: match
          ? formatEligibilityDetailsModal(match, originalMemberID)
          : formatReportDetailsModal(row, formattedDate),
        eligibilityRequestNumber:
          match?.["Eligibility Request Number"] || row["FileNo"] || null,
        status,
        remarks,
        match,
        unknown,
        clinicianMismatchMsg,
        serviceCategory: match?.["Service Category"] || ""
      };
    })
    .filter(Boolean);
}

function validateXmlWithEligibility(xmlPayload, eligRows) {
  const { encounters, claims } = xmlPayload;
  const seenClaimIDs = new Set();
  const usedEligSet = new Set();

  // Build claims lookup by claimID for extra info (packageName, providerID)
  const claimsById = {};
  if (claims && Array.isArray(claims)) {
    claims.forEach(claim => {
      if (claim.ID) claimsById[claim.ID] = claim;
    });
  }

  // Build eligibility map by normalized card number (strip leading zeros, no blanks)
  const eligByCard = {};
  eligRows.forEach((e, idx) => {
    let card = (e["Card Number / DHA Member ID"] || "").toString().replace(/[-\s]/g, "").trim();
    if (!card) return;
    card = card.replace(/^0+/, ''); // Normalize card by stripping leading zeros
    (eligByCard[card] = eligByCard[card] || []).push({ ...e, __rowIndex: idx });
  });

  return encounters
    .map(enc => {
      const {
        claimID,
        memberID,
        encounterStart,
        claimClinician,
        multipleClinicians,
        clinic: encClinic,
        FacilityID
      } = enc;

      if (!claimID || seenClaimIDs.has(claimID)) return null;
      seenClaimIDs.add(claimID);

      const remarks = [];
      let match = null;
      let status = "";
      let clinicianMismatch = false;
      let clinicianMismatchMsg = "";

      if (multipleClinicians) {
        remarks.push("Multiple clinicians in claim activities");
      }

      if (!memberID) {
        remarks.push("MemberID missing in XML");
      }

      // Normalize memberID: strip spaces, hyphens, leading zeros
      let normalizedMemberID = "";
      if (memberID) {
        normalizedMemberID = memberID.toString().replace(/[-\s]/g, "").replace(/^0+/, '');
        if (normalizedMemberID !== memberID.toString()) {
          remarks.push("MemberID had leading zeros; normalized for matching");
        }
      }

      if (normalizedMemberID) {
        const eligList = eligByCard[normalizedMemberID] || [];

        // Find best eligibility match with date and clinician checks, and unused eligibility
        const bestMatch = eligList.find(e => {
          const key = `${normalizedMemberID}::${e["Eligibility Request Number"]}`;
          if (usedEligSet.has(key)) return false;

          const eligClin = (e["Clinician"] || "").trim();
          const date = parseDate(encounterStart);
          const start = parseDate(e["EffectiveDate"] || e["Ordered On"]);
          const end = parseDate(e["Answered On"] || e["ExpiryDate"]);

          const clinicianMatch = !claimClinician || claimClinician === eligClin;
          const dateValid = !date || (!start || date >= start) && (!end || date <= end);

          return clinicianMatch && dateValid;
        });

        if (!bestMatch) {
          remarks.push("No eligibility rows found for card number");
        } else {
          match = bestMatch;
          const matchKey = `${normalizedMemberID}::${match["Eligibility Request Number"]}`;
          usedEligSet.add(matchKey);

          status = match["Status"] || "";

          // Service Category & Consultation Status validation
          const svc = (match["Service Category"] || "").trim();
          const consultStatus = (match["Consultation Status"] || "").trim().toLowerCase();

          if (svc === "Consultation" && consultStatus !== "elective") {
            remarks.push(`Consultation must be Elective (got "${consultStatus}")`);
          } else if (!["Dental Services", "Physiotherapy", "Other OP Services", "Consultation"].includes(svc)) {
            remarks.push(`Invalid Service Category: "${svc}"`);
          }

          if (status.toLowerCase() !== "eligible") {
            remarks.push(`Status not eligible (${status})`);
          }

          // Check insurance company mismatch between XML claim clinic or facility and eligibility payer
          const eligPayer = (match["Payer Name"] || "").trim();
          // (Optional: add your insurance company validation here if needed)

          // Clinician mismatch check
          const eligClin = (match["Clinician"] || "").trim();
          if (claimClinician && eligClin && claimClinician !== eligClin) {
            clinicianMismatch = true;
            clinicianMismatchMsg = buildClinicianMismatchMsg(
              claimClinician,
              eligClin,
              "",
              match["Clinician Name"] || "",
              "XML Activities",
              "Eligibility"
            );
          }
        }
      }

      const unknown = clinicianMismatch && remarks.length === 0;
      if (unknown) {
        remarks.push("Clinician mismatch (treated as unknown)");
      }

      const claimData = claimsById[claimID] || {};
      const formattedDate = (() => {
        const parsedDate = parseDate(encounterStart);
        return parsedDate ? excelDateToDDMMYYYY(parsedDate) : encounterStart;
      })();

      return {
        claimID,
        memberID,
        encounterStart: formattedDate,
        details: match ? formatEligibilityDetailsModal(match, memberID) : "",
        eligibilityRequestNumber: match?.["Eligibility Request Number"] || null,
        status,
        remarks,
        unknown,
        clinicianMismatchMsg,
        insuranceCompany: match?.["Payer Name"] || "",
        packageName: claimData.Contract?.PackageName || match?.["Package Name"] || "",
        serviceCategory: match?.["Service Category"] || "",
        clinic: encClinic || FacilityID || claimData.ProviderID || "",
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
      { label: "Member ID", value: memberID },
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

// renderResults — now logs each row's data before creating and appending it
function renderResults(results, containerId = "results") {
  const tbody = buildTableContainer(containerId);
  const modalElements = setupModal(containerId);

  if (results.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:#888;">No matching rows found.</td></tr>`;
    return;
  }

  results.forEach((r, i) => {
    console.log(`Debug: rendering row #${i + 1}`, r);  // log row data for debug
    const rowEl = createRow(r, i, modalElements);
    tbody.appendChild(rowEl);
  });
}

// Updated createRow with correct details button placement (7th cell)
// createRow — add “description-col” class to Insurance Company, Package Name, and Encounter Start cells
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
    <td class="wrap-col description-col">${r.insuranceCompany || ""}</td>  <!-- truncated -->
    <td class="wrap-col description-col">${r.packageName || ""}</td>      <!-- truncated -->
    <td class="wrap-col description-col">${r.encounterStart || ""}</td>            <!-- truncated -->
    <td></td>
    <td>${r.status || ""}</td>
    <td>${r.serviceCategory || ""}</td>
    <td>${r.clinic || ""}</td>
    <td style="white-space: pre-line;">${remarksCellHtml}</td>
  `;

  // Replace the placeholder cell (7th) with our details button
  row.querySelector("td:nth-child(7)").replaceWith(tdBtn);

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

function isValidClaimID(id) {
  if (!id) return false;
  const trimmed = id.trim();
  if (trimmed === "") return false;
  // Example regex: starts with letters, optional letters, then digits, no spaces
  return /^[A-Z]+[A-Z]*\d+$/i.test(trimmed);
}

function updateStatus() {
  const usingXml = xmlRadio.checked;
  const xmlLoaded = !!xmlData;
  const xlsLoaded = !!xlsData;
  const eligLoaded = !!eligData;
  const licensesLoaded = !!insuranceLicenses;
  const msgs = [];

  if (usingXml && xmlLoaded) {
    const claimIDs = new Set((xmlData.encounters || []).map((r) => r.claimID));
    const count = claimIDs.size;
    msgs.push(`${count} unique Claim ID${count !== 1 ? "s" : ""} loaded`);
  }

  if (!usingXml && xlsLoaded) {
    const allRows = xlsData || [];
    const claimIDs = new Set(allRows.map((r) => r["ClaimID"]));
    const count = claimIDs.size;

    // Define isCsvFile before using it!
    const isCsvFile = allRows.length > 0 && (
      Object.prototype.hasOwnProperty.call(allRows[0], "Pri. Claim No") &&
      Object.prototype.hasOwnProperty.call(allRows[0], "Pri. Patient Insurance Card No")
    );

    const label = isCsvFile ? "CSV" : "XLS";
    msgs.push(`${allRows.length} ${label} row${allRows.length !== 1 ? "s" : ""} loaded (${count} unique Claim ID${count !== 1 ? "s" : ""})`);
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
  exportInvalidBtn.disabled = true;
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

// 1) In your report input listener, detect .csv and call parseCsvAsXlsx
reportInput.addEventListener("change", async (e) => {
  status.textContent = "Loading report…";
  exportInvalidBtn.disabled = true;
  processBtn.disabled = true;
  const file = e.target.files[0];
  if (!file) return;
  const isCsv = file.name.toLowerCase().endsWith(".csv");
  try {
    if (isCsv) {
      // use the XLSX-based CSV parser
      xlsData = await parseCsvAsXlsx(file);
    } else {
      xlsData = await parseExcel(file, 0);
    }

    const invalids = validateDatesInData(
      xlsData,
      ["ClaimDate"],
      isCsv ? "CSV" : "XLS"
    );
    if (invalids.length) {
      console.warn(`Invalid dates in ${isCsv ? "CSV" : "XLS"}:`, invalids);
      status.textContent = `Warning: ${invalids.length} invalid date(s). Check console.`;
    }
  } catch (err) {
    status.textContent = `${isCsv ? "CSV" : "XLS"} load error: ${err.message}`;
    xlsData = null;
  }

  updateStatus();
});

eligInput.addEventListener("change", async (e) => {
  status.textContent = "Loading Eligibility XLSX…";
  exportInvalidBtn.disabled = true;
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
  const tbody = document.querySelector("#results tbody");
  if (tbody) tbody.innerHTML = ""; // ✅ Clear previous results

  if (xmlRadio.checked) {
    if (!xmlData || !eligData) {
      alert("Please upload both XML and Eligibility XLSX.");
      return;
    }

    status.textContent = "Validating XML…";
    processBtn.disabled = true;

    const results = validateXmlWithEligibility(xmlData, eligData);
    renderResults(results);

    const validCount = results.filter(r => r.unknown || r.remarks.length === 0).length;
    const totalCount = results.length;
    status.textContent = `Valid: ${validCount} / ${totalCount} (${totalCount ? Math.round(validCount / totalCount * 100) : 0}%)`;

    processBtn.disabled = false;
  } else {
    if (!xlsData || !eligData) {
      alert("Please upload both report file and Eligibility XLSX.");
      return;
    }

    status.textContent = "Validating…";
    processBtn.disabled = true;

    const isCsv = xlsData.length > 0 && Object.prototype.hasOwnProperty.call(xlsData[0], "MemberID");
    let results;
    if (isCsv) {
      results = validateInstaWithEligibility(xlsData, eligData);
    } else {
      results = validateClinicProWithEligibility(xlsData, eligData);
    }

    renderResults(results);

    const validCount = results.filter(r => r.unknown || r.remarks.length === 0).length;
    const totalCount = results.length;
    status.textContent = `Valid: ${validCount} / ${totalCount} (${totalCount ? Math.round(validCount / totalCount * 100) : 0}%)`;

    processBtn.disabled = false;
  }
});

  function exportInvalidRowsXLSX({ results, reportRows = [], eligRows = [], mode = "insta" }) {
    if (!Array.isArray(results) || results.length === 0) {
      alert("No results to export.");
      return;
    }
  
    const invalids = results.filter(r => !r.unknown && r.remarks.length > 0);
    if (invalids.length === 0) {
      alert("No invalid rows to export.");
      return;
    }
  
    const eligByRequest = {};
    eligRows.forEach(e => {
      const key = e["Eligibility Request Number"];
      if (key) eligByRequest[key] = e;
    });
  
    const final = invalids.map(r => {
      const base = (mode === "insta")
        ? reportRows.find(s => s["ClaimID"] === r.claimID)
        : { ClaimID: r.claimID, MemberID: r.memberID };
  
      const elig = r.eligibilityRequestNumber ? eligByRequest[r.eligibilityRequestNumber] : {};
      return {
        ...base,
        ...elig,
        Remarks: r.remarks.join(" | ")
      };
    });
  
    const ws = XLSX.utils.json_to_sheet(final);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Invalid Rows");
    XLSX.writeFile(wb, "invalid_claims.xlsx");
  }


  
  swapInputGroups();
});
