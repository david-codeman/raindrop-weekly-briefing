// ============================================================
// Your Week in Bookmarks — Google Apps Script
// Fetches your Raindrop.io bookmarks, sends them to Claude for
// AI analysis, and emails you a weekly digest sorted into three
// tiers: print / skim / skip.
//
// Runs on Google's servers. Your computer can be off.
//
// SETUP (5 minutes):
// 1. Go to script.google.com → New Project
// 2. Paste this entire file into Code.gs
// 3. Edit setApiKeys() with YOUR keys (see below)
// 4. Run setApiKeys() once — this stores them securely
// 5. Clear the key values from setApiKeys() for security
// 6. Run sendWeeklyBriefing() to test
// 7. Run setupWeeklyTrigger() to schedule it weekly
//
// REQUIREMENTS:
// - Raindrop.io account + API token (free)
//   → https://app.raindrop.io/settings/integrations
// - Anthropic API key with credits (~$0.02/week on Haiku)
//   → https://console.anthropic.com
// - Google account (for Apps Script + Gmail)
//
// Originally built with Claude in Cowork mode, March 2026.
// https://github.com/YOUR_USERNAME/raindrop-weekly-briefing
// ============================================================


// —— API Keys (stored securely in Script Properties) ——

function setApiKeys() {
  const props = PropertiesService.getScriptProperties();

  // ⚠️  EDIT THESE, run this function ONCE, then delete the values.
  //     The keys are stored in Script Properties, not in the code.
  props.setProperties({
    'RAINDROP_TOKEN': 'YOUR_RAINDROP_TOKEN',
    'ANTHROPIC_API_KEY': 'YOUR_ANTHROPIC_API_KEY',
    'EMAIL_TO': 'you@example.com',
    'CLAUDE_MODEL': 'claude-haiku-4-5-20251001'
  });

  Logger.log('API keys saved to Script Properties.');
  Logger.log('Now delete the actual values from this function for security.');
}

function getConfig() {
  const props = PropertiesService.getScriptProperties();
  return {
    raindropToken: props.getProperty('RAINDROP_TOKEN'),
    anthropicKey: props.getProperty('ANTHROPIC_API_KEY'),
    emailTo: props.getProperty('EMAIL_TO') || 'you@example.com',
    model: props.getProperty('CLAUDE_MODEL') || 'claude-haiku-4-5-20251001',
    // Model fallback chain: if the primary model is deprecated, try these in order.
    // Anthropic retires specific model versions but keeps the "-latest" aliases current.
    modelFallbacks: [
      props.getProperty('CLAUDE_MODEL') || 'claude-haiku-4-5-20251001',
      'claude-haiku-4-5-latest',
      'claude-3-5-haiku-latest',
      'claude-3-haiku-20240307'
    ]
  };
}

// —— Error notification ——
// If the script fails for any reason, email the user instead of failing silently.
function sendErrorEmail(config, subject, body) {
  try {
    GmailApp.sendEmail(
      config.emailTo,
      'Raindrop Briefing ERROR: ' + subject,
      body,
      { htmlBody: '<div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">' +
        '<h2 style="color: #c0392b;">Your weekly briefing failed</h2>' +
        '<p>' + body.replace(/\n/g, '<br>') + '</p>' +
        '<p style="color: #888; font-size: 12px; margin-top: 20px;">This error email was sent by your Raindrop briefing script. ' +
        'Common fixes: check your <a href="https://console.anthropic.com/settings/billing">Anthropic credit balance</a>, ' +
        'or <a href="https://app.raindrop.io/settings/integrations">regenerate your Raindrop token</a>.</p>' +
        '<div style="margin-top: 20px; padding: 12px 16px; background: #f8f8f8; border-radius: 6px; font-size: 13px; color: #555;">' +
        '<strong>Want to stop these emails entirely?</strong><br>' +
        '1. Go to <a href="https://script.google.com">script.google.com</a><br>' +
        '2. Find the project called "Raindrop Weekly Briefing"<br>' +
        '3. Click the three-dot menu (\u22EE) next to it and choose Remove<br>' +
        'That deletes everything \u2014 the script, the trigger, these emails. Done.</div>' +
        '</div>' }
    );
  } catch (e) {
    Logger.log('Could not send error email: ' + e.message);
  }
}

