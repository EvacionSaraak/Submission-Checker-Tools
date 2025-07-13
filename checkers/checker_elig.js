// checker_elig.js
window.addEventListener("DOMContentLoaded", () => {
  console.log("DOM fully loaded and parsed");
  
  // =====================
  // DOM INITIALIZATION
  // =====================
  const VALID_SERVICES = ['Consultation', 'Dental Services', 'Physiotherapy'];
  const DATE_KEYS = ['Date', 'On'];
  const MONTHS = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];

  const xmlInput = document.getElementById("xmlFileInput");
  const reportInput = document.getElementById("reportFileInput");
  const eligInput = document.getElementById("eligibilityFileInput");
  const xmlGroup = document.getElementById("xmlReportInputGroup");
  const reportGroup = document.getElementById("reportInputGroup");
  const eligGroup = document.getElementById("eligibilityInputGroup");
  const processBtn = document.getElementById("processBtn");
  const status = document.getElementById("uploadStatus");
  const xmlRadio = document.querySelector('input[name="reportSource"][value="xml"]');
  const xlsRadio = document.querySelector('input[name="reportSource"][value="xls"]');

  console.log("DOM elements initialized:", {
    xmlInput, reportInput, eligInput, xmlGroup, reportGroup, 
    eligGroup, processBtn, status, xmlRadio, xlsRadio
  });

  // =====================
  // DATA HOLDERS
  // =====================
  let xmlData = null, xlsData = null, eligData = null, insuranceLicenses = null;
  console.log("Data holders initialized");

  // =====================
  // UTILITY FUNCTIONS
  // =====================
  function findUnusedEligibility(eligibilities, claimDate, usedEligibilities) {
    // Try to find eligibility within date range and not already used
    let match = eligibilities.find(e => {
      if (usedEligibilities.has(e['Eligibility Request Number'])) return false;
      const start = parseDate(e.EffectiveDate || e['Ordered On']);
      const end = parseDate(e.ExpiryDate || e['Answered On']);
      return (!claimDate || !start || claimDate >= start) && (!claimDate || !end || claimDate <= end);
    });
    if (match) return match;
  
    // If no date-matched found, find any unused eligibility
    return eligibilities.find(e => !usedEligibilities.has(e['Eligibility Request Number'])) || null;
  }

  // Normalize member IDs by removing non-digits and leading zeros
  const normalizeMemberID = id => {
    const normalized = id ? String(id).replace(/\D/g, '').replace(/^0+/, '') : '';
    console.debug(`Normalizing ID: ${id} => ${normalized}`);
    return normalized;
  };

  function escapeHtml(unsafe) {
    if (!unsafe) return '';
    return unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
  }

  // Format Excel/JS dates to DD/MM/YYYY
  function excelDateToDDMMYYYY(date) {
    console.debug("Formatting date:", date);
    if (!date) return "";
    if (date instanceof Date && isNaN(date)) return "";
    if (date instanceof Date) {
      return `${String(date.getDate()).padStart(2, "0")}/${String(date.getMonth() + 1).padStart(2, "0")}/${date.getFullYear()}`;
    }
    if (typeof date === "string") {
      if (/\d{1,2}\/\d{1,2}\/\d{2,4}/.test(date)) return date;
      if (/\d{4}-\d{2}-\d{2}/.test(date)) return date.split("-").reverse().join("/");
    }
    try {
      const parsed = new Date(Math.round((date - 25569) * 86400 * 1000));
      return isNaN(parsed) ? "" : parsed.toLocaleDateString("en-GB");
    } catch (err) {
      console.error("Failed to convert Excel date:", date, err);
      return "";
    }
  }

  function parseDate(val) {
    if (!val) return null;
    if (val instanceof Date) return val;
    if (typeof val === "number") return new Date(Math.round((val - 25569) * 86400 * 1000));
  
    const formats = [
      /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/,
      /^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/,
      /^(\d{1,2})[\/\-]([a-z]{3})[\/\-](\d{4})$/i
    ];
  
    for (const regex of formats) {
      const parts = val.match(regex);
      if (!parts) continue;
  
      let day, month, year;
      if (parts[2] && isNaN(parts[2])) {
        day = parseInt(parts[1]);
        month = MONTHS.indexOf(parts[2].toLowerCase());
        year = parseInt(parts[3]);
      } else if (parts[1] > 31) {
        year = parseInt(parts[1]);
        month = parseInt(parts[2]) - 1;
        day = parseInt(parts[3]);
      } else {
        day = parseInt(parts[1]);
        month = parseInt(parts[2]) - 1;
        year = parseInt(parts[3]) + (parts[3].length === 2 ? 2000 : 0);
        if (day > 12 && month <= 11) [day, month] = [month + 1, day - 1];
      }
  
      const dateObj = new Date(year, month, day);
      if (!isNaN(dateObj.getTime())) return dateObj;
    }
  
    return new Date(val); // Fallback
  }

  function formatEligibilityDetailsModal(eligRecord, memberID) {
    if (!eligRecord) return "<p>No eligibility details available</p>";
    
    // Create a table with all eligibility fields
    let html = `
        <h3>Eligibility Details for Member: ${memberID}</h3>
        <table class="eligibility-details">
            <tbody>
    `;
    
    // Add all fields from the eligibility record
    Object.entries(eligRecord).forEach(([key, value]) => {
        // Format dates properly
        if (key.includes('Date') || key.includes('On')) {
            value = excelDateToDDMMYYYY(parseDate(value)) || value;
        }
        
        html += `
            <tr>
                <th>${key}</th>
                <td>${value || ''}</td>
            </tr>
        `;
    });
    
    html += `
            </tbody>
        </table>
    `;
    
    return html;
}

  // =====================
  // FILE PARSING
  // =====================
  // Parse CSV files using SheetJS
  async function parseCsv(file) {
    console.log("Starting CSV parsing for file:", file.name);
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = e => {
        try {
          console.log("CSV file read successfully");
          const workbook = XLSX.read(e.target.result, { type: 'string' });
          console.log("Workbook parsed with sheets:", workbook.SheetNames);
          const sheet = workbook.Sheets[workbook.SheetNames[0]];
          const [headers, , , ...rows] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
          
          console.log("CSV headers:", headers);
          console.log("First 3 rows:", rows.slice(0, 3));

          // Column mapping
          const getCol = name => headers.findIndex(h => new RegExp(name, "i").test(h));
          const colMap = {
            ClaimID: getCol('Pri\\. Claim No'),
            MemberID: getCol('Patient Insurance Card No'),
            ClaimDate: getCol('Encounter Date'),
            ClinicianLicense: getCol('Clinician License'),
            InsuranceCompany: getCol('Pri\\. Payer Name'),
            Clinic: getCol('Department'),
            Status: getCol('Codification Status'),
            PackageName: getCol('Pri\\. Plan Name')
          };
          
          console.log("Column mappings:", colMap);
          
          const result = rows.map(row => ({
            ClaimID: row[colMap.ClaimID]?.toString().trim() || "",
            MemberID: row[colMap.MemberID]?.toString().trim() || "",
            ClaimDate: parseDate(row[colMap.ClaimDate]) || null,
            "Clinician License": row[colMap.ClinicianLicense]?.toString().trim() || "",
            "Insurance Company": row[colMap.InsuranceCompany]?.toString().trim() || "",
            Clinic: row[colMap.Clinic]?.toString().trim() || "",
            Status: row[colMap.Status]?.toString().trim() || "",
            "Package Name": row[colMap.PackageName]?.toString().trim() || ""
          }));
          
          console.log("First 3 parsed rows:", result.slice(0, 3));
          resolve(result);
        } catch (err) {
          console.error("Error parsing CSV:", err);
          reject(err);
        }
      };
      reader.onerror = () => {
        console.error("FileReader error:", reader.error);
        reject(reader.error);
      };
      reader.readAsText(file);
    });
  }

  // Unified Excel parser for both reports and eligibility files
  async function parseExcel(file) {
    console.log("Starting Excel parsing for file:", file.name);
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = async e => {
        try {
          console.log("Excel file read successfully");
          const data = new Uint8Array(e.target.result);
          const workbook = XLSX.read(data, { type: 'array' });
          console.log("Workbook parsed with sheets:", workbook.SheetNames);
          const sheet = workbook.Sheets[workbook.SheetNames[0]];
          if (!sheet) throw new Error('Worksheet not found');
          const allRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
          
          console.log("First 3 rows of sheet:", allRows.slice(0, 3));
          const isEligibility = allRows[0]?.some(h => h.includes("Card Number / DHA Member ID"));
          console.log("Is eligibility file:", isEligibility);

          if (isEligibility) {
            console.log("Processing as eligibility file");
            // Fixed header mapping for eligibility files
            const headers = [
              'Payer Name', 'Member Name', 'Transcation Id', 'Eligibility Request Number',
              'Card Number / DHA Member ID', 'EID', 'Ordered On', 'Answered On', 'Mobile Number',
              'Authorization Number', 'Status', 'Denial Code/Rule ID', 'Denial Description/Rule Description',
              'Clinician', 'Clinician Name', 'Provider License', 'Provider Name', 'User Name',
              'Submitted via Emirates Id', 'Service Category', 'Consultation Status', 'Reffering Clinician',
              'Refferal Letter Reference No', 'Has Multiple Policy', 'Rule Ansswered', 'VOI Number',
              'VOI Message', 'Card Number', 'PolicyId', 'PolicyName', 'EffectiveDate', 'ExpiryDate',
              'Package Name', 'Card Network', 'Network Billing Reference'
            ];

            const result = allRows.slice(1).map(row => {
              const obj = {};
              headers.forEach((h, i) => {
                obj[h] = row[i] || '';
                if (DATE_KEYS.some(key => h.includes(key))) obj[h] = parseDate(obj[h]) || obj[h];
              });
              return obj;
            });
            
            console.log("First 3 eligibility records:", result.slice(0, 3));
            resolve(result);
          } else {
            console.log("Processing as standard report");
            const headers = allRows[1];
            console.log("Report headers:", headers);
            
            const result = allRows.slice(2).map(row => {
              const obj = {};
              headers.forEach((h, i) => obj[h.trim()] = row[i] || '');

              // Preserve MemberID as-is for display and later normalization
              if (obj.ClaimDate) obj.ClaimDate = parseDate(obj.ClaimDate);
              obj.MemberID = (obj.MemberID || "").toString().trim();
              return obj;
            });
            
            console.log("First 3 report rows:", result.slice(0, 3));
            resolve(result);
          }
        } catch (err) {
          console.error("Error parsing Excel:", err);
          reject(err);
        }
      };
      reader.onerror = () => {
        console.error("FileReader error:", reader.error);
        reject(reader.error);
      };
      reader.readAsArrayBuffer(file);
    });
  }

