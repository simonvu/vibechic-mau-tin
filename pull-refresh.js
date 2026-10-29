/* Pull-to-refresh for iOS standalone PWA (no native PTR) */
(function (global) {
  'use strict';

  const DEFAULTS = {
    threshold: 68,
    maxPull: 110,
    resistance: 0.5
  };

  /**
   * Pure helper — maps pull distance → UI phase label.
   * @returns {'idle'|'pull'|'ready'|'refresh'}
   */
  function phaseFor(pull, threshold, refreshing) {
    if (refreshing) return 'refresh';
    if (pull <= 0) return 'idle';
    if (pull >= threshold) return 'ready';
    return 'pull';
  }

  function labelFor(phase) {
    if (phase === 'refresh') return 'Đang tải...';
    if (phase === 'ready') return 'Thả để tải lại';
    return 'Kéo để tải lại';
  }

  function createPullRefresh(opts) {
    const threshold = opts.threshold != null ? opts.threshold : DEFAULTS.threshold;
    const maxPull = opts.maxPull != null ? opts.maxPull : DEFAULTS.maxPull;
    const resistance = opts.resistance != null ? opts.resistance : DEFAULTS.resistance;
    const root = opts.root || document;
    const indicator = opts.indicator;
    const labelEl = opts.labelEl;
    const getScrollTop = opts.getScrollTop || (() =>
      window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0);
    const isBlocked = opts.isBlocked || (() => false);
    const onRefresh = opts.onRefresh || (async () => {});

    let startY = 0;
    let startX = 0;
    let armed = false;
    let pulling = false;
    let refreshing = false;
    let pull = 0;
    let trackingId = null;

    function setUI() {
      const phase = phaseFor(pull, threshold, refreshing);
      if (indicator) {
        indicator.classList.toggle('visible', pull > 0 || refreshing);
        indicator.classList.toggle('ready', phase === 'ready');
        indicator.classList.toggle('refreshing', phase === 'refresh');
        indicator.style.height = refreshing ? '' : (pull > 0 ? Math.round(pull) + 'px' : '0px');
        indicator.setAttribute('aria-hidden', phase === 'idle' ? 'true' : 'false');
      }
      if (labelEl) labelEl.textContent = labelFor(phase === 'idle' ? 'pull' : phase);
    }

    function reset() {
      pull = 0;
      pulling = false;
      armed = false;
      trackingId = null;
      if (!refreshing) setUI();
    }

    async function doRefresh() {
      if (refreshing) return;
      refreshing = true;
      pull = Math.max(pull, 52);
      setUI();
      try {
        await onRefresh();
      } finally {
        refreshing = false;
        pull = 0;
        pulling = false;
        armed = false;
        setUI();
      }
    }

    function touchFrom(e, id) {
      const touches = e.touches && e.touches.length ? e.touches : e.changedTouches;
      if (!touches) return null;
      for (let i = 0; i < touches.length; i++) {
        if (id == null || touches[i].identifier === id) return touches[i];
      }
      return touches[0];
    }

    function onStart(e) {
      if (refreshing || isBlocked()) return;
      if (getScrollTop() > 2) return;
      const t = touchFrom(e);
      if (!t) return;
      // Ignore if starting inside a modal overlay
      const pathTarget = e.target;
      if (pathTarget && pathTarget.closest && pathTarget.closest('.overlay')) return;
      startY = t.clientY;
      startX = t.clientX;
      trackingId = t.identifier;
      armed = true;
      pulling = false;
      pull = 0;
    }

    function onMove(e) {
      if (!armed || refreshing || isBlocked()) return;
      if (getScrollTop() > 2) {
        reset();
        return;
      }
      const t = touchFrom(e, trackingId);
      if (!t) return;
      const dy = t.clientY - startY;
      const dx = t.clientX - startX;
      if (dy <= 0) {
        pull = 0;
        pulling = false;
        setUI();
        return;
      }
      // Axis lock: ignore mostly-horizontal gestures (chips / swipe)
      if (Math.abs(dx) > dy) {
        reset();
        return;
      }
      if (dy > 6) {
        pulling = true;
        // Prevent page rubber-band / scroll while PTR active
        if (e.cancelable) e.preventDefault();
      }
      pull = Math.min(maxPull, dy * resistance);
      setUI();
    }

    function onEnd(e) {
      if (!armed) return;
      const should = pulling && pull >= threshold && !refreshing;
      armed = false;
      pulling = false;
      trackingId = null;
      if (should) doRefresh();
      else {
        pull = 0;
        setUI();
      }
    }

    const moveOpts = { passive: false, capture: true };
    const startOpts = { passive: true, capture: true };
    root.addEventListener('touchstart', onStart, startOpts);
    root.addEventListener('touchmove', onMove, moveOpts);
    root.addEventListener('touchend', onEnd, startOpts);
    root.addEventListener('touchcancel', onEnd, startOpts);

    setUI();

    return {
      destroy() {
        root.removeEventListener('touchstart', onStart, startOpts);
        root.removeEventListener('touchmove', onMove, moveOpts);
        root.removeEventListener('touchend', onEnd, startOpts);
        root.removeEventListener('touchcancel', onEnd, startOpts);
      },
      triggerRefresh: doRefresh,
      _test: {
        phaseFor, labelFor, get state() {
          return { pull, armed, pulling, refreshing, threshold };
        },
        setPull(v) { pull = v; setUI(); },
        setRefreshing(v) { refreshing = v; setUI(); }
      }
    };
  }

  global.VCPullRefresh = { createPullRefresh, phaseFor, labelFor, DEFAULTS };
})(typeof window !== 'undefined' ? window : globalThis);
