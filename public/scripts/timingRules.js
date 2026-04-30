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
      International: 35
    },
    preference: {
      Domestic: 60,
      International: 90
    },
    confidenceBuffer: {
      Domestic: 10,
      International: 15
    }
  };

  const BASE = {
    travelTime: 45,
    terminalNavigation: 20,
    boardingTime: 15,
    loungeTime: 45,
    loungeContributionCap: 60,
    security: {
      Standard: 25,
      PreCheck: 8,
      'CLEAR + PreCheck': 3
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
    const luggage = inputs.luggage;
    if (inputs.flightType === 'International') {
      if (luggage === 'Checking bags' || luggage === 'Bag drop') {
        return { label: 'International bag drop/check-in', minutes: 30 };
      }
      return { label: 'International check-in', minutes: 20 };
    }
    if (luggage === 'Checking bags' || luggage === 'Bag drop') {
      return { label: 'Bag drop', minutes: 15 };
    }
    return null;
  }

  function getBehavioralRule(inputs) {
    const key = String(inputs.complexity || '').trim().toLowerCase();
    if (key === 'family / children') return { label: 'Family / children', minutes: 20 };
    if (key === 'traveling with pets') return { label: 'Traveling with pets', minutes: inputs.flightType === 'International' ? 35 : 20 };
    if (key === 'group travel') return { label: 'Group travel', minutes: inputs.flightType === 'International' ? 30 : 15 };
    return null;
  }

  function calculateConfidenceBuffer(inputs, baseMinutes, peakWindow) {
    const reductions = [];
    const isLounge = inputs.boarding === 'Lounge';
    const isFamily = String(inputs.complexity || '').trim().toLowerCase() === 'family / children';
    const addReduction = (reason, minutes) => {
      const amount = Math.max(0, Math.round(minutes));
      if (amount > 0) reductions.push({ reason, minutes: amount });
    };

    if (inputs.style === 'Balanced') addReduction('balanced style uses a medium hidden confidence buffer', inputs.flightType === 'International' ? 5 : 3);
    if (inputs.style === 'Relaxed') addReduction('relaxed traveler already adds explicit preference time', inputs.flightType === 'International' ? 12 : 8);
    if (isLounge) addReduction('lounge selected already creates dwell cushion', inputs.flightType === 'International' ? 7 : 5);
    if (isFamily) addReduction('family travel already adds behavioral cushion', inputs.flightType === 'International' ? 5 : 3);

    const reducedBy = Math.min(baseMinutes, reductions.reduce((sum, item) => sum + item.minutes, 0));
    return {
      requested: baseMinutes,
      applied: Math.max(0, baseMinutes - reducedBy),
      reducedBy,
      reductions,
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
      departureDate: input.departureDate instanceof Date ? input.departureDate : null
    };
    const acc = createAccumulator(inputs);
    const isInternational = inputs.flightType === 'International';

    // 1. Base operational timing
    addRule(acc, 'base-travel-time', {
      label: 'Base travel estimate',
      minutes: BASE.travelTime,
      layer: LAYERS.travelTime,
      visible: false
    });
    addRule(acc, 'terminal-navigation', {
      label: 'Terminal navigation',
      minutes: BASE.terminalNavigation,
      layer: LAYERS.terminalFlow,
      visible: true
    });
    addRule(acc, 'boarding-time', {
      label: 'Boarding time',
      minutes: BASE.boardingTime,
      layer: LAYERS.terminalFlow,
      visible: true
    });

    // 2. Reduction logic
    if (inputs.style === 'Tight') {
      skipRule(acc, 'tight-travel-style', 'Applied during confidence stabilization');
    } else {
      skipRule(acc, 'tight-travel-style', 'Travel style is not tight');
    }

    // 3. Structural modifiers
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

    const securityMinutes = BASE.security[inputs.security];
    addRule(acc, 'security-replacement', {
      label: inputs.security === 'Standard' ? 'Standard security' : inputs.security,
      minutes: securityMinutes,
      layer: LAYERS.security,
      visible: true
    });

    // 4. Behavioral modifiers
    const behavioralCap = CAPS.behavioral[inputs.flightType];
    let behavioralTotal = 0;
    const behavioralRule = getBehavioralRule(inputs);
    if (behavioralRule) {
      behavioralTotal = applyCappedRule(acc, 'travel-complexity', 'behavioralTime', {
        ...behavioralRule,
        layer: LAYERS.behavioral,
        visible: true
      }, behavioralTotal, behavioralCap);
    } else {
      skipRule(acc, 'travel-complexity', 'Just me selected');
    }

    // 5. Preference modifiers
    const preferenceCap = CAPS.preference[inputs.flightType];
    let preferenceTotal = 0;
    if (inputs.boarding === 'Lounge') {
      const loungeMinutes = Math.min(BASE.loungeTime, BASE.loungeContributionCap);
      preferenceTotal = applyCappedRule(acc, 'lounge-time', 'preferenceTime', {
        label: 'Lounge time',
        minutes: loungeMinutes,
        layer: LAYERS.preference,
        visible: true
      }, preferenceTotal, preferenceCap);
      acc.debug.blendedPreferenceLogicApplied.push({
        rule: 'lounge-time',
        requested: BASE.loungeTime,
        applied: loungeMinutes,
        max: BASE.loungeContributionCap
      });
    } else if (inputs.boarding === 'Hudson News' || inputs.boarding === 'Grab food') {
      preferenceTotal = applyCappedRule(acc, 'hudson-news-stop', 'preferenceTime', {
        label: 'Hudson News stop',
        minutes: 15,
        layer: LAYERS.preference,
        visible: true
      }, preferenceTotal, preferenceCap);
    } else {
      skipRule(acc, 'boarding-preference', 'Head to gate selected');
    }

    if (inputs.style === 'Relaxed') {
      const hasLounge = inputs.boarding === 'Lounge';
      const relaxedMinutes = hasLounge ? (isInternational ? 15 : 10) : (isInternational ? 45 : 25);
      if (hasLounge) {
        acc.debug.blendedPreferenceLogicApplied.push({
          rule: 'relaxed-travel-style',
          reason: 'Relaxed style and lounge share the same dwell-buffer mindset',
          standaloneMinutes: isInternational ? 45 : 25,
          blendedMinutes: relaxedMinutes
        });
      }
      preferenceTotal = applyCappedRule(acc, 'relaxed-travel-style', 'preferenceTime', {
        label: 'Relaxed travel style',
        minutes: relaxedMinutes,
        layer: LAYERS.preference,
        visible: true
      }, preferenceTotal, preferenceCap);
    } else {
      skipRule(acc, 'relaxed-travel-style', 'Travel style is not relaxed');
    }

    // 6. Confidence stabilization
    const confidenceCap = CAPS.confidenceBuffer[inputs.flightType];
    const peakWindow = isPeakDepartureWindow(inputs.departureDate);
    const confidenceBuffer = calculateConfidenceBuffer(inputs, confidenceCap, peakWindow);
    acc.debug.hiddenBufferReductionsApplied = confidenceBuffer.reductions.map((item) => ({
      ...item,
      requested: confidenceBuffer.requested,
      applied: confidenceBuffer.applied
    }));
    if (confidenceBuffer.applied <= 0) {
      skipRule(acc, 'confidence-buffer', 'Cautionary selections already provide enough buffer');
    } else if (peakWindow) {
      addRule(acc, 'peak-confidence-buffer', {
        label: 'Peak travel window',
        minutes: confidenceBuffer.applied,
        layer: LAYERS.confidenceBuffer,
        visible: true
      });
      acc.capsApplied.push({ cap: 'confidenceBufferTime', rule: 'peak-confidence-buffer', requested: confidenceBuffer.requested, applied: confidenceBuffer.applied, max: confidenceCap });
    } else {
      addRule(acc, 'base-confidence-buffer', {
        label: 'Confidence buffer',
        minutes: confidenceBuffer.applied,
        layer: LAYERS.confidenceBuffer,
        visible: false
      });
    }

    if (inputs.style === 'Tight') {
      skipRule(acc, 'tight-travel-style', 'No hidden buffer reduction; tight travelers still need confidence stabilization');
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
        terminalNavigationMinutes: BASE.terminalNavigation,
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
