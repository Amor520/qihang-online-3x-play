// ==UserScript==
// @name         BJY Right Click Control
// @namespace    http://tampermonkey.net/
// @version      2.6.0
// @description  长按方向右键临时三倍速，短按保留页面原本快进
// @match        https://pre.iqihang.com/ark/record/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const TARGET_RATE = 3;
  const HOLD_DELAY = 150;
  const FORWARD_KEY = 'ArrowRight';
  const RATE_TRIGGER_SELECTORS = [
    '.ccH5sp',
    '[class*="ccH5sp"]',
    '[data-has-bind-mouseover="true"]',
  ];
  const RATE_MENU_SELECTORS = ['.ccH5spul', '[class*="ccH5spul"]'];

  let badgeEl = null;
  let holdTimer = null;
  let boostTimer = null;
  let boosting = false;
  let forwardKeyHeld = false;
  let activeVideo = null;
  let originalRate = 1;
  let originalRateLabel = '';
  let originalRateValue = '';

  function ensureBadge() {
    if (badgeEl && document.contains(badgeEl)) return badgeEl;

    const el = document.createElement('div');
    el.textContent = 'BJY RC bootstrapped';
    el.style.cssText = [
      'position:fixed',
      'top:12px',
      'left:12px',
      'z-index:2147483647',
      'padding:6px 10px',
      'border-radius:999px',
      'background:#1d4ed8',
      'color:#fff',
      'font:12px/1.2 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
      'box-shadow:0 4px 14px rgba(0,0,0,.18)',
      'pointer-events:none',
      'opacity:.92',
    ].join(';');

    const mount = document.body || document.documentElement;
    if (mount) {
      mount.appendChild(el);
      badgeEl = el;
    }
    return badgeEl;
  }

  function updateBadge(text, color) {
    const el = ensureBadge();
    if (!el) return;
    el.textContent = text;
    if (color) el.style.background = color;
  }

  function normalizeText(text) {
    return String(text || '')
      .replace(/\s+/g, '')
      .replace(/倍速/g, '')
      .trim();
  }

  function isVisibleElement(el) {
    if (!el || !document.contains(el)) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isSpeedText(text) {
    return /^(正常|\d+(?:\.\d+)?(?:x|X|倍))$/.test(normalizeText(text));
  }

  function buildRateLabels(rate) {
    const numeric = Number(rate);
    if (!Number.isFinite(numeric)) return [];

    return Array.from(
      new Set(
        [
          `${numeric}x`,
          `${numeric}X`,
          `${numeric.toFixed(1)}x`,
          `${numeric.toFixed(1)}X`,
          `${numeric.toFixed(2)}x`,
          `${numeric.toFixed(2)}X`,
          `${numeric}倍`,
        ]
          .map(normalizeText)
          .filter(Boolean),
      ),
    );
  }

  function buildRateValues(rate) {
    const numeric = Number(rate);
    if (!Number.isFinite(numeric)) return [];

    return Array.from(
      new Set([String(numeric), numeric.toFixed(1), numeric.toFixed(2)]),
    );
  }

  function getMainVideo() {
    const videos = Array.from(document.querySelectorAll('video'));
    if (!videos.length) return null;

    const ccVideo = videos.find((video) => video.id && video.id.startsWith('cc_'));
    if (ccVideo) return ccVideo;

    videos.sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return br.width * br.height - ar.width * ar.height;
    });

    return videos[0];
  }

  function getClickableAncestor(el) {
    let node = el;
    while (node && node !== document.body) {
      const style = window.getComputedStyle(node);
      if (
        node.matches('button, [role="button"], a, [tabindex]') ||
        style.cursor === 'pointer' ||
        node.dataset.hasBindMouseover === 'true' ||
        node.dataset.hasBindClick === 'true'
      ) {
        return node;
      }
      node = node.parentElement;
    }
    return el;
  }

  function getRateLabelElement() {
    const directCandidates = [];
    RATE_TRIGGER_SELECTORS.forEach((selector) => {
      document.querySelectorAll(selector).forEach((el) => directCandidates.push(el));
    });

    const genericCandidates = Array.from(document.querySelectorAll('span, button, div, a'));
    const candidates = directCandidates.concat(genericCandidates);

    return candidates.find((el) => isVisibleElement(el) && isSpeedText(el.textContent)) || null;
  }

  function getRateMenu() {
    for (const selector of RATE_MENU_SELECTORS) {
      const el = document.querySelector(selector);
      if (el) return el;
    }
    return null;
  }

  function getSelectedRateOption() {
    const menu = getRateMenu();
    if (!menu) return null;

    return (
      menu.querySelector('li.selected[data-sp]') ||
      menu.querySelector('li.selected') ||
      menu.querySelector('li[data-sp].selected') ||
      null
    );
  }

  function getCurrentRateState() {
    const selected = getSelectedRateOption();
    const labelEl = getRateLabelElement();

    return {
      value: selected ? String(selected.dataset.sp || '').trim() : '',
      label: normalizeText(
        selected ? selected.textContent : labelEl ? labelEl.textContent : '',
      ),
    };
  }

  function getRateTrigger() {
    const labelEl = getRateLabelElement();
    if (!labelEl) return null;
    return getClickableAncestor(labelEl);
  }

  function getElementCenter(el) {
    const rect = el.getBoundingClientRect();
    return {
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    };
  }

  function fireMouseEvent(el, type) {
    if (!el) return;
    const point = getElementCenter(el);
    const eventInit = {
      bubbles: true,
      cancelable: true,
      view: window,
      button: 0,
      buttons: 1,
      ...point,
    };
    const EventCtor =
      type.startsWith('pointer') && typeof window.PointerEvent === 'function'
        ? window.PointerEvent
        : MouseEvent;

    el.dispatchEvent(new EventCtor(type, eventInit));
  }

  function hoverRateControl() {
    const labelEl = getRateLabelElement();
    const trigger = getRateTrigger();

    if (labelEl) {
      fireMouseEvent(labelEl, 'pointerover');
      fireMouseEvent(labelEl, 'pointerenter');
      fireMouseEvent(labelEl, 'mouseover');
      fireMouseEvent(labelEl, 'mouseenter');
    }

    if (trigger && trigger !== labelEl) {
      fireMouseEvent(trigger, 'pointerover');
      fireMouseEvent(trigger, 'pointerenter');
      fireMouseEvent(trigger, 'mouseover');
      fireMouseEvent(trigger, 'mouseenter');
    }
  }

  function leaveRateControl() {
    const labelEl = getRateLabelElement();
    const trigger = getRateTrigger();

    if (labelEl) {
      fireMouseEvent(labelEl, 'pointerout');
      fireMouseEvent(labelEl, 'pointerleave');
      fireMouseEvent(labelEl, 'mouseout');
      fireMouseEvent(labelEl, 'mouseleave');
    }

    if (trigger && trigger !== labelEl) {
      fireMouseEvent(trigger, 'pointerout');
      fireMouseEvent(trigger, 'pointerleave');
      fireMouseEvent(trigger, 'mouseout');
      fireMouseEvent(trigger, 'mouseleave');
    }
  }

  function clickElement(el) {
    if (!el) return;
    fireMouseEvent(el, 'pointerdown');
    fireMouseEvent(el, 'mousedown');
    fireMouseEvent(el, 'pointerup');
    fireMouseEvent(el, 'mouseup');
    fireMouseEvent(el, 'click');
    if (typeof el.click === 'function') el.click();
  }

  function findRateOption(spec) {
    const wantedLabels = new Set((spec.labels || []).map(normalizeText).filter(Boolean));
    const wantedValues = new Set((spec.values || []).map(String).filter(Boolean));
    const menu = getRateMenu();
    const labelEl = getRateLabelElement();
    const trigger = getRateTrigger();

    if (menu) {
      const exactOption = Array.from(menu.querySelectorAll('li[data-sp], li')).find((el) => {
        const value = String(el.dataset.sp || '').trim();
        const label = normalizeText(el.textContent);
        return wantedValues.has(value) || wantedLabels.has(label);
      });
      if (exactOption) return exactOption;
    }

    return (
      Array.from(document.querySelectorAll('span, button, li, div, a')).find((el) => {
        if (!isVisibleElement(el)) return false;
        if (el === labelEl || el === trigger) return false;
        if (labelEl && labelEl.contains(el)) return false;
        const value = String(el.dataset && el.dataset.sp ? el.dataset.sp : '').trim();
        const label = normalizeText(el.textContent);
        return wantedValues.has(value) || wantedLabels.has(label);
      }) || null
    );
  }

  function matchesRateState(state, spec) {
    const wantedLabels = new Set((spec.labels || []).map(normalizeText).filter(Boolean));
    const wantedValues = new Set((spec.values || []).map(String).filter(Boolean));

    return (
      (state.value && wantedValues.has(state.value)) ||
      (state.label && wantedLabels.has(state.label))
    );
  }

  function selectRateViaUi(spec, onDone) {
    const trySelect = (attempt) => {
      const trigger = getRateTrigger();
      const currentState = getCurrentRateState();

      if (matchesRateState(currentState, spec)) {
        leaveRateControl();
        onDone(true);
        return;
      }

      if (!trigger) {
        leaveRateControl();
        onDone(false);
        return;
      }

      hoverRateControl();

      const option = findRateOption(spec);
      if (option) {
        clickElement(option);
        window.setTimeout(() => {
          leaveRateControl();
          onDone(matchesRateState(getCurrentRateState(), spec));
        }, 40);
        return;
      }

      if (attempt === 0) clickElement(trigger);
      if (attempt >= 5) {
        leaveRateControl();
        onDone(false);
        return;
      }

      window.setTimeout(() => trySelect(attempt + 1), 60);
    };

    trySelect(0);
  }

  function clearHoldTimer() {
    if (!holdTimer) return;
    clearTimeout(holdTimer);
    holdTimer = null;
  }

  function clearBoostTimer() {
    if (!boostTimer) return;
    clearInterval(boostTimer);
    boostTimer = null;
  }

  function resetHoldState() {
    forwardKeyHeld = false;
    clearHoldTimer();
  }

  function startBoost() {
    const video = getMainVideo();
    const trigger = getRateTrigger();
    if ((!video && !trigger) || boosting) return;

    activeVideo = video || null;
    originalRate = video ? Number(video.playbackRate) || 1 : 1;

    const currentRateState = getCurrentRateState();
    originalRateLabel = currentRateState.label;
    originalRateValue = currentRateState.value;

    if (activeVideo) {
      activeVideo.playbackRate = TARGET_RATE;
      activeVideo.defaultPlaybackRate = TARGET_RATE;
    }

    boosting = true;
    clearBoostTimer();

    if (activeVideo) {
      boostTimer = window.setInterval(() => {
        if (!activeVideo) return;
        activeVideo.playbackRate = TARGET_RATE;
        activeVideo.defaultPlaybackRate = TARGET_RATE;
      }, 120);
    }

    if (trigger) {
      selectRateViaUi(
        {
          labels: buildRateLabels(TARGET_RATE),
          values: buildRateValues(TARGET_RATE),
        },
        () => {},
      );
    }

    updateBadge('BJY RC 3x', '#166534');
  }

  function stopBoost() {
    resetHoldState();
    clearBoostTimer();

    if (!boosting) return;

    const restoreLabel = originalRateLabel;
    const restoreValue = originalRateValue;

    if (activeVideo) {
      activeVideo.playbackRate = originalRate || 1;
      activeVideo.defaultPlaybackRate = originalRate || 1;
    }

    if (restoreLabel || restoreValue) {
      selectRateViaUi(
        {
          labels: restoreLabel ? [restoreLabel] : [],
          values: restoreValue ? [restoreValue] : [],
        },
        () => {},
      );
    } else {
      leaveRateControl();
    }

    activeVideo = null;
    boosting = false;
    originalRateLabel = '';
    originalRateValue = '';
    updateBadge('BJY RC ready', '#1d4ed8');
  }

  function isForwardKeyEvent(event) {
    return !!event && event.key === FORWARD_KEY;
  }

  function isEditableTarget(target) {
    if (!target || !(target instanceof Element)) return false;

    return !!target.closest(
      'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"]',
    );
  }

  function onForwardKeyDown(event) {
    if (!isForwardKeyEvent(event)) return;
    if (isEditableTarget(event.target)) return;
    if (!getMainVideo()) return;

    if (event.repeat && (holdTimer || boosting)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (forwardKeyHeld) return;
    forwardKeyHeld = true;

    clearHoldTimer();
    holdTimer = window.setTimeout(startBoost, HOLD_DELAY);
  }

  function onForwardKeyUp(event) {
    if (!isForwardKeyEvent(event)) return;
    if (isEditableTarget(event.target)) return;

    resetHoldState();

    if (boosting) {
      event.preventDefault();
      event.stopPropagation();
      stopBoost();
    }
  }

  function init() {
    window.__BJY_RIGHT_CLICK_CONTROL__ = 'loaded';
    ensureBadge();
    updateBadge('BJY RC waiting player', '#92400e');

    const bindIfReady = () => {
      if (!getMainVideo() && !getRateLabelElement()) return false;
      updateBadge('BJY RC ready', '#1d4ed8');
      return true;
    };

    bindIfReady();

    const observer = new MutationObserver(() => {
      if (bindIfReady()) observer.disconnect();
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    document.addEventListener('keydown', onForwardKeyDown, true);
    window.addEventListener('keyup', onForwardKeyUp, true);
    window.addEventListener('blur', stopBoost, true);
    document.addEventListener(
      'visibilitychange',
      () => {
        if (document.hidden) stopBoost();
      },
      true,
    );
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
