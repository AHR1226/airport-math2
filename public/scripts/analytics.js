(function () {
  function analyticsDevMode() {
    try {
      if (window.__ANALYTICS_DEV__ === true) return true;
      var h = window.location && window.location.hostname;
      return h === 'localhost' || h === '127.0.0.1';
    } catch (_e) {
      return false;
    }
  }

  function devLog(message) {
    if (!analyticsDevMode()) return;
    console.log('[analytics] ' + message);
  }

  function capture(eventName, props) {
    try {
      var ph = window.posthog;
      if (ph && typeof ph.capture === 'function') {
        ph.capture(eventName, props || {});
      }
    } catch (_e) {
      /* never break the app */
    }
  }

  window.trackTripCalculated = function () {
    devLog('trip_calculated fired');
    capture('trip_calculated');
  };

  window.trackTripRecalculated = function () {
    devLog('trip_recalculated fired');
    capture('trip_recalculated');
  };

  window.trackTripSaved = function () {
    devLog('trip_saved fired');
    capture('trip_saved');
  };

  window.trackTripViewedAgain = function () {
    devLog('trip_viewed_again fired');
    capture('trip_viewed_again');
  };

  window.trackEtaFeedback = function (outcome) {
    if (!outcome) return;
    capture('eta_feedback', { outcome: String(outcome) });
  };
})();