// —— Retry helper ——
// Retries a function up to maxRetries times with exponential backoff.
// Handles transient network errors, rate limits, and server errors.
function withRetry(fn, maxRetries) {
  maxRetries = maxRetries || 3;
  var lastError;
  for (var attempt = 0; attempt < maxRetries; attempt++) {
    try {
      var result = fn();
      // Check for rate limit or server error HTTP codes
      if (result && typeof result.getResponseCode === 'function') {
        var code = result.getResponseCode();
        if (code === 429 || code === 500 || code === 502 || code === 503) {
          lastError = 'HTTP ' + code;
          var wait = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
          Utilities.sleep(wait);
          continue;
        }
      }
      return result;
    } catch (e) {
      lastError = e.message;
      var wait = Math.pow(2, attempt) * 1000;
      Utilities.sleep(wait);
    }
  }
  throw new Error('Failed after ' + maxRetries + ' retries. Last error: ' + lastError);
}


// —— Collection Map (optional) ——
// If you use Raindrop.io collections, add them here so Claude can
// suggest where each bookmark belongs. Leave empty if you don't
// use collections — the script works fine without them.
//
// To find your collection IDs:
//   curl -H "Authorization: Bearer YOUR_TOKEN" \
//     https://api.raindrop.io/rest/v1/collections
//
// Example:
//   const COLLECTION_MAP = {
//     'Tech':    12345678,
//     'Science': 23456789,
//     'Archive': 34567890,
//   };

const COLLECTION_MAP = {};
const COLLECTION_NAMES = Object.keys(COLLECTION_MAP).join(', ');


// —— Raindrop API ——

function fetchRaindrops(token, collectionId, days, maxItems) {
  collectionId = collectionId || -1; // -1 = Unsorted
  days = days || 7;
  maxItems = maxItems || 200;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  let allItems = [];
  let page = 0;
  const perPage = 50;

  while (allItems.length < maxItems) {
    const url = 'https://api.raindrop.io/rest/v1/raindrops/' + collectionId + '?perpage=' + perPage + '&page=' + page + '&sort=-created';
    var resp = withRetry(function() {
      return UrlFetchApp.fetch(url, {
        headers: { 'Authorization': 'Bearer ' + token },
        muteHttpExceptions: true
      });
    });

    if (resp.getResponseCode() === 401 || resp.getResponseCode() === 403) {
      throw new Error('Raindrop API returned ' + resp.getResponseCode() + ' — your token is likely expired or invalid.');
    }

    if (resp.getResponseCode() !== 200) {
      Logger.log('Raindrop API error: ' + resp.getResponseCode() + ' - ' + resp.getContentText().substring(0, 200));
      break;
    }

    const items = JSON.parse(resp.getContentText()).items || [];
    if (items.length === 0) break;

    for (var i = 0; i < items.length; i++) {
      var created = new Date(items[i].created);
      if (created >= cutoff) {
        allItems.push(items[i]);
      } else {
        return allItems.slice(0, maxItems);
      }
    }

    if (items.length < perPage) break;
    page++;
  }

  return allItems.slice(0, maxItems);
}


// —— Full-text fetching ——

function fetchArticleFromCache(token, raindropId) {
  try {
    var url = 'https://api.raindrop.io/rest/v1/raindrop/' + raindropId + '/cache';
    var resp = withRetry(function() {
      return UrlFetchApp.fetch(url, {
        headers: { 'Authorization': 'Bearer ' + token },
        muteHttpExceptions: true
      });
    });

    if (resp.getResponseCode() === 200) {
      var contentType = resp.getHeaders()['Content-Type'] || '';
      if (contentType.indexOf('text/html') !== -1 || contentType.indexOf('application/xhtml') !== -1) {
        var text = stripHtml(resp.getContentText());
        if (text.length > 100) {
          return { text: text.substring(0, 8000), source: 'cache' };
        }
      }
    }
  } catch (e) {
    // Cache not available — that's fine
  }
  return { text: null, source: null };
}

