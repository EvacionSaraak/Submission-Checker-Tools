(function (root, factory) {
  'use strict';

  const api = factory(root);

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  if (root) {
    root.MandatoryTariffShared = api;
  }
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';

  const nativeFetch = root && typeof root.fetch === 'function'
    ? root.fetch.bind(root)
    : null;

  const TYPE_ALIASES = Object.freeze({
    '3': 'CPT',
    CPT: 'CPT',
    HCPCS: 'CPT',
    PROCEDURE: 'CPT',
    PROCEDURES: 'CPT',

    '6': 'USCLS',
    USCLS: 'USCLS',
    DENTAL: 'USCLS',
    DENTISTRY: 'USCLS',

    '8': 'SERVICE',
    SERVICE: 'SERVICE',
    SERVICES: 'SERVICE'
  });

  const SUPPORTED_TYPES = new Set(['CPT', 'USCLS', 'SERVICE']);

  const HEADER_ALIASES = Object.freeze({
    type: new Set([
      'type',
      'cpttype',
      'activitytype',
      'activitytypecode',
      'codetype',
      'tarifftype',
      'servicetype'
    ]),
    code: new Set([
      'code',
      'activitycode',
      'cptcode',
      'procedurecode',
      'servicecode',
      'tariffcode'
    ]),
    maxOccurrences: new Set([
      'cptmuevalues',
      'cptmuevalue',
      'cptmue',
      'muevalues',
      'muevalue',
      'mue',
      'practitionerservicesmedicallyunlikelyedit'
    ])
  });

  function unique(values) {
    return Array.from(new Set(values.filter(Boolean)));
  }

  function buildDefaultPaths() {
    const paths = [];
    const fileNames = [
      'Mandatory Tariff Updated.xlsx',
      'Mandatory Tariff  Updated.xlsx'
    ];

    let scriptUrl = '';

    try {
      scriptUrl = root?.document?.currentScript?.src || '';
    } catch (error) {
      scriptUrl = '';
    }

    if (scriptUrl) {
      for (const fileName of fileNames) {
        try {
          paths.push(new URL(`../resources/${fileName}`, scriptUrl).href);
        } catch (error) {
          // Continue to other path strategies.
        }
      }
    }

    if (root?.location?.href) {
      for (const fileName of fileNames) {
        try {
          const pageUrl = new URL(root.location.href);
          const marker = '/Submission-Checker-Tools/';
          const markerIndex = pageUrl.pathname.indexOf(marker);

          if (markerIndex >= 0) {
            const basePath = pageUrl.pathname.slice(0, markerIndex + marker.length);
            paths.push(new URL(`${basePath}resources/${fileName}`, pageUrl.origin).href);
          }
        } catch (error) {
          // Continue to raw GitHub fallbacks.
        }
      }
    }

    const rawBase =
      'https://raw.githubusercontent.com/EvacionSaraak/' +
      'Submission-Checker-Tools/refs/heads/' +
      'copilot/copilotimplement-exclusion-checker/resources/';

    for (const fileName of fileNames) {
      paths.push(rawBase + encodeURIComponent(fileName).replace(/%2F/gi, '/'));
    }

    return Object.freeze(unique(paths));
  }

  const DEFAULT_PATHS = buildDefaultPaths();

  let cachedPromise = null;
  let cachedPathsKey = '';
  let fetchFallbackInstalled = false;

  function normalizeHeader(value) {
    return String(value == null ? '' : value)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  }

  function normalizeActivityType(value) {
    const raw = String(value == null ? '' : value)
      .trim()
      .toUpperCase();

    return TYPE_ALIASES[raw] || raw;
  }

  function normalizeCode(value, activityType) {
    const type = normalizeActivityType(activityType);
    let code = String(value == null ? '' : value)
      .trim()
      .toUpperCase();

    if (type === 'CPT' && /^\d+$/.test(code) && code.length < 5) {
      code = code.padStart(5, '0');
    }

    return code;
  }

  function makeTariffKey(activityType, code) {
    const normalizedType = normalizeActivityType(activityType);
    return `${normalizedType}|${normalizeCode(code, normalizedType)}`;
  }

  function parseMaxOccurrences(rawValue) {
    const text = String(rawValue == null ? '' : rawValue).trim();

    if (!text) {
      return { limit: null, error: null };
    }

    const numericValue = Number(text.replace(/,/g, ''));

    if (!Number.isFinite(numericValue)) {
      return {
        limit: null,
        error: `Invalid CPT MUE value: ${text}`
      };
    }

    // Blank and 0 mean that no occurrence cap is applied by this checker.
    if (numericValue === 0) {
      return { limit: null, error: null };
    }

    if (!Number.isInteger(numericValue) || numericValue < 0) {
      return {
        limit: null,
        error: `Invalid CPT MUE value: ${text}`
      };
    }

    return { limit: numericValue, error: null };
  }

  function getDirectChildren(parent, tagName) {
    if (!parent || !parent.childNodes) return [];

    return Array.from(parent.childNodes).filter((node) => {
      if (!node || node.nodeType !== 1) return false;
      return (node.localName || node.nodeName) === tagName;
    });
  }

  function getDirectChildText(parent, tagName) {
    const child = getDirectChildren(parent, tagName)[0];
    return child && child.textContent ? child.textContent.trim() : '';
  }

  function findColumnIndex(headerRow, aliases) {
    return headerRow.findIndex((cell) => aliases.has(normalizeHeader(cell)));
  }

  function locateHeaderRow(matrix) {
    const maxRows = Math.min(matrix.length, 50);

    for (let rowIndex = 0; rowIndex < maxRows; rowIndex += 1) {
      const row = Array.isArray(matrix[rowIndex]) ? matrix[rowIndex] : [];
      const typeIndex = findColumnIndex(row, HEADER_ALIASES.type);
      const codeIndex = findColumnIndex(row, HEADER_ALIASES.code);
      const maxOccurrencesIndex = findColumnIndex(row, HEADER_ALIASES.maxOccurrences);

      if (typeIndex >= 0 && codeIndex >= 0 && maxOccurrencesIndex >= 0) {
        return {
          rowIndex,
          typeIndex,
          codeIndex,
          maxOccurrencesIndex
        };
      }
    }

    return null;
  }

  function sheetPriority(name, originalIndex) {
    const text = String(name || '').trim();
    const mandatoryMatch = text.match(/mandatory\s*tariff\s*(\d{4})?/i);

    if (mandatoryMatch) {
      const year = mandatoryMatch[1] ? Number(mandatoryMatch[1]) : 0;
      return { group: 0, year, originalIndex };
    }

    return { group: 1, year: 0, originalIndex };
  }

  function locateTariffWorksheet(workbook, XLSX) {
    const sheetNames = Array.isArray(workbook?.SheetNames)
      ? workbook.SheetNames
      : [];

    if (!sheetNames.length) {
      throw new Error('Mandatory Tariff workbook contains no worksheets.');
    }

    const orderedSheetNames = sheetNames
      .map((name, originalIndex) => ({
        name,
        ...sheetPriority(name, originalIndex)
      }))
      .sort((left, right) => {
        if (left.group !== right.group) return left.group - right.group;
        if (left.year !== right.year) return right.year - left.year;
        return left.originalIndex - right.originalIndex;
      });

    const inspectedSheets = [];

    for (const candidate of orderedSheetNames) {
      const sheetName = candidate.name;
      const sheet = workbook.Sheets[sheetName];

      if (!sheet) continue;

      const matrix = XLSX.utils.sheet_to_json(sheet, {
        header: 1,
        defval: '',
        raw: false,
        blankrows: false
      });

      const header = locateHeaderRow(matrix);
      inspectedSheets.push(sheetName);

      if (header) {
        return {
          sheetName,
          sheet,
          matrix,
          header,
          inspectedSheets
        };
      }
    }

    throw new Error(
      'Mandatory Tariff is missing one or more required columns: ' +
      'Type, Code, CPT MUE Values. ' +
      `Worksheets checked: ${inspectedSheets.join(', ')}.`
    );
  }

  function parseMandatoryTariffWorkbook(workbook, xlsxOverride) {
    const XLSX = xlsxOverride || root?.XLSX;

    if (!XLSX?.utils || typeof XLSX.utils.sheet_to_json !== 'function') {
      throw new Error('SheetJS (XLSX) is unavailable.');
    }

    const located = locateTariffWorksheet(workbook, XLSX);
    const { sheetName, matrix, header } = located;
    const map = new Map();
    const rows = [];
    const warnings = [];

    for (let rowIndex = header.rowIndex + 1; rowIndex < matrix.length; rowIndex += 1) {
      const sourceRow = Array.isArray(matrix[rowIndex]) ? matrix[rowIndex] : [];
      const rawType = sourceRow[header.typeIndex];
      const rawCode = sourceRow[header.codeIndex];
      const rawMueValue = sourceRow[header.maxOccurrencesIndex];
      const activityType = normalizeActivityType(rawType);
      const code = normalizeCode(rawCode, activityType);

      if (!activityType && !code && String(rawMueValue || '').trim() === '') {
        continue;
      }

      if (!SUPPORTED_TYPES.has(activityType)) {
        continue;
      }

      if (!code) {
        warnings.push(
          `${sheetName} row ${rowIndex + 1} was skipped because Code is blank.`
        );
        continue;
      }

      const parsedLimit = parseMaxOccurrences(rawMueValue);

      if (parsedLimit.error) {
        warnings.push(`${sheetName} row ${rowIndex + 1}: ${parsedLimit.error}`);
      }

      const record = {
        activityType,
        code,
        maxOccurrencesPerClaim: parsedLimit.limit,
        rawMueValue: String(rawMueValue == null ? '' : rawMueValue).trim(),
        sheetName,
        sheetRowNumber: rowIndex + 1,
        rawRow: sourceRow.slice()
      };

      const key = makeTariffKey(activityType, code);
      const existing = map.get(key);

      if (existing) {
        if (existing.maxOccurrencesPerClaim !== record.maxOccurrencesPerClaim) {
          warnings.push(
            `${sheetName} has conflicting CPT MUE values for ${activityType} ${code} ` +
            `(rows ${existing.sheetRowNumber} and ${record.sheetRowNumber}). ` +
            'The first row is being used.'
          );
        }
        continue;
      }

      map.set(key, record);
      rows.push(record);
    }

    return {
      map,
      rows,
      codeSet: new Set(rows.map((row) => row.code)),
      warnings,
      sheetName,
      headerRowNumber: header.rowIndex + 1,
      occurrenceColumnName: 'CPT MUE Values'
    };
  }

  function requestUrl(input) {
    if (typeof input === 'string') return input;
    if (input && typeof input.url === 'string') return input.url;
    return String(input || '');
  }

  function isMandatoryTariffRequest(input) {
    let value = requestUrl(input);

    try {
      value = decodeURIComponent(value);
    } catch (error) {
      // Keep the original URL when decoding fails.
    }

    return /mandatory\s*tariff.*\.xlsx(?:$|[?#])/i.test(value);
  }

  function requestMethod(input, init) {
    return String(init?.method || input?.method || 'GET').toUpperCase();
  }

  function sameUrl(left, right) {
    try {
      return new URL(left, root?.location?.href || undefined).href ===
        new URL(right, root?.location?.href || undefined).href;
    } catch (error) {
      return String(left) === String(right);
    }
  }

  function installTariffFetchFallback() {
    if (!root || !nativeFetch || fetchFallbackInstalled) return false;

    root.fetch = async function mandatoryTariffAwareFetch(input, init) {
      const response = await nativeFetch(input, init);

      if (
        response?.ok ||
        requestMethod(input, init) !== 'GET' ||
        !isMandatoryTariffRequest(input)
      ) {
        return response;
      }

      const originalUrl = requestUrl(input);

      for (const fallbackPath of DEFAULT_PATHS) {
        if (sameUrl(originalUrl, fallbackPath)) continue;

        try {
          const fallbackResponse = await nativeFetch(fallbackPath, init);
          if (fallbackResponse?.ok) {
            console.warn(
              `[MANDATORY TARIFF] ${originalUrl} returned HTTP ${response.status}; ` +
              `using ${fallbackPath}.`
            );
            return fallbackResponse;
          }
        } catch (error) {
          // Try the next fallback.
        }
      }

      return response;
    };

    fetchFallbackInstalled = true;
    return true;
  }

  async function fetchWorkbook(paths, fetchOverride) {
    const fetchFn = fetchOverride || nativeFetch || root?.fetch;

    if (typeof fetchFn !== 'function') {
      throw new Error('fetch() is unavailable, so Mandatory Tariff cannot be loaded.');
    }

    const failures = [];

    for (const path of unique(paths)) {
      try {
        const response = await fetchFn(path, { cache: 'no-store' });

        if (!response?.ok) {
          failures.push(`${path}: HTTP ${response ? response.status : 'unknown'}`);
          continue;
        }

        return {
          path,
          arrayBuffer: await response.arrayBuffer()
        };
      } catch (error) {
        failures.push(`${path}: ${error?.message || String(error)}`);
      }
    }

    throw new Error('Mandatory Tariff could not be loaded. ' + failures.join(' | '));
  }

  async function loadBundledMandatoryTariff(options) {
    const config = options || {};
    const paths = Array.isArray(config.paths) && config.paths.length
      ? config.paths
      : DEFAULT_PATHS;
    const pathsKey = paths.join('|');

    if (!config.forceReload && cachedPromise && cachedPathsKey === pathsKey) {
      return cachedPromise;
    }

    cachedPathsKey = pathsKey;
    cachedPromise = (async () => {
      const XLSX = config.XLSX || root?.XLSX;

      if (!XLSX || typeof XLSX.read !== 'function') {
        throw new Error('SheetJS (XLSX) is unavailable.');
      }

      const fetched = await fetchWorkbook(paths, config.fetch);
      const workbook = XLSX.read(fetched.arrayBuffer, {
        type: 'array',
        cellDates: true
      });
      const parsed = parseMandatoryTariffWorkbook(workbook, XLSX);
      parsed.path = fetched.path;
      return parsed;
    })().catch((error) => {
      cachedPromise = null;
      cachedPathsKey = '';
      throw error;
    });

    return cachedPromise;
  }

  function getTariffRow(tariffMap, activityType, code) {
    if (!(tariffMap instanceof Map)) return null;
    return tariffMap.get(makeTariffKey(activityType, code)) || null;
  }

  function validateClaimOccurrenceLimits(claim, tariffMap) {
    if (!claim) return [];

    if (!(tariffMap instanceof Map)) {
      throw new TypeError('validateClaimOccurrenceLimits requires a Mandatory Tariff Map.');
    }

    const claimID = getDirectChildText(claim, 'ID') || 'Unknown';
    const activities = getDirectChildren(claim, 'Activity');
    const occurrences = new Map();

    for (const activity of activities) {
      const xmlActivityType = getDirectChildText(activity, 'Type');
      const rawCode = getDirectChildText(activity, 'Code');
      const activityType = normalizeActivityType(xmlActivityType);

      if (!SUPPORTED_TYPES.has(activityType) || !rawCode) continue;

      const code = normalizeCode(rawCode, activityType);
      const key = makeTariffKey(activityType, code);
      const current = occurrences.get(key) || {
        claimID,
        key,
        activityType,
        xmlActivityType: String(xmlActivityType).trim(),
        code,
        count: 0
      };

      // Count Activity elements. Do not use the XML Quantity value here.
      current.count += 1;
      occurrences.set(key, current);
    }

    const findings = [];

    for (const occurrence of occurrences.values()) {
      const tariffRow = tariffMap.get(occurrence.key);

      if (!tariffRow || tariffRow.maxOccurrencesPerClaim == null) continue;

      const limit = tariffRow.maxOccurrencesPerClaim;
      if (occurrence.count <= limit) continue;

      findings.push({
        ruleId: 'TARIFF_MAX_OCCURRENCES',
        status: 'Invalid',
        claimID,
        activityType: occurrence.activityType,
        xmlActivityType: occurrence.xmlActivityType,
        code: occurrence.code,
        actualCount: occurrence.count,
        allowedCount: limit,
        remark:
          `${occurrence.code} can only be coded ${limit} ` +
          `${limit === 1 ? 'time' : 'times'} in one claim.`
      });
    }

    return findings;
  }

  function validateSubmissionOccurrenceLimits(xmlDoc, tariffMap) {
    if (!xmlDoc?.documentElement) return [];

    return getDirectChildren(xmlDoc.documentElement, 'Claim')
      .flatMap((claim) => validateClaimOccurrenceLimits(claim, tariffMap));
  }

  function clearCache() {
    cachedPromise = null;
    cachedPathsKey = '';
  }

  installTariffFetchFallback();

  return Object.freeze({
    DEFAULT_PATHS,
    HEADER_ALIASES,
    normalizeHeader,
    normalizeActivityType,
    normalizeCode,
    makeTariffKey,
    parseMaxOccurrences,
    getDirectChildren,
    getDirectChildText,
    locateHeaderRow,
    locateTariffWorksheet,
    parseMandatoryTariffWorkbook,
    installTariffFetchFallback,
    loadBundledMandatoryTariff,
    getTariffRow,
    validateClaimOccurrenceLimits,
    validateSubmissionOccurrenceLimits,
    clearCache
  });
});
