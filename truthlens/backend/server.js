require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const localAnalysisCache = new Map();
const LOCAL_CACHE_TTL_MS = 1000 * 60 * 60 * 12;
const ANALYSIS_CACHE_VERSION = 'v8';

app.use(cors());
app.use(express.json());

let braveRequests = 0;
let braveWindowStart = Date.now();
const TRUSTED_SITE_DOMAINS = [
  'lemonde.fr',
  'lefigaro.fr',
  'liberation.fr',
  'francetvinfo.fr',
  'leparisien.fr',
  'france24.com',
  'bfmtv.com',
  'lesechos.fr',
  'mediapart.fr',
  'la-croix.com',
  'rfi.fr',
  'europe1.fr',
  'gouvernement.fr',
  'service-public.fr',
  'data.gouv.fr',
  'economie.gouv.fr',
  'diplomatie.gouv.fr',
  'nasa.gov',
  'britannica.com',
  'wikipedia.org',
  'nationalgeographic.com',
  'cnrs.fr',
  'futura-sciences.com',
  'science.org'
];

function getResponseText(resp) {
  if (!resp || !resp.choices || !resp.choices[0]) return '';
  const choice = resp.choices[0];
  if (choice.message && choice.message.content) return choice.message.content.trim();
  if (choice.text) return choice.text.trim();
  return '';
}