function fetchArticleFromUrl(articleUrl) {
  if (!articleUrl || articleUrl.indexOf('http') !== 0) return null;

  try {
    var resp = withRetry(function() {
      return UrlFetchApp.fetch(articleUrl, {
        muteHttpExceptions: true,
        followRedirects: true,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Accept': 'text/html,application/xhtml+xml'
        }
      });
    }, 2); // Only 2 retries for direct URL fetch (many will legitimately 403/paywall)

    if (resp.getResponseCode() !== 200) return null;

    var contentType = resp.getHeaders()['Content-Type'] || '';
    if (contentType.indexOf('text/html') === -1 && contentType.indexOf('application/xhtml') === -1) return null;

    var text = stripHtml(resp.getContentText());
    if (text.length < 200) return null;

    return text.substring(0, 8000);
  } catch (e) {
    return null;
  }
}

function stripHtml(html) {
  // Remove script, style, nav, header, footer, aside, noscript
  html = html.replace(/<(script|style|nav|header|footer|aside|noscript)[^>]*>[\s\S]*?<\/\1>/gi, '');
  // Add newlines before block elements
  html = html.replace(/<(p|br|div|h[1-4]|li|tr)[^>]*>/gi, '\n');
  // Remove all remaining tags
  html = html.replace(/<[^>]+>/g, '');
  // Decode HTML entities
  html = html.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  // Collapse whitespace
  var lines = html.split('\n');
  var cleaned = [];
  for (var i = 0; i < lines.length; i++) {
    var trimmed = lines[i].replace(/^\s+|\s+$/g, '');
    if (trimmed.length > 0) cleaned.push(trimmed);
  }
  return cleaned.join('\n');
}

function fetchAllArticles(token, raindrops) {
  var fromCache = 0, fromUrl = 0, failed = 0;

  for (var i = 0; i < raindrops.length; i++) {
    var rd = raindrops[i];

    // Try Raindrop's cache first (fastest, usually has full text)
    var cached = fetchArticleFromCache(token, rd._id);
    if (cached.text) {
      rd.full_text = cached.text;
      rd.text_source = 'cache';
      fromCache++;
      continue;
    }

    // Fall back to fetching the URL directly
    var urlText = fetchArticleFromUrl(rd.link);
    if (urlText) {
      rd.full_text = urlText;
      rd.text_source = 'url';
      fromUrl++;
      continue;
    }

    rd.full_text = null;
    rd.text_source = null;
    failed++;
  }

  Logger.log('Fetched articles: ' + fromCache + ' cache, ' + fromUrl + ' URL, ' + failed + ' excerpt-only');
  return raindrops;
}


// —— Claude Analysis ——

