(function (root) {
  'use strict';

  if (!root || root.__schemaOccurrenceLimitsPatchInstalled) {
    return;
  }

  const OLD_DUPLICATE_PATTERN = /^Duplicate code\s+.+?\s+with Ordering Clinician\s+.+?\.?$/i;
  const OK_PATTERN = /^OK\.?$/i;

  function normalizeHeader(value) {
    return String(value == null ? '' : value)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  }

  function getVisibleCheckerContainer() {
    const candidates = Array.from(document.querySelectorAll('.checker-container'));
    return candidates.find((element) => {
      if (!element || element.id !== 'checker-container-schema') return false;
      return getComputedStyle(element).display !== 'none';
    }) || document.getElementById('checker-container-schema') || null;
  }

  function getScopedElement(id) {
    const container = getVisibleCheckerContainer();
    return (container && container.querySelector(`#${id}`)) || document.getElementById(id);
  }

  function resolveXmlFile() {
    const input = getScopedElement('xmlFile');
    return input?.files?.[0] || root.unifiedCheckerFiles?.xml || null;
  }

  function parseXml(xmlText) {
    const safeText = String(xmlText || '').replace(
      /&(?!(amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;))/g,
      'and'
    );
    const documentNode = new DOMParser().parseFromString(safeText, 'application/xml');
    const parserError = documentNode.getElementsByTagName('parsererror')[0];

    if (parserError) {
      throw new Error('The XML is not well-formed.');
    }

    return documentNode;
  }


  function temporarilySuppressOldDuplicateFinding() {
    const originalPush = Array.prototype.push;

    Array.prototype.push = function patchedArrayPush() {
      const items = Array.from(arguments).filter((item) => {
        return !(typeof item === 'string' && OLD_DUPLICATE_PATTERN.test(item.trim()));
      });

      if (items.length === 0) return this.length;
      return originalPush.apply(this, items);
    };

    return function restoreArrayPush() {
      if (Array.prototype.push !== originalPush) {
        Array.prototype.push = originalPush;
      }
    };
  }

  function groupFindingsByClaim(findings) {
    const map = new Map();

    for (const finding of findings || []) {
      const claimID = String(finding.claimID || 'Unknown').trim();
      if (!map.has(claimID)) map.set(claimID, []);
      map.get(claimID).push(finding);
    }

    return map;
  }

  function cleanRemarkLines(remark) {
    return String(remark == null ? '' : remark)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !OLD_DUPLICATE_PATTERN.test(line));
  }

  function applyFindingsToResult(result, findings) {
    const originalLines = String(result?.Remark || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const removedDuplicateCount = originalLines.filter((line) => OLD_DUPLICATE_PATTERN.test(line)).length;
    let lines = cleanRemarkLines(result?.Remark);

    if (findings.length > 0) {
      lines = lines.filter((line) => !OK_PATTERN.test(line));
      for (const finding of findings) {
        if (!lines.includes(finding.remark)) lines.push(finding.remark);
      }
      result.Valid = false;
      result.Unknown = false;
    } else if (removedDuplicateCount > 0) {
      const substantiveLines = lines.filter((line) => !OK_PATTERN.test(line));
      if (substantiveLines.length === 0) {
        result.Valid = true;
        lines = ['OK'];
      }
    }

    if (lines.length === 0) lines = ['OK'];
    result.Remark = lines.join('\n');
    result.TariffOccurrenceFindings = findings.slice();
    return result;
  }

  function updateLastResults(findingsByClaim) {
    const results = root._lastValidationResults;

    if (!Array.isArray(results)) {
      return null;
    }

    for (const result of results) {
      const claimID = String(result?.ClaimID || 'Unknown').trim();
      applyFindingsToResult(result, findingsByClaim.get(claimID) || []);
    }

    return results;
  }

  function findColumnIndexes(table) {
    const headers = Array.from(table?.querySelectorAll('thead th') || []);
    const normalized = headers.map((cell) => normalizeHeader(cell.textContent));

    function findIndex(names) {
      return normalized.findIndex((header) => names.some((name) => header === name || header.includes(name)));
    }

    return {
      claim: findIndex(['claimid', 'claim']),
      status: findIndex(['status', 'validity', 'valid']),
      remark: findIndex(['remarks', 'remark', 'errors', 'error'])
    };
  }

  function statusForResult(result) {
    if (!result?.Valid) return 'Invalid';
    if (result?.Unknown) return 'Unknown';
    return 'Valid';
  }

  function applyRowStyle(row, status) {
    const classNames = [
      'valid', 'invalid', 'unknown',
      'valid-row', 'invalid-row', 'unknown-row',
      'table-success', 'table-danger', 'table-warning'
    ];
    row.classList.remove(...classNames);

    if (status === 'Invalid') {
      row.classList.add('invalid-row', 'table-danger');
    } else if (status === 'Unknown') {
      row.classList.add('unknown-row', 'table-warning');
    } else {
      row.classList.add('valid-row', 'table-success');
    }
  }

  function updateRenderedTable(resultElement, results, findingsByClaim) {
    const table = resultElement?.tagName === 'TABLE'
      ? resultElement
      : resultElement?.querySelector?.('table');

    if (!table) return;

    const indexes = findColumnIndexes(table);
    const rows = Array.from(table.querySelectorAll('tbody tr'));

    rows.forEach((row, rowIndex) => {
      const cells = Array.from(row.cells || []);
      const claimFromCell = indexes.claim >= 0 ? String(cells[indexes.claim]?.textContent || '').trim() : '';
      const result = Array.isArray(results)
        ? (results.find((entry) => String(entry?.ClaimID || '').trim() === claimFromCell) || results[rowIndex])
        : null;

      if (result) {
        const status = statusForResult(result);

        if (indexes.status >= 0 && cells[indexes.status]) {
          cells[indexes.status].textContent = status;
          cells[indexes.status].dataset.status = status.toLowerCase();
        }

        if (indexes.remark >= 0 && cells[indexes.remark]) {
          cells[indexes.remark].textContent = result.Remark || 'OK';
          cells[indexes.remark].style.whiteSpace = 'pre-line';
        }

        applyRowStyle(row, status);
        return;
      }

      // Fallback for an older renderer that did not expose _lastValidationResults.
      const claimID = claimFromCell || `__row_${rowIndex}`;
      const findings = findingsByClaim.get(claimID) || [];

      if (indexes.remark >= 0 && cells[indexes.remark]) {
        let lines = cleanRemarkLines(cells[indexes.remark].textContent);

        if (findings.length > 0) {
          lines = lines.filter((line) => !OK_PATTERN.test(line));
          findings.forEach((finding) => {
            if (!lines.includes(finding.remark)) lines.push(finding.remark);
          });
        }

        if (lines.length === 0) lines = ['OK'];
        cells[indexes.remark].textContent = lines.join('\n');
        cells[indexes.remark].style.whiteSpace = 'pre-line';

        if (findings.length > 0 && indexes.status >= 0 && cells[indexes.status]) {
          cells[indexes.status].textContent = 'Invalid';
          applyRowStyle(row, 'Invalid');
        }
      }
    });
  }

  function updateSummary(results) {
    if (!Array.isArray(results)) return;

    const status = getScopedElement('uploadStatus');
    if (!status) return;

    const total = results.length;
    const valid = results.filter((result) => result?.Valid).length;
    const percentage = total > 0 ? ((valid / total) * 100).toFixed(1) : '0.0';
    status.textContent = `Valid claims: ${valid} / ${total} (${percentage}%)`;
  }

  function createErrorResult(message) {
    const wrapper = document.createElement('div');
    wrapper.className = 'alert alert-danger';
    wrapper.setAttribute('role', 'alert');
    wrapper.textContent = `Schema Checker failed: ${message}`;
    return wrapper;
  }

  function installPatch() {
    const originalValidateXmlSchema = root.validateXmlSchema;

    if (typeof originalValidateXmlSchema !== 'function') {
      console.error('[SCHEMA][TARIFF] validateXmlSchema is unavailable. Load this script after checker_schema.js.');
      return false;
    }

    if (!root.MandatoryTariffShared) {
      console.error('[SCHEMA][TARIFF] MandatoryTariffShared is unavailable. Load mandatory_tariff_shared.js first.');
      return false;
    }

    root.validateXmlSchema = async function patchedValidateXmlSchema() {
      const xmlFile = resolveXmlFile();
      const status = getScopedElement('uploadStatus');

      if (!xmlFile) {
        return originalValidateXmlSchema.apply(this, arguments);
      }

      let tariffData;
      let xmlDocument;

      try {
        const [loadedTariff, xmlText] = await Promise.all([
          root.MandatoryTariffShared.loadBundledMandatoryTariff(),
          xmlFile.text()
        ]);
        tariffData = loadedTariff;
        xmlDocument = parseXml(xmlText);
      } catch (error) {
        const message = error?.message || String(error);
        console.error('[SCHEMA][TARIFF] Failed before Schema validation:', error);
        if (status) status.textContent = `Schema Checker failed: ${message}`;
        return createErrorResult(message);
      }

      const restoreArrayPush = temporarilySuppressOldDuplicateFinding();
      let resultElement;

      try {
        resultElement = await originalValidateXmlSchema.apply(this, arguments);
      } finally {
        restoreArrayPush();
      }

      if (!resultElement || xmlDocument.documentElement.nodeName !== 'Claim.Submission') {
        return resultElement;
      }

      try {
        tariffData.warnings.forEach((warning) => console.warn('[SCHEMA][TARIFF]', warning));

        const findings = root.MandatoryTariffShared.validateSubmissionOccurrenceLimits(
          xmlDocument,
          tariffData.map
        );
        const findingsByClaim = groupFindingsByClaim(findings);
        const results = updateLastResults(findingsByClaim);

        updateRenderedTable(resultElement, results, findingsByClaim);
        updateSummary(results);

        root._lastTariffOccurrenceFindings = findings;
        console.log(
          `[SCHEMA][TARIFF] Applied occurrence limits. Findings: ${findings.length}; ` +
          `tariff rows: ${tariffData.rows.length}; source: ${tariffData.path}`
        );
      } catch (error) {
        const message = error?.message || String(error);
        console.error('[SCHEMA][TARIFF] Failed to apply occurrence limits:', error);
        if (status) status.textContent = `Schema Checker failed: ${message}`;
        return createErrorResult(message);
      }

      return resultElement;
    };

    root.__schemaOccurrenceLimitsPatchInstalled = true;
    root.SchemaOccurrenceLimitsPatch = Object.freeze({
      cleanRemarkLines,
      applyFindingsToResult,
      groupFindingsByClaim
    });

    console.log('[SCHEMA][TARIFF] Occurrence-limit patch installed.');
    return true;
  }

  installPatch();
})(typeof window !== 'undefined' ? window : globalThis);