function parseModelJson(output) {
  const cleanedOutput = String(output || '').replace(/^```json\s*/, '').replace(/^```\s*/, '').replace(/\s*```$/, '').trim();

  try {
    return JSON.parse(cleanedOutput);
  } catch (error) {
  }

  const firstObject = cleanedOutput.indexOf('{');
  const lastObject = cleanedOutput.lastIndexOf('}');
  if (firstObject !== -1 && lastObject !== -1 && lastObject > firstObject) {
    try {
      return JSON.parse(cleanedOutput.slice(firstObject, lastObject + 1));
    } catch (error) {
    }
  }

  const firstArray = cleanedOutput.indexOf('[');
  const lastArray = cleanedOutput.lastIndexOf(']');
  if (firstArray !== -1 && lastArray !== -1 && lastArray > firstArray) {
    try {
      return JSON.parse(cleanedOutput.slice(firstArray, lastArray + 1));
    } catch (error) {
    }
  }

  throw new Error('Unable to parse model JSON');
}

function canUseBraveSearch() {
  const now = Date.now();
  if (now - braveWindowStart > 1000) {
    braveWindowStart = now;
    braveRequests = 0;
  }
  braveRequests += 1;
  return braveRequests <= 50;
}

app.post('/cache/clear', async (req, res) => {
  localAnalysisCache.clear();
  res.json({ ok: true });
});

app.post('/verify', async (req, res) => {
  try {
    const { url, text, mode, page, pageContext, analysisMode = 'quick' } = req.body;
    const normalizedMode = analysisMode === 'deep' ? 'deep' : 'quick';
    const cacheKey = createAnalysisCacheKey({
      url: mode === 'selection' ? '' : url,
      text,
      mode,
      page,
      pageContext: mode === 'selection' ? null : pageContext,
      analysisMode: normalizedMode
    });
    const cachedPayload = await getCachedAnalysis(cacheKey);
    if (cachedPayload) {
      res.json(cachedPayload);
      return;
    }

    if (mode === 'selection') {
      const result = await verifySelectionStrict(text, normalizedMode);
      const payload = {
        result,
        debug: {
          selectionOnly: true,
          analysisMode: normalizedMode,
          cache: { hit: false, layer: 'aucun' }
        }
      };
      await setCachedAnalysis(cacheKey, payload);
      res.json(payload);
      return;
    }

    const reducedPage = reducePagePayload(page || { content: text || '' }, normalizedMode);
    const claims = await extractClaimsFromPage(reducedPage, normalizedMode);
    if (claims.length === 0) {
      const fallbackResult = {
        claim: reducedPage?.title || 'Page analysée',
        verdict: 'uncertain',
        credibility_score: 0.35,
        explanation: 'Aucune affirmation factuelle claire n\'a pu être extraite du contenu principal de la page.',
        sources: []
      };
      const payload = {
        results: [fallbackResult],
        debug: buildDebugPayload(reducedPage, [], [fallbackResult], normalizedMode, { hit: false, layer: 'aucun' })
      };
      await setCachedAnalysis(cacheKey, payload);
      res.json(payload);
      return;
    }

    const results = await verifyClaimsBatch(claims, url, reducedPage, normalizedMode);
    const payload = {
      results,
      debug: buildDebugPayload(reducedPage, claims, results, normalizedMode, { hit: false, layer: 'aucun' })
    };
    await setCachedAnalysis(cacheKey, payload);
    res.json(payload);
  } catch (error) {
    console.error('Error in /verify:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

async function extractClaimsFromPage(page, analysisMode) {
  const maxClaims = analysisMode === 'deep' ? 4 : 2;
  const prompt = `Vous analysez une page web d'actualité ou d'information.\n` +
    `À partir du titre, du résumé et du contenu principal, identifiez le sujet réel de la page puis extrayez jusqu'à ${maxClaims} affirmations factuelles centrales qui méritent une vérification.\n` +
    `Ignorez les menus, publicités, appels à l'action, éléments de navigation et phrases sans portée factuelle.\n` +
    `N'extrayez pas de détails secondaires hors sujet.\n` +
    `Retournez uniquement un tableau JSON de chaînes.\n\n` +
    `${buildPageSummary(page)}`;

  const response = await axios.post('https://api.mistral.ai/v1/chat/completions', {
    model: 'mistral-small-latest',
    messages: [{ role: 'user', content: prompt }],
    max_tokens: analysisMode === 'deep' ? 320 : 180,
  }, {
    headers: {
      Authorization: `Bearer ${process.env.MISTRAL_API_KEY}`,
      'Content-Type': 'application/json',
    }
  });

  const content = getResponseText(response.data);
  try {
    const parsed = parseModelJson(content);
    return Array.isArray(parsed) ? dedupeClaims(parsed).slice(0, maxClaims) : [];
  } catch (error) {
    console.error('Failed to parse claims:', content);
    return [];
  }
}

function dedupeClaims(claims) {
  const seen = new Set();
  return claims.filter((claim) => {
    const normalized = cleanText(claim).toLowerCase();
    if (!normalized || normalized.length < 20 || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function reducePagePayload(page, analysisMode) {
  const headings = Array.isArray(page?.headings) ? page.headings.map(cleanText).filter(Boolean).slice(0, 6) : [];
  const sentenceLimit = analysisMode === 'deep' ? 24 : 12;
  const contentLimit = analysisMode === 'deep' ? 6000 : 3200;
  const content = cleanText(page?.content)
    .split(/(?<=[\.!?])\s+/)
    .filter((sentence) => sentence.length > 70)
    .slice(0, sentenceLimit)
    .join(' ')
    .slice(0, contentLimit);

  return {
    title: cleanText(page?.title),
    description: cleanText(page?.description),
    headings,
    content,
    selectedSource: cleanText(page?.selectedSource)
  };
}

function buildPageSummary(page) {
  const title = cleanText(page?.title);
  const description = cleanText(page?.description);
  const headings = Array.isArray(page?.headings) ? page.headings.map(cleanText).filter(Boolean) : [];
  const content = cleanText(page?.content);

  return [
    `Titre: ${title || 'non disponible'}`,
    `Résumé: ${description || 'non disponible'}`,
    `Intertitres: ${headings.join(' | ') || 'non disponibles'}`,
    `Contenu principal: """${content || 'non disponible'}"""`
  ].join('\n');
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function cleanSnippet(value) {
  return cleanText(decodeHtmlEntities(String(value || '').replace(/<[^>]+>/g, ' ')));
}

function normalizeForMatch(value) {
  return cleanSnippet(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

const SELECTION_SOURCE_STOPWORDS = new Set([
  'la', 'le', 'les', 'un', 'une', 'des', 'de', 'du', 'd', 'et', 'ou', 'a', 'au', 'aux', 'en', 'dans', 'sur', 'pour',
  'que', 'qui', 'quoi', 'est', 'sont', 'etre', 'ete', 'avec', 'sans', 'par', 'plus', 'moins', 'ses', 'son', 'sa',
  'their', 'this', 'that', 'the', 'and', 'are', 'is', 'was', 'were'
]);

function extractSignificantTerms(value) {
  return Array.from(new Set(
    normalizeForMatch(value)
      .split(/[^a-z0-9]+/)
      .filter((term) => term.length >= 3 && !SELECTION_SOURCE_STOPWORDS.has(term))
  ));
}

function scoreSourceRelevance(claim, source) {
  const claimTerms = extractSignificantTerms(claim);
  if (!claimTerms.length) {
    return 0;
  }

  const sourceText = normalizeForMatch(`${source.title || ''} ${source.snippet || ''} ${source.url || ''}`);
  const matchedTerms = claimTerms.filter((term) => sourceText.includes(term));
  return matchedTerms.length / claimTerms.length;
}

function filterRelevantSources(claim, sources) {
  const claimTerms = extractSignificantTerms(claim);
  if (!claimTerms.length) {
    return sources;
  }

  return sources.filter((source) => {
    const relevance = scoreSourceRelevance(claim, source);
    const minimumRatio = claimTerms.length <= 2 ? 0.5 : 0.34;
    return relevance >= minimumRatio;
  });
}

function isTimeSensitiveClaim(claim) {
  const normalized = normalizeForMatch(claim);
  return [
    'aujourdhui',
    'aujourd hui',
    'actuellement',
    'en ce moment',
    'maintenant',
    'cette annee',
    'ce mois',
    'cette semaine',
    'en 2026',
    'en 2025',
    'president actuel',
    'premier ministre actuel',
    'cours de',
    'prix de',
    'score de',
    'resultat de',
    'dernieres nouvelles',
    'actualite',
    'actualité'
  ].some((marker) => normalized.includes(normalizeForMatch(marker)));
}

function chooseSelectionVerdict({ needsFreshSources, knowledgeVerdict, sourceVerdict }) {
  if (sourceVerdict && ['true', 'false'].includes(sourceVerdict.verdict)) {
    return sourceVerdict;
  }

  if (!needsFreshSources && knowledgeVerdict && ['true', 'false'].includes(knowledgeVerdict.verdict)) {
    return knowledgeVerdict;
  }

  if (sourceVerdict && sourceVerdict.verdict !== 'uncertain') {
    return sourceVerdict;
  }

  if (knowledgeVerdict && knowledgeVerdict.verdict !== 'uncertain') {
    return knowledgeVerdict;
  }

  return sourceVerdict || knowledgeVerdict || {
    verdict: 'uncertain',
    credibility_score: 0.5,
    explanation: 'Les sources disponibles et les connaissances générales disponibles ne permettent pas une conclusion plus nette.'
  };
}

async function verifyClaimsBatch(claims, pageUrl, pageContext, analysisMode) {
  const bundles = await Promise.all(claims.map(async (claim) => {
    try {
      const sources = await checkBraveSearch(composeSearchQuery(claim, pageContext), analysisMode);
      return { claim, sources };
    } catch (error) {
      console.error('Brave Search error:', error?.message || error);
      return { claim, sources: [] };
    }
  }));

  return assessClaimsWithMistral(bundles, pageUrl, pageContext, analysisMode);
}

async function verifySelectionStrict(selectedText, analysisMode) {
  const claim = cleanText(selectedText);
  if (!claim) {
    return {
      claim: '',
      verdict: 'uncertain',
      credibility_score: 50,
      explanation: 'Aucun texte sélectionné.',
      sources: []
    };
  }

  const needsFreshSources = isTimeSensitiveClaim(claim);
  const sources = filterRelevantSources(claim, await getStrictSelectionSources(claim, analysisMode));
  const knowledgeVerdict = needsFreshSources ? null : await compareSelectionWithGeneralKnowledge(claim, analysisMode);
  const sourceVerdict = await compareSelectionWithSources(claim, sources, analysisMode);
  const verdict = chooseSelectionVerdict({
    needsFreshSources,
    knowledgeVerdict,
    sourceVerdict
  });
  return {
    claim,
    verdict: verdict.verdict,
    credibility_score: typeof verdict.credibility_score === 'number'
      ? Math.max(0, Math.min(1, verdict.credibility_score))
      : verdict.verdict === 'true'
        ? 1
        : verdict.verdict === 'false'
          ? 0
          : 0.5,
    explanation: verdict.explanation,
    sources
  };
}

async function getStrictSelectionSources(claim, analysisMode) {
  const sources = [];
  const googleSources = await checkGoogleFactCheck(claim);
  if (googleSources.length) {
    sources.push(...googleSources.slice(0, analysisMode === 'deep' ? 4 : 2));
  }

  const targetCount = analysisMode === 'deep' ? 4 : 2;
  if (sources.length < targetCount) {
    for (const query of buildStrictSelectionQueries(claim)) {
      if (dedupeSources(sources).length >= targetCount) {
        break;
      }
      try {
        const braveSources = await checkBraveSearch(query, analysisMode);
        sources.push(...braveSources);
      } catch (error) {
        console.error('Strict selection Brave Search error:', error?.message || error);
      }
    }
  }

  return dedupeSources(sources).filter((source) => scoreSource(source.url || '') > 0).slice(0, analysisMode === 'deep' ? 6 : 3);
}

function buildStrictSelectionQueries(claim) {
  const base = cleanText(claim);
  const queries = [
    `${base}`,
    `"${base}"`,
    `"${base}" vrai ou faux`,
    `"${base}" fact check`,
    `"${base}" vérification`,
    `${base} source fiable`,
    `${base} explication`
  ];

  return Array.from(new Set(queries.map((query) => cleanText(query)).filter(Boolean)));
}

function dedupeSources(sources) {
  const seen = new Set();
  return sources.filter((source) => {
    const key = `${source.url || ''}|${source.title || ''}`;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function checkGoogleFactCheck(claim) {
  const key = process.env.GOOGLE_FACTCHECK_API_KEY;
  if (!key) return [];

  try {
    const response = await axios.get('https://factchecktools.googleapis.com/v1alpha1/claims:search', {
      params: {
        query: claim,
        key,
        languageCode: 'fr'
      }
    });

    const claims = response.data?.claims || [];
    return claims.flatMap((item) => {
      const reviews = Array.isArray(item.claimReview) ? item.claimReview : [];
      return reviews.map((review) => ({
        title: review.publisher?.name ? `${review.publisher.name} - ${review.title || 'Fact check'}` : (review.title || 'Fact check'),
        url: review.url,
        snippet: cleanSnippet(review.textualRating || item.text || '')
      }));
    }).filter((source) => source.url);
  } catch (error) {
    console.error('Google Fact Check error:', error?.message || error);
    return [];
  }
}

function composeSearchQuery(claim, pageContext) {
  const title = cleanText(pageContext?.title);
  return title ? `${claim} ${title}` : claim;
}

async function checkBraveSearch(query, analysisMode) {
  if (!process.env.BRAVE_SEARCH_API_KEY) {
    throw new Error('BRAVE_SEARCH_API_KEY not set');
  }
  if (!canUseBraveSearch()) {
    throw new Error('Rate limit exceeded for Brave Search');
  }

  const response = await axios.get('https://api.search.brave.com/res/v1/web/search', {
    headers: {
      Accept: 'application/json',
      'X-Subscription-Token': process.env.BRAVE_SEARCH_API_KEY
    },
    params: {
      q: query,
      country: 'FR',
      search_lang: 'fr',
      count: analysisMode === 'deep' ? 5 : 3
    }
  });

  const webResults = response.data?.web?.results || [];
  return webResults
    .map((item) => ({
      title: cleanText(item.title),
      url: item.url,
      snippet: cleanSnippet(item.description || item.snippet || '')
    }))
    .filter((item) => item.url && scoreSource(item.url) > 0)
    .sort((left, right) => scoreSource(right.url) - scoreSource(left.url))
    .slice(0, analysisMode === 'deep' ? 5 : 3);
}

function scoreSource(url) {
  const normalizedUrl = String(url || '').toLowerCase();
  if (!normalizedUrl) return 0;
  const extraTrustedDomains = ['.gouv.fr', '.gov', '.edu', 'who.int', 'europa.eu', 'un.org'];
  const trustedDomains = [...TRUSTED_SITE_DOMAINS, ...extraTrustedDomains];
  return trustedDomains.some((domain) => normalizedUrl.includes(domain)) ? 1 : 0;
}

async function assessClaimsWithMistral(bundles, pageUrl, pageContext, analysisMode) {
  const claims = bundles.map((bundle) => bundle.claim);
  const sourceText = bundles.map((bundle, index) => {
    const header = `Affirmation ${index + 1}: ${bundle.claim}`;
    if (!bundle.sources.length) {
      return `${header}\n- Aucune source exploitable trouvée.`;
    }
    return `${header}\n${bundle.sources.map((source) => `- ${source.title} (${source.url}): ${source.snippet}`).join('\n')}`;
  }).join('\n\n');

  const contextText = pageContext
    ? `Contexte de la page : ${buildPageSummary(pageContext)}`
    : 'Contexte de la page : non disponible.';

  const prompt = `Vous êtes un assistant de vérification des faits très rigoureux.\n\n` +
    `Instructions générales :\n` +
    `1. Analysez uniquement les affirmations fournies.\n` +
    `2. Retournez strictement un JSON valide avec chaque affirmation ayant :\n` +
    `   - claim : la chaîne originale\n` +
    `   - verdict : "true", "false" ou "uncertain"\n` +
    `   - credibility_score : nombre entre 0.0 et 1.0\n` +
    `   - explanation : courte explication en français\n` +
    `   - sources : tableau d'objets {title, url, snippet}\n\n` +
    `Règles pour les verdicts :\n` +
    `- Si au moins une source fiable externe confirme clairement l'affirmation, verdict = "true".\n` +
    `- Si au moins une source fiable externe contredit clairement l'affirmation, verdict = "false".\n` +
    `- Si aucune source externe n'est disponible, utilisez vos connaissances générales vérifiables pour juger.\n` +
    `- Si les sources et vos connaissances ne suffisent pas, verdict = "uncertain".\n` +
    `- Ne laissez jamais un verdict flou si l'information est connue.\n\n` +
    `Sources externes :\n` +
    `- Brave Search est la source principale utilisée ici.\n` +
    `- Google FactCheck peut être présent et doit être priorisé s'il apparaît parmi les sources.\n\n` +
    `Format JSON attendu :\n` +
    `[{"claim":"...","verdict":"true|false|uncertain","credibility_score":0.0,"explanation":"...","sources":[{"title":"...","url":"...","snippet":"..."}]}]\n\n` +
    `Affirmations à juger : ${JSON.stringify(claims)}\n` +
    `URL de la page : "${pageUrl || 'inconnue'}"\n` +
    `${contextText}\n` +
    `Sources externes par affirmation :\n${sourceText}\n\n` +
    `Répondez avec le JSON uniquement, sans texte autour.`;

  const response = await axios.post('https://api.mistral.ai/v1/chat/completions', {
    model: 'mistral-small-latest',
    messages: [{ role: 'user', content: prompt }],
    max_tokens: analysisMode === 'deep' ? 650 : 420,
  }, {
    headers: {
      Authorization: `Bearer ${process.env.MISTRAL_API_KEY}`,
      'Content-Type': 'application/json',
    }
  });

  const output = getResponseText(response.data);
  try {
    const parsed = parseModelJson(output);
    const parsedArray = Array.isArray(parsed) ? parsed : [];
    return bundles.map((bundle) => {
      const match = parsedArray.find((item) => cleanText(item?.claim).toLowerCase() === cleanText(bundle.claim).toLowerCase());
      return {
        claim: bundle.claim,
        verdict: match?.verdict || 'uncertain',
        credibility_score: typeof match?.credibility_score === 'number' ? match.credibility_score : 0.5,
        explanation: match?.explanation || '',
        sources: Array.isArray(match?.sources) && match.sources.length ? match.sources : bundle.sources
      };
    });
  } catch (error) {
    console.error('Failed to parse Mistral verdict:', output);
    return bundles.map((bundle) => ({
      claim: bundle.claim,
      verdict: 'uncertain',
      credibility_score: 0.5,
      explanation: 'Impossible d\'interpréter correctement la réponse du modèle.',
      sources: bundle.sources
    }));
  }
}

async function compareSelectionWithSources(claim, sources, analysisMode) {
  const sourceText = sources.length
    ? sources.map((source) => `- ${source.title} (${source.url}): ${source.snippet}`).join('\n')
    : '- Aucune source externe exploitable trouvée.';

  const prompt = `Jugez l'affirmation uniquement avec les sources ci-dessous.\n` +
    `Ignorez les sources hors sujet.\n` +
    `Choisissez "true" si une source pertinente confirme clairement l'affirmation.\n` +
    `Choisissez "false" si une source pertinente la contredit clairement.\n` +
    `Choisissez "uncertain" seulement si les sources pertinentes sont réellement insuffisantes ou ambiguës.\n` +
    `Préférez "true" ou "false" quand une conclusion nette est possible.\n` +
    `Explication courte, 25 mots maximum.\n` +
    `Répondez strictement avec un JSON valide: {"claim":"...","verdict":"true|false|uncertain","credibility_score":0.0,"explanation":"...","sources":[]}.\n\n` +
    `Affirmation: "${claim}"\n\n` +
    `Sources:\n${sourceText}`;

  const response = await axios.post('https://api.mistral.ai/v1/chat/completions', {
    model: 'mistral-small-latest',
    messages: [{ role: 'user', content: prompt }],
    max_tokens: analysisMode === 'deep' ? 140 : 90,
  }, {
    headers: {
      Authorization: `Bearer ${process.env.MISTRAL_API_KEY}`,
      'Content-Type': 'application/json',
    }
  });

  const output = getResponseText(response.data);
  try {
    const parsed = parseModelJson(output);
    const verdict = ['true', 'false', 'uncertain'].includes(parsed?.verdict) ? parsed.verdict : 'uncertain';
    return {
      verdict,
      credibility_score: typeof parsed?.credibility_score === 'number' ? parsed.credibility_score : undefined,
      explanation: cleanText(parsed?.explanation) || 'Les sources disponibles et les connaissances générales disponibles ne permettent pas une conclusion plus nette.'
    };
  } catch (error) {
    console.error('Failed to parse strict selection verdict:', output);
    return {
      verdict: 'uncertain',
      credibility_score: 0.5,
      explanation: 'Les sources disponibles et les connaissances générales disponibles ne permettent pas une conclusion plus nette.'
    };
  }
}

async function compareSelectionWithGeneralKnowledge(claim, analysisMode) {
  const prompt = `Jugez l'affirmation uniquement avec des connaissances générales stables et largement établies.\n` +
    `N'utilisez pas d'actualité récente. Si le fait dépend du présent ou d'un contexte mouvant, répondez "uncertain".\n` +
    `Si la réponse est connue de manière générale, choisissez clairement "true" ou "false".\n` +
    `Utilisez "uncertain" seulement en cas de vraie ambiguïté.\n` +
    `Explication courte, 25 mots maximum.\n` +
    `Répondez strictement avec un JSON valide: {"claim":"...","verdict":"true|false|uncertain","credibility_score":0.0,"explanation":"...","sources":[]}.\n\n` +
    `Affirmation: "${claim}"`;

  const response = await axios.post('https://api.mistral.ai/v1/chat/completions', {
    model: 'mistral-small-latest',
    messages: [{ role: 'user', content: prompt }],
    max_tokens: analysisMode === 'deep' ? 140 : 90,
  }, {
    headers: {
      Authorization: `Bearer ${process.env.MISTRAL_API_KEY}`,
      'Content-Type': 'application/json',
    }
  });

  const output = getResponseText(response.data);
  try {
    const parsed = parseModelJson(output);
    const verdict = ['true', 'false', 'uncertain'].includes(parsed?.verdict) ? parsed.verdict : 'uncertain';
    return {
      verdict,
      credibility_score: typeof parsed?.credibility_score === 'number' ? parsed.credibility_score : undefined,
      explanation: cleanText(parsed?.explanation) || 'Les connaissances générales disponibles ne permettent pas une conclusion plus nette.'
    };
  } catch (error) {
    console.error('Failed to parse general knowledge verdict:', output);
    return {
      verdict: 'uncertain',
      credibility_score: 0.5,
      explanation: 'Les connaissances générales disponibles ne permettent pas une conclusion plus nette.'
    };
  }
}

function buildDebugPayload(page, claims, results, analysisMode, cache) {
  const consultedDomains = Array.from(new Set(
    results
      .flatMap((result) => Array.isArray(result.sources) ? result.sources : [])
      .map((source) => {
        try {
          return new URL(source.url).hostname;
        } catch (error) {
          return null;
        }
      })
      .filter(Boolean)
  ));

  return {
    analysisMode,
    cache,
    page: {
      title: cleanText(page?.title),
      description: cleanText(page?.description),
      headings: Array.isArray(page?.headings) ? page.headings.map(cleanText).filter(Boolean) : [],
      selectedSource: cleanText(page?.selectedSource)
    },
    extractedClaims: Array.isArray(claims) ? claims : [],
    consultedDomains,
    sourceCount: results.reduce((count, result) => count + (Array.isArray(result.sources) ? result.sources.length : 0), 0)
  };
}

function createAnalysisCacheKey({ url, text, mode, page, pageContext, analysisMode }) {
  const raw = JSON.stringify({
    version: ANALYSIS_CACHE_VERSION,
    url: cleanText(url),
    text: cleanText(text).slice(0, 2000),
    mode,
    analysisMode,
    page: reducePagePayload(page || {}, analysisMode),
    pageContext: {
      title: cleanText(pageContext?.title),
      description: cleanText(pageContext?.description),
      headings: Array.isArray(pageContext?.headings) ? pageContext.headings.map(cleanText).slice(0, 5) : []
    }
  });
  return crypto.createHash('sha1').update(raw).digest('hex');
}

function markCacheHit(payload, layer) {
  return {
    ...payload,
    debug: {
      ...(payload.debug || {}),
      cache: {
        hit: true,
        layer
      }
    }
  };
}

async function getCachedAnalysis(cacheKey) {
  const localEntry = localAnalysisCache.get(cacheKey);
  if (localEntry && Date.now() - localEntry.savedAt < LOCAL_CACHE_TTL_MS) {
    return markCacheHit(localEntry.payload, 'mémoire serveur');
  }
  if (localEntry) {
    localAnalysisCache.delete(cacheKey);
  }

  const remoteEntry = await getSupabaseCachedAnalysis(cacheKey);
  if (remoteEntry) {
    localAnalysisCache.set(cacheKey, { savedAt: Date.now(), payload: remoteEntry });
    return markCacheHit(remoteEntry, 'supabase');
  }

  return null;
}

async function setCachedAnalysis(cacheKey, payload) {
  localAnalysisCache.set(cacheKey, { savedAt: Date.now(), payload });
  await setSupabaseCachedAnalysis(cacheKey, payload);
}

function hasSupabaseCacheConfig() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

async function getSupabaseCachedAnalysis(cacheKey) {
  if (!hasSupabaseCacheConfig()) {
    return null;
  }

  try {
    const response = await axios.get(`${process.env.SUPABASE_URL}/rest/v1/truthlens_cache`, {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`
      },
      params: {
        cache_key: `eq.${cacheKey}`,
        select: 'payload,updated_at',
        limit: 1
      },
      timeout: 2500
    });
    const row = Array.isArray(response.data) ? response.data[0] : null;
    return row?.payload || null;
  } catch (error) {
    console.error('Supabase cache read error:', error?.message || error);
    return null;
  }
}

async function setSupabaseCachedAnalysis(cacheKey, payload) {
  if (!hasSupabaseCacheConfig()) {
    return;
  }

  try {
    await axios.post(`${process.env.SUPABASE_URL}/rest/v1/truthlens_cache`, {
      cache_key: cacheKey,
      payload,
      updated_at: new Date().toISOString()
    }, {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        Prefer: 'resolution=merge-duplicates'
      },
      timeout: 2500
    });
  } catch (error) {
    console.error('Supabase cache write error:', error?.message || error);
  }
}

app.listen(PORT, () => {
  console.log(`TruthLens backend running on port ${PORT}`);
});