// checker_elig.js
window.addEventListener("DOMContentLoaded", () => {
  // =====================
  // DOM INITIALIZATION
  // =====================
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

  // =====================
  // DATA HOLDERS
  // =====================
  let xmlData = null, xlsData = null, eligData = null, insuranceLicenses = null;

  // =====================
  // UTILITY FUNCTIONS
  // =====================
  // Normalize member IDs by removing non-digits and leading zeros
  const normalizeMemberID = id => id ? String(id).replace(/\D/g, '').replace(/^0+/, '') : '';

  // Format Excel/JS dates to DD/MM/YYYY
  function excelDateToDDMMYYYY(date) {
    if (!date) return "";
    if (date instanceof Date && isNaN(date)) return ""; // Handle invalid date
    if (date instanceof Date) return `${String(date.getDate()).padStart(2, "0")}/${String(date.getMonth() + 1).padStart(2, "0")}/${date.getFullYear()}`;
    if (typeof date === "string") {
      if (/\d{1,2}\/\d{1,2}\/\d{2,4}/.test(date)) return date;
      if (/\d{4}-\d{2}-\d{2}/.test(date)) return date.split("-").reverse().join("/");
    }
    try {
      const parsed = new Date(Math.round((date - 25569) * 86400 * 1000));
      return isNaN(parsed) ? "" : parsed.toLocaleDateString("en-GB");
    } catch {
      return "";
    }
  }

  // Robust date parser with DMY/MDY detection
  function parseDate(val) {
    if (!val) return null;
    if (val instanceof Date) return val;
    if (typeof val === "number") return new Date(Math.round((val - 25569) * 86400 * 1000));
    
    // Try common formats
    const formats = [
      /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/,
      /^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/,
      /^(\d{1,2})[\/\-]([a-z]{3})[\/\-](\d{4})$/i
    ];
    
    for (const regex of formats) {
      const parts = val.match(regex);
      if (!parts) continue;
      
      let day, month, year;
      if (parts[2] && isNaN(parts[2])) { // Month name format
        const months = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
        day = parseInt(parts[1]);
        month = months.indexOf(parts[2].toLowerCase());
        year = parseInt(parts[3]);
      } else if (parts[1] > 31) { // YYYY-MM-DD
        year = parseInt(parts[1]);
        month = parseInt(parts[2]) - 1;
        day = parseInt(parts[3]);
      } else { // DD/MM/YYYY or MM/DD/YYYY
        day = parseInt(parts[1]);
        month = parseInt(parts[2]) - 1;
        year = parseInt(parts[3]) + (parts[3].length === 2 ? 2000 : 0);
        if (day > 12 && month <= 11) [day, month] = [month + 1, day - 1]; // Swap if ambiguous
      }
      
      const dateObj = new Date(year, month, day);
      if (!isNaN(dateObj.getTime())) return dateObj;
    }
    
    return new Date(val); // Fallback to native parser
  }

  // =====================
  // FILE PARSING
  // =====================
  // Parse CSV files using SheetJS
  async function parseCsv(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = e => {
        try {
          const workbook = XLSX.read(e.target.result, { type: 'string' });
          const sheet = workbook.Sheets[workbook.SheetNames[0]];
          const [headers, , , ...rows] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
          
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
          
          resolve(result);
        } catch (err) {
          reject(err);
        }
      };
      reader.readAsText(file);
    });
  }

  // Unified Excel parser for both reports and eligibility files