async function parseXML(file) {
  console.log("Starting XML parsing for file:", file.name);
  try {
    const text = await file.text();
    const xmlDoc = new DOMParser().parseFromString(text, "application/xml");
    const claims = Array.from(xmlDoc.querySelectorAll('Claim')).map(claim => {
      const claimID = claim.querySelector('ID')?.textContent.trim() || '';
      const memberID = claim.querySelector('MemberID')?.textContent.trim() || '';

      console.debug(`Processing claim ${claimID} for member ${memberID}`);

      // Collect clinicians
      const clinicians = new Set();
      claim.querySelectorAll('Activity Clinician').forEach(c => {
        if (c.textContent.trim()) clinicians.add(c.textContent.trim());
      });

      console.debug(`Found ${clinicians.size} clinicians for claim ${claimID}`);

      // Process encounters
      const encounters = Array.from(claim.querySelectorAll('Encounter')).map(enc => {
        const startElem = enc.querySelector('Start');
        const startText = startElem ? startElem.textContent.trim() : '';
        console.debug(`Encounter Start text for claim ${claimID}:`, startText);
        const encounterStart = startText ? parseDate(startText) : null;
        return {
          claimID,
          memberID,
          encounterStart: encounterStart || '',
          claimClinician: clinicians.size === 1 ? [...clinicians][0] : null,
          multipleClinicians: clinicians.size > 1
        };
      });


      return { claimID, encounters };
    });

    const result = {
      claimsCount: claims.length,
      encounters: claims.flatMap(c => c.encounters)
    };

    console.log("XML parsing complete. Found:", {
      claims: result.claimsCount,
      encounters: result.encounters.length,
      sampleEncounter: result.encounters[0]
    });

    return result;
  } catch (err) {
    console.error("Error parsing XML:", err);
    throw err;
  }
}
  
  // =====================
  // VALIDATION LOGIC
  // =====================

  // Validate XML data against eligibility
   function validateXml(xmlData, eligData) {
    console.log("Starting XML validation");
    const results = [], seenClaims = new Set(), eligMap = {};
    const usedEligibilities = new Set();
  
    eligData.forEach(e => {
      const id = normalizeMemberID(e['Card Number / DHA Member ID'] || e.MemberID);
      if (id) (eligMap[id] = eligMap[id] || []).push(e);
    });
  
    xmlData.encounters.forEach(enc => {
      if (!enc.claimID || seenClaims.has(enc.claimID)) return;
      seenClaims.add(enc.claimID);
  
      const memberID = normalizeMemberID(enc.memberID);
      const eligMatches = memberID ? (eligMap[memberID] || []) : [];
      const remarks = [];
      let match = null;
  
      if (!memberID) remarks.push("Missing MemberID in XML");
      else if (!eligMatches.length) remarks.push("No matching eligibility found");
      else {
        const claimDate = parseDate(enc.encounterStart);
        match = findUnusedEligibility(eligMatches, claimDate, usedEligibilities);
        if (match) usedEligibilities.add(match['Eligibility Request Number']);
  
        if (match?.Status?.toLowerCase() !== "eligible") remarks.push(`Invalid status: ${match?.Status}`);
  
        const svc = match?.['Service Category'] || '';
        if (!['Consultation', 'Dental Services', 'Physiotherapy'].includes(svc)) remarks.push(`Invalid service: ${svc}`);
      }
  
      results.push({
        claimID: enc.claimID,
        memberID,
        insuranceCompany: match?.['Payer Name'] || "",
        packageName: match?.['Package Name'] || "",
        encounterStart: enc.encounterStart ? excelDateToDDMMYYYY(parseDate(enc.encounterStart)) : enc.encounterStart,
        status: match?.Status || "",
        remarks,
        eligibilityRequestNumber: match?.["Eligibility Request Number"] || "",
        fullEligibilityRecord: match || null
      });
    });
  
    return results;
  }

  // Validate Insta CSV data against eligibility
  function validateInsta(instaRows, eligData) {
    console.log("Starting Insta CSV validation");
    const results = [], seenClaims = new Set(), eligMap = {};
    const usedEligibilities = new Set();
  
    eligData.forEach(e => {
      ['Card Number / DHA Member ID', 'Card Number', 'MemberID'].forEach(field => {
        const id = normalizeMemberID(e[field]);
        if (id) (eligMap[id] = eligMap[id] || []).push(e);
      });
    });
  
    instaRows.forEach(row => {
      const claimID = (row.ClaimID || '').toString().trim();
      if (!claimID || seenClaims.has(claimID)) return;
      seenClaims.add(claimID);
  
      const memberID = normalizeMemberID(row.MemberID);
      const eligMatches = memberID ? (eligMap[memberID] || []) : [];
      const remarks = [];
      let match = null;
  
      if (!memberID) remarks.push("Missing MemberID");
      else if (!eligMatches.length) remarks.push("No matching eligibility found");
      else {
        const claimDate = parseDate(row.ClaimDate);
        match = findUnusedEligibility(eligMatches, claimDate, usedEligibilities);
        if (match) usedEligibilities.add(match['Eligibility Request Number']);
  
        if (match?.Status?.toLowerCase() !== "eligible") remarks.push(`Invalid status: ${match.Status}`);
      }
  
      results.push({
        claimID,
        memberID,
        insuranceCompany: match?.['Payer Name'] || "",
        packageName: match?.['Package Name'] || "",
        encounterStart: row.ClaimDate ? excelDateToDDMMYYYY(row.ClaimDate) : row.ClaimDate,
        status: match?.Status || "",
        remarks,
        eligibilityRequestNumber: match?.["Eligibility Request Number"] || "",
        fullEligibilityRecord: match || null
      });
    });
  
    return results;
  }

  // Validate ClinicPro XLS data against eligibility
  function validateClinicPro(reportRows, eligData) {
    const results = [], seenClaims = new Set(), eligMap = {};
    const usedEligibilities = new Set();
  
    eligData.forEach(e => {
      const id = normalizeMemberID(e['Card Number / DHA Member ID'] || e.MemberID);
      if (id) (eligMap[id] = eligMap[id] || []).push(e);
    });
  
    reportRows.forEach(row => {
      const claimID = row.ClaimID;
      if (!claimID || seenClaims.has(claimID)) return;
      seenClaims.add(claimID);
  
      const memberID = normalizeMemberID(row.MemberID);
      const eligMatches = memberID ? (eligMap[memberID] || []) : [];
      const remarks = [];
      let match = null;
  
      if (!memberID) remarks.push("Missing MemberID");
      else if (!eligMatches.length) remarks.push("No matching eligibility found");
      else {
        const claimDate = parseDate(row.ClaimDate);
        match = findUnusedEligibility(eligMatches, claimDate, usedEligibilities);
        if (match) usedEligibilities.add(match['Eligibility Request Number']);
  
        if (match?.Status?.toLowerCase() !== "eligible") remarks.push(`Invalid status: ${match.Status}`);
  
        const svc = match?.['Service Category'] || '';
        if (!['Consultation', 'Dental Services', 'Physiotherapy'].includes(svc)) remarks.push(`Invalid service: ${svc}`);
      }
  
      const encounterStart = row.ClaimDate ? excelDateToDDMMYYYY(row.ClaimDate) : 
        match?.['Ordered On'] ? excelDateToDDMMYYYY(parseDate(match['Ordered On'])) : '';
      const packageName = match?.['Package Name'] || '';
      const insuranceCompany = match?.['Payer Name'] || row['Insurance Company'] || '';
      const detailsHTML = match ? formatEligibilityDetailsModal(match, memberID) : '';
  
      results.push({
        claimID,
        memberID,
        insuranceCompany,
        packageName,
        encounterStart,
        status: match?.Status || "",
        remarks,
        eligibilityRequestNumber: match?.["Eligibility Request Number"] || "",
        details: detailsHTML,
        serviceCategory: match?.['Service Category'] || "",
        clinic: row.Clinic || "",
        fullEligibilityRecord: match || null
      });
    });
  
    return results;
  }
  
  // =====================
  // UI RENDERING
  // =====================
  // Render results table
