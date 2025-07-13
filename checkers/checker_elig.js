// checker_elig.js
window.addEventListener("DOMContentLoaded", () => {
  console.log("DOM fully loaded and parsed");
  
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
  // Normalize member IDs by removing non-digits and leading zeros
  const normalizeMemberID = id => {
    const normalized = id ? String(id).replace(/\D/g, '').replace(/^0+/, '') : '';
    console.debug(`Normalizing ID: ${id} => ${normalized}`);
    return normalized;
  };

  // Format Excel/JS dates to DD/MM/YYYY
  function excelDateToDDMMYYYY(date) {
    console.debug("Formatting date:", date);
    if (!date) {
      console.debug("Empty date, returning empty string");
      return "";
    }
    if (date instanceof Date && isNaN(date)) {
      console.warn("Invalid Date instance:", date);
      return "";
    }
    if (date instanceof Date) {
      const formatted = `${String(date.getDate()).padStart(2, "0")}/${String(date.getMonth() + 1).padStart(2, "0")}/${date.getFullYear()}`;
      console.debug("Formatted Date instance:", formatted);
      return formatted;
    }
    if (typeof date === "string") {
      if (/\d{1,2}\/\d{1,2}\/\d{2,4}/.test(date)) {
        console.debug("Already in DD/MM/YYYY format");
        return date;
      }
      if (/\d{4}-\d{2}-\d{2}/.test(date)) {
        const formatted = date.split("-").reverse().join("/");
        console.debug("Formatted YYYY-MM-DD to DD/MM/YYYY:", formatted);
        return formatted;
      }
    }
    try {
      const parsed = new Date(Math.round((date - 25569) * 86400 * 1000));
      const result = isNaN(parsed) ? "" : parsed.toLocaleDateString("en-GB");
      console.debug("Converted Excel date:", {input: date, output: result});
      return result;
    } catch (err) {
      console.error("Failed to convert Excel date:", date, err);
      return "";
    }
  }

  // Robust date parser with DMY/MDY detection
  function parseDate(val) {
    console.debug("Parsing date:", val);
    if (!val) {
      console.debug("Empty value, returning null");
      return null;
    }
    if (val instanceof Date) {
      console.debug("Already a Date object");
      return val;
    }
    if (typeof val === "number") {
      const dateObj = new Date(Math.round((val - 25569) * 86400 * 1000));
      console.debug("Converted Excel numeric date:", dateObj);
      return dateObj;
    }
    
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
        console.debug("Month name format detected:", {day, month, year});
      } else if (parts[1] > 31) { // YYYY-MM-DD
        year = parseInt(parts[1]);
        month = parseInt(parts[2]) - 1;
        day = parseInt(parts[3]);
        console.debug("YYYY-MM-DD format detected:", {year, month, day});
      } else { // DD/MM/YYYY or MM/DD/YYYY
        day = parseInt(parts[1]);
        month = parseInt(parts[2]) - 1;
        year = parseInt(parts[3]) + (parts[3].length === 2 ? 2000 : 0);
        if (day > 12 && month <= 11) {
          console.debug("Ambiguous date, swapping day/month:", {before: {day, month}, after: {day: month + 1, month: day - 1}});
          [day, month] = [month + 1, day - 1];
        }
      }
      
      const dateObj = new Date(year, month, day);
      if (!isNaN(dateObj.getTime())) {
        console.debug("Successfully parsed date:", dateObj);
        return dateObj;
      }
    }
    
    console.debug("Falling back to native Date parser");
    return new Date(val); // Fallback to native parser
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
                if (h.includes('Date') || h.includes('On')) {
                  obj[h] = parseDate(obj[h]) || obj[h];
                }
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

  // Parse XML claim files
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
        const encounters = Array.from(claim.querySelectorAll('Encounter')).map(enc => ({
          claimID,
          memberID,
          encounterStart: parseDate(enc.querySelector('Start')?.textContent.trim()) || '',
          claimClinician: clinicians.size === 1 ? [...clinicians][0] : null,
          multipleClinicians: clinicians.size > 1
        }));
        
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
    console.log("XML data:", {claims: xmlData.claimsCount, encounters: xmlData.encounters.length});
    console.log("Eligibility data count:", eligData.length);
    
    const results = [], seenClaims = new Set(), eligMap = {};
    
    // Build eligibility index
    eligData.forEach(e => {
      const id = normalizeMemberID(e['Card Number / DHA Member ID'] || e.MemberID);
      if (id) (eligMap[id] = eligMap[id] || []).push(e);
    });

    console.log("Eligibility map size:", Object.keys(eligMap).length);
    
    xmlData.encounters.forEach(enc => {
      if (!enc.claimID || seenClaims.has(enc.claimID)) {
        console.debug(`Skipping duplicate or empty claim ID: ${enc.claimID}`);
        return;
      }
      seenClaims.add(enc.claimID);

      const memberID = normalizeMemberID(enc.memberID);
      const eligMatches = memberID ? (eligMap[memberID] || []) : [];
      const remarks = [];
      let match = null;

      console.debug(`Validating claim ${enc.claimID} for member ${memberID}`);
      
      // Find matching eligibility
      if (!memberID) {
        remarks.push("Missing MemberID in XML");
        console.warn("Missing MemberID in XML for claim:", enc.claimID);
      } else if (!eligMatches.length) {
        remarks.push("No matching eligibility found");
        console.warn(`No eligibility matches for member ${memberID}`);
      } else {
        const claimDate = parseDate(enc.encounterStart);
        console.debug("Claim date:", claimDate);
        
        match = eligMatches.find(e => {
          const start = parseDate(e.EffectiveDate || e['Ordered On']);
          const end = parseDate(e.ExpiryDate || e['Answered On']);
          const inWindow = (!claimDate || !start || claimDate >= start) && 
                         (!claimDate || !end || claimDate <= end);
          console.debug("Checking eligibility window:", {
            claimDate,
            start,
            end,
            inWindow
          });
          return inWindow;
        }) || eligMatches[0];
        
        if (match) {
          console.debug("Found matching eligibility:", {
            requestNumber: match['Eligibility Request Number'],
            status: match.Status,
            service: match['Service Category']
          });
        }
        
        if (match.Status?.toLowerCase() !== "eligible") {
          remarks.push(`Invalid status: ${match.Status}`);
          console.warn(`Invalid status for claim ${enc.claimID}: ${match.Status}`);
        }
        
        // Additional checks
        const svc = match['Service Category'] || '';
        if (!['Consultation', 'Dental Services', 'Physiotherapy'].includes(svc)) {
          remarks.push(`Invalid service: ${svc}`);
          console.warn(`Invalid service category for claim ${enc.claimID}: ${svc}`);
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
    
    console.log("XML validation complete. Results count:", results.length);
    console.log("Sample result:", results[0]);
    return results;
  }

  // Validate Insta CSV data against eligibility
  function validateInsta(instaRows, eligData) {
    console.log("Starting Insta CSV validation");
    console.log("Insta rows count:", instaRows.length);
    console.log("Eligibility data count:", eligData.length);
    
    const results = [], seenClaims = new Set(), eligMap = {};
    
    // Build eligibility index
    eligData.forEach(e => {
      ['Card Number / DHA Member ID', 'Card Number', 'MemberID'].forEach(field => {
        const id = normalizeMemberID(e[field]);
        if (id) (eligMap[id] = eligMap[id] || []).push(e);
      });
    });

    console.log("Eligibility map size:", Object.keys(eligMap).length);
    
    instaRows.forEach(row => {
      const claimID = (row.ClaimID || '').toString().trim();
      if (!claimID || seenClaims.has(claimID)) {
        console.debug(`Skipping duplicate or empty claim ID: ${claimID}`);
        return;
      }
      seenClaims.add(claimID);

      const memberID = normalizeMemberID(row.MemberID);
      const eligMatches = memberID ? (eligMap[memberID] || []) : [];
      const remarks = [];
      let match = null;

      console.debug(`Validating claim ${claimID} for member ${memberID}`);
      
      // Find matching eligibility
      if (!memberID) {
        remarks.push("Missing MemberID");
        console.warn("Missing MemberID for claim:", claimID);
      } else if (!eligMatches.length) {
        remarks.push("No matching eligibility found");
        console.warn(`No eligibility matches for member ${memberID}`);
      } else {
        const claimDate = parseDate(row.ClaimDate);
        console.debug("Claim date:", claimDate);
        
        match = eligMatches.find(e => {
          const start = parseDate(e.EffectiveDate || e['Ordered On']);
          const end = parseDate(e.ExpiryDate || e['Answered On']);
          const inWindow = (!claimDate || !start || claimDate >= start) && 
                         (!claimDate || !end || claimDate <= end);
          console.debug("Checking eligibility window:", {
            claimDate,
            start,
            end,
            inWindow
          });
          return inWindow;
        }) || eligMatches[0];
        
        if (match) {
          console.debug("Found matching eligibility:", {
            requestNumber: match['Eligibility Request Number'],
            status: match.Status
          });
        }
        
        if (match.Status?.toLowerCase() !== "eligible") {
          remarks.push(`Invalid status: ${match.Status}`);
          console.warn(`Invalid status for claim ${claimID}: ${match.Status}`);
        }
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
    
    console.log("Insta validation complete. Results count:", results.length);
    console.log("Sample result:", results[0]);
    return results;
  }

  // Validate ClinicPro XLS data against eligibility
  function validateClinicPro(reportRows, eligData) {
    console.log("Starting ClinicPro validation");
    console.log("Report rows count:", reportRows.length);
    console.log("Eligibility data count:", eligData.length);
    
    const results = [], seenClaims = new Set(), eligMap = {};
  
    eligData.forEach(e => {
      const id = normalizeMemberID(e['Card Number / DHA Member ID'] || e.MemberID);
      if (id) (eligMap[id] = eligMap[id] || []).push(e);
    });
  
    console.log("Eligibility map size:", Object.keys(eligMap).length);
    
    reportRows.forEach(row => {
      const claimID = row.ClaimID;
      if (!claimID || seenClaims.has(claimID)) {
        console.debug(`Skipping duplicate or empty claim ID: ${claimID}`);
        return;
      }
      seenClaims.add(claimID);
  
      const memberID = normalizeMemberID(row.MemberID);
      const eligMatches = memberID ? (eligMap[memberID] || []) : [];
      const remarks = [];
      let match = null;
  
      console.log(`\n[Validating ClaimID: ${claimID}]`);
      console.log("MemberID:", memberID);
      if (!memberID) {
        remarks.push("Missing MemberID");
        console.warn("Missing MemberID for claim:", claimID);
      } else if (!eligMatches.length) {
        remarks.push("No matching eligibility found");
        console.warn(`No eligibility rows for memberID: ${memberID}`);
      } else {
        const claimDate = parseDate(row.ClaimDate);
        console.log("Parsed Claim Date:", claimDate);
  
        match = eligMatches.find(e => {
          const start = parseDate(e.EffectiveDate || e['Ordered On']);
          const end = parseDate(e.ExpiryDate || e['Answered On']);
          const matchResult = (!claimDate || !start || claimDate >= start) &&
                            (!claimDate || !end || claimDate <= end);
          console.log("Checking date window:", {
            claimDate,
            start,
            end,
            matchResult
          });
          return matchResult;
        }) || eligMatches[0];
  
        if (match) {
          console.log("Eligibility Match Found:", {
            requestNumber: match['Eligibility Request Number'],
            status: match.Status,
            service: match['Service Category']
          });
        }
  
        if (match.Status?.toLowerCase() !== "eligible") {
          remarks.push(`Invalid status: ${match.Status}`);
          console.warn(`Invalid status for claim ${claimID}: ${match.Status}`);
        }
  
        const svc = match['Service Category'] || '';
        if (!['Consultation', 'Dental Services', 'Physiotherapy'].includes(svc)) {
          remarks.push(`Invalid service: ${svc}`);
          console.warn(`Invalid service category for claim ${claimID}: ${svc}`);
        }
      }
  
      const encounterStart = row.ClaimDate ? excelDateToDDMMYYYY(row.ClaimDate) : row.ClaimDate;
      const detailsHTML = match
        ? formatEligibilityDetailsModal(match, memberID)
        : formatReportDetailsModal(row, encounterStart);
  
      console.log("Encounter Start (formatted):", encounterStart);
      console.log("Details HTML generated:", detailsHTML);
  
      results.push({
        claimID,
        memberID,
        insuranceCompany: row['Insurance Company'] || "",
        packageName: match?.['Package Name'] || "",
        encounterStart,
        status: match?.Status || "",
        remarks,
        eligibilityRequestNumber: match?.["Eligibility Request Number"] || "",
        details: detailsHTML,
        serviceCategory: match?.['Service Category'] || "",
        clinic: row.Clinic || ""
      });
    });
    
    console.log("ClinicPro validation complete. Results count:", results.length);
    console.log("Sample result:", results[0]);
    return results;
  }

  // =====================
  // UI RENDERING
  // =====================
  // Render results table
  function renderResults(results, containerId = "results") {
    console.log("Rendering results table");
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
    
    console.log("Results table rendered with", results.length, "rows");
    
    // Attach modal handlers
    container.querySelectorAll(".details-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        console.log("Details button clicked for claim:", btn.textContent.trim());
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
    console.log("Updating status:", newStatus);
    status.textContent = newStatus;
    
    const isDisabled = !(xmlRadio.checked ? xmlData && eligData : xlsData && eligData);
    console.log("Process button disabled:", isDisabled);
    processBtn.disabled = isDisabled;
  }

  // Handle file uploads
  async function handleFileUpload(input, type) {
    console.log(`Handling ${type} file upload`);
    status.textContent = `Loading ${type}...`;
    try {
      const file = input.files[0];
      if (!file) {
        console.log("No file selected");
        return;
      }
      
      console.log(`Processing ${type} file:`, file.name);
      
      if (type === "XML") {
        xmlData = await parseXML(file);
        console.log("XML data parsed:", xmlData);
      } else if (type === "CSV") {
        xlsData = await parseCsv(file);
        console.log("CSV data parsed:", xlsData?.slice(0, 3));
      } else if (type === "Eligibility") {
        eligData = await parseExcel(file);
        console.log("Eligibility data parsed:", eligData?.slice(0, 3));
      } else {
        xlsData = await parseExcel(file); // XLS/XLSX
        console.log("Report data parsed:", xlsData?.slice(0, 3));
      }
      
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
