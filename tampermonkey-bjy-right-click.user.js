// ==UserScript==
// @name         BJY Right Click Control
// @namespace    http://tampermonkey.net/
// @version      2.8.0
// @description  长按方向右键临时三倍速，支持播放器原生全屏、全屏播完自动下一节，并默认收起右侧目录
// @match        https://pre.iqihang.com/ark/record/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const TARGET_RATE = 3;
  const HOLD_DELAY = 150;
  const FORWARD_KEY = 'ArrowRight';
  const FULLSCREEN_KEY = 'f';
  const AUTO_ADVANCE_COOLDOWN = 1500;
  const FULLSCREEN_RESTORE_WINDOW = 5000;
  const AUTO_PLAY_RETRY_DELAYS = [120, 500, 1200, 2400, 4000, 6500];
  const RATE_TRIGGER_SELECTORS = [
    '.ccH5sp',
    '[class*="ccH5sp"]',
    '[data-has-bind-mouseover="true"]',
  ];
  const RATE_MENU_SELECTORS = ['.ccH5spul', '[class*="ccH5spul"]'];
  const PLAYER_PLAY_SELECTORS = ['.ccH5PlayBtn', '.vjs-big-play-button'];
  const PLAYER_FULLSCREEN_ENTER_SELECTORS = ['.ccH5FullsBtn'];
  const PLAYER_FULLSCREEN_EXIT_SELECTORS = ['.ccH5ExitFullsBtn'];
  const RIGHT_PANEL_SELECTOR = '.record--slide';
  const RIGHT_PANEL_TOGGLE_SELECTOR = '.packup-icon';
  const RIGHT_PANEL_OPEN_CLASS = 'unpackup';
  const CHAPTER_TREE_SELECTOR = '.learn--tree';
  const CHAPTER_ITEM_SELECTOR = '.learn--tree__content.have-content';
  const CHAPTER_ITEM_ACTIVE_SELECTOR =
    '.learn--tree__content.learn--tree__content--active.have-content';
  const CHAPTER_ITEM_CLICK_SELECTOR = '.learn--tree__content--container';

  let badgeEl = null;
  let holdTimer = null;
  let boostTimer = null;
  let boosting = false;
  let forwardKeyHeld = false;
  let activeVideo = null;
  let trackedVideo = null;
  let originalRate = 1;
  let originalRateLabel = '';
  let originalRateValue = '';
  let readyAnnounced = false;
  let hasAutoCollapsedRightPanel = false;
  let lastAutoAdvanceKey = '';
  let lastAutoAdvanceAt = 0;
  let fullscreenRestoreUntil = 0;
  let autoPlayAttemptToken = 0;

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

  function normalizeKey(key) {
    return String(key || '').trim().toLowerCase();
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
    if (!el) return false;
    fireMouseEvent(el, 'pointerdown');
    fireMouseEvent(el, 'mousedown');
    fireMouseEvent(el, 'pointerup');
    fireMouseEvent(el, 'mouseup');
    fireMouseEvent(el, 'click');
    if (typeof el.click === 'function') el.click();
    return true;
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

  function isBrowserShortcut(event) {
    if (!event || event.altKey) return false;
    if (!event.metaKey && !event.ctrlKey) return false;

    const key = normalizeKey(event.key);
    return (
      /^[1-9]$/.test(event.key || '') ||
      /^Digit[1-9]$/.test(event.code || '') ||
      key === 'w' ||
      key === 'r'
    );
  }

  function allowBrowserShortcut(event) {
    if (!isBrowserShortcut(event)) return;

    event.stopImmediatePropagation();
    event.stopPropagation();
  }

  function isEditableTarget(target) {
    if (!target || !(target instanceof Element)) return false;

    return !!target.closest(
      'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"]',
    );
  }

  function isFullscreenKeyEvent(event) {
    if (!event) return false;
    if (event.metaKey || event.ctrlKey || event.altKey) return false;
    return normalizeKey(event.key) === FULLSCREEN_KEY;
  }

  function getVisibleElementBySelectors(selectors, root = document) {
    for (const selector of selectors) {
      const match = Array.from(root.querySelectorAll(selector)).find(isVisibleElement);
      if (match) return match;
    }
    return null;
  }

  function getElementBySelectors(selectors, root = document) {
    for (const selector of selectors) {
      const match = root.querySelector(selector);
      if (match) return match;
    }
    return null;
  }

  function getPlayerFullscreenEnterButton(preferVisible = true) {
    return preferVisible
      ? getVisibleElementBySelectors(PLAYER_FULLSCREEN_ENTER_SELECTORS) ||
          getElementBySelectors(PLAYER_FULLSCREEN_ENTER_SELECTORS)
      : getElementBySelectors(PLAYER_FULLSCREEN_ENTER_SELECTORS);
  }

  function getPlayerFullscreenExitButton(preferVisible = true) {
    return preferVisible
      ? getVisibleElementBySelectors(PLAYER_FULLSCREEN_EXIT_SELECTORS) ||
          getElementBySelectors(PLAYER_FULLSCREEN_EXIT_SELECTORS)
      : getElementBySelectors(PLAYER_FULLSCREEN_EXIT_SELECTORS);
  }

  function getPlayerPlayButton(preferVisible = true) {
    return preferVisible
      ? getVisibleElementBySelectors(PLAYER_PLAY_SELECTORS) ||
          getElementBySelectors(PLAYER_PLAY_SELECTORS)
      : getElementBySelectors(PLAYER_PLAY_SELECTORS);
  }

  function isVideoPlaying(video = getMainVideo()) {
    return !!video && !video.paused && !video.ended && video.readyState >= 2;
  }

  function tryAutoPlay(video = getMainVideo()) {
    if (!video || isVideoPlaying(video)) return;

    const tryButtonFallback = () => {
      if (isVideoPlaying(video) || !video.paused || video.ended) return;
      const playButton = getPlayerPlayButton();
      if (playButton) clickElement(playButton);
    };

    try {
      const result = video.play();
      if (result && typeof result.then === 'function') {
        result
          .then(() => {
            if (isVideoPlaying(video)) {
              updateBadge('BJY RC autoplay', '#166534');
            }
          })
          .catch(() => {
            tryButtonFallback();
          });
        return;
      }
    } catch (error) {
      // Ignore and fall back to the player's own play button.
    }

    tryButtonFallback();
    window.setTimeout(() => {
      if (isVideoPlaying(video)) {
        updateBadge('BJY RC autoplay', '#166534');
      }
    }, 80);
  }

  function scheduleAutoPlay(video = trackedVideo || getMainVideo()) {
    if (!video) return;

    const token = ++autoPlayAttemptToken;
    AUTO_PLAY_RETRY_DELAYS.forEach((delay) => {
      window.setTimeout(() => {
        if (token !== autoPlayAttemptToken) return;
        if (trackedVideo !== video) return;
        if (!document.contains(video)) return;
        if (isVideoPlaying(video)) return;
        if (video.ended) return;
        tryAutoPlay(video);
      }, delay);
    });
  }

  function suppressBeforeUnloadPrompt() {
    const clearBeforeUnloadState = () => {
      try {
        window.onbeforeunload = null;
      } catch (error) {
        // Ignore assignment failures from hostile pages.
      }
    };

    clearBeforeUnloadState();
    window.addEventListener(
      'beforeunload',
      (event) => {
        clearBeforeUnloadState();
        event.stopImmediatePropagation();
        event.stopPropagation();
        try {
          delete event.returnValue;
        } catch (error) {
          event.returnValue = undefined;
        }
        return undefined;
      },
      true,
    );
  }

  function isPlayerFullscreenActive() {
    const exitButton = getPlayerFullscreenExitButton(false);
    const enterButton = getPlayerFullscreenEnterButton(false);

    if (exitButton && isVisibleElement(exitButton)) return true;
    if (enterButton && isVisibleElement(enterButton)) return false;
    if (document.fullscreenElement || document.webkitFullscreenElement) return true;

    return false;
  }

  function toggleFullscreen() {
    const exitButton = getPlayerFullscreenExitButton();
    const enterButton = getPlayerFullscreenEnterButton();
    const target = isPlayerFullscreenActive() ? exitButton || enterButton : enterButton || exitButton;

    return clickElement(target);
  }

  function onFullscreenKeyDown(event) {
    if (!isFullscreenKeyEvent(event)) return;
    if (isEditableTarget(event.target)) return;
    if (event.repeat) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    toggleFullscreen();
  }

  function getBestRightPanel() {
    const panels = Array.from(document.querySelectorAll(RIGHT_PANEL_SELECTOR));
    if (!panels.length) return null;

    const visiblePanel = panels
      .filter((panel) => {
        const style = window.getComputedStyle(panel);
        return style.display !== 'none' && style.visibility !== 'hidden';
      })
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return br.width * br.height - ar.width * ar.height;
      })[0];

    return visiblePanel || panels[0];
  }

  function getRightPanelToggle() {
    return (
      Array.from(document.querySelectorAll(RIGHT_PANEL_TOGGLE_SELECTOR)).find(isVisibleElement) ||
      document.querySelector(RIGHT_PANEL_TOGGLE_SELECTOR)
    );
  }

  function isRightPanelExpanded(panel = getBestRightPanel(), toggle = getRightPanelToggle()) {
    if (toggle && toggle.classList.contains(RIGHT_PANEL_OPEN_CLASS)) return true;
    if (!panel) return false;

    const style = window.getComputedStyle(panel);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = panel.getBoundingClientRect();
    return rect.width > 80 && rect.height > 80;
  }

  function collapseRightPanelIfNeeded() {
    if (hasAutoCollapsedRightPanel) return false;

    const panel = getBestRightPanel();
    const toggle = getRightPanelToggle();
    if (!panel && !toggle) return false;

    if (!isRightPanelExpanded(panel, toggle)) {
      hasAutoCollapsedRightPanel = true;
      return true;
    }

    if (!toggle) return false;
    hasAutoCollapsedRightPanel = true;
    return clickElement(toggle);
  }

  function getActiveChapterItem() {
    const activeItems = Array.from(document.querySelectorAll(CHAPTER_ITEM_ACTIVE_SELECTOR));
    if (!activeItems.length) return null;

    return activeItems.find(isVisibleElement) || activeItems[0];
  }

  function getChapterItemsForActiveTree(activeItem) {
    const tree = activeItem ? activeItem.closest(CHAPTER_TREE_SELECTOR) : null;
    const scopedItems = tree ? Array.from(tree.querySelectorAll(CHAPTER_ITEM_SELECTOR)) : [];
    return scopedItems.length ? scopedItems : Array.from(document.querySelectorAll(CHAPTER_ITEM_SELECTOR));
  }

  function getChapterItemKey(item) {
    if (!item) return '';

    const titleEl = item.querySelector('.title-text');
    const idPart = item.id ? `id:${item.id}` : '';
    const textPart = normalizeText(titleEl ? titleEl.textContent : item.textContent);
    return `${idPart}|${textPart}`;
  }

  function findNextChapterItem() {
    const activeItem = getActiveChapterItem();
    if (!activeItem) return null;

    const items = getChapterItemsForActiveTree(activeItem);
    if (!items.length) return null;

    const currentKey = getChapterItemKey(activeItem);
    let activeIndex = items.indexOf(activeItem);

    if (activeIndex < 0 && currentKey) {
      activeIndex = items.findIndex((item) => getChapterItemKey(item) === currentKey);
    }

    if (activeIndex < 0) return null;
    return items.slice(activeIndex + 1).find(Boolean) || null;
  }

  function scheduleFullscreenRestoreChecks() {
    [180, 450, 900, 1600, 2600].forEach((delay) => {
      window.setTimeout(() => {
        if (Date.now() > fullscreenRestoreUntil) return;
        if (isPlayerFullscreenActive()) {
          fullscreenRestoreUntil = 0;
          return;
        }

        const enterButton = getPlayerFullscreenEnterButton();
        if (!enterButton) return;
        clickElement(enterButton);

        window.setTimeout(() => {
          if (isPlayerFullscreenActive()) fullscreenRestoreUntil = 0;
        }, 80);
      }, delay);
    });
  }

  function advanceToNextChapter() {
    const activeItem = getActiveChapterItem();
    const nextItem = findNextChapterItem();
    if (!activeItem || !nextItem) return false;

    const advanceKey = `${getChapterItemKey(activeItem)}=>${getChapterItemKey(nextItem)}`;
    const now = Date.now();
    if (advanceKey === lastAutoAdvanceKey && now - lastAutoAdvanceAt < AUTO_ADVANCE_COOLDOWN) {
      return false;
    }

    lastAutoAdvanceKey = advanceKey;
    lastAutoAdvanceAt = now;

    const target = nextItem.querySelector(CHAPTER_ITEM_CLICK_SELECTOR) || nextItem;
    const clicked = clickElement(target);
    if (clicked) {
      updateBadge('BJY RC next lesson', '#166534');
      scheduleFullscreenRestoreChecks();
    }

    return clicked;
  }

  function handleVideoEnded() {
    if (!isPlayerFullscreenActive()) return;

    fullscreenRestoreUntil = Date.now() + FULLSCREEN_RESTORE_WINDOW;
    const advanced = advanceToNextChapter();
    if (!advanced) {
      fullscreenRestoreUntil = 0;
      updateBadge('BJY RC list end', '#92400e');
    }
  }

  function handleTrackedVideoPlayable() {
    tryAutoPlay(trackedVideo);
    if (Date.now() > fullscreenRestoreUntil) return;
    scheduleFullscreenRestoreChecks();
  }

  function bindVideoListeners() {
    const video = getMainVideo();
    if (video === trackedVideo) return !!trackedVideo;

    if (trackedVideo) {
      trackedVideo.removeEventListener('ended', handleVideoEnded, true);
      trackedVideo.removeEventListener('play', handleTrackedVideoPlayable, true);
      trackedVideo.removeEventListener('canplay', handleTrackedVideoPlayable, true);
      trackedVideo.removeEventListener('loadedmetadata', handleTrackedVideoPlayable, true);
    }

    trackedVideo = video;
    if (!trackedVideo) return false;

    trackedVideo.addEventListener('ended', handleVideoEnded, true);
    trackedVideo.addEventListener('play', handleTrackedVideoPlayable, true);
    trackedVideo.addEventListener('canplay', handleTrackedVideoPlayable, true);
    trackedVideo.addEventListener('loadedmetadata', handleTrackedVideoPlayable, true);
    scheduleAutoPlay(trackedVideo);
    return true;
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
    suppressBeforeUnloadPrompt();
    ensureBadge();
    updateBadge('BJY RC waiting player', '#92400e');

    const bindIfReady = () => {
      const hasVideo = bindVideoListeners();
      const hasRateControl = !!getRateLabelElement();
      if (!hasVideo && !hasRateControl) return false;

      if (!readyAnnounced) {
        readyAnnounced = true;
        updateBadge('BJY RC ready', '#1d4ed8');
      }
      return true;
    };

    bindIfReady();
    collapseRightPanelIfNeeded();
    window.setTimeout(collapseRightPanelIfNeeded, 300);
    window.setTimeout(collapseRightPanelIfNeeded, 1000);

    const pageObserver = new MutationObserver(() => {
      bindIfReady();
      if (!hasAutoCollapsedRightPanel) collapseRightPanelIfNeeded();
    });

    pageObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    document.addEventListener('keydown', allowBrowserShortcut, true);
    window.addEventListener('keyup', allowBrowserShortcut, true);
    document.addEventListener('keydown', onFullscreenKeyDown, true);
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
