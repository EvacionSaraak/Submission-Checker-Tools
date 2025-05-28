//YWA KA LAGI HAHAAH CHAT GPT PA MORE!!!

(function() {
    'use strict';
    var openJetClinicianList = [];
    var xmlDoc = null;
    var clinicianMap = null;
    var xmlInput, excelInput, openJetInput, resultsDiv, validationDiv, processBtn, exportCsvBtn;

    function sheetToJsonWithHeader(file, sheetIndex, headerRow) {
        var idx = sheetIndex || 0;
        var hdr = headerRow || 1;
        return file.arrayBuffer().then(function (buffer) {
            var data = new Uint8Array(buffer);
            var wb = XLSX.read(data, { type: 'array' });
            var name = wb.SheetNames[idx];
            if (!name) {
                throw new Error('Sheet index ' + idx + ' not found');
            }
            var sheet = wb.Sheets[name];
            var rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
            if (!rows || rows.length < hdr) {
                throw new Error('Header row ' + hdr + ' out of range');
            }
            var headers = rows[hdr - 1];
            if (!headers || headers.length === 0) {
                throw new Error('No header found at row ' + hdr);
            }
            var dataRows = rows.slice(hdr);
            return dataRows.map(function (row) {
                var obj = {};
                headers.forEach(function (h, i) {
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
        if (excelInput) {
            excelInput.addEventListener('change', handleUnifiedExcelInput);
        }
        if (openJetInput) {
            openJetInput.addEventListener('change', handleUnifiedExcelInput);
        }
        processBtn.addEventListener('click', function() {
            if (xmlDoc && clinicianMap && openJetClinicianList.length > 0) {
                processClaims(xmlDoc, clinicianMap);
            }
        });
    }

    function handleUnifiedExcelInput() {
        resultsDiv.textContent = 'Loading Excel files...';
        var promises = [];
        if (excelInput.files[0]) {
            promises.push(
                sheetToJsonWithHeader(excelInput.files[0], 0, 2).then(function (data) {
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
                })
            );
        }
        if (openJetInput.files[0]) {
            promises.push(
                sheetToJsonWithHeader(openJetInput.files[0], 0, 1).then(function (data) {
                    openJetClinicianList = [];
                    data.forEach(function (row) {
                        var lic = (row['Clinician'] || '').toString().trim();
                        if (lic) {
                            openJetClinicianList.push(lic);
                        }
                    });
                })
            );
        }
        Promise.all(promises).then(function () {
            var cCount = Object.keys(clinicianMap).length;
            var oCount = openJetClinicianList.length;
            resultsDiv.textContent = 'Excel loaded: ' + cCount + ' clinicians, ' + oCount + ' Open Jet IDs.';
            toggleProcessButton();
        }).catch(function (e) {
            resultsDiv.textContent = 'Error loading Excel files: ' + e.message;
            toggleProcessButton();
        });
    }

    function handleXmlInput() {
        resultsDiv.textContent = 'Loading XML...';
        var file = xmlInput.files[0];
        if (!file) {
            xmlDoc = null;
            resultsDiv.textContent = 'Error loading XML: No XML selected';
            toggleProcessButton();
            return;
        }
        file.text().then(function (text) {
            if (!text.trim()) {
                throw new Error('Empty XML');
            }
            var doc = new DOMParser().parseFromString(text, 'application/xml');
            if (doc.querySelector('parsererror')) {
                throw new Error('Invalid XML');
            }
            xmlDoc = doc;
            resultsDiv.textContent = 'XML loaded (' + xmlDoc.getElementsByTagName('Claim').length + ' claims).';
            toggleProcessButton();
        }).catch(function (e) {
            xmlDoc = null;
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
        if (!o || !p) {
            return false;
        }
        if (o === p) {
            return true;
        }
        return od.category === pd.category;
    }

    function generateRemarks(od, pd) {
        var r = [];
        if (od.category !== pd.category) {
            r.push('Category mismatch (' + od.category + ' vs ' + pd.category + ')');
        }
        return r.join('; ');
    }

    function processClaims(d, m) {
        resultsDiv.textContent = 'Processing...';
        var claims = Array.prototype.slice.call(d.getElementsByTagName('Claim'));
        var res = [];
        claims.forEach(function (cl) {
            var cid = getText(cl, 'ID') || 'N/A';
            var acts = Array.prototype.slice.call(cl.getElementsByTagName('Activity'));
            acts.forEach(function (act) {
                var aid = getText(act, 'ID') || 'N/A';
                var oid = getText(act, 'OrderingClinician') || '';
                var pid = getText(act, 'Clinician') || '';
                var od = m[oid] || defaultClinicianData();
                var pd = m[pid] || defaultClinicianData();
                var rem = [];
                if (pid && openJetClinicianList.indexOf(pid) === -1) {
                    rem.push('Performing Clinician (' + pid + ') not in Open Jet');
                }
                if (oid && openJetClinicianList.indexOf(oid) === -1) {
                    rem.push('Ordering Clinician (' + oid + ') not in Open Jet');
                }
                var valid = validateClinicians(oid, pid, od, pd);
                if (!valid) {
                    rem.push(generateRemarks(od, pd));
                }
                res.push({
                    claimId: cid,
                    activityId: aid,
                    clinicianInfo: 'Ordering: ' + oid + ' - ' + od.name + '\nPerforming: ' + pid + ' - ' + pd.name,
                    privilegesInfo: 'Ordering: ' + od.privileges + '\nPerforming: ' + pd.privileges,
                    categoryInfo: 'Ordering: ' + od.category + '\nPerforming: ' + pd.category,
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

    function renderResults(results) {
        resultsDiv.innerHTML = '';
        validationDiv.innerHTML = '';
        if (!results.length) {
            resultsDiv.textContent = 'No results found';
            return;
        }
        var vc = results.filter(function (r) {
            return r.valid;
        }).length;
        var tot = results.length;
        var pct = Math.round(vc / tot * 100);
        validationDiv.textContent = 'Validation completed: ' + vc + '/' + tot + ' valid (' + pct + '%)';
        validationDiv.className = pct > 90 ? 'valid-message' : pct > 70 ? 'warning-message' : 'error-message';
        var tbl = document.createElement('table');
        var thead = document.createElement('thead');
        var hrow = document.createElement('tr');
        ['Claim ID', 'Act ID', 'Clinicians', 'Privileges', 'Categories', 'Valid', 'Remarks'].forEach(function (t) {
            var th = document.createElement('th');
            th.textContent = t;
            hrow.appendChild(th);
        });
        thead.appendChild(hrow);
        tbl.appendChild(thead);
        var tbody = document.createElement('tbody');
        results.forEach(function (r) {
            if (r.rowSpan === 0) {
                return;
            }
            var tr = document.createElement('tr');
            tr.className = r.valid ? 'valid' : 'invalid';
            var td0 = document.createElement('td');
            td0.textContent = r.claimId;
            if (r.rowSpan > 1) {
                td0.rowSpan = r.rowSpan;
                td0.style.verticalAlign = 'top';
            }
            tr.appendChild(td0);
            [r.activityId, r.clinicianInfo, r.privilegesInfo, r.categoryInfo, r.valid ? '✔️' : '❌', r.remarks].forEach(function (txt) {
                var td = document.createElement('td');
                td.style.whiteSpace = txt.includes('\n') ? 'pre-line' : 'nowrap';
                td.textContent = txt;
                tr.appendChild(td);
            });
            tbody.appendChild(tr);
        });
        tbl.appendChild(tbody);
        resultsDiv.appendChild(tbl);
    }

    function setupExportHandler(results) {
        exportCsvBtn.disabled = false;
        exportCsvBtn.onclick = function () {
            var hdr = ['Claim ID', 'Act ID', 'Clinicians', 'Privileges', 'Categories', 'Valid', 'Remarks'];
            var rows = results.map(function (r) {
                return [r.claimId, r.activityId, r.clinicianInfo, r.privilegesInfo, r.categoryInfo, r.valid ? 'Yes' : 'No', r.remarks];
            });
            var csv = [hdr].concat(rows).map(function (r) {
                return r.map(function (v) { return '"' + v.replace(/"/g, '""') + '"'; }).join(',');
            }).join('\n');
            var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            var a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'validation_results.csv';
            a.click();
        };
    }

    function toggleProcessButton() {
        processBtn.disabled = !(xmlDoc && clinicianMap && openJetClinicianList.length > 0);
    }

    document.addEventListener('DOMContentLoaded', initEventListeners);
})();
