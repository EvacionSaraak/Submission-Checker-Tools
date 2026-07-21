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

  const DEFAULT_PATHS = Object.freeze([
    '../resources/Mandatory Tariff Updated.xlsx',
    'resources/Mandatory Tariff Updated.xlsx',
    './resources/Mandatory Tariff Updated.xlsx'
  ]);

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

  const HEADER_ALIASES = Object.freeze({
    type: new Set([
      'type',
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
      'cptmodifier'
    ])
  });

  let cachedPromise = null;
  let cachedPathsKey = '';

  function normalizeHeader(value) {
    return String(value == null ? '' : value)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  }

  function normalizeCode(value) {
    return String(value == null ? '' : value)
      .trim()
      .toUpperCase();
  }

  function normalizeActivityType(value) {
    const raw = String(value == null ? '' : value)
      .trim()
      .toUpperCase();

    return TYPE_ALIASES[raw] || raw;
  }

  function makeTariffKey(activityType, code) {
    return `${normalizeActivityType(activityType)}|${normalizeCode(code)}`;
  }

  function parseMaxOccurrences(rawValue) {
    const text = String(rawValue == null ? '' : rawValue).trim();

    if (!text) {
      return {
        limit: null,
        error: null
      };
    }

    const numericValue = Number(text.replace(/,/g, ''));

    if (!Number.isInteger(numericValue) || numericValue < 1) {
      return {
        limit: null,
        error: `Invalid CPT Modifier occurrence limit: ${text}`
      };
    }

    return {
      limit: numericValue,
      error: null
    };
  }

  function getDirectChildren(parent, tagName) {
    if (!parent || !parent.childNodes) return [];

    return Array.from(parent.childNodes).filter((node) => {
      if (!node || node.nodeType !== 1) return false;
      const nodeName = node.localName || node.nodeName;
      return nodeName === tagName;
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
    const maxRows = Math.min(matrix.length, 30);

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

  function selectTariffSheet(workbook) {
    const sheetNames = Array.isArray(workbook && workbook.SheetNames)
      ? workbook.SheetNames
      : [];

    if (sheetNames.length === 0) {
      throw new Error('Mandatory Tariff workbook contains no worksheets.');
    }

    const preferred = sheetNames.find((name) => {
      const normalized = normalizeHeader(name);
      return normalized.includes('mandatorytariff') || normalized === 'tariff';
    });

    return preferred || sheetNames[0];
  }

  function parseMandatoryTariffWorkbook(workbook, xlsxOverride) {
    const XLSX = xlsxOverride || (root && root.XLSX);

    if (!XLSX || !XLSX.utils || typeof XLSX.utils.sheet_to_json !== 'function') {
      throw new Error('SheetJS (XLSX) is unavailable.');
    }

    const sheetName = selectTariffSheet(workbook);
    const sheet = workbook.Sheets[sheetName];

    if (!sheet) {
      throw new Error(`Worksheet "${sheetName}" could not be read.`);
    }

    const matrix = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      defval: '',
      raw: false,
      blankrows: false
    });

    const header = locateHeaderRow(matrix);

    if (!header) {
      throw new Error(
        'Mandatory Tariff is missing one or more required columns: Type, Code, CPT Modifier.'
      );
    }

    const map = new Map();
    const rows = [];
    const warnings = [];

    for (let rowIndex = header.rowIndex + 1; rowIndex < matrix.length; rowIndex += 1) {
      const sourceRow = Array.isArray(matrix[rowIndex]) ? matrix[rowIndex] : [];
      const rawType = sourceRow[header.typeIndex];
      const rawCode = sourceRow[header.codeIndex];
      const rawLimit = sourceRow[header.maxOccurrencesIndex];
      const activityType = normalizeActivityType(rawType);
      const code = normalizeCode(rawCode);

      if (!activityType && !code && String(rawLimit || '').trim() === '') {
        continue;
      }

      if (!activityType || !code) {
        warnings.push(
          `Mandatory Tariff row ${rowIndex + 1} was skipped because Type or Code is blank.`
        );
        continue;
      }

      const parsedLimit = parseMaxOccurrences(rawLimit);

      if (parsedLimit.error) {
        warnings.push(`Mandatory Tariff row ${rowIndex + 1}: ${parsedLimit.error}`);
      }

      const record = {
        activityType,
        code,
        maxOccurrencesPerClaim: parsedLimit.limit,
        rawCptModifier: String(rawLimit == null ? '' : rawLimit).trim(),
        sheetRowNumber: rowIndex + 1,
        rawRow: sourceRow.slice()
      };

      const key = makeTariffKey(activityType, code);
      const existing = map.get(key);

      if (existing) {
        const existingLimit = existing.maxOccurrencesPerClaim;
        const incomingLimit = record.maxOccurrencesPerClaim;

        if (existingLimit !== incomingLimit) {
          warnings.push(
            `Mandatory Tariff has conflicting CPT Modifier limits for ${activityType} ${code} ` +
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
      warnings,
      sheetName,
      headerRowNumber: header.rowIndex + 1
    };
  }

  async function fetchWorkbook(paths, fetchOverride) {
    const fetchFn = fetchOverride || (root && root.fetch);

    if (typeof fetchFn !== 'function') {
      throw new Error('fetch() is unavailable, so Mandatory Tariff cannot be loaded.');
    }

    const failures = [];

    for (const path of paths) {
      try {
        const response = await fetchFn(path, { cache: 'no-store' });

        if (!response || !response.ok) {
          failures.push(`${path}: HTTP ${response ? response.status : 'unknown'}`);
          continue;
        }

        return {
          path,
          arrayBuffer: await response.arrayBuffer()
        };
      } catch (error) {
        failures.push(`${path}: ${error && error.message ? error.message : String(error)}`);
      }
    }

    throw new Error(
      'Mandatory Tariff could not be loaded. ' + failures.join(' | ')
    );
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
      const XLSX = config.XLSX || (root && root.XLSX);

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
      const activityType = getDirectChildText(activity, 'Type');
      const code = getDirectChildText(activity, 'Code');

      if (!activityType || !code) continue;

      const key = makeTariffKey(activityType, code);
      const current = occurrences.get(key) || {
        claimID,
        key,
        activityType: normalizeActivityType(activityType),
        xmlActivityType: String(activityType).trim(),
        code: normalizeCode(code),
        count: 0
      };

      current.count += 1;
      occurrences.set(key, current);
    }

    const findings = [];

    for (const occurrence of occurrences.values()) {
      const tariffRow = tariffMap.get(occurrence.key);

      if (!tariffRow || tariffRow.maxOccurrencesPerClaim == null) {
        continue;
      }

      const limit = tariffRow.maxOccurrencesPerClaim;

      if (occurrence.count <= limit) {
        continue;
      }

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
    if (!xmlDoc || !xmlDoc.documentElement) return [];

    const claims = getDirectChildren(xmlDoc.documentElement, 'Claim');
    return claims.flatMap((claim) => validateClaimOccurrenceLimits(claim, tariffMap));
  }

  function clearCache() {
    cachedPromise = null;
    cachedPathsKey = '';
  }

  return Object.freeze({
    DEFAULT_PATHS,
    normalizeHeader,
    normalizeCode,
    normalizeActivityType,
    makeTariffKey,
    parseMaxOccurrences,
    getDirectChildren,
    getDirectChildText,
    parseMandatoryTariffWorkbook,
    loadBundledMandatoryTariff,
    getTariffRow,
    validateClaimOccurrenceLimits,
    validateSubmissionOccurrenceLimits,
    clearCache
  });
});