function buildAnalysisPrompt(raindrops) {
  var itemsText = '';

  for (var i = 0; i < raindrops.length; i++) {
    var rd = raindrops[i];
    var excerpt = (rd.excerpt || '').substring(0, 500);
    var tags = (rd.tags || []).join(', ');
    var note = rd.note || '';
    var fullText = rd.full_text || '';

    var contentBlock;
    if (fullText) {
      contentBlock = 'Full article text:\n' + fullText;
    } else {
      contentBlock = 'Excerpt only (full text unavailable — paywall or JS-rendered site):\n' + excerpt;
    }

    itemsText += '\n--- ITEM ' + (i + 1) + ' ---\n' +
      'ID: ' + rd._id + '\n' +
      'Title: ' + (rd.title || 'No title') + '\n' +
      'URL: ' + (rd.link || '') + '\n' +
      'Tags: ' + tags + '\n' +
      'Note: ' + note + '\n' +
      'Saved: ' + (rd.created || '') + '\n\n' +
      contentBlock + '\n';
  }

  // ── CUSTOMIZE THIS PROMPT ──
  // Change "David" to your name, and adjust the persona description
  // to match your interests and reading habits.
  return 'You are a reading assistant. The user saves links to Raindrop.io throughout the week and you help them make sense of what they\'ve collected.\n\n' +
    'Your job: read each article and summarize what\'s there. The user saved these for a reason — your starting assumption is that their instincts are good. Your job is to surface what\'s interesting, not to gatekeep.\n\n' +
    'For EACH item, return a JSON object with these fields:\n\n' +
    '- "id": the raindrop ID (integer)\n' +
    '- "quality": 1-5 score based on the ACTUAL CONTENT (not just the headline):\n' +
    '  5 = exceptional — original thinking, important findings, beautiful writing\n' +
    '  4 = strong — well-argued, has real substance, worth the time\n' +
    '  3 = solid — useful information or decent writing, nothing wrong with it\n' +
    '  2 = thin — the headline was better than the article, or it\'s mostly filler\n' +
    '  1 = skip — broken link, content-farm SEO, or genuinely empty\n' +
    '- "quadrant": one of "print" (exceptional, worth printing — HARD CAP: max 2-3 per batch), "skim" (interesting enough to scan), "skip" (summary captures the gist)\n' +
    (COLLECTION_NAMES ? '- "collection": suggested collection from [' + COLLECTION_NAMES + ']\n' : '') +
    '- "verdict": one line, honest and specific.\n' +
    '- "summary": DYNAMIC LENGTH based on quality:\n' +
    '  Quality 5: 5-8 sentences. Quality 4: 3-5 sentences. Quality 3: 2-3 sentences.\n' +
    '  Quality 2: One sentence. Quality 1: One short line.\n\n' +
    'CRITICAL RULE FOR PAYWALLED/EXCERPT-ONLY ARTICLES: If you only have an excerpt, you CANNOT judge quality. Set quality to 0, quadrant to "unsummarized", and note this in your verdict.\n\n' +
    'Return ONLY a JSON array of objects, no markdown formatting.\n\n' +
    itemsText;
}

function analyzeWithClaude(raindrops, config, batchSize) {
  batchSize = batchSize || 10;
  var allResults = [];
  var errors = [];

  // Determine which model to use. Try the primary model first;
  // if it returns a model-not-found error, walk the fallback chain.
  var workingModel = null;

  for (var i = 0; i < raindrops.length; i += batchSize) {
    var batch = raindrops.slice(i, i + batchSize);
    var prompt = buildAnalysisPrompt(batch);
    var batchNum = Math.floor(i / batchSize) + 1;
    var success = false;

    // Try each model in the fallback chain until one works
    var modelsToTry = workingModel ? [workingModel] : config.modelFallbacks;

    for (var m = 0; m < modelsToTry.length; m++) {
      var modelName = modelsToTry[m];

      var resp;
      try {
        resp = withRetry(function() {
          return UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
            method: 'post',
            headers: {
              'x-api-key': config.anthropicKey,
              'anthropic-version': '2023-06-01',
              'Content-Type': 'application/json'
            },
            payload: JSON.stringify({
              model: modelName,
              max_tokens: 8192,
              messages: [{ role: 'user', content: prompt }]
            }),
            muteHttpExceptions: true
          });
        });
      } catch (e) {
        errors.push('Batch ' + batchNum + ': network error after retries - ' + e.message);
        continue;
      }

      var code = resp.getResponseCode();

      // Model not found — try next in fallback chain
      if (code === 404 || (code === 400 && resp.getContentText().indexOf('model') !== -1)) {
        Logger.log('Model "' + modelName + '" not available, trying next fallback...');
        continue;
      }

      // Auth error — API key is wrong or credits exhausted. No point retrying.
      if (code === 401) {
        errors.push('Batch ' + batchNum + ': API key invalid (401). Check your Anthropic API key.');
        break;
      }
      if (code === 402 || (code === 400 && resp.getContentText().indexOf('credit') !== -1)) {
        errors.push('Batch ' + batchNum + ': Anthropic credits exhausted. Add funds at console.anthropic.com.');
        break;
      }

      // Other non-200 error
      if (code !== 200) {
        errors.push('Batch ' + batchNum + ': Claude API error ' + code + ' - ' + resp.getContentText().substring(0, 200));
        break;
      }

      // Success! Remember which model worked.
      workingModel = modelName;
      if (modelName !== config.model) {
        Logger.log('NOTE: Primary model unavailable. Using fallback: ' + modelName);
      }

      var content = JSON.parse(resp.getContentText()).content[0].text;
      var results = extractJson(content);

      if (results) {
        allResults = allResults.concat(results);
      } else {
        errors.push('Batch ' + batchNum + ': Claude responded but output was not valid JSON.');
      }

      success = true;
      break; // Don't try more models — this one worked
    }

    if (!success && errors.length === 0) {
      errors.push('Batch ' + batchNum + ': All model fallbacks failed. Anthropic may have changed their model names.');
    }

    Logger.log('Analyzed ' + Math.min(i + batchSize, raindrops.length) + '/' + raindrops.length + ' bookmarks');
  }

  // Store errors so sendWeeklyBriefing can report them
  config._errors = errors;
  return allResults;
}

