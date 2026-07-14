(function() {
  'use strict';

  const DX_EXCLUDES1 = 'DX_EXCLUDES1';
  const DEFAULT_RULES_PATH = '../json/icd10cm_exclusions_2026.json';

  let rulesCachePromise = null;

  function normalizeDiagnosisCode(value) {
    return String(value || '').toUpperCase().replace(/\./g, '').trim();
  }

  function formatDiagnosisCode(value) {
    return String(value || '').toUpperCase().trim();
  }

  function normalizePrefix(value) {
    return normalizeDiagnosisCode(String(value || '').replace(/-$/, ''));
  }

  function normalizeCategory(value) {
    return normalizeDiagnosisCode(value).slice(0, 3);
  }

  function toRangeComparable(categoryValue) {
    const category = normalizeCategory(categoryValue);
    if (!/^[A-Z][0-9]{2}$/.test(category)) return null;
    return ((category.charCodeAt(0) - 65) * 100) + parseInt(category.slice(1), 10);
  }

  function createMatcher(spec, malformedEntries) {
    if (!spec || typeof spec !== 'object') {
      malformedEntries.push('Malformed matcher: expected object');
      return null;
    }

    if (spec.code) {
      const exact = normalizeDiagnosisCode(spec.code);
      if (!exact) {
        malformedEntries.push('Malformed matcher: empty code');
        return null;
      }
      return {
        kind: 'code',
        value: exact,
        matches(code) {
          return code === exact;
        }
      };
    }

    if (spec.category) {
      const category = normalizeCategory(spec.category);
      if (!/^[A-Z][0-9]{2}$/.test(category)) {
        malformedEntries.push(`Malformed category matcher: ${spec.category}`);
        return null;
      }
      return {
        kind: 'category',
        value: category,
        matches(code) {
          return code.startsWith(category);
        }
      };
    }

    if (spec.prefix) {
      const prefix = normalizePrefix(spec.prefix);
      if (!prefix) {
        malformedEntries.push(`Malformed prefix matcher: ${spec.prefix}`);
        return null;
      }
      return {
        kind: 'prefix',
        value: prefix,
        matches(code) {
          return code.startsWith(prefix);
        }
      };
    }

    if (spec.range) {
      const rangeParts = String(spec.range).split('-').map(part => part.trim());
      if (rangeParts.length !== 2) {
        malformedEntries.push(`Malformed range matcher: ${spec.range}`);
        return null;
      }
      const start = toRangeComparable(rangeParts[0]);
      const end = toRangeComparable(rangeParts[1]);
      if (start == null || end == null || start > end) {
        malformedEntries.push(`Malformed range matcher: ${spec.range}`);
        return null;
      }
      return {
        kind: 'range',
        value: `${normalizeCategory(rangeParts[0])}-${normalizeCategory(rangeParts[1])}`,
        matches(code) {
          const comparable = toRangeComparable(code);
          return comparable != null && comparable >= start && comparable <= end;
        }
      };
    }

    malformedEntries.push('Malformed matcher: expected code/category/prefix/range');
    return null;
  }

  function compileRule(rawRule, malformedEntries) {
    if (!rawRule || typeof rawRule !== 'object') {
      malformedEntries.push('Malformed rule entry: expected object');
      return null;
    }

    const sourceMatcher = createMatcher(rawRule, malformedEntries);
    const targets = Array.isArray(rawRule.excludes1) ? rawRule.excludes1 : [];
    if (!sourceMatcher || targets.length === 0) {
      malformedEntries.push('Malformed rule entry: missing source matcher or excludes1 targets');
      return null;
    }

    const targetMatchers = targets
      .map(target => {
        const matcher = createMatcher(target, malformedEntries);
        if (!matcher) return null;
        return {
          matcher,
          note: target.note ? String(target.note).trim() : '',
          display: target.display ? String(target.display).trim() : matcher.value
        };
      })
      .filter(Boolean);

    if (targetMatchers.length === 0) {
      malformedEntries.push('Malformed rule entry: no valid excludes1 targets');
      return null;
    }

    return {
      sourceMatcher,
      sourceDisplay: rawRule.display ? String(rawRule.display).trim() : sourceMatcher.value,
      targets: targetMatchers,
      note: rawRule.note ? String(rawRule.note).trim() : '',
      ruleType: 'Excludes1',
      ruleId: DX_EXCLUDES1
    };
  }

  function compileExclusionRules(rawData) {
    const malformedEntries = [];
    const metadata = (rawData && typeof rawData === 'object' && rawData.metadata) ? rawData.metadata : {};
    const rawRules = (rawData && Array.isArray(rawData.rules)) ? rawData.rules : [];

    const compiledRules = rawRules.map(rule => compileRule(rule, malformedEntries)).filter(Boolean);

    return {
      metadata,
      rules: compiledRules,
      malformedEntries
    };
  }

  function detectExcludes1Conflicts(diagnoses, compiledRuleSet) {
    const findings = [];

    if (!compiledRuleSet || !Array.isArray(compiledRuleSet.rules) || compiledRuleSet.rules.length === 0) {
      return findings;
    }

    const normalizedDiagnoses = (Array.isArray(diagnoses) ? diagnoses : [])
      .map((diagnosis, index) => {
        const normalizedCode = normalizeDiagnosisCode(diagnosis.code);
        if (!normalizedCode) return null;
        return {
          index,
          code: normalizedCode,
          displayCode: formatDiagnosisCode(diagnosis.code),
          type: diagnosis.type || ''
        };
      })
      .filter(Boolean);

    const seenPairs = new Set();

    for (let i = 0; i < normalizedDiagnoses.length; i += 1) {
      const left = normalizedDiagnoses[i];
      for (let j = i + 1; j < normalizedDiagnoses.length; j += 1) {
        const right = normalizedDiagnoses[j];

        for (const compiledRule of compiledRuleSet.rules) {
          const forward = tryMatchRulePair(left, right, compiledRule);
          const reverse = forward ? null : tryMatchRulePair(right, left, compiledRule);
          const matched = forward || reverse;

          if (!matched) {
            continue;
          }

          const pairKey = `${left.code < right.code ? left.code : right.code}|${left.code < right.code ? right.code : left.code}`;
          if (seenPairs.has(pairKey)) {
            continue;
          }
          seenPairs.add(pairKey);

          const note = matched.note || compiledRule.note;
          findings.push({
            diagnosis1: left.displayCode,
            diagnosis2: right.displayCode,
            diagnosis1Type: left.type,
            diagnosis2Type: right.type,
            normalizedPairKey: pairKey,
            ruleType: 'Excludes1',
            ruleId: DX_EXCLUDES1,
            note,
            message: `Excludes1 Error: ${left.displayCode} and ${right.displayCode} should not normally be reported together. Review only if documentation clearly supports unrelated conditions.`
          });
          break;
        }
      }
    }

    return findings;
  }

  function tryMatchRulePair(sourceDx, targetDx, compiledRule) {
    if (!compiledRule.sourceMatcher.matches(sourceDx.code)) {
      return null;
    }

    for (const target of compiledRule.targets) {
      if (target.matcher.matches(targetDx.code)) {
        return {
          note: target.note,
          targetDisplay: target.display
        };
      }
    }

    return null;
  }

  function loadExclusionRules(rulesPath = DEFAULT_RULES_PATH) {
    if (!rulesCachePromise) {
      rulesCachePromise = fetch(rulesPath)
        .then(response => {
          if (!response.ok) {
            throw new Error(`Failed to load Excludes1 rules (${response.status})`);
          }
          return response.json();
        })
        .then(raw => compileExclusionRules(raw));
    }

    return rulesCachePromise;
  }

  function resetExclusionRulesCache() {
    rulesCachePromise = null;
  }

  const api = {
    DX_EXCLUDES1,
    DEFAULT_RULES_PATH,
    normalizeDiagnosisCode,
    formatDiagnosisCode,
    compileExclusionRules,
    detectExcludes1Conflicts,
    loadExclusionRules,
    resetExclusionRulesCache,
    _internal: {
      createMatcher,
      tryMatchRulePair,
      toRangeComparable
    }
  };

  if (typeof window !== 'undefined') {
    window.DxRulesEngine = api;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
