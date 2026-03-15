let lastSelectedText = '';
let lastSelectionRects = [];
let redrawScheduled = false;

initializeSelectionTracking();

function initializeSelectionTracking() {
  try {
    ensureHighlightStyle();
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('selectionchange', scheduleSelectionCapture, true);
    document.addEventListener('mouseup', scheduleSelectionCapture, true);
    document.addEventListener('keyup', scheduleSelectionCapture, true);
    window.addEventListener('resize', scheduleHighlightRedraw, true);
    window.addEventListener('scroll', scheduleHighlightRedraw, true);
    chrome.runtime.onMessage.addListener(handleRuntimeMessage);
  } catch (error) {
    console.debug('TruthLens selection tracking disabled:', error);
  }
}

function handlePointerDown() {
  if (lastSelectedText) {
    clearStoredSelection();
  }
}

function ensureHighlightStyle() {
  if (document.getElementById('truthlens-highlight-style')) {
    return;
  }

  const highlightStyle = document.createElement('style');
  highlightStyle.id = 'truthlens-highlight-style';
  highlightStyle.textContent = `
    .truthlens-selection-highlight {
      position: fixed;
      background: rgba(59, 130, 246, 0.28);
      border: 1px solid rgba(37, 99, 235, 0.45);
      border-radius: 4px;
      pointer-events: none;
      z-index: 2147483646;
    }
  `;
  (document.head || document.documentElement).appendChild(highlightStyle);
}

function scheduleSelectionCapture() {
  window.setTimeout(captureSelection, 0);
}

function captureSelection() {
  try {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      if (document.hasFocus()) {
        clearStoredSelection();
      }
      return;
    }

    const text = selection.toString().trim();
    if (!text) {
      if (document.hasFocus()) {
        clearStoredSelection();
      }
      return;
    }

    lastSelectedText = text;
    lastSelectionRects = Array.from(selection.getRangeAt(0).getClientRects())
      .map((rect) => ({
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height
      }))
      .filter((rect) => rect.width > 0 && rect.height > 0);

    persistSelection(text);
    scheduleHighlightRedraw();
  } catch (error) {
    console.debug('TruthLens selection capture skipped:', error);
  }
}

function clearStoredSelection() {
  lastSelectedText = '';
  lastSelectionRects = [];
  clearSelectionHighlight();
  persistSelection('');
}

function handleRuntimeMessage(message, sender, sendResponse) {
  if (message?.type !== 'truthlens:getSelectionState') {
    return false;
  }

  sendResponse({
    text: lastSelectedText,
    url: window.location.href,
    savedAt: Date.now()
  });
  return false;
}

function scheduleHighlightRedraw() {
  if (redrawScheduled) {
    return;
  }
  redrawScheduled = true;
  window.requestAnimationFrame(() => {
    redrawScheduled = false;
    redrawSelectionHighlight();
  });
}

function redrawSelectionHighlight() {
  try {
    clearSelectionHighlight();
    lastSelectionRects.forEach((rect) => {
      const overlay = document.createElement('div');
      overlay.className = 'truthlens-selection-highlight';
      overlay.style.top = `${rect.top}px`;
      overlay.style.left = `${rect.left}px`;
      overlay.style.width = `${rect.width}px`;
      overlay.style.height = `${rect.height}px`;
      document.documentElement.appendChild(overlay);
    });
  } catch (error) {
    console.debug('TruthLens highlight redraw skipped:', error);
  }
}

function clearSelectionHighlight() {
  document.querySelectorAll('.truthlens-selection-highlight').forEach((node) => node.remove());
}

function persistSelection(text) {
  chrome.storage.local.set({
    truthlensLastSelection: {
      text,
      savedAt: Date.now(),
      url: window.location.href
    }
  }).catch(() => {});
}