(function () {
  'use strict';

  let xmlInput, eligibilityInput, processBtn, resultsDiv;
  let xmlDoc = null, eligibilityMap = {};

  document.addEventListener('DOMContentLoaded', () => {
    xmlInput = document.getElementById('xmlFileInput');
    eligibilityInput = document.getElementById('eligibilityFileInput');
    processBtn = document.getElementById('processBtn');
    resultsDiv = document.getElementById('results');

    xmlInput.addEventListener('change', debounce(handleXmlInput, 300));
    eligibilityInput.addEventListener('change', debounce(handleEligibilityInput, 300));
    processBtn.addEventListener('click', validateEligibility);
  });

  function handleXmlInput(e) {
    const file = e.target.files[0];
    if (!file) return;
    showLoading('Processing XML file...');
    file.text().then(text => {
      try {
        const parsed = new DOMParser().parseFromString(text, 'application/xml');
        // Check for parser errors
        if (parsed.getElementsByTagName('parsererror').length) {
          throw new Error('Invalid XML format.');
        }
        xmlDoc = parsed;
        showSuccess('XML file loaded successfully.');
      } catch (error) {
        console.error('Error parsing XML:', error);
        alert('Invalid XML file.');
        xmlDoc = null;
        showError('Failed to load XML file.');
      }
    }).finally(hideLoading);
  }

  function handleEligibilityInput(e) {
    const file = e.target.files[0];
    if (!file) return;
    showLoading('Processing eligibility file...');
    readExcel(file, data => {
      eligibilityMap = {}; // Reset map for each new upload
      let missingFields = false;
      data.forEach(row => {
        const id = row['Clinician']?.toString().trim();
        if (!id) return;
        // Check required fields
        if (
          !row.hasOwnProperty('EffectiveDate') ||
          !row.hasOwnProperty('ExpiryDate') ||
          !row.hasOwnProperty('Card Status')
        ) {
          missingFields = true;
        }
        eligibilityMap[id] = row;
      });
      if (missingFields) {
        alert('Some rows in the eligibility file are missing required fields (EffectiveDate, ExpiryDate, Card Status).');
        showError('Eligibility file missing required fields.');
      } else {
        showSuccess('Eligibility file loaded successfully.');
      }
      hideLoading();
    });
  }

  function validateEligibility() {
    if (!xmlDoc) {
      alert('Please upload a valid XML file first.');
      return;
    }
    if (Object.keys(eligibilityMap).length === 0) {
      alert('Please upload a valid eligibility file first.');
      return;
    }
    showLoading('Validating eligibility...');
    const claims = xmlDoc.getElementsByTagName('Claim');
    const results = [];

    for (const claim of claims) {
      const encounter = claim.getElementsByTagName('Encounter')[0];
      const start = parseDate(getText(encounter, 'Start'));
      const end = parseDate(getText(encounter, 'End'));

      const activities = claim.getElementsByTagName('Activity');
      for (const activity of activities) {
        const orderingId = getText(activity, 'OrderingClinician');
        const performingId = getText(activity, 'Clinician');
        const remarks = [];

        const validate = (id, role) => {
          const row = eligibilityMap[id];
          if (!row) return `${role} (${id}) not found in eligibility file`;
          const from = parseDate(row['EffectiveDate']);
          const to = parseDate(row['ExpiryDate']);
          if (from.toString() === 'Invalid Date' || to.toString() === 'Invalid Date') {
            return `${role} (${id}) has invalid eligibility dates.`;
          }
          if (start < from || end > to) {
            return `${role} eligibility period invalid (${from.toDateString()} - ${to.toDateString()})`;
          }
          if (row['Card Status']?.toLowerCase() !== 'active') return `${role} card is not active`;
          return null;
        };

        const oRes = validate(orderingId, 'Ordering');
        const pRes = validate(performingId, 'Performing');

        if (oRes) remarks.push(oRes);
        if (pRes) remarks.push(pRes);

        results.push({
          claimId: getText(claim, 'ID'),
          activityId: getText(activity, 'ID'),
          ordering: orderingId,
          performing: performingId,
          remarks: remarks
        });
      }
    }
    render(results);
    hideLoading();
  }

  function render(results) {
    if (!results.length) {
      resultsDiv.innerHTML = '<p role="status" aria-live="polite">No results found.</p>';
      return;
    }
    resultsDiv.innerHTML = `
      <table aria-label="Eligibility Results" role="table">
        <thead>
          <tr>
            <th>Claim</th>
            <th>Activity</th>
            <th>Ordering</th>
            <th>Performing</th>
            <th>Remarks</th>
          </tr>
        </thead>
        <tbody>
          ${
            results.map(r =>
              `<tr>
                <td>${r.claimId}</td>
                <td>${r.activityId}</td>
                <td>${r.ordering}</td>
                <td>${r.performing}</td>
                <td>${r.remarks.length ? r.remarks.map(escapeHTML).join('; ') : 'OK'}</td>
              </tr>`
            ).join('')
          }
        </tbody>
      </table>
    `;
  }

  function getText(parent, tag) {
    if (!parent) return '';
    const el = parent.getElementsByTagName(tag)[0];
    return el ? el.textContent.trim() : '';
  }

  function parseDate(str) {
    if (!str) return new Date('Invalid');
    const d = new Date(str);
    if (isNaN(d.getTime())) {
      console.warn('Invalid date:', str);
      return new Date('Invalid');
    }
    return d;
  }

  function readExcel(file, callback) {
    const reader = new FileReader();
    reader.onload = function (e) {
      try {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: 'array' });
        const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(firstSheet);
        if (!rows.length) throw new Error('Empty Excel sheet.');
        callback(rows);
      } catch (error) {
        console.error('Error reading Excel:', error);
        alert('Invalid eligibility file.');
        showError('Failed to load eligibility file.');
      }
    };
    reader.readAsArrayBuffer(file);
  }

  // Utilities

  function debounce(fn, delay) {
    let timeout;
    return function (...args) {
      clearTimeout(timeout);
      timeout = setTimeout(() => fn.apply(this, args), delay);
    };
  }

  function showLoading(message) {
    let loader = document.getElementById('loader');
    if (!loader) {
      loader = document.createElement('div');
      loader.id = 'loader';
      loader.setAttribute('role', 'status');
      loader.setAttribute('aria-live', 'polite');
      loader.style.position = 'fixed';
      loader.style.top = '10px';
      loader.style.right = '10px';
      loader.style.background = '#fff';
      loader.style.color = '#444';
      loader.style.padding = '8px 16px';
      loader.style.border = '1px solid #ccc';
      loader.style.borderRadius = '4px';
      loader.style.zIndex = 1000;
      document.body.appendChild(loader);
    }
    loader.textContent = message || 'Loading...';
    loader.style.display = 'block';
  }

  function hideLoading() {
    const loader = document.getElementById('loader');
    if (loader) loader.style.display = 'none';
  }

  function showSuccess(msg) {
    showBanner(msg, '#dff0d8', '#3c763d');
  }

  function showError(msg) {
    showBanner(msg, '#f2dede', '#a94442');
  }

  function showBanner(msg, bg, color) {
    let banner = document.getElementById('banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'banner';
      banner.setAttribute('role', 'alert');
      banner.style.position = 'fixed';
      banner.style.top = '0px';
      banner.style.left = '0px';
      banner.style.right = '0px';
      banner.style.fontWeight = 'bold';
      banner.style.textAlign = 'center';
      banner.style.padding = '8px 0';
      banner.style.zIndex = 1001;
      document.body.appendChild(banner);
    }
    banner.textContent = msg;
    banner.style.background = bg;
    banner.style.color = color;
    banner.style.display = 'block';
    setTimeout(() => { if (banner) banner.style.display = 'none'; }, 3000);
  }

  function escapeHTML(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // Optional: Expose utility functions for unit testing (if using a test runner)
  if (typeof window !== 'undefined') {
    window._checkerEligUtils = {
      getText,
      parseDate,
      readExcel,
      debounce,
      escapeHTML
    };
  }

})();
