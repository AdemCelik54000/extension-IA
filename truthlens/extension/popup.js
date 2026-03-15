document.addEventListener('DOMContentLoaded', () => {
  const verifyPageBtn = document.getElementById('verifyPageBtn');
  const verifySelectionBtn = document.getElementById('verifySelectionBtn');
  const clearCacheBtn = document.getElementById('clearCacheBtn');
  const analysisModeSelect = document.getElementById('analysisMode');
  const statusDiv = document.getElementById('status');
  const resultsDiv = document.getElementById('results');
  const CACHE_TTL_MS = 1000 * 60 * 60 * 6;
  const CACHE_VERSION = 'v5';

  restoreAnalysisMode();

  verifyPageBtn.addEventListener('click', async () => {
    const analysisMode = analysisModeSelect.value;
    await persistAnalysisMode(analysisMode);
    setStatus('Lecture du contenu principal de la page...');
    resultsDiv.innerHTML = '';

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    try {
      const extraction = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        function: extractPagePayload,
        args: [analysisMode]
      });

      const payload = extraction[0]?.result;
      if (!payload || !payload.content) {
        setStatus('');
        resultsDiv.innerHTML = '<p>Impossible de lire le contenu principal de cette page.</p>';
        return;
      }

      const cacheKey = buildCacheKey({
        kind: 'page',
        analysisMode,
        url: tab.url,
        text: `${payload.title}|${payload.description}|${payload.content.slice(0, 1200)}`
      });
      const cached = await readCachedAnalysis(cacheKey);
      if (cached) {
        setStatus('Résultat chargé depuis le cache local.');
        renderAnalysis(normalizeAnalysisResponse(cached, 'full'));
        return;
      }

      setStatus('Analyse du sujet puis vérification avec Brave Search et Mistral...');
      const analysis = await verifyWithBackend({
        url: tab.url,
        page: payload,
        mode: 'full',
        analysisMode
      });
      await writeCachedAnalysis(cacheKey, analysis);
      setStatus('Analyse terminée.');
      renderAnalysis(normalizeAnalysisResponse(analysis, 'full'));
    } catch (error) {
      setStatus('');
      resultsDiv.innerHTML = '<p>Erreur : ' + escapeHtml(error.message) + '</p>';
    }
  });

  verifySelectionBtn.addEventListener('click', async () => {
    const analysisMode = analysisModeSelect.value;
    await persistAnalysisMode(analysisMode);
    setStatus('Lecture du texte sélectionné...');
    resultsDiv.innerHTML = '';

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    try {
      const payload = await readStoredSelection(tab);
      if (!payload || !payload.text) {
        setStatus('');
        resultsDiv.innerHTML = '<p>Sélectionnez un texte sur la page avant de lancer l’analyse.</p>';
        return;
      }

      const cacheKey = buildCacheKey({
        kind: 'selection',
        analysisMode,
        url: '',
        text: payload.text
      });
      const cached = await readCachedAnalysis(cacheKey);
      if (cached) {
        setStatus('Résultat chargé depuis le cache local.');
        renderAnalysis(normalizeAnalysisResponse(cached, 'selection'));
        return;
      }

      setStatus('Vérification de la sélection avec Brave Search et Mistral...');
      const analysis = await verifyWithBackend({
        url: tab.url,
        text: payload.text,
        mode: 'selection',
        analysisMode
      });
      await writeCachedAnalysis(cacheKey, analysis);
      setStatus('Analyse terminée.');
      renderAnalysis(normalizeAnalysisResponse(analysis, 'selection'));
    } catch (error) {
      setStatus('');
      resultsDiv.innerHTML = '<p>Erreur : ' + escapeHtml(error.message) + '</p>';
    }
  });

  clearCacheBtn.addEventListener('click', async () => {
    setStatus('Suppression du cache...');
    try {
      const stored = await chrome.storage.local.get(null);
      const keys = Object.keys(stored).filter((key) => key.startsWith('truthlens-cache:') || key === 'truthlensLastSelection');
      if (keys.length > 0) {
        await chrome.storage.local.remove(keys);
      }

      try {
        await fetch('http://localhost:3001/cache/clear', { method: 'POST' });
      } catch (error) {
      }

      setStatus('');
      resultsDiv.innerHTML = '<p>Le cache a été vidé.</p>';
    } catch (error) {
      setStatus('');
      resultsDiv.innerHTML = '<p>Impossible de vider le cache.</p>';
    }
  });

  function setStatus(message) {
    statusDiv.textContent = message;
  }

  async function verifyWithBackend(payload) {
    const response = await fetch('http://localhost:3001/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(errorText || 'Le backend a renvoyé une erreur.');
    }

    return response.json();
  }

  async function readStoredSelection(tab) {
    const directSelection = await readSelectionFromContentScript(tab?.id);
    if (directSelection?.text) {
      await chrome.storage.local.set({
        truthlensLastSelection: {
          text: directSelection.text,
          savedAt: directSelection.savedAt || Date.now(),
          url: directSelection.url || tab?.url || ''
        }
      });
      return { text: directSelection.text };
    }

    const stored = await chrome.storage.local.get(['truthlensLastSelection']);
    const entry = stored.truthlensLastSelection;
    if (entry && entry.text) {
      if (Date.now() - entry.savedAt > 1000 * 60 * 30) {
        await chrome.storage.local.remove('truthlensLastSelection');
      } else if (tab?.url && entry.url && entry.url !== tab.url) {
        await chrome.storage.local.remove('truthlensLastSelection');
      } else {
        return { text: entry.text };
      }
    }

    if (!tab?.id) {
      return null;
    }

    try {
      const fallback = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        function: getLiveSelectionText
      });
      const liveText = fallback[0]?.result;
      if (!liveText) {
        return null;
      }
      await chrome.storage.local.set({
        truthlensLastSelection: {
          text: liveText,
          savedAt: Date.now(),
          url: tab.url || ''
        }
      });
      return { text: liveText };
    } catch (error) {
      return null;
    }
  }

  async function readSelectionFromContentScript(tabId) {
    if (!tabId) {
      return null;
    }

    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: 'truthlens:getSelectionState' });
      return response?.text ? response : null;
    } catch (error) {
      return null;
    }
  }

  function getLiveSelectionText() {
    const selection = window.getSelection();
    return selection ? selection.toString().trim() : '';
  }

  async function restoreAnalysisMode() {
    const stored = await chrome.storage.local.get(['truthlens-analysis-mode']);
    analysisModeSelect.value = stored['truthlens-analysis-mode'] || 'quick';
  }

  async function persistAnalysisMode(value) {
    await chrome.storage.local.set({ 'truthlens-analysis-mode': value });
  }

  function buildCacheKey({ kind, analysisMode, url, text }) {
    const normalized = `${CACHE_VERSION}|${kind}|${analysisMode}|${normalizeCacheText(url)}|${normalizeCacheText(text)}`;
    let hash = 0;
    for (let index = 0; index < normalized.length; index += 1) {
      hash = ((hash << 5) - hash) + normalized.charCodeAt(index);
      hash |= 0;
    }
    return `truthlens-cache:${kind}:${analysisMode}:${Math.abs(hash)}`;
  }

  function normalizeCacheText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 1600);
  }

  async function readCachedAnalysis(cacheKey) {
    const stored = await chrome.storage.local.get([cacheKey]);
    const entry = stored[cacheKey];
    if (!entry) {
      return null;
    }
    if (Date.now() - entry.savedAt > CACHE_TTL_MS) {
      await chrome.storage.local.remove(cacheKey);
      return null;
    }

    return {
      ...entry.payload,
      debug: {
        ...(entry.payload?.debug || {}),
        cache: {
          hit: true,
          layer: 'cache local'
        }
      }
    };
  }

  async function writeCachedAnalysis(cacheKey, payload) {
    await chrome.storage.local.set({
      [cacheKey]: {
        savedAt: Date.now(),
        payload
      }
    });
  }

  function normalizeAnalysisResponse(response, mode) {
    if (mode === 'full' && Array.isArray(response)) {
      return { results: response, debug: null };
    }
    if (mode === 'selection' && response && !response.result) {
      return { results: [response], debug: null };
    }

    return {
      results: Array.isArray(response?.results)
        ? response.results
        : response?.result
          ? [response.result]
          : [],
      debug: response?.debug || null
    };
  }

  function renderAnalysis(analysis) {
    const results = analysis.results || [];
    displayResults(results, analysis.debug?.selectionOnly === true);
    if (analysis.debug && analysis.debug.selectionOnly !== true) {
      resultsDiv.insertAdjacentHTML('beforeend', renderDebugInfo(analysis.debug));
    }
  }

  function displayResults(results, selectionOnly = false) {
    resultsDiv.innerHTML = '';
    if (!Array.isArray(results)) {
      resultsDiv.innerHTML = '<p>Erreur : ' + escapeHtml(JSON.stringify(results)) + '</p>';
      return;
    }

    results.forEach((result) => {
      const item = document.createElement('div');
      item.className = `result-item ${result.verdict || 'uncertain'}`;
      const sources = Array.isArray(result.sources) ? result.sources : [];
      item.innerHTML = `
        <div><span class="label">Affirmation :</span> ${escapeHtml(result.claim || '')}</div>
        <div><span class="label">Verdict :</span> ${formatVerdict(result.verdict)}</div>
        <div><span class="label">Fiabilité :</span> ${formatCredibility(result.credibility_score)}%</div>
        <div><span class="label">Explication :</span> ${escapeHtml(result.explanation || '')}</div>
        <div class="source-list"><span class="label">Sources consultées :</span> ${formatSources(sources)}</div>
      `;
      resultsDiv.appendChild(item);
    });

    if (selectionOnly && results.length === 1) {
      resultsDiv.firstElementChild?.classList.add('selection-result');
    }
  }

  function renderDebugInfo(debug) {
    const page = debug.page || {};
    const claims = Array.isArray(debug.extractedClaims) ? debug.extractedClaims : [];
    const domains = Array.isArray(debug.consultedDomains) ? debug.consultedDomains : [];
    const sourceCount = typeof debug.sourceCount === 'number' ? debug.sourceCount : 0;
    const cacheInfo = debug.cache || {};

    return `
      <div class="debug-box">
        <h4>Base de l'analyse</h4>
        <p><span class="label">Mode :</span> ${escapeHtml(debug.analysisMode === 'deep' ? 'analyse approfondie' : 'analyse rapide')}</p>
        <p><span class="label">Cache :</span> ${escapeHtml(cacheInfo.hit ? `oui (${cacheInfo.layer || 'inconnu'})` : 'non')}</p>
        <p><span class="label">Titre lu :</span> ${escapeHtml(page.title || 'non disponible')}</p>
        <p><span class="label">Résumé lu :</span> ${escapeHtml(page.description || 'non disponible')}</p>
        <p><span class="label">Intertitres lus :</span> ${escapeHtml((page.headings || []).join(' | ') || 'non disponibles')}</p>
        <p><span class="label">Bloc retenu :</span> ${escapeHtml(page.selectedSource || 'contenu principal de la page')}</p>
        <p><span class="label">Affirmations retenues :</span></p>
        ${claims.length ? `<ul>${claims.map((claim) => `<li>${escapeHtml(claim)}</li>`).join('')}</ul>` : '<p class="muted">aucune affirmation retenue</p>'}
        <p><span class="label">Domaines consultés via Brave :</span> ${escapeHtml(domains.join(', ') || 'aucun')}</p>
        <p><span class="label">Nombre de sources exploitées :</span> ${sourceCount}</p>
      </div>
    `;
  }

  function formatVerdict(verdict) {
    if (verdict === 'true') {
      return 'plutôt vrai';
    }
    if (verdict === 'false') {
      return 'plutôt faux';
    }
    return 'incertain';
  }

  function formatCredibility(score) {
    if (typeof score !== 'number') {
      return 50;
    }
    return score > 1 ? Math.round(score) : Math.round(score * 100);
  }

  function formatSources(sources) {
    if (!sources.length) {
      return 'aucune source exploitable trouvée';
    }
    return sources.map((source) => {
      const title = escapeHtml(source.title || source.url || 'Source');
      const snippetText = normalizeSourceText(source.snippet || '');
      const snippet = snippetText ? ` - ${escapeHtml(snippetText)}` : '';
      if (!source.url) {
        return `${title}${snippet}`;
      }
      return `<a href="${source.url}" target="_blank">${title}</a>${snippet}`;
    }).join('<br>');
  }

  function normalizeSourceText(value) {
    return String(value || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
      .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function escapeHtml(value) {
    return String(value || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }
});

function extractPagePayload(analysisMode) {
  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function metaContent(selector) {
    const element = document.querySelector(selector);
    return normalizeText(element?.content || '');
  }

  function uniqueTexts(values, minLength, maxItems) {
    return Array.from(new Set(
      values
        .map((value) => normalizeText(value))
        .filter((value) => value.length >= minLength)
    )).slice(0, maxItems);
  }

  function getNodeText(node) {
    return normalizeText(node?.innerText || node?.textContent || '');
  }

  function collectTexts(root, selectors, minLength, maxItems) {
    const nodes = selectors.flatMap((selector) => Array.from(root.querySelectorAll(selector)));
    return uniqueTexts(nodes.map((node) => getNodeText(node)), minLength, maxItems);
  }

  function stripNoise(element) {
    const clone = element.cloneNode(true);
    clone.querySelectorAll([
      'script', 'style', 'noscript', 'svg', 'canvas', 'iframe', 'nav', 'footer', 'header', 'aside',
      'form', 'button', 'input', 'select', 'textarea', '[role="navigation"]', '[aria-hidden="true"]',
      '.menu', '.nav', '.navbar', '.footer', '.header', '.sidebar', '.related', '.recommendation',
      '.newsletter', '.paywall', '.advert', '.ads', '.social', '.cookie', '.comments'
    ].join(','))
      .forEach((node) => node.remove());
    return clone;
  }

  function buildSocialSnapshot() {
    const hostname = window.location.hostname.toLowerCase();
    const configs = [
      {
        match: ['x.com', 'twitter.com'],
        sourceLabel: 'post X/Twitter',
        rootSelectors: ['article[data-testid="tweet"]', 'article[role="article"]', 'main article'],
        textSelectors: ['[data-testid="tweetText"]', 'div[lang]', 'span[lang]'],
        authorSelectors: ['[data-testid="User-Name"]', 'a[role="link"][href^="/"] span']
      },
      {
        match: ['linkedin.com'],
        sourceLabel: 'post LinkedIn',
        rootSelectors: ['article', '.feed-shared-update-v2', '[data-urn*="activity:"]'],
        textSelectors: ['.feed-shared-inline-show-more-text', '.feed-shared-update-v2__description', '.update-components-text'],
        authorSelectors: ['.update-components-actor__name', '.feed-shared-actor__name']
      },
      {
        match: ['reddit.com'],
        sourceLabel: 'post Reddit',
        rootSelectors: ['shreddit-post', '[data-test-id="post-content"]', 'article'],
        textSelectors: ['[slot="text-body"]', '[data-click-id="text"]', '.md', '[slot="title"]'],
        authorSelectors: ['[data-testid="post_author_link"]', 'a[href*="/user/"]']
      },
      {
        match: ['facebook.com'],
        sourceLabel: 'post Facebook',
        rootSelectors: ['div[role="article"]', 'article'],
        textSelectors: ['div[data-ad-preview="message"]', 'div[dir="auto"]'],
        authorSelectors: ['h2[dir="auto"]', 'strong span[dir="auto"]']
      },
      {
        match: ['instagram.com'],
        sourceLabel: 'post Instagram',
        rootSelectors: ['article'],
        textSelectors: ['h1', 'ul li', 'div[role="button"] + div span'],
        authorSelectors: ['header a', 'header span']
      },
      {
        match: ['threads.net'],
        sourceLabel: 'post Threads',
        rootSelectors: ['article'],
        textSelectors: ['div[dir="auto"]', 'span[dir="auto"]'],
        authorSelectors: ['header a', 'header span']
      },
      {
        match: ['tiktok.com'],
        sourceLabel: 'post TikTok',
        rootSelectors: ['div[data-e2e="browse-video-desc"]', 'main', 'article'],
        textSelectors: ['h1', '[data-e2e="browse-video-desc"]', '[data-e2e="video-desc"]'],
        authorSelectors: ['h3', '[data-e2e="video-author-uniqueid"]']
      },
      {
        match: ['bsky.app'],
        sourceLabel: 'post Bluesky',
        rootSelectors: ['div[data-testid="postThreadItem"]', 'main article', 'article'],
        textSelectors: ['div[dir="auto"]', 'span[dir="auto"]'],
        authorSelectors: ['a[href^="/profile/"]', '[data-testid="profileLink"]']
      }
    ];

    const config = configs.find((entry) => entry.match.some((part) => hostname.includes(part)));
    if (!config) {
      return null;
    }

    const candidateRoots = config.rootSelectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)));
    const rankedRoots = candidateRoots
      .map((root) => ({
        root,
        textLength: getNodeText(root).length,
        postLength: collectTexts(root, config.textSelectors, 12, 12).join(' ').length
      }))
      .sort((left, right) => (right.postLength + right.textLength) - (left.postLength + left.textLength));

    const chosenRoot = rankedRoots[0]?.root;
    if (!chosenRoot) {
      return null;
    }

    const textBlocks = collectTexts(chosenRoot, config.textSelectors, 12, 12);
    const authorText = uniqueTexts(
      config.authorSelectors.flatMap((selector) => Array.from(chosenRoot.querySelectorAll(selector)).map((node) => getNodeText(node))),
      2,
      3
    ).join(' | ');
    const timeText = normalizeText(chosenRoot.querySelector('time')?.getAttribute('datetime') || chosenRoot.querySelector('time')?.innerText || '');
    const imageAlt = uniqueTexts(
      Array.from(chosenRoot.querySelectorAll('img')).map((image) => image.getAttribute('alt') || ''),
      8,
      4
    );
    const metadataFallback = metaContent('meta[property="og:description"]') || metaContent('meta[name="description"]');

    const content = normalizeText([
      authorText,
      timeText,
      ...textBlocks,
      ...imageAlt,
      metadataFallback
    ].filter(Boolean).join('\n'));

    if (content.length < 24) {
      return null;
    }

    return {
      title: normalizeText(metaContent('meta[property="og:title"]') || document.title || authorText || config.sourceLabel),
      description: normalizeText(metadataFallback || textBlocks[0] || content),
      headings: authorText ? [authorText] : [],
      content,
      selectedSource: config.sourceLabel,
      url: window.location.href
    };
  }

  function scoreSnapshot(snapshot) {
    return (snapshot?.content || '').length + (snapshot?.headings || []).length * 120 + (snapshot?.description ? 200 : 0);
  }

  function buildArticleSnapshot() {
    const maxParagraphs = analysisMode === 'deep' ? 24 : 14;
    const maxLength = analysisMode === 'deep' ? 12000 : 7000;
    const candidates = Array.from(document.querySelectorAll('article, main, [role="main"], .article, .article-content, .post-content, .entry-content, .story, .story-body, .article-body, .content__body, .wysiwyg, section'));
    const scoredCandidates = candidates
      .map((node) => {
        const clone = stripNoise(node);
        const paragraphs = uniqueTexts(
          Array.from(clone.querySelectorAll('p, li, blockquote')).map((paragraph) => paragraph.innerText),
          45,
          maxParagraphs
        );
        const headings = uniqueTexts(
          Array.from(clone.querySelectorAll('h1, h2, h3')).map((heading) => heading.innerText),
          4,
          8
        );
        const content = normalizeText(paragraphs.join('\n')).slice(0, maxLength);
        const description = normalizeText(metaContent('meta[name="description"]') || metaContent('meta[property="og:description"]'));

        return {
          title: normalizeText(metaContent('meta[property="og:title"]') || document.title),
          description,
          headings,
          content,
          selectedSource: node.tagName.toLowerCase(),
          url: window.location.href
        };
      })
      .filter((snapshot) => snapshot.content.length >= 140)
      .sort((left, right) => scoreSnapshot(right) - scoreSnapshot(left));

    if (scoredCandidates.length > 0) {
      return scoredCandidates[0];
    }

    const bodyClone = stripNoise(document.body || document.documentElement);
    const bodyParagraphs = uniqueTexts(
      Array.from(bodyClone.querySelectorAll('p, li, blockquote, div')).map((node) => node.innerText),
      60,
      maxParagraphs
    );
    const fallbackMetaContent = normalizeText(metaContent('meta[property="og:description"]') || metaContent('meta[name="description"]'));
    const fallbackContent = normalizeText(bodyParagraphs.join('\n')).slice(0, maxLength) || fallbackMetaContent;

    return {
      title: normalizeText(metaContent('meta[property="og:title"]') || document.title),
      description: normalizeText(metaContent('meta[name="description"]') || metaContent('meta[property="og:description"]')),
      headings: uniqueTexts(Array.from(document.querySelectorAll('h1, h2, h3')).map((heading) => heading.innerText), 4, 8),
      content: fallbackContent,
      selectedSource: 'page complète',
      url: window.location.href
    };
  }

  const socialSnapshot = buildSocialSnapshot();
  const pageSnapshot = socialSnapshot || buildArticleSnapshot();

  if (!pageSnapshot || !pageSnapshot.content) {
    return null;
  }

  return {
    title: pageSnapshot.title,
    description: pageSnapshot.description,
    headings: pageSnapshot.headings,
    content: pageSnapshot.content,
    selectedSource: pageSnapshot.selectedSource,
    url: pageSnapshot.url
  };
}

