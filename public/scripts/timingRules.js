(function () {
  const LAYERS = {
    travelTime: 'travelTime',
    airportProcessing: 'airportProcessing',
    security: 'security',
    terminalFlow: 'terminalFlow',
    behavioral: 'behavioral',
    preference: 'preference',
    confidenceBuffer: 'confidenceBuffer'
  };

  const CAPS = {
    behavioral: {
      Domestic: 20,
      International: 30
    },
    preference: {
      Domestic: 45,
      International: 45
    },
    confidenceBuffer: {
      Domestic: 20,
      International: 30
    },
    style: {
      Domestic: 20,
      International: 30
    }
  };

  /** Single source for in-airport walking / terminal navigation (breakdown label: "Terminal navigation"). */
  const TERMINAL_NAVIGATION_MINUTES = 15;

  const BASE = {
    travelTime: 45,
    terminalNavigationMinutes: TERMINAL_NAVIGATION_MINUTES,
    boardingBuffer: {
      Domestic: 30,
      International: 45
    },
    checkIn: {
      Domestic: {
        carryOn: 0,
        checked: 15
      },
      International: {
        carryOn: 25,
        checked: 40
      }
    }
  };

  function normalizeFlightType(value) {
    return String(value || '').trim().toLowerCase() === 'international'
      ? 'International'
      : 'Domestic';
  }

  function normalizeTravelStyle(value) {
    const raw = String(value || '').trim();
    const lower = raw.toLowerCase();
    if (lower.includes('tight') || lower.includes('cut')) return 'Tight';
    if (lower.includes('relaxed') || lower.includes('no rush')) return 'Relaxed';
    return 'Balanced';
  }

  function normalizeSecurity(value) {
    const raw = String(value || '').trim();
    if (raw === 'CLEAR + PreCheck') return raw;
    if (raw === 'CLEAR') return raw;
    if (raw === 'Standard') return raw;
    return 'PreCheck';
  }

  function isPeakDepartureWindow(departureDate) {
    if (!(departureDate instanceof Date) || Number.isNaN(departureDate.getTime())) return false;
    const day = departureDate.getDay();
    const hour = departureDate.getHours();
    return (
      (day === 5 && hour >= 15)
      || (day === 0 && hour >= 12 && hour <= 21)
      || (day >= 1 && day <= 5 && hour >= 6 && hour < 9)
    );
  }

  function normalizeAirportComplexity(value) {
    const key = String(value || '').trim().toLowerCase();
    if (key.includes('very')) return 'very complex';
    if (key.includes('complex')) return 'complex';
    if (key.includes('simple')) return 'simple';
    return 'standard';
  }

  function getLuggageType(value) {
    const key = String(value || '').trim().toLowerCase();
    return key.includes('checking') || key.includes('checked') || key.includes('bag drop')
      ? 'checked'
      : 'carryOn';
  }

  function getSecurityMinutes(securityMode, baseWait) {
    const base = Math.max(0, Math.round(Number(baseWait) || 25));
    if (securityMode === 'Standard') return base;
    if (securityMode === 'CLEAR + PreCheck') return Math.max(Math.round(base * 0.35), 3);
    if (securityMode === 'CLEAR') return Math.max(Math.round(base * 0.5), 4);
    return Math.max(Math.round(base * 0.6), 5);
  }

  function getSecurityLabel(securityMode) {
    if (securityMode === 'Standard') return 'Standard security';
    return securityMode;
  }

  function getAirportProcessingNavigationTotal(acc) {
    return Math.max(0, Math.round(
      (Number(acc.layerTotals.airportProcessingTime) || 0)
      + (Number(acc.layerTotals.securityTime) || 0)
      + (Number(acc.layerTotals.terminalFlowTime) || 0)
    ));
  }

  function addCappedLayerTotal(acc, capName, layer, ruleName, label, desiredMinutes, currentTotal, cap, visible = true) {
    const desired = Math.max(0, Math.round(Number(desiredMinutes) || 0));
    const available = Math.max(0, cap - currentTotal);
    const applied = Math.min(desired, available);
    if (applied <= 0) {
      skipRule(acc, ruleName, `${capName} cap already reached`);
      acc.capsApplied.push({ cap: capName, rule: ruleName, requested: desired, applied: 0, max: cap });
      return currentTotal;
    }
    addRule(acc, ruleName, { label, minutes: applied, layer, visible });
    if (applied < desired) {
      acc.capsApplied.push({ cap: capName, rule: ruleName, requested: desired, applied, max: cap });
    }
    return currentTotal + applied;
  }

  function createAccumulator(inputs) {
    return {
      inputs,
      rows: [],
      appliedRules: [],
      skippedRules: [],
      capsApplied: [],
      debug: {
        hiddenBufferReductionsApplied: [],
        blendedPreferenceLogicApplied: [],
        cappedPreferenceTotals: [],
        cappedBehavioralTotals: []
      },
      layerTotals: {
        travelTime: 0,
        airportProcessingTime: 0,
        securityTime: 0,
        terminalFlowTime: 0,
        behavioralTime: 0,
        preferenceTime: 0,
        confidenceBufferTime: 0
      }
    };
  }

  function addRule(acc, ruleName, row) {
    const minutes = Math.round(Number(row.minutes) || 0);
    const entry = {
      label: row.label,
      minutes,
      layer: row.layer,
      visible: row.visible !== false
    };
    acc.rows.push(entry);
    acc.appliedRules.push({ rule: ruleName, ...entry });
    addToLayer(acc.layerTotals, row.layer, minutes);
  }

  function skipRule(acc, rule, reason) {
    acc.skippedRules.push({ rule, reason });
  }

  function addToLayer(layerTotals, layer, minutes) {
    if (Object.prototype.hasOwnProperty.call(layerTotals, layer)) {
      layerTotals[layer] += minutes;
      return;
    }
    const key = `${layer}Time`;
    if (Object.prototype.hasOwnProperty.call(layerTotals, key)) {
      layerTotals[key] += minutes;
    }
  }

  function applyCappedRule(acc, ruleName, capName, row, currentTotal, cap) {
    const desired = Math.max(0, Math.round(Number(row.minutes) || 0));
    const available = Math.max(0, cap - currentTotal);
    const applied = Math.min(desired, available);
    recordCappedTotal(acc, capName, {
      rule: ruleName,
      requested: desired,
      applied,
      previousTotal: currentTotal,
      resultingTotal: currentTotal + applied,
      max: cap
    });
    if (applied <= 0) {
      skipRule(acc, ruleName, `${capName} cap already reached`);
      acc.capsApplied.push({ cap: capName, rule: ruleName, requested: desired, applied: 0, max: cap });
      return currentTotal;
    }
    addRule(acc, ruleName, { ...row, minutes: applied });
    if (applied < desired) {
      acc.capsApplied.push({ cap: capName, rule: ruleName, requested: desired, applied, max: cap });
    }
    return currentTotal + applied;
  }

  function recordCappedTotal(acc, capName, payload) {
    if (capName === 'preferenceTime') {
      acc.debug.cappedPreferenceTotals.push(payload);
    }
    if (capName === 'behavioralTime') {
      acc.debug.cappedBehavioralTotals.push(payload);
    }
  }

  function getCheckInRule(inputs) {
    const luggageType = getLuggageType(inputs.luggage);
    if (inputs.flightType === 'International') {
      if (luggageType === 'checked') {
        return { label: 'International bag drop/check-in', minutes: BASE.checkIn.International.checked };
      }
      return { label: 'International check-in', minutes: BASE.checkIn.International.carryOn };
    }
    if (luggageType === 'checked') {
      return { label: 'Bag drop', minutes: BASE.checkIn.Domestic.checked };
    }
    return null;
  }

  function getBehavioralRule(inputs, baseMinutes) {
    const key = String(inputs.complexity || '').trim().toLowerCase();
    if (key === 'family / children' || key.includes('kid')) return { label: 'Family / children', minutes: Math.round(baseMinutes * 0.15) };
    if (key === 'traveling with pets' || key.includes('pet')) return { label: 'Traveling with pets', minutes: Math.round(baseMinutes * 0.1) };
    if (key === 'group travel' || key.includes('group')) return { label: 'Group travel', minutes: Math.round(baseMinutes * 0.1) };
    if (key.includes('accessibility') || key.includes('mobility')) return { label: 'Accessibility / mobility', minutes: Math.round(baseMinutes * 0.2) };
    return null;
  }

  function getPreferenceDwellRule(inputs) {
    const key = String(inputs.boarding || '').trim().toLowerCase();
    const hasLounge = key.includes('lounge');
    const hasFood = key.includes('hudson') || key.includes('grab food') || key.includes('food');
    if (hasLounge && hasFood) return { label: 'Lounge + food stop', minutes: 45 };
    if (hasLounge) return { label: 'Lounge time', minutes: 35 };
    if (hasFood) return { label: 'Hudson News stop', minutes: 15 };
    return null;
  }

  function getStyleRule(inputs, baseMinutes) {
    if (inputs.style === 'Tight') return { label: 'Cutting it close', minutes: -Math.round(baseMinutes * 0.1) };
    if (inputs.style === 'Relaxed') return { label: 'Avoid panic buffer', minutes: Math.round(baseMinutes * 0.15) };
    return null;
  }

  function calculateConfidenceBuffer(inputs, peakWindow) {
    const cap = CAPS.confidenceBuffer[inputs.flightType];
    const requestedRows = [{ label: 'Normal confidence buffer', minutes: 5, reason: 'normal' }];
    if (inputs.highTrafficVolatility) requestedRows.push({ label: 'Traffic volatility buffer', minutes: 10, reason: 'high traffic volatility' });
    if (inputs.airportAdvisory) requestedRows.push({ label: 'Airport advisory buffer', minutes: 15, reason: 'airport advisory' });
    if (peakWindow) {
      requestedRows.push({
        label: 'Peak travel window',
        minutes: inputs.flightType === 'International' ? 15 : 10,
        reason: 'holiday/peak travel window'
      });
    }
    const requested = requestedRows.reduce((sum, row) => sum + row.minutes, 0);
    return {
      requestedRows,
      requested,
      applied: Math.min(requested, cap),
      cap,
      peakWindow
    };
  }

  function calculate(input = {}) {
    const inputs = {
      transport: String(input.transport || 'Rideshare').trim(),
      luggage: String(input.luggage || 'Carry-on only').trim(),
      security: normalizeSecurity(input.security),
      boarding: String(input.boarding || 'Head to gate').trim(),
      complexity: String(input.complexity || 'Just me').trim(),
      style: normalizeTravelStyle(input.style),
      flightType: normalizeFlightType(input.flightType),
      departureDate: input.departureDate instanceof Date ? input.departureDate : null,
      securityWaitMinutes: Number.isFinite(Number(input.securityWaitMinutes)) ? Number(input.securityWaitMinutes) : 25,
      airportComplexity: normalizeAirportComplexity(input.airportComplexity),
      highTrafficVolatility: Boolean(input.highTrafficVolatility),
      airportAdvisory: Boolean(input.airportAdvisory)
    };
    const acc = createAccumulator(inputs);

    // 1. Base operational timing
    addRule(acc, 'base-travel-time', {
      label: 'Base travel estimate',
      minutes: BASE.travelTime,
      layer: LAYERS.travelTime,
      visible: false
    });

    // 2. Structural modifiers
    if (inputs.transport === 'Transit') {
      addRule(acc, 'transport-transit', { label: 'Transit travel adjustment', minutes: 20, layer: LAYERS.travelTime, visible: false });
    } else if (inputs.transport === 'Drive & park') {
      addRule(acc, 'transport-drive-park', { label: 'Parking buffer', minutes: 15, layer: LAYERS.airportProcessing, visible: true });
    } else if (inputs.transport === 'Drop-off') {
      addRule(acc, 'transport-drop-off', { label: 'Drop-off travel adjustment', minutes: -5, layer: LAYERS.travelTime, visible: false });
    } else {
      skipRule(acc, 'transport-adjustment', 'Rideshare baseline selected');
    }

    const checkInRule = getCheckInRule(inputs);
    if (checkInRule) {
      addRule(acc, 'check-in-bag-logic', {
        ...checkInRule,
        layer: LAYERS.airportProcessing,
        visible: true
      });
    } else {
      skipRule(acc, 'check-in-bag-logic', 'Domestic carry-on has no bag/check-in time');
    }

    const securityMinutes = getSecurityMinutes(inputs.security, inputs.securityWaitMinutes);
    addRule(acc, 'security-replacement', {
      label: getSecurityLabel(inputs.security),
      minutes: securityMinutes,
      layer: LAYERS.security,
      visible: true
    });

    addRule(acc, 'terminal-navigation', {
      label: 'Terminal navigation',
      minutes: TERMINAL_NAVIGATION_MINUTES,
      layer: LAYERS.terminalFlow,
      visible: true
    });

    addRule(acc, 'boarding-buffer', {
      label: 'Boarding buffer',
      minutes: BASE.boardingBuffer[inputs.flightType],
      layer: LAYERS.terminalFlow,
      visible: true
    });

    // 3. Behavioral modifiers
    const behavioralCap = CAPS.behavioral[inputs.flightType];
    let behavioralTotal = 0;
    const processingNavigationTotal = getAirportProcessingNavigationTotal(acc);
    const behavioralRule = getBehavioralRule(inputs, processingNavigationTotal);
    if (behavioralRule) {
      behavioralTotal = applyCappedRule(acc, 'travel-complexity', 'behavioralTime', {
        ...behavioralRule,
        layer: LAYERS.behavioral,
        visible: true
      }, behavioralTotal, behavioralCap);
    } else {
      skipRule(acc, 'travel-complexity', 'Just me selected');
    }

    // 4. Preference dwell
    const preferenceCap = CAPS.preference[inputs.flightType];
    let preferenceTotal = 0;
    const dwellRule = getPreferenceDwellRule(inputs);
    if (dwellRule) {
      preferenceTotal = applyCappedRule(acc, 'preference-dwell', 'preferenceTime', {
        ...dwellRule,
        layer: LAYERS.preference,
        visible: true
      }, preferenceTotal, preferenceCap);
    } else {
      skipRule(acc, 'preference-dwell', 'Straight to gate selected');
    }

    // 5. Timing style / comfort buffer
    const styleCap = CAPS.style[inputs.flightType];
    const styleRule = getStyleRule(inputs, processingNavigationTotal);
    if (styleRule) {
      const isReduction = styleRule.minutes < 0;
      const requested = Math.abs(styleRule.minutes);
      const applied = isReduction ? -requested : Math.min(requested, styleCap);
      addRule(acc, 'timing-style', {
        label: styleRule.label,
        minutes: applied,
        layer: LAYERS.preference,
        visible: true
      });
      if (!isReduction && applied < requested) {
        acc.capsApplied.push({ cap: 'styleTime', rule: 'timing-style', requested, applied, max: styleCap });
      }
    } else {
      skipRule(acc, 'timing-style', 'Balanced style selected');
    }

    // 6. Confidence buffers
    const peakWindow = isPeakDepartureWindow(inputs.departureDate);
    const confidenceBuffer = calculateConfidenceBuffer(inputs, peakWindow);
    let confidenceTotal = 0;
    confidenceBuffer.requestedRows.forEach((row) => {
      confidenceTotal = addCappedLayerTotal(
        acc,
        'confidenceBufferTime',
        LAYERS.confidenceBuffer,
        `confidence-${row.reason}`,
        row.label === 'Normal confidence buffer' ? 'Confidence buffer' : row.label,
        row.minutes,
        confidenceTotal,
        confidenceBuffer.cap,
        row.label !== 'Normal confidence buffer' || confidenceBuffer.requestedRows.length === 1
      );
    });
    if (confidenceBuffer.requested > confidenceTotal) {
      acc.capsApplied.push({
        cap: 'confidenceBufferTime',
        rule: 'confidence-buffer',
        requested: confidenceBuffer.requested,
        applied: confidenceTotal,
        max: confidenceBuffer.cap
      });
    }

    const finalRecommendationMinutes = Object.values(acc.layerTotals).reduce((sum, value) => sum + value, 0);
    return {
      layers: { ...acc.layerTotals },
      rows: acc.rows,
      visibleRows: acc.rows.filter((row) => row.visible),
      totalMinutes: finalRecommendationMinutes,
      debug: {
        selectedInputs: inputs,
        appliedRules: acc.appliedRules,
        skippedRules: acc.skippedRules,
        layerTotals: { ...acc.layerTotals },
        capsApplied: acc.capsApplied,
        hiddenBufferReductionsApplied: acc.debug.hiddenBufferReductionsApplied,
        blendedPreferenceLogicApplied: acc.debug.blendedPreferenceLogicApplied,
        cappedPreferenceTotals: acc.debug.cappedPreferenceTotals,
        cappedBehavioralTotals: acc.debug.cappedBehavioralTotals,
        terminalNavigationMinutes: TERMINAL_NAVIGATION_MINUTES,
        airportComplexityProfile: inputs.airportComplexity,
        boardingBufferMinutes: BASE.boardingBuffer[inputs.flightType],
        securityBaseWaitMinutes: inputs.securityWaitMinutes,
        finalRecommendationMinutes
      }
    };
  }

  window.AirportMathTimingRules = {
    calculate,
    LAYERS,
    CAPS,
    BASE
  };
})();