function renderResults(results, containerId = "results") {
    const container = document.getElementById(containerId);
    container.innerHTML = `
      <table class="shared-table">
        <thead><tr>
          <th>#</th><th>ID</th><th>MemberID</th><th>Insurance</th>
          <th>Package</th><th>Date</th><th>Details</th>
          <th>Status</th><th>Service</th><th>Clinic</th><th>Remarks</th>
        </tr></thead>
        <tbody>
          ${results.map((r, i) => `
            <tr class="${r.remarks.length ? "invalid" : "valid"}" data-details="${escapeHtml(r.details)}">
              <td>${i + 1}</td>
              <td class="wrap-col">${r.claimID}</td>
              <td class="wrap-col">${r.memberID}</td>
              <td class="wrap-col">${r.insuranceCompany || ""}</td>
              <td class="wrap-col">${r.packageName || ""}</td>
              <td class="wrap-col">${r.encounterStart || ""}</td>
              <td><button class="details-btn" ${r.details && r.details.trim() ? "" : "disabled"}>
                ${r.eligibilityRequestNumber || "No Request"}
              </button></td>
              <td>${r.status || ""}</td>
              <td>${r.serviceCategory || ""}</td>
              <td>${r.clinic || ""}</td>
              <td style="white-space: pre-line;">${r.remarks.join("\n")}</td>
            </tr>`
          ).join("")}
        </tbody>
      </table>
    `;
    
    // Attach modal handlers
    container.querySelectorAll(".details-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const modal = document.getElementById("eligibilityModal") || createModal(container);
        modal.querySelector("#modalContent").innerHTML = btn.closest("tr").dataset.details;
        modal.style.display = "block";
      });
    });
}
  
  // Create modal dialog
  function createModal(container) {
    console.log("Creating modal dialog");
    container.insertAdjacentHTML("beforeend", `
      <div id="eligibilityModal" class="modal">
        <div class="modal-content">
          <span class="close">&times;</span>
          <div id="modalContent"></div>
        </div>
      </div>
    `);
    const modal = container.querySelector("#eligibilityModal");
    modal.querySelector(".close").addEventListener("click", () => {
      console.log("Closing modal");
      modal.style.display = "none";
    });
    return modal;
  }

  // =====================
  // EVENT HANDLERS
  // =====================
  // Toggle input groups based on report source
  function swapInputGroups() {
    const xmlChecked = xmlRadio.checked;
    console.log("Swapping input groups. XML mode:", xmlChecked);
    xmlGroup.style.display = xmlChecked ? "block" : "none";
    reportGroup.style.display = !xmlChecked ? "block" : "none";
    updateStatus();
  }

  // Update upload status text
  function updateStatus() {
    const statusParts = [];
    if (xmlRadio.checked && xmlData) statusParts.push(`${xmlData.encounters.length} XML claims`);
    if (xlsRadio.checked && xlsData) statusParts.push(`${xlsData.length} report rows`);
    if (eligData) statusParts.push(`${eligData.length} eligibility records`);
    if (insuranceLicenses) statusParts.push("Licenses loaded");
  
    const newStatus = statusParts.join(", ") || "Awaiting files";
    status.textContent = newStatus;
  
    const hasRequiredData = xmlRadio.checked ? xmlData && eligData : xlsData && eligData;
    processBtn.disabled = !hasRequiredData;
  }

  // Handle file uploads
  async function handleFileUpload(input, type) {
    console.log(`Handling ${type} file upload`);
    status.textContent = `Loading ${type}...`;
    try {
      const file = input.files[0];
      if (!file) return console.log("No file selected");
  
      console.log(`Processing ${type} file:`, file.name);
      if (type === "XML") xmlData = await parseXML(file);
      else if (type === "CSV") xlsData = await parseCsv(file);
      else if (type === "Eligibility") eligData = await parseExcel(file);
      else xlsData = await parseExcel(file);
  
      updateStatus();
    } catch (err) {
      console.error(`Error processing ${type} file:`, err);
      status.textContent = `${type} Error: ${err.message}`;
    }
  }

  // Process validation
  async function processValidation() {
    console.log("Starting validation process");
    const resultsContainer = document.getElementById("results");
    resultsContainer.innerHTML = "<div class='loading'>Processing...</div>";
    
    try {
      let results = [];
      
      if (xmlRadio.checked) {
        if (!xmlData || !eligData) {
          const errMsg = "Missing XML or Eligibility data";
          console.error(errMsg, {xmlData: !!xmlData, eligData: !!eligData});
          throw new Error(errMsg);
        }
        console.log("Validating XML data");
        results = validateXml(xmlData, eligData);
      } else {
        if (!xlsData || !eligData) {
          const errMsg = "Missing report or Eligibility data";
          console.error(errMsg, {xlsData: !!xlsData, eligData: !!eligData});
          throw new Error(errMsg);
        }
        
        if (xlsData[0]?.hasOwnProperty("Pri. Claim No")) {
          console.log("Validating Insta CSV data");
          results = validateInsta(xlsData, eligData);
        } else {
          console.log("Validating ClinicPro XLS data");
          results = validateClinicPro(xlsData, eligData);
        }
      }
      
      // Add safety check before rendering
      if (!Array.isArray(results)) {
        const errMsg = "Validation returned invalid results format";
        console.error(errMsg, {results});
        throw new Error(errMsg);
      }
      
      console.log("Validation complete. Rendering results");
      renderResults(results);
      
      const validCount = results.filter(r => r.remarks.length === 0).length;
      const totalCount = results.length;
      const validPercent = totalCount ? Math.round(validCount/totalCount*100) : 0;
      
      const statusMsg = `Valid: ${validCount}/${totalCount} (${validPercent}%)`;
      console.log(statusMsg);
      status.textContent = statusMsg;
    } catch (err) {
      console.error("Validation failed:", err);
      resultsContainer.innerHTML = `<div class="error">${err.message}</div>`;
      status.textContent = "Processing failed";
    }
  }

  // =====================
  // INITIAL SETUP
  // =====================
  console.log("Initializing event listeners");
  
  // Initialize event listeners
  xmlRadio.addEventListener("change", swapInputGroups);
  xlsRadio.addEventListener("change", swapInputGroups);
  xmlInput.addEventListener("change", () => handleFileUpload(xmlInput, "XML"));
  reportInput.addEventListener("change", function() {
    handleFileUpload(this, this.files[0]?.name.endsWith(".csv") ? "CSV" : "Report");
  });
  eligInput.addEventListener("change", () => handleFileUpload(eligInput, "Eligibility"));
  processBtn.addEventListener("click", processValidation);
  
  // Load insurance licenses
  console.log("Loading insurance licenses");
  fetch("insurance_licenses.json")
    .then(r => {
      if (!r.ok) throw new Error(`HTTP error! status: ${r.status}`);
      return r.json();
    })
    .then(json => {
      console.log("Insurance licenses loaded:", json?.length);
      insuranceLicenses = json;
      updateStatus();
    })
    .catch(err => {
      console.error("Error loading insurance licenses:", err);
      insuranceLicenses = null;
    });

  // Initial UI setup
  console.log("Performing initial UI setup");
  eligGroup.style.display = "block";
  swapInputGroups();
  
  console.log("Initialization complete");
});