async function parseExcel(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async e => {
      try {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: 'array' });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        if (!sheet) throw new Error('Worksheet not found');
        const allRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
        const isEligibility = allRows[0]?.some(h => h.includes("Card Number / DHA Member ID"));
        if (isEligibility) {
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

          resolve(allRows.slice(1).map(row => {
            const obj = {};
            headers.forEach((h, i) => {
              obj[h] = row[i] || '';
              if (h.includes('Date') || h.includes('On')) {
                obj[h] = parseDate(obj[h]) || obj[h];
              }
            });
            return obj;
          }));
        } else {
          // Standard report processing
          const headers = allRows[1];
          resolve(allRows.slice(2).map(row => {
            const obj = {};
            headers.forEach((h, i) => obj[h.trim()] = row[i] || '');

            // Preserve MemberID as-is for display and later normalization
            if (obj.ClaimDate) obj.ClaimDate = parseDate(obj.ClaimDate);
            obj.MemberID = (obj.MemberID || "").toString().trim();
            return obj;
          }));
        }
      } catch (err) {
        reject(err);
      }
    };
    reader.readAsArrayBuffer(file);
  });
}

  // Parse XML claim files
  async function parseXML(file) {
    const text = await file.text();
    const xmlDoc = new DOMParser().parseFromString(text, "application/xml");
    const claims = Array.from(xmlDoc.querySelectorAll('Claim')).map(claim => {
      const claimID = claim.querySelector('ID')?.textContent.trim() || '';
      const memberID = claim.querySelector('MemberID')?.textContent.trim() || '';
      
      // Collect clinicians
      const clinicians = new Set();
      claim.querySelectorAll('Activity Clinician').forEach(c => {
        if (c.textContent.trim()) clinicians.add(c.textContent.trim());
      });
      
      // Process encounters
      const encounters = Array.from(claim.querySelectorAll('Encounter')).map(enc => ({
        claimID,
        memberID,
        encounterStart: parseDate(enc.querySelector('Start')?.textContent.trim()) || '',
        claimClinician: clinicians.size === 1 ? [...clinicians][0] : null,
        multipleClinicians: clinicians.size > 1
      }));
      
      return { claimID, encounters };
    });
    
    return {
      claimsCount: claims.length,
      encounters: claims.flatMap(c => c.encounters)
    };
  }

  // =====================
  // VALIDATION LOGIC
  // =====================

  // Validate XML data against eligibility
	function validateXml(xmlData, eligData) {
    const results = [], seenClaims = new Set(), eligMap = {};
    
    // Build eligibility index
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

        // Find matching eligibility
        if (!memberID) remarks.push("Missing MemberID in XML");
        else if (!eligMatches.length) remarks.push("No matching eligibility found");
        else {
            const claimDate = parseDate(enc.encounterStart);
            match = eligMatches.find(e => {
                const start = parseDate(e.EffectiveDate || e['Ordered On']);
                const end = parseDate(e.ExpiryDate || e['Answered On']);
                return (!claimDate || !start || claimDate >= start) && 
                       (!claimDate || !end || claimDate <= end);
            }) || eligMatches[0];
            
            if (match.Status?.toLowerCase() !== "eligible") remarks.push(`Invalid status: ${match.Status}`);
            
            // Additional checks
            const svc = match['Service Category'] || '';
            if (!['Consultation', 'Dental Services', 'Physiotherapy'].includes(svc)) {
                remarks.push(`Invalid service: ${svc}`);
            }
        }

        results.push({
            claimID: enc.claimID,
            memberID,
            insuranceCompany: match?.['Payer Name'] || "",
            packageName: match?.['Package Name'] || "",
            encounterStart: enc.encounterStart ? excelDateToDDMMYYYY(parseDate(enc.encounterStart)) : enc.encounterStart,
            status: match?.Status || "",
            remarks,
            eligibilityRequestNumber: match?.["Eligibility Request Number"] || ""
        });
    });
    
    return results;
}

  // Validate Insta CSV data against eligibility
  function validateInsta(instaRows, eligData) {
    const results = [], seenClaims = new Set(), eligMap = {};
    
    // Build eligibility index
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

      // Find matching eligibility
      if (!memberID) remarks.push("Missing MemberID");
      else if (!eligMatches.length) remarks.push("No matching eligibility found");
      else {
        const claimDate = parseDate(row.ClaimDate);
        match = eligMatches.find(e => {
          const start = parseDate(e.EffectiveDate || e['Ordered On']);
          const end = parseDate(e.ExpiryDate || e['Answered On']);
          return (!claimDate || !start || claimDate >= start) && 
                 (!claimDate || !end || claimDate <= end);
        }) || eligMatches[0];
        
        if (match.Status?.toLowerCase() !== "eligible") remarks.push(`Invalid status: ${match.Status}`);
      }

      results.push({
        claimID,
        memberID,
        insuranceCompany: match?.['Payer Name'] || "",
        packageName: match?.['Package Name'] || "",
        encounterStart: row.ClaimDate ? excelDateToDDMMYYYY(row.ClaimDate) : row.ClaimDate,
        status: match?.Status || "",
        remarks,
        eligibilityRequestNumber: match?.["Eligibility Request Number"] || ""
      });
    });
    
    return results;
  }

  // Validate ClinicPro XLS data against eligibility
  function validateClinicPro(reportRows, eligData) {
    const results = [], seenClaims = new Set(), eligMap = {};
    
    // Build eligibility index
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

      // Find matching eligibility
      if (!memberID) remarks.push("Missing MemberID");
      else if (!eligMatches.length) remarks.push("No matching eligibility found");
      else {
        const claimDate = parseDate(row.ClaimDate);
        match = eligMatches.find(e => {
          const start = parseDate(e.EffectiveDate || e['Ordered On']);
          const end = parseDate(e.ExpiryDate || e['Answered On']);
          return (!claimDate || !start || claimDate >= start) && 
                 (!claimDate || !end || claimDate <= end);
        }) || eligMatches[0];
        
        if (match.Status?.toLowerCase() !== "eligible") remarks.push(`Invalid status: ${match.Status}`);
        
        // Additional checks
        const svc = match['Service Category'] || '';
        if (!['Consultation', 'Dental Services', 'Physiotherapy'].includes(svc)) {
          remarks.push(`Invalid service: ${svc}`);
        }
      }

      results.push({
        claimID,
        memberID,
        insuranceCompany: row['Insurance Company'] || "",
        packageName: match?.['Package Name'] || "",
        encounterStart: row.ClaimDate ? excelDateToDDMMYYYY(row.ClaimDate) : row.ClaimDate,
        status: match?.Status || "",
        remarks,
        eligibilityRequestNumber: match?.["Eligibility Request Number"] || ""
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
            <tr class="${r.remarks.length ? "invalid" : "valid"}">
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
    container.insertAdjacentHTML("beforeend", `
      <div id="eligibilityModal" class="modal">
        <div class="modal-content">
          <span class="close">&times;</span>
          <div id="modalContent"></div>
        </div>
      </div>
    `);
    const modal = container.querySelector("#eligibilityModal");
    modal.querySelector(".close").addEventListener("click", () => modal.style.display = "none");
    return modal;
  }

  // =====================
  // EVENT HANDLERS
  // =====================
  // Toggle input groups based on report source
  function swapInputGroups() {
    xmlGroup.style.display = xmlRadio.checked ? "block" : "none";
    reportGroup.style.display = xlsRadio.checked ? "block" : "none";
    updateStatus();
  }

  // Update upload status text
  function updateStatus() {
    const statusParts = [];
    if (xmlRadio.checked && xmlData) statusParts.push(`${xmlData.encounters.length} XML claims`);
    if (xlsRadio.checked && xlsData) statusParts.push(`${xlsData.length} report rows`);
    if (eligData) statusParts.push(`${eligData.length} eligibility records`);
    if (insuranceLicenses) statusParts.push("Licenses loaded");
    
    status.textContent = statusParts.join(", ") || "Awaiting files";
    processBtn.disabled = !(xmlRadio.checked ? xmlData && eligData : xlsData && eligData);
  }

  // Handle file uploads
  async function handleFileUpload(input, type) {
    status.textContent = `Loading ${type}...`;
    try {
      const file = input.files[0];
      if (!file) return;
      
      if (type === "XML") xmlData = await parseXML(file);
      else if (type === "CSV") xlsData = await parseCsv(file);
      else if (type === "Eligibility") eligData = await parseExcel(file);
      else xlsData = await parseExcel(file); // XLS/XLSX
      
      updateStatus();
    } catch (err) {
      status.textContent = `${type} Error: ${err.message}`;
    }
  }

  // Process validation
async function processValidation() {
    const resultsContainer = document.getElementById("results");
    resultsContainer.innerHTML = "<div class='loading'>Processing...</div>";
    
    try {
        let results = [];
        
        if (xmlRadio.checked) {
            if (!xmlData || !eligData) throw new Error("Missing XML or Eligibility data");
            results = validateXml(xmlData, eligData); // Call XML validation
        } else {
            if (!xlsData || !eligData) throw new Error("Missing report or Eligibility data");
            results = xlsData[0]?.hasOwnProperty("Pri. Claim No") ? 
                validateInsta(xlsData, eligData) : 
                validateClinicPro(xlsData, eligData);
        }
        
        // Add safety check before rendering
        if (!Array.isArray(results)) {
            throw new Error("Validation returned invalid results format");
        }
        
        renderResults(results);
        const validCount = results.filter(r => r.remarks.length === 0).length;
        const totalCount = results.length;
        status.textContent = `Valid: ${validCount}/${totalCount} (${totalCount ? Math.round(validCount/totalCount*100) : 0}%)`;
    } catch (err) {
        resultsContainer.innerHTML = `<div class="error">${err.message}</div>`;
        status.textContent = "Processing failed";
    }
}
  // =====================
  // INITIAL SETUP
  // =====================
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
  fetch("insurance_licenses.json")
    .then(r => r.json())
    .then(json => { insuranceLicenses = json; updateStatus(); })
    .catch(() => insuranceLicenses = null);

  // Initial UI setup
  eligGroup.style.display = "block";
  swapInputGroups();
});
