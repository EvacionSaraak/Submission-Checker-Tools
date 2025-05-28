//HOI YWA

(function () {
    'use strict';

    var openJetClinicianList = [];
    var xmlDoc = null;
    var clinicianMap = null;
    var xmlInput, excelInput, openJetInput, resultsDiv, validationDiv, processBtn, exportCsvBtn;
    var clinicianCount = 0, openJetCount = 0, claimCount = 0;


    function sheetToJsonWithHeader(file, sheetIndex = 0, headerRow = 1, skipRowAboveHeader = false) {
        return file.arrayBuffer().then(function (buffer) {
            const data = new Uint8Array(buffer);
            const wb = XLSX.read(data, { type: 'array' });
            const name = wb.SheetNames[sheetIndex];
            if (!name) throw new Error('Sheet index ' + sheetIndex + ' not found');
    
            const sheet = wb.Sheets[name];
            const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    
            // Adjust for one extra row if needed (e.g. "Policy1" above real headers)
            const headerRowIndex = (headerRow - 1) + (skipRowAboveHeader ? 1 : 0);
    
            if (!rows || rows.length <= headerRowIndex) {
                throw new Error(`Header row ${headerRowIndex + 1} out of range`);
            }
    
            const rawHeaders = rows[headerRowIndex];
            const headers = rawHeaders.map(h => (h || '').toString().trim());
    
            // Slice data starting after the header
            const dataRows = rows.slice(headerRowIndex + 1);
    
            return dataRows.map(row => {
                const obj = {};
                headers.forEach((h, i) => {
                    obj[h] = row[i] || '';
                });
                return obj;
            });
        });
    }

    function initEventListeners() {
        xmlInput = document.getElementById('xmlFileInput');
        excelInput = document.getElementById('excelFileInput');
        openJetInput = document.getElementById('openJetFileInput');
        resultsDiv = document.getElementById('results');

        validationDiv = document.createElement('div');
        validationDiv.id = 'validation-message';
        resultsDiv.parentNode.insertBefore(validationDiv, resultsDiv);

        processBtn = document.getElementById('processBtn');
        exportCsvBtn = document.getElementById('exportCsvBtn');

        xmlInput.addEventListener('change', handleXmlInput);
        if (excelInput) excelInput.addEventListener('change', handleUnifiedExcelInput);
        if (openJetInput) openJetInput.addEventListener('change', handleUnifiedExcelInput);

        processBtn.addEventListener('click', function () {
            if (xmlDoc && clinicianMap && openJetClinicianList.length > 0) {
                processClaims(xmlDoc, clinicianMap);
            }
        });
    }

    function updateResultsDiv() {
        let messages = [];
        if (clinicianCount > 0) messages.push(`${clinicianCount} clinicians loaded`);
        if (openJetCount > 0) messages.push(`${openJetCount} Open Jet IDs loaded`);
        if (claimCount > 0) messages.push(`${claimCount} claims loaded`);
        resultsDiv.textContent = messages.join(', ');
        toggleProcessButton();
    }
    
    function handleUnifiedExcelInput() {
        // Clear results and disable process button immediately
        resultsDiv.innerHTML = '';
        validationDiv.innerHTML = '';
        processBtn.disabled = true;
    
        var promises = [];
    
        if (excelInput.files[0]) {
            promises.push(
                sheetToJsonWithHeader(excelInput.files[0], 0, 1, false).then(function (data) {
                    clinicianMap = {};
                    data.forEach(function (row) {
                        var id = (row['Clinician License'] || '').toString().trim();
                        if (id) {
                            clinicianMap[id] = {
                                name: row['Clinician Name'] || row['Name'] || '',
                                category: row['Clinician Category'] || row['Category'] || '',
                                privileges: row['Activity Group'] || row['Privileges'] || ''
                            };
                        }
                    });
                    clinicianCount = Object.keys(clinicianMap).length;
                    updateResultsDiv();
                })
            );
        }
    
        if (openJetInput.files[0]) {
            promises.push(
                sheetToJsonWithHeader(openJetInput.files[0], 0, 1, true).then(function (data) {
                    openJetClinicianList = [];
                    data.forEach(function (row) {
                        var lic = (row['Clinician'] || '').toString().trim();
                        if (lic) openJetClinicianList.push(lic);
                    });
                    openJetCount = openJetClinicianList.length;
                    updateResultsDiv();
                })
            );
        }
    
        Promise.all(promises).catch(function (e) {
            resultsDiv.textContent = 'Error loading Excel files: ' + e.message;
            toggleProcessButton();
        });
    }

    function handleXmlInput() {
        // Clear results and disable process button immediately
        resultsDiv.innerHTML = '';
        validationDiv.innerHTML = '';
        processBtn.disabled = true;
        resultsDiv.textContent = 'Loading XML...';
    
        var file = xmlInput.files[0];
        if (!file) {
            xmlDoc = null;
            claimCount = 0;
            updateResultsDiv();
            toggleProcessButton();
            return;
        }
    
        file.text().then(function (text) {
            if (!text.trim()) throw new Error('Empty XML');
    
            var doc = new DOMParser().parseFromString(text, 'application/xml');
            if (doc.querySelector('parsererror')) throw new Error('Invalid XML');
    
            xmlDoc = doc;
            claimCount = xmlDoc.getElementsByTagName('Claim').length;
            updateResultsDiv();
            toggleProcessButton();
        }).catch(function (e) {
            xmlDoc = null;
            claimCount = 0;
            resultsDiv.textContent = 'Error loading XML: ' + e.message;
            toggleProcessButton();
        });
    }

    function getText(p, tag) {
        var el = p.getElementsByTagName(tag)[0];
        return el ? el.textContent.trim() : '';
    }

    function defaultClinicianData() {
        return { name: 'Unknown', category: 'Unknown', privileges: 'Unknown' };
    }

    function validateClinicians(o, p, od, pd) {
        if (!o || !p) return false;
        return o === p || od.category === pd.category;
    }

    function generateRemarks(od, pd) {
        var r = [];
        if (od.category !== pd.category) {
            r.push(`Category mismatch (${od.category} vs ${pd.category})`);
        }
        return r.join('; ');
    }

    function processClaims(d, m) {
        resultsDiv.textContent = 'Processing...';
        var claims = Array.from(d.getElementsByTagName('Claim'));
        var res = [];

        claims.forEach(function (cl) {
            var cid = getText(cl, 'ID') || 'N/A';
            var acts = Array.from(cl.getElementsByTagName('Activity'));

            acts.forEach(function (act) {
                var aid = getText(act, 'ID') || 'N/A';
                var oid = getText(act, 'OrderingClinician') || '';
                var pid = getText(act, 'Clinician') || '';
                var od = m[oid] || defaultClinicianData();
                var pd = m[pid] || defaultClinicianData();

                var rem = [];
                if (pid && !openJetClinicianList.includes(pid)) {
                    rem.push(`Performing Clinician (${pid}) not in Open Jet`);
                }
                if (oid && !openJetClinicianList.includes(oid)) {
                    rem.push(`Ordering Clinician (${oid}) not in Open Jet`);
                }

                var valid = validateClinicians(oid, pid, od, pd);
                if (!valid) {
                    rem.push(generateRemarks(od, pd));
                }

                res.push({
                    claimId: cid,
                    activityId: aid,
                    clinicianInfo: `Ordering: ${oid} - ${od.name}\nPerforming: ${pid} - ${pd.name}`,
                    privilegesInfo: `Ordering: ${od.privileges}\nPerforming: ${pd.privileges}`,
                    categoryInfo: `Ordering: ${od.category}\nPerforming: ${pd.category}`,
                    valid: valid,
                    remarks: rem.join('; '),
                    rowSpan: 1
                });
            });
        });

        for (var i = 1; i < res.length; i++) {
            if (res[i].claimId === res[i - 1].claimId) {
                res[i].rowSpan = 0;
                res[i - 1].rowSpan++;
            }
        }

        renderResults(res);
        setupExportHandler(res);
    }

    function formatClinicianInfo(text) {
        if (!text) return '';
        text = text.replace(/\b(Ordering|Performing):/g, '<b>$1:</b>');
        text = text.replace(/\bDr\b\s/g, '<i>Dr</i> ');
        return text;
    }

    function renderResults(results) {
        resultsDiv.innerHTML = '';
        validationDiv.innerHTML = '';
    
        if (!results.length) {
            resultsDiv.textContent = 'No results found';
            return;
        }
    
        const validCount = results.filter(r => r.valid).length;
        const total = results.length;
        const pct = Math.round((validCount / total) * 100);
    
        validationDiv.textContent = `Validation completed: ${validCount}/${total} valid (${pct}%)`;
        validationDiv.className = pct > 90 ? 'valid-message' : pct > 70 ? 'warning-message' : 'error-message';
    
        const table = document.createElement('table');
        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');
        ['Claim ID', 'Act ID', 'Clinicians', 'Privileges', 'Categories', 'Valid', 'Remarks'].forEach(function (t) {
            const th = document.createElement('th');
            th.scope = 'col';
            th.textContent = t;
            headerRow.appendChild(th);
        });
        thead.appendChild(headerRow);
        table.appendChild(thead);
    
        const tbody = document.createElement('tbody');
        let prevClaimId = null;
    
        results.forEach(function (r) {
            const tr = document.createElement('tr');
            tr.className = r.valid ? 'valid' : 'invalid';
    
            // Only show Claim ID if it's different from the previous one
            const td0 = document.createElement('td');
            if (r.claimId !== prevClaimId) {
                td0.textContent = r.claimId;
                prevClaimId = r.claimId;
            } else {
                td0.textContent = '';
            }
            td0.style.verticalAlign = 'top';
            tr.appendChild(td0);
    
            // Columns besides Claim ID
            const cols = [
                r.activityId,
                formatClinicianInfo(r.clinicianInfo),
                r.privilegesInfo,
                r.categoryInfo,
                r.valid ? '✔️' : '❌',
                r.remarks
            ];
    
            cols.forEach(function (txt, idx) {
                const td = document.createElement('td');
                // For the clinicianInfo column, use innerHTML to support formatting
                if (idx === 1) {
                    td.style.whiteSpace = 'pre-line';
                    td.innerHTML = txt;
                } else {
                    td.style.whiteSpace = txt.includes('\n') ? 'pre-line' : 'nowrap';
                    td.textContent = txt;
                }
                tr.appendChild(td);
            });
    
            tbody.appendChild(tr);
        });
    
        table.appendChild(tbody);
        resultsDiv.appendChild(table);
    }

    function setupExportHandler(results) {
        exportCsvBtn.disabled = false;
        exportCsvBtn.onclick = function () {
            if (!xmlDoc) {
                alert('No XML document loaded for export.');
                return;
            }
    
            // Extract SenderID
            const senderID = (xmlDoc.querySelector('Header > SenderID')?.textContent || 'UnknownSender').trim();
    
            // Extract and parse TransactionDate (format: dd/MM/yyyy HH:mm)
            const transactionDateRaw = (xmlDoc.querySelector('Header > TransactionDate')?.textContent || '').trim();
            let transactionDateFormatted = 'UnknownDate';
    
            if (transactionDateRaw) {
                // Convert from dd/MM/yyyy to yyyy-MM-dd
                const dateParts = transactionDateRaw.split(' ')[0].split('/');
                if (dateParts.length === 3) {
                    // Format YYYY-MM-DD
                    transactionDateFormatted = `${dateParts[2]}-${dateParts[1].padStart(2,'0')}-${dateParts[0].padStart(2,'0')}`;
                }
            }
    
            // Prepare data rows for XLSX
            const headers = [
                'Claim ID',
                'Activity ID',
                'Valid/Invalid',
                'Remarks',
                'Ordering Clinician ID',
                'Ordering Privilege',
                'Ordering Category',
                'Performing Clinician ID',
                'Performing Privilege',
                'Performing Category'
            ];
    
            const rows = results.map(r => {
                // Split clinicianInfo like "Ordering: oid - name\nPerforming: pid - name"
                // We want just the IDs (oid and pid)
                let orderingID = '', performingID = '';
                if (r.clinicianInfo) {
                    const lines = r.clinicianInfo.split('\n');
                    const orderingLine = lines.find(l => l.startsWith('Ordering:')) || '';
                    const performingLine = lines.find(l => l.startsWith('Performing:')) || '';
    
                    // Ordering: oid - name
                    const orderMatch = orderingLine.match(/^Ordering:\s*(\S+)\s*-/);
                    orderingID = orderMatch ? orderMatch[1] : '';
    
                    // Performing: pid - name
                    const performMatch = performingLine.match(/^Performing:\s*(\S+)\s*-/);
                    performingID = performMatch ? performMatch[1] : '';
                }
    
                return [
                    r.claimId,
                    r.activityId,
                    r.valid ? 'Valid' : 'Invalid',
                    r.remarks,
                    orderingID,
                    r.privilegesInfo.split('\n')[0].replace(/^Ordering:\s*/, '') || '',
                    r.categoryInfo.split('\n')[0].replace(/^Ordering:\s*/, '') || '',
                    performingID,
                    r.privilegesInfo.split('\n')[1]?.replace(/^Performing:\s*/, '') || '',
                    r.categoryInfo.split('\n')[1]?.replace(/^Performing:\s*/, '') || ''
                ];
            });
    
            // Create workbook and worksheet
            const wb = XLSX.utils.book_new();
            const wsData = [headers, ...rows];
            const ws = XLSX.utils.aoa_to_sheet(wsData);
    
            // Freeze first row (headers)
            ws['!freeze'] = { xSplit: 0, ySplit: 1 };
    
            // Auto-width columns based on max length in each column
            const colWidths = headers.map((h, i) => {
                let maxLen = h.length;
                rows.forEach(r => {
                    const v = r[i];
                    if (v) maxLen = Math.max(maxLen, v.toString().length);
                });
                return { wch: Math.min(maxLen + 5, 50) }; // cap max width to 50 chars
            });
            ws['!cols'] = colWidths;
    
            XLSX.utils.book_append_sheet(wb, ws, 'Validation Results');
    
            // Generate filename
            const filename = `ClaimsValidation__${senderID}__${transactionDateFormatted}.xlsx`;
    
            // Export file
            XLSX.writeFile(wb, filename);
        };
    }

    function toggleProcessButton() {
        processBtn.disabled = !(xmlDoc && clinicianMap && openJetClinicianList.length > 0);
    }

    document.addEventListener('DOMContentLoaded', initEventListeners);
})();