function extractJson(text) {
  text = text.replace(/^\s+|\s+$/g, '');

  // Strategy 1: Direct parse
  try { return JSON.parse(text); } catch (e) {}

  // Strategy 2: Strip markdown code fences
  var fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1].replace(/^\s+|\s+$/g, '')); } catch (e) {}
  }

  // Strategy 3: Find JSON array
  var arrayMatch = text.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try { return JSON.parse(arrayMatch[0]); } catch (e) {}
  }

  return null;
}


// —— Email Building ——

function buildEmailHtml(analyses, totalCount, weekLabel, errors) {
  // Map legacy 'read' tier to 'skim'
  for (var i = 0; i < analyses.length; i++) {
    if (analyses[i].quadrant === 'read') analyses[i].quadrant = 'skim';
  }

  // Bucket-sort for reliable tier ordering (Rhino-safe — no unstable Array.sort)
  var sorted = [];
  var tiers = ['print', 'skim', 'skip', 'unsummarized'];
  for (var t = 0; t < tiers.length; t++) {
    var bucket = [];
    for (var j = 0; j < analyses.length; j++) {
      if (analyses[j].quadrant === tiers[t]) bucket.push(analyses[j]);
    }
    bucket.sort(function(a, b) { return (b.quality || 0) - (a.quality || 0); });
    sorted = sorted.concat(bucket);
  }
  // Catch any with unknown quadrant
  for (var k = 0; k < analyses.length; k++) {
    if (tiers.indexOf(analyses[k].quadrant) === -1) sorted.push(analyses[k]);
  }
  analyses = sorted;

  // Count items per tier
  var qCounts = {};
  for (var c = 0; c < analyses.length; c++) {
    var q = analyses[c].quadrant || 'unknown';
    qCounts[q] = (qCounts[q] || 0) + 1;
  }

  var quadrantLabels = {
    'print': ['Worth Printing', '#2d7d46'],
    'skim': ['Worth Skimming', '#b8860b'],
    'skip': ['Summary Only', '#c0392b'],
    'unsummarized': ['Could Not Summarize', '#aaa']
  };

  var itemsHtml = '';
  var currentQuadrant = null;

  for (var m = 0; m < analyses.length; m++) {
    var a = analyses[m];
    var tier = a.quadrant || 'unknown';

    // Section header when tier changes
    if (tier !== currentQuadrant) {
      currentQuadrant = tier;
      var labelInfo = quadrantLabels[tier] || [tier, '#333'];
      var label = labelInfo[0];
      var color = labelInfo[1];
      itemsHtml += '<tr><td colspan="2" style="padding: 20px 0 8px 0; border-bottom: 2px solid ' + color + ';">' +
        '<span style="font-size: 18px; font-weight: bold; color: ' + color + '; text-transform: uppercase; letter-spacing: 1px;">' + label + '</span>' +
        '</td></tr>';
    }

    var quality = a.quality || 0;
    var title = a.title || 'Untitled';
    var url = a.url || '#';
    var verdict = a.verdict || '';
    var summary = a.summary || '';
    var collection = a.collection || '';

    // If title looks like a raw URL, extract a readable slug
    if (title.indexOf('http') === 0) {
      var parts = title.replace(/[?#].*/, '').split('/');
      var filtered = [];
      for (var p = 0; p < parts.length; p++) {
        if (parts[p].length > 0) filtered.push(parts[p]);
      }
      var slug = filtered[filtered.length - 1] || '';
      if (slug) {
        slug = slug.replace(/[-_]/g, ' ').replace(/\.html?$/, '');
        title = slug.charAt(0).toUpperCase() + slug.slice(1);
      }
    }

    var isUnsummarized = quality === 0;
    var titleColor = isUnsummarized ? '#aaa' : '#1a1a1a';
    var textColor = isUnsummarized ? '#bbb' : '#444';
    var verdictColor = isUnsummarized ? '#bbb' : '#666';

    itemsHtml += '<tr><td style="padding: 16px 0; border-bottom: 1px solid #eee;" colspan="2">' +
      '<div style="margin-bottom: 6px;">' +
      '<a href="' + url + '" style="color: ' + titleColor + '; text-decoration: none; font-weight: 600; font-size: 15px;">' + title + '</a>' +
      '</div>' +
      '<div style="color: ' + textColor + '; font-size: 14px; line-height: 1.6; margin: 6px 0;">' + summary + '</div>' +
      (verdict ? '<div style="margin-top: 8px;"><span style="color: ' + verdictColor + '; font-style: italic; font-size: 13px;">' + verdict + '</span></div>' : '') +
      (collection ? '<div style="margin-top: 6px;"><span style="background: #f0f0f0; color: #888; font-size: 11px; padding: 2px 8px; border-radius: 3px;">' + collection + '</span></div>' : '') +
      '</td></tr>';
  }

  var unsummarizedCount = qCounts['unsummarized'] || 0;
  var unsummarizedNote = unsummarizedCount ? ' <span style="color: #aaa;">' + unsummarizedCount + ' unsummarized</span>' : '';

  return '<!DOCTYPE html>\n' +
    '<html>\n<head><meta charset="utf-8"></head>\n' +
    '<body style="font-family: -apple-system, BlinkMacSystemFont, \'Segoe UI\', Roboto, sans-serif; max-width: 640px; margin: 0 auto; padding: 20px; color: #1a1a1a; background: #fff;">\n' +
    '<div style="border-bottom: 3px solid #1a1a1a; padding-bottom: 12px; margin-bottom: 20px;">\n' +
    '<h1 style="margin: 0; font-size: 22px; font-weight: 700;">Your Week in Bookmarks</h1>\n' +
    '<p style="margin: 4px 0 0 0; color: #666; font-size: 14px;">' + weekLabel + ' &middot; ' + totalCount + ' bookmarks analyzed</p>\n' +
    '</div>\n' +
    '<div style="background: #f8f8f8; border-radius: 6px; padding: 14px 18px; margin-bottom: 24px; font-size: 14px; line-height: 1.6;">' +
    '<strong style="color: #2d7d46;">' + (qCounts['print'] || 0) + '</strong> worth printing &nbsp; ' +
    '<strong style="color: #b8860b;">' + (qCounts['skim'] || 0) + '</strong> worth skimming &nbsp; ' +
    '<strong style="color: #c0392b;">' + (qCounts['skip'] || 0) + '</strong> summary only' + unsummarizedNote +
    '</div>\n' +
    '<table cellpadding="0" cellspacing="0" style="width: 100%;">' + itemsHtml + '</table>\n' +
    // Show partial errors if some batches failed but others succeeded
    (errors && errors.length > 0
      ? '<div style="margin-top: 20px; padding: 12px 16px; background: #fff8f0; border-left: 3px solid #e67e22; font-size: 13px; color: #666;">' +
        '<strong style="color: #e67e22;">Note:</strong> Some articles could not be analyzed. ' + errors.length + ' error(s) occurred:<br>' +
        '<span style="font-size: 12px; color: #999;">' + errors.join('<br>') + '</span></div>\n'
      : '') +
    '<div style="margin-top: 30px; padding-top: 16px; border-top: 1px solid #ddd; color: #999; font-size: 12px;">' +
    'Generated by Your Week in Bookmarks &middot; Powered by Claude</div>\n' +
    '<div style="margin-top: 12px; color: #bbb; font-size: 11px;">' +
    '<a href="https://script.google.com" style="color: #bbb;">Unsubscribe</a> — ' +
    'go to script.google.com, find this project, click the \u22EE menu, and choose Remove.</div>\n' +
    '</body>\n</html>';
}


// —— Main Function ——

function sendWeeklyBriefing() {
  var config = getConfig();
  var props = PropertiesService.getScriptProperties();

  if (!config.raindropToken || config.raindropToken === 'YOUR_RAINDROP_TOKEN') {
    Logger.log('ERROR: Run setApiKeys() first to configure your API keys.');
    return;
  }

  // —— Circuit breaker ——
  // After 3 consecutive failures, stop sending error emails and disable the trigger.
  // This prevents your inbox from filling up with error emails if something is
  // persistently broken (expired token, depleted credits, etc).
  // To re-enable after fixing the issue: run setupWeeklyTrigger() again.
  var consecutiveFailures = parseInt(props.getProperty('CONSECUTIVE_FAILURES') || '0', 10);
  var MAX_FAILURES = 3;

  if (consecutiveFailures >= MAX_FAILURES) {
    Logger.log('Circuit breaker OPEN: ' + consecutiveFailures + ' consecutive failures. Removing trigger to stop retrying.');
    Logger.log('Fix the underlying issue, then run setupWeeklyTrigger() to re-enable.');
    // Remove the trigger so it stops running
    var triggers = ScriptApp.getProjectTriggers();
    for (var t = 0; t < triggers.length; t++) {
      if (triggers[t].getHandlerFunction() === 'sendWeeklyBriefing') {
        ScriptApp.deleteTrigger(triggers[t]);
      }
    }
    return;
  }

  try {
    // Fetch recent bookmarks
    Logger.log('Fetching raindrops...');
    var raindrops;
    try {
      raindrops = fetchRaindrops(config.raindropToken, -1, 7, 200);
    } catch (e) {
      throw new Error('Failed to fetch bookmarks from Raindrop.io: ' + e.message +
        '\n\nThis usually means your Raindrop API token has expired. ' +
        'Create a new one at https://app.raindrop.io/settings/integrations');
    }

    if (raindrops.length === 0) {
      Logger.log('No bookmarks found this week.');
      GmailApp.sendEmail(config.emailTo,
        'Your Week in Bookmarks: Nothing new',
        'No new bookmarks this week.',
        { htmlBody: '<p>No new bookmarks saved this week. Either you saved nothing or the Raindrop token expired.</p>' }
      );
      // Not a failure — reset counter
      props.setProperty('CONSECUTIVE_FAILURES', '0');
      return;
    }

    Logger.log('Found ' + raindrops.length + ' bookmarks.');

    // Fetch full article text
    Logger.log('Fetching article content...');
    fetchAllArticles(config.raindropToken, raindrops);

    // Analyze with Claude
    Logger.log('Analyzing with Claude...');
    var analyses = analyzeWithClaude(raindrops, config);

    // If ALL analyses failed, don't send an empty digest — send an error email instead
    if (!analyses || analyses.length === 0) {
      var errorDetail = (config._errors && config._errors.length > 0)
        ? config._errors.join('\n')
        : 'Unknown error — Claude returned no results.';
      throw new Error('Claude analysis returned no results.\n\n' + errorDetail);
    }

    // Enrich with original data (titles, URLs)
    var rdMap = {};
    for (var i = 0; i < raindrops.length; i++) {
      rdMap[raindrops[i]._id] = raindrops[i];
    }
    for (var j = 0; j < analyses.length; j++) {
      var rd = rdMap[analyses[j].id];
      if (rd) {
        analyses[j].title = analyses[j].title || rd.title || 'Untitled';
        analyses[j].url = analyses[j].url || rd.link || '';
      }
    }

    // Build and send email
    var weekLabel = 'Week of ' + new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    var subject = 'Your Week in Bookmarks';
    var html = buildEmailHtml(analyses, analyses.length, weekLabel, config._errors);

    GmailApp.sendEmail(config.emailTo, subject, 'See HTML version', { htmlBody: html });
    Logger.log('Email sent to ' + config.emailTo + '. ' + analyses.length + ' bookmarks analyzed.');

    // Gmail sometimes skips inbox for self-sent emails — force it
    Utilities.sleep(2000);
    var sent = GmailApp.search('subject:"Your Week in Bookmarks" newer_than:1d from:me to:me', 0, 1);
    if (sent.length > 0) sent[0].moveToInbox();

    // Success — reset failure counter
    props.setProperty('CONSECUTIVE_FAILURES', '0');

  } catch (e) {
    // Increment failure counter
    consecutiveFailures++;
    props.setProperty('CONSECUTIVE_FAILURES', String(consecutiveFailures));

    Logger.log('FATAL ERROR: ' + e.message);

    // Send error email (but only if we haven't hit the circuit breaker)
    if (consecutiveFailures < MAX_FAILURES) {
      sendErrorEmail(config, 'Script failed (' + consecutiveFailures + '/' + MAX_FAILURES + ' before auto-disable)',
        e.message + '\n\nThis is failure ' + consecutiveFailures + ' of ' + MAX_FAILURES + '. ' +
        'If the script fails ' + MAX_FAILURES + ' times in a row, it will automatically disable itself ' +
        'to stop sending you error emails.\n\n' +
        'To re-enable after fixing the issue: open the script and run setupWeeklyTrigger().');
    } else {
      // Final failure — send one last email saying it's disabling itself
      sendErrorEmail(config, 'Script has disabled itself after ' + MAX_FAILURES + ' consecutive failures',
        e.message + '\n\n' +
        'The weekly briefing has been automatically disabled to stop filling your inbox with error emails.\n\n' +
        'To fix and re-enable:\n' +
        '1. Open the script at script.google.com\n' +
        '2. Fix the issue (check API keys, credits, etc.)\n' +
        '3. Run setupWeeklyTrigger() to re-enable the weekly schedule.');
    }
  }
}


// —— Trigger Management ——

function setupWeeklyTrigger() {
  // Remove any existing triggers for this function
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'sendWeeklyBriefing') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }

  // Reset the circuit breaker so the script can run again
  PropertiesService.getScriptProperties().setProperty('CONSECUTIVE_FAILURES', '0');

  // Create new weekly trigger: every Sunday, 8-9 AM
  ScriptApp.newTrigger('sendWeeklyBriefing')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.SUNDAY)
    .atHour(8)
    .create();

  Logger.log('Weekly trigger set: every Sunday, 8-9 AM. Failure counter reset.');
}

function removeWeeklyTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'sendWeeklyBriefing') {
      ScriptApp.deleteTrigger(triggers[i]);
      Logger.log('Trigger removed.');
    }
  }
}
