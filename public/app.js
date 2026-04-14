// DiscoverHermes frontend — vanilla JS, no build step.
//
// Page-aware: checks <body data-page="..."> and runs only the code for
// whichever page is loaded (feed, detail, stats, submit).

(function () {
  // Anti-bot: bots that POST without loading the page have no JS-set token.
  // Initialize immediately so early human clicks work; upgrade after delay
  // so the token is harder to predict for scrapers that do run minimal JS.
  window._likeToken = '1';
  setTimeout(() => { window._likeToken = Date.now().toString(36); }, 1500);

  // ---------- utilities shared across pages ----------

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[c]);
  }

  function fmtDate(d) {
    if (!d) return '';
    const dt = new Date(d);
    if (isNaN(dt)) return d;
    return dt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  }

  function fmtNumber(n) {
    if (n == null || Number.isNaN(Number(n))) return '—';
    n = Number(n);
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(n < 10_000 ? 1 : 0) + 'k';
    return String(n);
  }

  // Turn kebab-case enum values ("fully-autonomous", "under-10") into the
  // human-readable label we show in the UI ("Fully autonomous", "<$10/mo").
  // Small lookup table for the cases where mechanical humanization isn't
  // pretty enough.
  const ENUM_LABELS = {
    'fully-autonomous': 'Fully autonomous',
    'human-in-loop':    'Human in the loop',
    'on-demand-only':   'On demand only',
    'small':            'Small (≤32k)',
    'medium':           'Medium (32–128k)',
    'large':            'Large (128k–1M)',
    'massive':          'Massive (1M+)',
    'free':             'Free',
    'under-10':         '< $10 / mo',
    '10-50':            '$10–50 / mo',
    '50-200':           '$50–200 / mo',
    '200-plus':         '$200+ / mo',
    'high':             'High',
    'medium-reliability': 'Medium',
    'low':              'Low',
    'wip':              'Work in progress',
    'fully-open':       'Fully open source',
    'partial-gist':     'Partial / gist',
    'prompt-only':      'Prompt only',
    'closed':           'Closed',
    'under-an-hour':    'Under an hour',
    'few-hours':        'A few hours',
    'weekend':          'A weekend',
    'week-plus':        'A week or more',
    'ongoing':          'Ongoing',
    'beginner':         'Beginner',
    'intermediate':     'Intermediate',
    'advanced':         'Advanced',
    'expert':           'Expert',
  };
  function humanize(val) {
    if (!val) return '';
    if (ENUM_LABELS[val]) return ENUM_LABELS[val];
    return String(val)
      .replace(/[-_]+/g, ' ')
      .replace(/^./, (c) => c.toUpperCase());
  }

  // ---------- copy-to-clipboard (all pages) ----------
  document.querySelectorAll('.copy-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      let text = btn.dataset.copyText;
      if (!text && btn.dataset.copyTarget) {
        const target = document.getElementById(btn.dataset.copyTarget);
        if (target) text = target.innerText;
      }
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        const original = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => (btn.textContent = original), 1500);
      } catch {
        btn.textContent = 'Press Ctrl+C';
      }
    });
  });

  // ---------- headline stats band (feed + stats page) ----------
  async function loadHeadline() {
    const el = document.getElementById('headline');
    if (!el) return null;
    try {
      const res = await fetch('/api/stats');
      const data = await res.json();
      el.querySelectorAll('[data-stat]').forEach((node) => {
        const key = node.dataset.stat;
        node.textContent = fmtNumber(data.totals[key]);
      });
      // Make top AI score and most liked stats link to those agents
      [['top_ai_score', 'top_ai_score_id'], ['top_likes', 'top_likes_id']].forEach(([stat, idKey]) => {
        const agentId = data.totals[idKey];
        if (!agentId) return;
        const node = el.querySelector('[data-stat="' + stat + '"]');
        if (!node) return;
        const wrapper = node.closest('.headline-stat');
        if (wrapper && !wrapper.dataset.linked) {
          wrapper.dataset.linked = '1';
          wrapper.style.cursor = 'pointer';
          wrapper.addEventListener('click', () => {
            location.href = '/use-cases/' + agentId;
          });
        }
      });
      return data;
    } catch {
      return null;
    }
  }

  // ---------- likes & dislikes: shared voted-id sets across pages ----------
  const LIKED_KEY = 'dh_liked_ids_v1';
  const DISLIKED_KEY = 'dh_disliked_ids_v1';
  const likedSet = new Set(JSON.parse(localStorage.getItem(LIKED_KEY) || '[]'));
  const dislikedSet = new Set(JSON.parse(localStorage.getItem(DISLIKED_KEY) || '[]'));
  const saveLiked = () => localStorage.setItem(LIKED_KEY, JSON.stringify([...likedSet]));
  const saveDisliked = () => localStorage.setItem(DISLIKED_KEY, JSON.stringify([...dislikedSet]));

  async function toggleLike(id, btn) {
    const wasLiked = likedSet.has(id);
    const countEl = btn.querySelector('.count');
    const current = Number(countEl.textContent) || 0;

    // If currently disliked, undo dislike first
    if (dislikedSet.has(id)) {
      dislikedSet.delete(id);
      saveDisliked();
      const disBtn = btn.closest('.vote-group')?.querySelector('.dislike-btn');
      if (disBtn) {
        disBtn.classList.remove('disliked');
        disBtn.setAttribute('aria-pressed', 'false');
        const disCt = disBtn.querySelector('.count');
        if (disCt) disCt.textContent = Math.max(0, (Number(disCt.textContent) || 0) - 1);
      }
      fetch(`/api/submissions/${id}/dislike`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ undislike: true, _t: window._likeToken }),
      }).catch(() => {});
    }

    if (wasLiked) {
      likedSet.delete(id);
      btn.classList.remove('liked');
      btn.setAttribute('aria-pressed', 'false');
      countEl.textContent = Math.max(0, current - 1);
    } else {
      likedSet.add(id);
      btn.classList.add('liked');
      btn.setAttribute('aria-pressed', 'true');
      countEl.textContent = current + 1;
      btn.classList.add('like-burst');
      btn.addEventListener('animationend', () => btn.classList.remove('like-burst'), { once: true });
    }
    saveLiked();

    try {
      const res = await fetch(`/api/submissions/${id}/like`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ unlike: wasLiked, _t: window._likeToken }),
      });
      if (res.ok) {
        const data = await res.json();
        countEl.textContent = data.likes;
      }
    } catch {
      /* optimistic UI is fine */
    }
  }

  async function toggleDislike(id, btn) {
    const wasDisliked = dislikedSet.has(id);
    const countEl = btn.querySelector('.count');
    const current = Number(countEl.textContent) || 0;

    // If currently liked, undo like first
    if (likedSet.has(id)) {
      likedSet.delete(id);
      saveLiked();
      const likeBtn = btn.closest('.vote-group')?.querySelector('.like-btn');
      if (likeBtn) {
        likeBtn.classList.remove('liked');
        likeBtn.setAttribute('aria-pressed', 'false');
        const likeCt = likeBtn.querySelector('.count');
        if (likeCt) likeCt.textContent = Math.max(0, (Number(likeCt.textContent) || 0) - 1);
      }
      fetch(`/api/submissions/${id}/like`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ unlike: true, _t: window._likeToken }),
      }).catch(() => {});
    }

    if (wasDisliked) {
      dislikedSet.delete(id);
      btn.classList.remove('disliked');
      btn.setAttribute('aria-pressed', 'false');
      countEl.textContent = Math.max(0, current - 1);
    } else {
      dislikedSet.add(id);
      btn.classList.add('disliked');
      btn.setAttribute('aria-pressed', 'true');
      countEl.textContent = current + 1;
    }
    saveDisliked();

    try {
      const res = await fetch(`/api/submissions/${id}/dislike`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ undislike: wasDisliked, _t: window._likeToken }),
      });
      if (res.ok) {
        const data = await res.json();
        countEl.textContent = data.dislikes;
      }
    } catch {
      /* optimistic UI is fine */
    }
  }

  function likeBtnHtml(item) {
    const liked = likedSet.has(item.id);
    const disliked = dislikedSet.has(item.id);
    return `
      <span class="vote-group">
        <button class="like-btn ${liked ? 'liked' : ''}" data-id="${item.id}"
                aria-pressed="${liked}">
          <span class="heart"></span>
          <span class="count">${item.likes}</span>
        </button>
        <button class="dislike-btn ${disliked ? 'disliked' : ''}" data-id="${item.id}"
                aria-pressed="${disliked}" title="Flag as low quality or fake">
          <span class="thumb-down"></span>
          <span class="count">${item.dislikes || 0}</span>
        </button>
      </span>`;
  }

  // ---------- rendering: shared card pieces ----------

  function mediaBlock(item) {
    if (item.video_url) {
      return `
        <div class="card-media">
          <video src="${escapeHtml(item.video_url)}"
                 controls preload="metadata" playsinline muted></video>
        </div>`;
    }
    if (item.image_url) {
      // If the image fails to load (404, CORS, etc.) swap to the branded
      // placeholder instead of a blank box. Embed the placeholder HTML as
      // a data attr so the onerror handler can use it directly.
      const ph = placeholderHtml(item);
      // Collect all images for hover cycling (primary + gallery)
      const gallery = Array.isArray(item.gallery) ? item.gallery : [];
      const allImgs = [item.image_url, ...gallery];
      const galleryAttr = allImgs.length > 1
        ? ` data-gallery="${escapeHtml(JSON.stringify(allImgs))}"` : '';
      return `
        <div class="card-media"${galleryAttr}>
          <img src="${escapeHtml(item.image_url)}" alt=""
               loading="lazy" referrerpolicy="no-referrer"
               onerror="this.parentElement.outerHTML=this.dataset.fallback"
               data-fallback="${escapeHtml(ph)}" />
        </div>`;
    }
    return placeholderHtml(item);
  }

  // Branded media fallback — used when a submission has no image_url (or the
  // uploaded one 404s). Shows the agent's title initials over a hue-stable
  // gradient derived from the title, so every card looks designed even when
  // the author didn't provide a screenshot.
  function placeholderHtml(item) {
    const initials = ((item.title || '?')
      .replace(/[^A-Za-z0-9 ]/g, '')
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0])
      .join('')
      .toUpperCase()) || '◆';
    let h = 0;
    for (let i = 0; i < (item.title || '').length; i++) {
      h = (h * 31 + (item.title || '').charCodeAt(i)) >>> 0;
    }
    const hue = h % 360;
    return `<div class="card-media placeholder" style="--ph-hue:${hue}"><span class="placeholder-initials">${escapeHtml(initials)}</span></div>`;
  }

  function handleBlock(item) {
    const name = item.display_name || (item.twitter_handle ? '@' + item.twitter_handle : 'anonymous');
    if (item.twitter_handle) {
      return `<a class="handle" href="https://x.com/${escapeHtml(item.twitter_handle)}"
                 target="_blank" rel="noopener">${escapeHtml(name)}</a>`;
    }
    return `<span class="handle">${escapeHtml(name)}</span>`;
  }

  function verifiedBadge(item) {
    return item.verified ? `<span class="verified-badge">Verified</span>` : '';
  }

  function chipRow(item) {
    // Prioritize chips that tell the agent's story: category, key integration,
    // model, then impact metric.  Generic taxonomy (deployment, trigger) is
    // less interesting for discovery browsing.
    const chips = [];
    // Show framework chip for non-Hermes agents (Hermes is default, no badge needed)
    if (item.agent_framework && item.agent_framework.toLowerCase() !== 'hermes') {
      chips.push(['framework', item.agent_framework]);
    }
    if (item.category) chips.push(['category', item.category]);
    if (Array.isArray(item.integrations) && item.integrations[0]) {
      chips.push(['integration', item.integrations[0]]);
    }
    if (item.model) chips.push(['model', item.model]);
    else if (item.platform) chips.push(['platform', item.platform]);
    if (item.time_saved_per_week) chips.push(['hours', `${item.time_saved_per_week}h/wk saved`]);
    else if (item.runs_completed) chips.push(['runs', `${fmtNum(item.runs_completed)} agent sessions`]);
    if (item.deployment) chips.push(['deployment', item.deployment]);
    return chips
      .slice(0, 4)
      .map(([k, v]) => `<span class="chip chip-${k}">${escapeHtml(v)}</span>`)
      .join('');
  }

  // Compact number formatter: 1200 → "1.2k", 1500000 → "1.5M"
  function fmtNum(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(n);
  }

  // ==========================================================
  // FEED PAGE
  // ==========================================================
  function initFeed() {
    const feedEl = document.getElementById('feed');
    if (!feedEl) return;

    // Read any deep-link filters from the URL on first load, e.g. a visitor
    // clicked a "Pinecone" chip on a detail page and landed on /?integration=Pinecone.
    const initialParams = new URLSearchParams(location.search);
    const PAGE_SIZE = 24;
    let feedViewMode = 'grid';
    const state = {
      sort:        'trending',
      category:    '',
      q:           '',
      verified:    false,
      integration: initialParams.get('integration') || '',
      tool:        initialParams.get('tool') || '',
      framework:   initialParams.get('framework') || '',
      offset:      0,
      allLoaded:   false,
      loading:     false,
    };
    let debounceTimer = null;

    // A submission is "new" if it was approved in the last 48 hours.
    // That treatment (gradient border + pulse + badge) gives the feed a
    // little bit of gamification when a fresh agent shows up.
    const NEW_WINDOW_MS = 48 * 60 * 60 * 1000;
    function isNew(item) {
      const ts = Date.parse(item.created_at || '');
      return Number.isFinite(ts) && Date.now() - ts < NEW_WINDOW_MS;
    }

    // Achievement badges — percentile-based, earned from real standing
    // _likePct / _aiPct are set by loadFeed before rendering (0–100, lower = better)
    function achievementBadges(item) {
      const badges = [];
      // Likes: top 1% → Legend, top 10% → Fan Favorite
      if (item._likePct != null && item._likePct <= 1) badges.push('<span class="achiev achiev-legendary" title="Top 1% most liked">👑 Legend</span>');
      else if (item._likePct != null && item._likePct <= 10) badges.push('<span class="achiev" title="Top 10% most liked">❤️ Fan Favorite</span>');
      // AI score: top 1% → Apex, top 10% → Elite
      if (item._aiPct != null && item._aiPct <= 1) badges.push('<span class="achiev achiev-legendary" title="Top 1% AI score">💎 Apex Agent</span>');
      else if (item._aiPct != null && item._aiPct <= 10) badges.push('<span class="achiev" title="Top 10% AI score">✨ Elite</span>');
      // Absolute metrics (still valuable signals)
      if (item.time_saved_per_week >= 10) badges.push('<span class="achiev" title="Saves 10+ hours/week">⚡ Time Saver</span>');
      if (item.runs_completed >= 500) badges.push('<span class="achiev" title="500+ agent sessions completed">🏆 Powerhouse</span>');
      if (item.cron_jobs >= 5) badges.push('<span class="achiev" title="5+ cron jobs running">⏰ Cron King</span>');
      if (item.tokens_total >= 1000000) badges.push('<span class="achiev" title="1M+ total tokens processed">🧠 Token Titan</span>');
      if (item.approx_monthly_tokens >= 1000000) badges.push('<span class="achiev" title="1M+ tokens/month">🧠 Token Beast</span>');
      return badges.slice(0, 2).join('');
    }

    function cardHtml(item, extraClass = '') {
      const fresh = isNew(item);
      const cls = ['card'];
      if (fresh) cls.push('is-new');
      if (extraClass) cls.push(extraClass);
      // Top-left badge: rank medal > new > trending (only one shown)
      let badge = '';
      if (item._rank && item._rank <= 3) {
        const medals = ['🥇', '🥈', '🥉'];
        badge = `<span class="rank-medal">${medals[item._rank - 1]}</span>`;
      } else if (fresh) {
        badge = `<span class="new-badge">New</span>`;
      } else if (extraClass.includes('is-trending')) {
        badge = `<span class="trending-badge">🔥 Trending</span>`;
      }
      // Gallery indicator — show image count if agent has multiple images
      const gallery = Array.isArray(item.gallery) ? item.gallery : [];
      const galleryCount = (item.image_url ? 1 : 0) + gallery.length;
      const galleryBadge = galleryCount > 1
        ? `<span class="gallery-badge" title="${galleryCount} images">📷 ${galleryCount}</span>` : '';
      // AI score pill — shown in footer next to likes for clean comparison
      const scoreDisplay = item.ai_score != null 
        ? (Number.isInteger(item.ai_score) ? item.ai_score : item.ai_score.toFixed(1))
        : null;
      const aiScorePill = item.ai_score
        ? `<span class="card-ai-score" title="AI Score: ${scoreDisplay}/100"><span class="card-ai-num">${scoreDisplay}</span> AI Score</span>`
        : (item.ai_score_pending ? `<span class="card-ai-score card-ai-pending">Pending AI Score</span>` : '');
      const achievs = achievementBadges(item);
      return `
        <div class="${cls.join(' ')}" data-href="/use-cases/${item.id}" data-id="${item.id}">
          ${badge}${galleryBadge}
          ${mediaBlock(item)}
          <div class="card-body">
            <h3 class="card-title">${escapeHtml(item.title)}</h3>
            <p class="card-pitch">${escapeHtml(item.pitch || item.description || '')}</p>
            ${achievs ? `<div class="achiev-row">${achievs}</div>` : ''}
            <div class="chip-row">${chipRow(item)}</div>
            <div class="card-foot">
              <span class="card-author">${handleBlock(item)}${verifiedBadge(item)}</span>
              <div class="card-foot-scores">
                ${aiScorePill}
                ${likeBtnHtml(item)}
              </div>
            </div>
          </div>
        </div>`;
    }

    function feedListRow(item) {
      const scoreDisplay = item.ai_score != null
        ? (Number.isInteger(item.ai_score) ? item.ai_score : item.ai_score.toFixed(1))
        : null;
      const aiPill = scoreDisplay
        ? `<span class="card-ai-score"><span class="card-ai-num">${scoreDisplay}</span> AI</span>`
        : '';
      const img = item.image_url
        ? `<img class="feed-row-img" src="${escapeHtml(item.image_url)}" alt="" />`
        : `<div class="feed-row-img feed-row-placeholder">◆</div>`;
      const author = escapeHtml(item.twitter_handle ? '@' + item.twitter_handle : item.display_name || '');
      return `
        <div class="feed-row" data-href="/use-cases/${item.id}" data-id="${item.id}">
          ${img}
          <div class="feed-row-body">
            <span class="feed-row-title">${escapeHtml(item.title)}</span>
            <span class="feed-row-author">${author}</span>
          </div>
          <div class="feed-row-scores">
            ${aiPill}
            ${likeBtnHtml(item)}
          </div>
        </div>`;
    }

    // Shows a dismissible pill when the feed is pre-filtered via a chip
    // deep-link (e.g. ?integration=Pinecone), so the visitor can tell why
    // they're only seeing a subset and can clear it with one click.
    function renderFilterBanner() {
      const banner = document.getElementById('active-filter-banner');
      if (!banner) return;
      const activeKey = state.integration ? 'integration' : (state.tool ? 'tool' : null);
      const activeVal = state.integration || state.tool;
      if (!activeKey) {
        banner.innerHTML = '';
        banner.hidden = true;
        return;
      }
      const label = activeKey === 'integration' ? 'integration' : 'tool';
      banner.hidden = false;
      banner.innerHTML = `
        <span class="active-filter-text">Showing agents that use
          <strong>${escapeHtml(activeVal)}</strong>
          <span class="active-filter-kind">(${label})</span>
        </span>
        <button class="active-filter-clear" type="button" aria-label="Clear filter">✕ Clear</button>`;
    }

    async function loadFeed() {
      state.offset = 0;
      state.allLoaded = false;
      await fetchFeedPage();
    }

    async function fetchFeedPage() {
      if (state.loading || state.allLoaded) return;
      const isFirstPage = state.offset === 0;
      state.loading = true;

      if (isFirstPage) {
        // Skeleton loading cards — shimmer while the API responds
        feedEl.classList.remove('feed-loaded');
        // Re-sync view mode class before rendering skeletons
        if (feedViewMode === 'list') {
          feedEl.classList.add('feed-list');
        } else {
          feedEl.classList.remove('feed-list');
        }
        if (feedViewMode === 'list') {
          feedEl.innerHTML = Array.from({ length: 8 }, () =>
            `<div class="feed-row skeleton"><div class="feed-row-img feed-row-placeholder skeleton-shimmer"></div><div class="feed-row-body"><div class="skeleton-line" style="width:60%"></div><div class="skeleton-line short" style="width:30%"></div></div></div>`
          ).join('');
        } else {
          feedEl.innerHTML = Array.from({ length: 6 }, () => `
            <div class="card skeleton">
              <div class="card-media skeleton-shimmer"></div>
              <div class="card-body">
                <div class="skeleton-line" style="width:80%"></div>
                <div class="skeleton-line" style="width:60%"></div>
                <div class="skeleton-line short" style="width:40%"></div>
              </div>
            </div>`).join('');
        }
        renderFilterBanner();
      }

      const params = new URLSearchParams();
      params.set('sort', state.sort);
      params.set('limit', String(PAGE_SIZE));
      params.set('offset', String(state.offset));
      if (state.category) params.set('category', state.category);
      if (state.q) params.set('q', state.q);
      if (state.verified) params.set('verified', '1');
      if (state.integration) params.set('integration', state.integration);
      if (state.tool) params.set('tool', state.tool);
      if (state.framework) params.set('agent_framework', state.framework);
      try {
        const res = await fetch('/api/submissions?' + params.toString());
        const items = await res.json();

        if (!Array.isArray(items) || (items.length === 0 && isFirstPage)) {
          feedEl.innerHTML = `
            <div class="empty">
              <div class="empty-icon">◆</div>
              <p>${state.q || state.category
                ? 'No matches found. Try a different filter.'
                : 'Nothing here yet.'}</p>
              <a class="empty-cta" href="/submit">Be the first to post →</a>
            </div>`;
          state.allLoaded = true;
          state.loading = false;
          return;
        }

        // If we got fewer than PAGE_SIZE, there are no more pages
        if (items.length < PAGE_SIZE) state.allLoaded = true;

        // Compute percentiles for achievement badges (first page only,
        // since percentiles are relative to the visible set)
        if (isFirstPage && items.length > 1) {
          const sortedLikes = items.map((it) => it.likes || 0).sort((a, b) => b - a);
          const sortedAi = items.filter((it) => it.ai_score != null).map((it) => it.ai_score).sort((a, b) => b - a);
          items.forEach((it) => {
            const likesAbove = sortedLikes.filter((l) => l > (it.likes || 0)).length;
            it._likePct = (likesAbove / items.length) * 100;
            if (it.ai_score != null && sortedAi.length > 1) {
              const aiAbove = sortedAi.filter((s) => s > it.ai_score).length;
              it._aiPct = (aiAbove / sortedAi.length) * 100;
            }
          });
        }

        // Mark top 3 as trending when viewing the trending sort (first page)
        const trendingIds = new Set();
        if (isFirstPage && state.sort === 'trending' && items.length > 1) {
          items.slice(0, 3).forEach((it) => trendingIds.add(it.id));
        }
        // Assign rank positions for "top" / "score" / "complexity" sorts
        if (['top', 'score', 'complexity'].includes(state.sort)) {
          items.forEach((it, idx) => { it._rank = state.offset + idx + 1; });
        }

        const cardsHtml = items.map((item, i) => {
          if (feedViewMode === 'list') return feedListRow(item);
          const extra = trendingIds.has(item.id) ? 'is-trending' : '';
          const idx = state.offset + i;
          return cardHtml(item, extra).replace('<div class="card', `<div style="--i:${idx % PAGE_SIZE}" class="card`);
        }).join('');

        if (isFirstPage) {
          feedEl.innerHTML = cardsHtml;
        } else {
          // Remove existing sentinel before appending
          const oldSentinel = feedEl.querySelector('.feed-sentinel');
          if (oldSentinel) oldSentinel.remove();
          feedEl.insertAdjacentHTML('beforeend', cardsHtml);
        }
        feedEl.classList.add('feed-loaded');
        // Defensive: always re-sync view mode class after render
        if (feedViewMode === 'list') {
          feedEl.classList.add('feed-list');
        } else {
          feedEl.classList.remove('feed-list');
        }

        // Append sentinel for infinite scroll if more pages exist
        if (!state.allLoaded) {
          const sentinel = document.createElement('div');
          sentinel.className = 'feed-sentinel';
          feedEl.appendChild(sentinel);
        }

        // Store feed IDs for next/prev navigation on detail pages
        try {
          const existing = isFirstPage ? [] : JSON.parse(sessionStorage.getItem('dh_feed_ids') || '[]');
          const merged = [...existing, ...items.map(it => it.id)];
          sessionStorage.setItem('dh_feed_ids', JSON.stringify(merged));
        } catch { /* quota exceeded — skip */ }

        // Advance offset for next page
        state.offset += items.length;
      } catch {
        if (isFirstPage) {
          feedEl.innerHTML = `
            <div class="empty">
              <div class="empty-icon">◆</div>
              <p>Couldn't load the feed.</p>
              <button class="empty-cta" onclick="location.reload()">Refresh →</button>
            </div>`;
        }
      }
      state.loading = false;
    }

    // Like click — event delegation (prevent navigation to detail page)
    feedEl.addEventListener('click', async (e) => {
      const btn = e.target.closest('.like-btn');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      toggleLike(Number(btn.dataset.id), btn);
    });

    // Dislike click — event delegation
    feedEl.addEventListener('click', async (e) => {
      const btn = e.target.closest('.dislike-btn');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      toggleDislike(Number(btn.dataset.id), btn);
    });

    // Card/row click — navigate to detail page.
    feedEl.addEventListener('click', (e) => {
      if (e.target.closest('a') || e.target.closest('button')) return;
      const card = e.target.closest('.card[data-href], .feed-row[data-href]');
      if (card) window.location.href = card.dataset.href;
    });

    // Hover image cycling — when a card has multiple gallery images,
    // cycle through them on hover with a crossfade.
    (function initHoverCycle() {
      let hoverTimer = null;
      let hoverIdx = 0;
      let hoverImgs = null;
      let hoverMedia = null;

      feedEl.addEventListener('mouseover', (e) => {
        const media = e.target.closest('.card-media[data-gallery]');
        if (!media || media === hoverMedia) return;
        stopCycle();
        hoverMedia = media;
        try { hoverImgs = JSON.parse(media.dataset.gallery); } catch { return; }
        if (!Array.isArray(hoverImgs) || hoverImgs.length < 2) return;
        hoverIdx = 0;
        hoverTimer = setInterval(() => {
          hoverIdx = (hoverIdx + 1) % hoverImgs.length;
          const img = media.querySelector('img');
          if (img) {
            img.style.opacity = '0';
            setTimeout(() => {
              img.src = hoverImgs[hoverIdx];
              img.style.opacity = '1';
            }, 150);
          }
        }, 1200);
      });

      feedEl.addEventListener('mouseleave', () => {
        if (hoverMedia) stopCycle();
      });
      feedEl.addEventListener('mouseout', (e) => {
        if (!hoverMedia) return;
        const related = e.relatedTarget;
        if (related && hoverMedia.contains(related)) return;
        if (related && related.closest && related.closest('.card-media[data-gallery]') === hoverMedia) return;
        stopCycle();
      });

      function stopCycle() {
        if (hoverTimer) clearInterval(hoverTimer);
        hoverTimer = null;
        if (hoverMedia && hoverImgs && hoverImgs.length > 0) {
          const img = hoverMedia.querySelector('img');
          if (img) {
            img.src = hoverImgs[0];
            img.style.opacity = '1';
          }
        }
        hoverMedia = null;
        hoverImgs = null;
        hoverIdx = 0;
      }
    })();

    // Feed view toggle (grid / list)
    // Sync initial class to match default feedViewMode
    feedEl.classList.remove('feed-list');
    const feedToggle = document.getElementById('feed-view-toggle');
    if (feedToggle) {
      feedToggle.querySelectorAll('.view-toggle-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          var mode = btn.dataset.mode;
          if (mode === feedViewMode) return;
          feedViewMode = mode;
          feedToggle.querySelectorAll('.view-toggle-btn').forEach((b) => {
            b.classList.toggle('active', b.dataset.mode === feedViewMode);
          });
          // Apply class BEFORE clearing/reloading
          feedEl.classList.remove('feed-list');
          if (feedViewMode === 'list') feedEl.classList.add('feed-list');
          // Full reset
          state.offset = 0;
          state.allLoaded = false;
          feedEl.innerHTML = '<div class="loading">Loading\u2026</div>';
          loadFeed();
        });
      });
    }

    // Sort tabs — only tabs that actually have a data-sort value.
    // The verified toggle shares the .tab class for visual consistency
    // but is an independent filter, not a sort, so it's handled below.
    document.querySelectorAll('.tab[data-sort]').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab[data-sort]').forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        state.sort = tab.dataset.sort;
        loadFeed();
      });
    });

    // Verified-only toggle — independent of the sort tabs.
    const verifiedBtn = document.getElementById('verified-toggle');
    if (verifiedBtn) {
      verifiedBtn.addEventListener('click', () => {
        state.verified = !state.verified;
        verifiedBtn.classList.toggle('active', state.verified);
        verifiedBtn.setAttribute('aria-pressed', String(state.verified));
        loadFeed();
      });
    }

    // "Clear filter" button in the active-filter banner — clears any
    // integration/tool deep-link filter and also strips the param from
    // the URL so a refresh doesn't re-apply it.
    const filterBanner = document.getElementById('active-filter-banner');
    if (filterBanner) {
      filterBanner.addEventListener('click', (e) => {
        if (!e.target.closest('.active-filter-clear')) return;
        state.integration = '';
        state.tool = '';
        const url = new URL(location.href);
        url.searchParams.delete('integration');
        url.searchParams.delete('tool');
        history.replaceState(null, '', url.pathname + (url.search || '') + url.hash);
        loadFeed();
      });
    }

    // Search (debounced)
    const searchInput = document.getElementById('search-input');
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          state.q = searchInput.value.trim();
          loadFeed();
        }, 250);
      });
    }

    // Category pills — populated from /api/meta. Only categories that
    // actually have submissions show up, so empty buckets don't clutter
    // the feed. When there are more than 6 populated categories, the
    // overflow tucks behind a "More ↓" toggle.
    const catRow = document.getElementById('category-filters');
    fetch('/api/meta').then((r) => r.json()).then((meta) => {
      const populated = Array.isArray(meta.category_counts) ? meta.category_counts : [];
      if (populated.length === 0) {
        catRow.style.display = 'none';
        return;
      }

      function makePill(name, count) {
        const btn = document.createElement('button');
        btn.className = 'pill';
        btn.dataset.category = name || '';
        btn.innerHTML = name
          ? `${escapeHtml(name)}<span class="pill-count">${count}</span>`
          : 'All';
        return btn;
      }

      const allBtn = makePill('', 0);
      allBtn.classList.add('active');
      catRow.appendChild(allBtn);
      populated.forEach((c) => catRow.appendChild(makePill(c.name, c.count)));

      // "More" toggle — expands the single row to show all categories
      if (populated.length > 4) {
        const moreBtn = document.createElement('button');
        moreBtn.className = 'pill pill-more';
        moreBtn.type = 'button';
        moreBtn.textContent = 'All categories ↓';
        moreBtn.style.flexShrink = '0';
        catRow.appendChild(moreBtn);

        moreBtn.addEventListener('click', () => {
          const nowOpen = !catRow.classList.contains('pill-row-expanded');
          catRow.classList.toggle('pill-row-expanded', nowOpen);
          moreBtn.classList.toggle('open', nowOpen);
          moreBtn.textContent = nowOpen ? 'Less ↑' : 'All categories ↓';
        });
      }

      catRow.addEventListener('click', (e) => {
        const pill = e.target.closest('.pill');
        if (!pill || pill.classList.contains('pill-more')) return;
        catRow.querySelectorAll('.pill').forEach((p) => p.classList.remove('active'));
        pill.classList.add('active');
        state.category = pill.dataset.category;
        loadFeed();
      });
    });

    // Framework filter pills — only shown when 2+ frameworks have agents
    const fwRow = document.getElementById('framework-filters');
    fetch('/api/meta').then((r) => r.json()).then((meta) => {
      const fwCounts = Array.isArray(meta.framework_counts) ? meta.framework_counts : [];
      if (fwCounts.length < 2) {
        if (fwRow) fwRow.style.display = 'none';
        return;
      }
      if (!fwRow) return;
      fwRow.style.display = '';
      const allBtn = document.createElement('button');
      allBtn.className = 'pill active';
      allBtn.dataset.framework = '';
      allBtn.textContent = 'All Frameworks';
      fwRow.appendChild(allBtn);
      fwCounts.forEach((fw) => {
        const btn = document.createElement('button');
        btn.className = 'pill';
        btn.dataset.framework = fw.name;
        btn.innerHTML = `${escapeHtml(fw.name)}<span class="pill-count">${fw.count}</span>`;
        fwRow.appendChild(btn);
      });
      fwRow.addEventListener('click', (e) => {
        const pill = e.target.closest('.pill');
        if (!pill) return;
        fwRow.querySelectorAll('.pill').forEach((p) => p.classList.remove('active'));
        pill.classList.add('active');
        state.framework = pill.dataset.framework;
        loadFeed();
      });
    });

    // Live polling: every 45s, quietly ask the server for the newest
    // submissions and prepend any we haven't shown yet with a flash-in
    // animation. Only runs in the default (unfiltered, trending) view
    // so it doesn't fight with whatever the user just filtered to.
    function startLivePoll() {
      const POLL_MS = 45_000;
      setInterval(async () => {
        // Only poll the default sort with no filters — otherwise we'd
        // be pushing items into a filtered view where they don't fit.
        if (state.sort !== 'trending' || state.category || state.q || state.verified) return;
        if (document.hidden) return;
        try {
          const res = await fetch('/api/submissions?sort=new&limit=10');
          const items = await res.json();
          if (!Array.isArray(items) || items.length === 0) return;
          const knownIds = new Set(
            [...feedEl.querySelectorAll('[data-id]')].map((n) => Number(n.dataset.id))
          );
          const fresh = items.filter((it) => !knownIds.has(Number(it.id)));
          if (fresh.length === 0) return;
          // If the feed was in an empty state, wipe it before prepending —
          // otherwise the "Nothing here yet" message stays visible below
          // the freshly arrived card.
          if (feedEl.querySelector('.empty')) {
            feedEl.innerHTML = '';
          }
          // Prepend in reverse so the newest item ends up on top.
          for (const item of fresh.reverse()) {
            const wrapper = document.createElement('div');
            wrapper.innerHTML = feedViewMode === 'list' ? feedListRow(item) : cardHtml(item, 'just-arrived');
            const node = wrapper.firstElementChild;
            if (node) feedEl.insertBefore(node, feedEl.firstChild);
          }
          // Bump the "agents showing off" headline count.
          const counter = document.querySelector('[data-stat="total_agents"]');
          if (counter) {
            const current = Number(counter.textContent.replace(/[^\d]/g, '')) || 0;
            counter.textContent = fmtNumber(current + fresh.length);
          }
        } catch { /* network blip — try again next tick */ }
      }, POLL_MS);
    }

    // Infinite scroll — observe a sentinel element at the bottom of the feed.
    // When it enters the viewport, load the next page of agents.
    const feedObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting && !state.loading && !state.allLoaded) {
          fetchFeedPage();
        }
      }
    }, { rootMargin: '400px' });

    // Re-observe sentinel after each page load via MutationObserver
    const feedMutation = new MutationObserver(() => {
      const sentinel = feedEl.querySelector('.feed-sentinel');
      if (sentinel) {
        feedObserver.disconnect();
        feedObserver.observe(sentinel);
      }
    });
    feedMutation.observe(feedEl, { childList: true, subtree: false });

    loadHeadline();
    loadFeed();
    startLivePoll();
    loadFeatured();
    loadSpotlight();
    loadActivityFeed();

    // ---------- hero text cycling: Hermes → OpenClaw → IronClaw … ----------
    const heroFw = document.getElementById('hero-framework');
    if (heroFw) {
      const names = ['Hermes', 'OpenClaw', 'IronClaw', 'AI Agents'];
      let idx = 0;
      setInterval(() => {
        heroFw.style.opacity = '0';
        setTimeout(() => {
          idx = (idx + 1) % names.length;
          heroFw.textContent = names[idx];
          heroFw.style.opacity = '1';
        }, 400);
      }, 3000);
    }
  }

  // ==========================================================
  // ACTIVITY FEED TICKER (feed page — independent pop-up slots)
  // One single-line-height bar. 3 slots inside, each independently cycles
  // through items on its own timer. Varied orange shades, no emojis.
  // Names and numbers are bolded.
  // ==========================================================
  async function loadActivityFeed() {
    var container = document.getElementById('activity-feed');
    if (!container) return;
    try {
      var res = await fetch('/api/activity');
      var items = await res.json();
      if (!Array.isArray(items) || items.length === 0) return;

      // Varied orange shade classes — each slot picks one per item
      var shades = ['activity-shade-0','activity-shade-1','activity-shade-2','activity-shade-3','activity-shade-4'];

      // Bold names and numbers. Also strip any leftover emoji codepoints.
      function formatText(raw, type) {
        // Strip emoji unicode (surrogate pairs + common emoji ranges)
        var clean = raw.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}]/gu, '').trim();
        var t = escapeHtml(clean);
        // Bold @handles
        t = t.replace(/@[\w]+/g, '<b>$&</b>');
        // Bold the name/title portion based on activity type patterns
        if (type === 'submitted') {
          // "@handle submitted <title>" — bold the title after "submitted "
          t = t.replace(/( submitted )(.+)$/, '$1<b>$2</b>');
        } else if (type === 'scored') {
          // "<title> scored ..." — bold title before " scored"
          t = t.replace(/^(.+?)( scored )/, '<b>$1</b>$2');
        } else if (type === 'commented') {
          // "<name> commented on <title>" — bold name + title
          t = t.replace(/^(.+?)( commented on )(.+)$/, '<b>$1</b>$2<b>$3</b>');
        } else if (type === 'trending') {
          // "<title> is trending with N likes" — bold title
          t = t.replace(/^(.+?)( is trending)/, '<b>$1</b>$2');
        }
        // Bold numbers like "28/100", standalone digits, "Grade A+"
        t = t.replace(/\d+\/\d+/g, '<b>$&</b>');
        t = t.replace(/(?<![\/\w])(\b\d+\b)(?!\/)/g, '<b>$1</b>');
        t = t.replace(/Grade\s+([A-F][+-]?|\?)/g, '<b>Grade $1</b>');
        // Clean up any nested <b> tags
        t = t.replace(/<b><b>/g, '<b>').replace(/<\/b><\/b>/g, '</b>');
        return t;
      }

      // Create 2 independent slots
      container.innerHTML = '<div class="activity-slot" id="aslot-0"></div>'
        + '<div class="activity-slot" id="aslot-1"></div>';

      // Render one item into a slot
      function renderSlot(slot, item, shadeIdx) {
        var shade = shades[shadeIdx % shades.length];
        slot.innerHTML = '<a class="activity-item ' + shade + '" href="' + escapeHtml(item.url) + '">'
          + '<span>' + formatText(item.text, item.type) + '</span>'
          + '</a>';
      }

      // Pre-load both slots immediately so they're visible on first paint
      var slotEls = [
        document.getElementById('aslot-0'),
        document.getElementById('aslot-1')
      ];
      var startOffsets = [0, Math.floor(items.length / 2)];
      for (var s = 0; s < 2; s++) {
        renderSlot(slotEls[s], items[startOffsets[s] % items.length], s);
        slotEls[s].classList.add('slot-in');
      }

      // Each slot cycles independently after the initial display
      function runSlot(slotId, startIdx, holdMs, pauseMs) {
        var slot = slotEls[slotId];
        if (!slot) return;
        var idx = startIdx;
        var shadeIdx = slotId;

        function cycleNext() {
          slot.classList.remove('slot-in');
          slot.classList.add('slot-out');
          setTimeout(function() {
            idx = (idx + 1) % items.length;
            shadeIdx++;
            renderSlot(slot, items[idx], shadeIdx);
            slot.classList.remove('slot-out');
            slot.classList.add('slot-in');
            setTimeout(cycleNext, holdMs);
          }, pauseMs);
        }
        setTimeout(cycleNext, holdMs);
      }

      // 2 slots with different hold times so they drift apart
      runSlot(0, startOffsets[0], 3400, 510);
      runSlot(1, startOffsets[1], 4080, 595);
    } catch (e) {
      // silently ignore — ticker is non-critical
    }
  }

  // ==========================================================
  // SPOTLIGHT STRIP (feed page — top agents horizontal scroll)
  // ==========================================================
  async function loadSpotlight() {
    const section = document.getElementById('spotlight');
    const track = document.getElementById('spotlight-track');
    if (!section || !track) return;
    try {
      const res = await fetch('/api/submissions?sort=top&limit=5');
      const items = await res.json();
      if (!Array.isArray(items) || items.length === 0) {
        section.style.display = 'none';
        return;
      }
      section.style.display = 'block';
      track.innerHTML = items.map((item) => `
        <a class="spotlight-card" href="/use-cases/${item.id}">
          ${item.image_url
            ? `<img src="${escapeHtml(item.image_url)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
            : `<div class="spotlight-placeholder">◆</div>`}
          <div class="spotlight-info">
            <span class="spotlight-name">${escapeHtml(item.title)}</span>
            ${item.category ? `<span class="spotlight-cat">${escapeHtml(item.category)}</span>` : ''}
            <div class="spotlight-meta">
              ${item.ai_score != null ? `<span class="spotlight-ai-score">${Number.isInteger(item.ai_score) ? item.ai_score : item.ai_score.toFixed(1)}</span>` : ''}
              ${(item.likes - (item.dislikes || 0)) > 0 ? `<span class="spotlight-likes">♥ ${item.likes - (item.dislikes || 0)}</span>` : ''}
            </div>
          </div>
        </a>
      `).join('');
    } catch {
      section.style.display = 'none';
    }
  }

  // ==========================================================
  // FEATURED SECTION (feed page)
  // ==========================================================
  async function loadFeatured() {
    const featuredEl = document.getElementById('featured');
    const gridEl = document.getElementById('featured-grid');
    if (!featuredEl || !gridEl) return;
    
    try {
      const res = await fetch('/api/featured?limit=4');
      const items = await res.json();
      if (!Array.isArray(items) || items.length === 0) {
        featuredEl.style.display = 'none';
        return;
      }
      
      featuredEl.style.display = 'block';
      gridEl.innerHTML = items.map((item) => `
        <a class="featured-card" href="/use-cases/${item.id}">
          ${item.image_url 
            ? `<img src="${escapeHtml(item.image_url)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
            : `<div class="featured-placeholder">◆</div>`}
          <div class="featured-body">
            <h3>${escapeHtml(item.title)}</h3>
            <p class="featured-reason">${escapeHtml(item.featured_reason || '')}</p>
          </div>
        </a>
      `).join('');
    } catch {
      featuredEl.style.display = 'none';
    }
  }

  // ==========================================================
  // Score history chart — draws AI score + net likes over time on a canvas
  function drawScoreHistory(canvas, item) {
    const history = item.score_history || [];
    const points = history.length > 0 ? history : (item.ai_score != null ? [{
      ai_score: item.ai_score,
      likes: item.likes || 0,
      dislikes: item.dislikes || 0,
      recorded_at: item.last_reviewed_at || item.created_at || new Date().toISOString(),
    }] : []);
    if (points.length === 0) { canvas.parentElement.style.display = 'none'; return; }

    const siteAvgScore = item.site_avg_score;
    const siteAvgLikes = item.site_avg_likes;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const W = rect.width, H = rect.height;
    const pad = { top: 36, right: 20, bottom: 32, left: 44 };
    const plotW = W - pad.left - pad.right;
    const plotH = H - pad.top - pad.bottom;

    const aiScores = points.map(p => p.ai_score ?? null);
    const netLikes = points.map(p => (p.likes || 0) - (p.dislikes || 0));
    const dates = points.map(p => p.recorded_at);

    const aiMax = 100;
    const likeMax = Math.max(5, ...netLikes.map(Math.abs), Math.abs(siteAvgLikes || 0) + 2);
    const likeMin = -likeMax;

    const xFor = (i) => pad.left + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
    const yAi = (v) => pad.top + (1 - v / aiMax) * plotH;
    const yLike = (v) => pad.top + (1 - (v - likeMin) / (likeMax - likeMin)) * plotH;

    // Background
    ctx.fillStyle = 'rgba(255,255,255,0.03)';
    ctx.fillRect(pad.left, pad.top, plotW, plotH);

    // Grid lines
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + (i / 4) * plotH;
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W - pad.right, y); ctx.stroke();
    }

    // --- Site average reference lines (dashed) ---
    if (siteAvgScore != null) {
      const avgY = yAi(siteAvgScore);
      ctx.save();
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = 'rgba(232, 131, 74, 0.4)';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(pad.left, avgY); ctx.lineTo(W - pad.right, avgY); ctx.stroke();
      ctx.restore();
      ctx.fillStyle = 'rgba(232, 131, 74, 0.6)';
      ctx.font = '10px -apple-system, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(`avg ${siteAvgScore}`, pad.left + 4, avgY - 4);
    }
    if (siteAvgLikes != null) {
      const avgY = yLike(siteAvgLikes);
      ctx.save();
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = 'rgba(255, 64, 96, 0.35)';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(pad.left, avgY); ctx.lineTo(W - pad.right, avgY); ctx.stroke();
      ctx.restore();
      ctx.fillStyle = 'rgba(255, 64, 96, 0.55)';
      ctx.font = '10px -apple-system, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(`avg ${siteAvgLikes}`, W - pad.right - 4, avgY - 4);
    }

    // --- Draw AI score line (orange) ---
    const validAi = aiScores.some(v => v != null);
    if (validAi) {
      ctx.strokeStyle = '#e8834a';
      ctx.lineWidth = 2.5;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      let started = false;
      aiScores.forEach((v, i) => {
        if (v == null) return;
        const x = xFor(i), y = yAi(v);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
      // Dots + value labels
      aiScores.forEach((v, i) => {
        if (v == null) return;
        const x = xFor(i), y = yAi(v);
        ctx.fillStyle = '#e8834a';
        ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
        // White outline
        ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 1;
        ctx.stroke();
        // Value label
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 12px -apple-system, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(Number.isInteger(v) ? String(v) : v.toFixed(1), x, y - 10);
      });
    }

    // --- Draw likes line (pink) ---
    ctx.strokeStyle = '#ff4060';
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    netLikes.forEach((v, i) => {
      const x = xFor(i), y = yLike(v);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    netLikes.forEach((v, i) => {
      const x = xFor(i), y = yLike(v);
      ctx.fillStyle = '#ff4060';
      ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 1;
      ctx.stroke();
      // Value label
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 11px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(String(v), x, y + 18);
    });

    // Header labels
    ctx.font = '11px -apple-system, sans-serif';
    ctx.fillStyle = '#e8834a';
    ctx.textAlign = 'left';
    ctx.fillText('AI Score (0–100)', pad.left + 4, pad.top - 14);
    ctx.fillStyle = '#ff4060';
    ctx.textAlign = 'right';
    ctx.fillText('Net Likes', W - pad.right - 4, pad.top - 14);

    // Y axis labels
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.textAlign = 'right';
    ctx.font = '10px -apple-system, sans-serif';
    ctx.fillText('100', pad.left - 4, pad.top + 4);
    ctx.fillText('0', pad.left - 4, pad.top + plotH + 4);

    // X axis dates
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.textAlign = 'center';
    ctx.font = '9px -apple-system, sans-serif';
    if (dates.length >= 2) {
      [0, dates.length - 1].forEach(i => {
        const d = new Date(dates[i]);
        ctx.fillText(d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), xFor(i), H - 6);
      });
    } else if (dates.length === 1) {
      const d = new Date(dates[0]);
      ctx.fillText(d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }), W / 2, H - 6);
    }
  }

  // DETAIL PAGE
  // ==========================================================
  function initDetail() {
    const root = document.getElementById('detail');
    if (!root) return;
    const m = location.pathname.match(/\/use-cases\/(\d+)/);
    if (!m) {
      root.innerHTML = `<div class="empty">Invalid use case URL.</div>`;
      return;
    }
    const id = Number(m[1]);
    const deleteToken = new URLSearchParams(location.search).get('delete') || '';

    function kv(label, value) {
      if (!value && value !== 0) return '';
      return `<div class="kv"><span class="kv-label">${escapeHtml(label)}</span><span class="kv-value">${escapeHtml(value)}</span></div>`;
    }
    function list(label, arr) {
      if (!Array.isArray(arr) || arr.length === 0) return '';
      return `
        <div class="kv kv-list">
          <span class="kv-label">${escapeHtml(label)}</span>
          <span class="kv-value">${arr.map((v) => `<span class="chip">${escapeHtml(v)}</span>`).join('')}</span>
        </div>`;
    }

    function render(item) {
      // Build hero media — carousel if multiple images, single if one
      const rawGallery = Array.isArray(item.gallery) ? item.gallery : [];
      const allImages = [];
      if (item.image_url) allImages.push(item.image_url);
      rawGallery.forEach((url) => { if (url !== item.image_url) allImages.push(url); });

      let media;
      if (item.video_url) {
        media = `<video src="${escapeHtml(item.video_url)}" controls playsinline></video>`;
      } else if (allImages.length > 1) {
        const heroSlides = allImages.map((url, i) => `
          <div class="hero-slide${i === 0 ? ' active' : ''}" data-idx="${i}">
            <img src="${escapeHtml(url)}" alt="Image ${i + 1}" referrerpolicy="no-referrer" />
          </div>`).join('');
        const heroDots = `<div class="hero-dots">${allImages.map((_, i) => `<button class="hero-dot${i === 0 ? ' active' : ''}" data-idx="${i}" type="button"></button>`).join('')}</div>`;
        media = `<div class="hero-carousel" data-count="${allImages.length}">
          <div class="hero-carousel-track">${heroSlides}</div>
          <button class="hero-carousel-prev" type="button" aria-label="Previous">&#8249;</button>
          <button class="hero-carousel-next" type="button" aria-label="Next">&#8250;</button>
          ${heroDots}
          <span class="hero-carousel-counter">1 / ${allImages.length}</span>
        </div>`;
      } else if (allImages.length === 1) {
        media = `<img src="${escapeHtml(allImages[0])}" alt="" referrerpolicy="no-referrer" />`;
      } else {
        media = `<div class="placeholder-big">◆</div>`;
      }

      const hasTech =
        item.integrations?.length || item.tools_used?.length ||
        item.data_sources?.length || item.output_channels?.length ||
        item.trigger_type || item.platform;

      const hasInfra =
        item.model || item.model_provider || item.deployment || item.host ||
        item.context_window || item.memory_type || item.tool_use != null || item.rag != null ||
        item.multi_agent != null || item.output_format || item.error_rate != null;

      const hasMetrics =
        item.running_since || item.time_saved_per_week || item.runs_completed ||
        item.hours_used || item.approx_monthly_tokens ||
        item.total_interactions || item.active_users || item.tasks_completed;

      // v3: the "Build details" block rolls up the structured tier/enum
      // fields the Hermes agent asks about during the interview.
      const hasBuildDetails =
        item.automation_level || item.context_tier || item.cost_tier ||
        item.reliability || item.source_available || item.time_to_build ||
        item.complexity_tier;

      const hasGotchas = Array.isArray(item.gotchas) && item.gotchas.length > 0;
      const hasCode = item.github_url || item.source_url;
      const hasAiScore = item.ai_score != null;
      const hasTags = Array.isArray(item.tags) && item.tags.length > 0;
      const approvedUpdates = Array.isArray(item.updates) ? item.updates : [];
      const pendingUpdates = Array.isArray(item.pending_updates) ? item.pending_updates : [];
      const updateCount = approvedUpdates.length;

      // Bold the first sentence of the story — agents tend to open with their
      // strongest hook, so lifting it out visually gives the detail page a
      // clear lede without asking agents to mark it up themselves.
      function formatStory(raw) {
        if (!raw) return '';
        // Strip markdown and bullet formatting that agents send despite rules.
        let cleaned = raw.trim()
          .replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1')  // **bold** and *italic*
          .replace(/^#{1,4}\s+/gm, '')                // # headers
          .replace(/^[-•●◦]\s+/gm, '')                // - bullet and • bullet
          .replace(/^\d+[.)]\s+/gm, '');               // 1. numbered lists
        // Collapse lines that were bullet items into flowing text.
        // Replace single newlines (not double) with spaces so bullet lists
        // become prose. Preserve paragraph breaks (double newline).
        cleaned = cleaned.replace(/\n(?!\n)/g, ' ').replace(/  +/g, ' ');
        const trimmed = cleaned.trim();

        // Split into paragraphs first (double newline), then tokenize sentences.
        const rawParas = trimmed.split(/\n\n+/).filter(Boolean);

        function tokenizeSentences(para) {
          const re = /([^.!?]*[.!?])(?:\s+(?=[A-Z"'])|$)/g;
          const out = [];
          let m, lastIdx = 0;
          while ((m = re.exec(para)) !== null) {
            const s = m[1].trim();
            if (s.length >= 8) out.push({ text: s, start: m.index });
            lastIdx = m.index + m[0].length;
          }
          const tail = para.slice(lastIdx).trim();
          if (tail.length >= 8) out.push({ text: tail, start: lastIdx });
          return out;
        }

        function scoreImportance(s, idx, totalSentences) {
          let n = 0;
          // Numbers = concrete data (runs, deals, indices, dimensions)
          const numCount = (s.match(/\d+/g) || []).length;
          n += Math.min(numCount, 3) * 2;
          // Named entities — capitalized words that aren't sentence starters
          const caps = (s.match(/\b[A-Z][a-z]{2,}/g) || []).length;
          n += Math.min(caps, 4);
          // Outcome/action verbs = impactful sentences
          if (/\b(built|shipped|scores?|surface|delivers?|queries?|pull|automates?|replaced?|saved?)\b/i.test(s)) n += 4;
          // Unique/differentiating language
          if (/\b(different|unique|unlike|only|first|not a|remember|persist)/i.test(s)) n += 3;
          // Integration/tool mentions = concrete architecture
          if (/\b(Pinecone|Telegram|Slack|Railway|GitHub|Express|SQLite|cron|API|database|vector)\b/i.test(s)) n += 2;
          // Prefer first sentence of each paragraph (paragraph openers)
          if (idx === 0) n += 2;
          // Sweet spot length — not too short, not too long
          if (s.length >= 50 && s.length <= 180) n += 2;
          if (s.length < 25) n -= 3;
          // Penalize meta/filler sentences
          if (/\b(straightforward|basically|simply|just)\b/i.test(s)) n -= 2;
          return n;
        }

        // Collect all sentences with paragraph index for context.
        const allSentences = [];
        rawParas.forEach((para, pIdx) => {
          tokenizeSentences(para).forEach((s, sIdx) => {
            allSentences.push({ ...s, paraIdx: pIdx, sentIdx: sIdx });
          });
        });
        const boldSet = new Set();

        if (allSentences.length > 0) {
          // Always bold the first sentence of the story (the lede).
          boldSet.add(allSentences[0].text);
          if (allSentences.length > 1) {
            // Score remaining sentences, pick top 3 for 4 total bolded.
            // Prefer spreading bolds across different paragraphs.
            const scored = allSentences.slice(1).map(s => ({
              s, score: scoreImportance(s.text, s.sentIdx, allSentences.length)
            }));
            scored.sort((a, b) => b.score - a.score);
            // Pick best sentence
            boldSet.add(scored[0].s.text);
            if (scored.length > 1) {
              // For the 3rd bold, prefer a different paragraph than the 2nd
              const secondPara = scored[0].s.paraIdx;
              const diffPara = scored.slice(1).find(x => x.s.paraIdx !== secondPara);
              boldSet.add((diffPara || scored[1]).s.text);
              if (scored.length > 2) {
                // For the 4th bold, prefer a paragraph not yet used
                const usedParas = new Set([allSentences[0].paraIdx, scored[0].s.paraIdx]);
                if (diffPara) usedParas.add(diffPara.s.paraIdx);
                const fourthCandidate = scored.slice(1).find(x => !boldSet.has(x.s.text) && !usedParas.has(x.s.paraIdx));
                boldSet.add((fourthCandidate || scored.find(x => !boldSet.has(x.s.text)) || scored[2]).s.text);
              }
            }
          }
        }

        function renderSentence(s) {
          return boldSet.has(s.text)
            ? `<strong class="story-lede">${escapeHtml(s.text)}</strong>`
            : escapeHtml(s.text);
        }

        // Render as <p> per paragraph for visual breathing room.
        if (rawParas.length > 1) {
          return rawParas.map((para) => {
            const sentences = tokenizeSentences(para);
            const content = sentences.length
              ? sentences.map(renderSentence).join(' ')
              : escapeHtml(para);
            return `<p class="detail-story">${content}</p>`;
          }).join('');
        }

        // Single paragraph — render sentences joined with spaces inside one <p>.
        const sentences = tokenizeSentences(rawParas[0] || trimmed);
        const content = sentences.length
          ? sentences.map(renderSentence).join(' ')
          : escapeHtml(trimmed);
        return `<p class="detail-story">${content}</p>`;
      }

      // "Living database" timeline: approved updates are public, pending
      // ones only come back from the API when the author's delete token
      // was in the request. Shows an author-only "Post an update" form +
      // inline approve/reject buttons for anything pending.
      function fmtDate(iso) {
        if (!iso) return '';
        // SQLite datetime("now") returns "YYYY-MM-DD HH:MM:SS" (UTC)
        const d = new Date(iso.replace(' ', 'T') + 'Z');
        if (Number.isNaN(d.getTime())) return iso;
        return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      }
      function renderUpdatesPanel(it) {
        const approved = Array.isArray(it.updates) ? it.updates : [];
        const pending  = Array.isArray(it.pending_updates) ? it.pending_updates : [];
        const isAuthor = !!it.is_author;

        const approvedHtml = approved.length
          ? `<ol class="updates-timeline">
               ${approved.map((u) => `
                 <li class="update-item timeline">
                   <span class="update-date">${escapeHtml(fmtDate(u.approved_at || u.created_at))}</span>
                   <p class="update-body">${escapeHtml(u.body)}</p>
                 </li>`).join('')}
             </ol>`
          : `<div class="updates-empty">
               <div class="updates-empty-icon">◆</div>
               <div class="updates-empty-title">No updates yet</div>
               <p>This agent hasn't posted any updates. When the builder shares new metrics, milestones, or improvements, they'll appear here — and the score updates in real time.</p>
               <div class="updates-empty-cta">
                 <strong>Builders:</strong> Tell your agent <em>"Post an update to my DiscoverHermes card"</em> to share what's new. Your score changes are tracked over time.
               </div>
             </div>`;

        const pendingHtml = (isAuthor && pending.length)
          ? `<div class="pending-block">
               <h3>Pending your approval (${pending.length})</h3>
               <ul class="update-list pending">
                 ${pending.map((u) => `
                   <li class="update-item pending" data-update-id="${u.id}">
                     <span class="update-date">${escapeHtml(fmtDate(u.created_at))}</span>
                     <p class="update-body">${escapeHtml(u.body)}</p>
                     <div class="update-actions">
                       <button class="approve-btn" type="button" data-update-id="${u.id}">Approve</button>
                       <button class="reject-btn"  type="button" data-update-id="${u.id}">Reject</button>
                     </div>
                   </li>`).join('')}
               </ul>
             </div>`
          : '';

        const postForm = isAuthor
          ? `<div class="post-update">
               <h3>Post an update</h3>
               <p class="muted">Short "what's new" — a new feature, an insight, something that changed. Your update is pending until you approve it below.</p>
               <textarea class="update-input" maxlength="600" rows="3" placeholder="e.g. Added a cost-watchdog step so the agent stops when my weekly API spend hits \$10."></textarea>
               <button class="post-update-btn primary" type="button">Submit update</button>
               <span class="post-update-status muted"></span>
             </div>`
          : '';

        return `
          <div class="updates-panel">
            ${approvedHtml}
            ${pendingHtml}
            ${postForm}
          </div>`;
      }

      // ---------- sidebar helpers ----------
      function sideCard(title, body) {
        if (!body) return '';
        return `<div class="side-card"><h3>${escapeHtml(title)}</h3>${body}</div>`;
      }
      function sideKv(label, value) {
        if (value == null || value === '') return '';
        return `<div class="side-kv"><span class="side-kv-label">${escapeHtml(label)}</span><span class="side-kv-value">${escapeHtml(value)}</span></div>`;
      }
      function sideChipList(arr, filterKey) {
        if (!Array.isArray(arr) || arr.length === 0) return '';
        // If a filterKey is passed, render each chip as a link to the feed
        // pre-filtered by that value. The home feed reads ?integration=X /
        // ?tool=X from the URL and forwards it to /api/submissions.
        return `<div class="side-chips">${arr
          .map((v) => {
            const label = escapeHtml(v);
            if (!filterKey) return `<span class="chip">${label}</span>`;
            const href = `/?${filterKey}=${encodeURIComponent(v)}`;
            return `<a class="chip chip-link" href="${href}" title="Find agents that use ${label}">${label}</a>`;
          })
          .join('')}</div>`;
      }

      // Author banner: shown only when ?delete=<token> is in the URL (the
      // author kept their delete link). Includes both the delete button and
      // the Stripe verify CTA if the submission isn't verified yet.
      let authorBanner = '';
      if (deleteToken) {
        const verifyBtn = item.verified || !window.__meta?.verify_enabled
          ? ''
          : `<a class="verify-btn" href="/api/verify/${item.id}">
               Verify agent — $${window.__meta.verify_price_usd} + tax
             </a>`;
        const bannerText = item.verified
          ? `<strong>You're the author.</strong> This post is verified. You can still delete it.`
          : `<strong>You're the author.</strong> Save this link — it's the only way to delete this post later. Add a Verified badge for trust.`;
        authorBanner = `
          <div class="author-banner">
            <div class="author-banner-text">${bannerText}</div>
            <div class="author-banner-actions">
              ${verifyBtn}
              <button class="delete-btn" type="button">Delete post</button>
            </div>
          </div>`;
      }

      // ---------- build the left sidebar (the creator + the impact) ----------
      // Author card
      const creatorName = item.display_name || (item.twitter_handle ? '@' + item.twitter_handle : 'Anonymous');
      const creatorInitials = (creatorName || '?').trim().replace(/^@/, '').slice(0, 2).toUpperCase();
      const creatorLink = item.twitter_handle
        ? `<a class="side-link side-link-x" href="https://x.com/${escapeHtml(item.twitter_handle)}" target="_blank" rel="noopener">
             <span class="side-link-label">X</span>
             <span class="side-link-value">@${escapeHtml(item.twitter_handle)}</span>
             <span class="side-link-arrow">↗</span>
           </a>`
        : '';
      const websiteLink = item.website
        ? `<a class="side-link side-link-web" href="${escapeHtml(item.website)}" target="_blank" rel="noopener">
             <span class="side-link-label">Web</span>
             <span class="side-link-value">${escapeHtml((item.website || '').replace(/^https?:\/\//, '').replace(/\/$/, ''))}</span>
             <span class="side-link-arrow">↗</span>
           </a>`
        : `<span class="side-link side-link-web side-link-placeholder">
             <span class="side-link-label">Web</span>
             <span class="side-link-value add-website-hint">Add via your agent</span>
           </span>`;
      const authorCard = `
        <div class="side-card author-card">
          <div class="author-row">
            <div class="author-avatar">${escapeHtml(creatorInitials || '?')}</div>
            <div class="author-meta">
              <div class="author-name">${escapeHtml(creatorName)}</div>
            </div>
          </div>
          ${creatorLink || websiteLink ? `
            <div class="author-links">
              ${creatorLink}
              ${websiteLink}
            </div>` : ''}
          <div class="author-posted muted">Posted ${escapeHtml(fmtDate(item.created_at) || (item.created_at || '').split(' ')[0] || '')}</div>
        </div>`;

      // Engagement card — like button + share button + badge button
      const shareHref = item.share_tweet_url ? escapeHtml(item.share_tweet_url) : '#';
      const badgeUrl = 'https://discoverhermes.com/api/badge/' + item.id + '.svg';
      const cardUrl = 'https://discoverhermes.com/use-cases/' + item.id;
      const badgeMarkdown = '[![DiscoverHermes](' + badgeUrl + ')](' + cardUrl + ')';
      const engagementCard = `
        <div class="side-card engagement-card">
          <div class="engagement-row">
            ${likeBtnHtml(item).replace('class="like-btn"', 'class="like-btn like-btn-big"')}
            <a class="share-btn" href="${shareHref}" target="_blank" rel="noopener" title="Share on X">
              <span class="share-icon">↗</span> Share
            </a>
          </div>
          <button class="badge-btn" type="button" title="Get embeddable badge for your README">
            <span class="badge-icon">◆</span> Embed badge in your GitHub README
          </button>
          <div class="badge-popover" style="display:none">
            <p class="badge-popover-label">Add this to your GitHub README:</p>
            <div class="badge-preview"><img src="/api/badge/${item.id}.svg" alt="badge preview" /></div>
            <div class="badge-snippet-row">
              <code class="badge-snippet">${escapeHtml(badgeMarkdown)}</code>
              <button class="copy-btn badge-copy" data-copy-text="${escapeHtml(badgeMarkdown)}" type="button">copy</button>
            </div>
          </div>
        </div>`;

      // At-a-glance metric card — big numbers for the impact
      const metricHtml = hasMetrics ? `
        <div class="side-card metric-card">
          <h3>At a glance</h3>
          <div class="side-metrics">
            ${item.total_interactions ? `<div class="side-metric"><span class="side-metric-val">${fmtNumber(item.total_interactions)}</span><span class="side-metric-lbl">interactions</span></div>` : ''}
            ${item.tasks_completed ? `<div class="side-metric"><span class="side-metric-val">${fmtNumber(item.tasks_completed)}</span><span class="side-metric-lbl">tasks done</span></div>` : ''}
            ${item.active_users && item.active_users > 1 ? `<div class="side-metric"><span class="side-metric-val">${fmtNumber(item.active_users)}</span><span class="side-metric-lbl">active users</span></div>` : ''}
            ${item.time_saved_per_week ? `<div class="side-metric"><span class="side-metric-val">${item.time_saved_per_week}h</span><span class="side-metric-lbl">saved / week</span></div>` : ''}
            ${item.runs_completed ? `<div class="side-metric"><span class="side-metric-val">${fmtNumber(item.runs_completed)}</span><span class="side-metric-lbl">agent sessions</span></div>` : ''}
            ${item.hours_used ? `<div class="side-metric"><span class="side-metric-val">${fmtNumber(item.hours_used)}</span><span class="side-metric-lbl">hours used</span></div>` : ''}
            ${item.approx_monthly_tokens ? `<div class="side-metric"><span class="side-metric-val">${fmtNumber(item.approx_monthly_tokens)}</span><span class="side-metric-lbl">tokens / mo</span></div>` : ''}
            ${item.running_since ? `<div class="side-metric wide"><span class="side-metric-val">${escapeHtml(fmtDate(item.running_since))}</span><span class="side-metric-lbl">running since</span></div>` : ''}
          </div>
        </div>` : '';

      // AI + Human score cards — placed in hero area for instant visibility
      const rankingsHref = item.category
        ? `/rankings?category=${encodeURIComponent(item.category)}`
        : '/rankings';
      const gradeLabels = { S: 'Legendary', A: 'Elite', B: 'Solid', C: 'Rising', D: 'Starter', F: 'Needs Work' };
      const aiRankStr = item.ai_rank != null
        ? `#${item.ai_rank}${item.total_scored != null ? ` of ${item.total_scored}` : ''}`
        : null;
      const likesCount = Number(item.likes) || 0;
      const dislikesCount = Number(item.dislikes) || 0;
      const netScore = likesCount - dislikesCount;
      const likesRankStr = item.likes_rank != null
        ? `#${item.likes_rank}${item.total_agents != null ? ` of ${item.total_agents}` : ''}`
        : null;
      const scoreDisplay = item.ai_score != null 
        ? (Number.isInteger(item.ai_score) ? item.ai_score : item.ai_score.toFixed(1))
        : null;
      const scoreCardsHtml = `
        <div class="score-cards-strip">
          ${hasAiScore ? `
          <div class="score-card ai-card">
            <div class="ai-card-row">
              <span class="rank-grade">${scoreDisplay}</span>
              <div>
                <div class="score-card-title">AI Score</div>
                <div class="ai-score-num">${scoreDisplay}<span class="ai-score-unit"> / 100</span></div>
                <div class="ai-score-label">${aiRankStr ? `Ranked ${aiRankStr}` : ''}</div>
              </div>
            </div>
            ${item.featured && item.featured_reason ? `<p class="ai-featured">⭐ ${escapeHtml(item.featured_reason)}</p>` : ''}
          </div>` : (item.ai_score_pending ? `
          <div class="score-card ai-card">
            <div class="ai-card-row">
              <span class="rank-grade grade-pending">…</span>
              <div>
                <div class="score-card-title">AI Score</div>
                <div class="ai-score-num" style="font-size:16px;opacity:0.6">Pending</div>
                <div class="ai-score-label">Score is being calculated</div>
              </div>
            </div>
          </div>` : '')}
          <div class="score-card human-card human-card-likeable" data-id="${item.id}" role="button" tabindex="0" title="Click to like this agent">
            <div class="ai-card-row">
              <span class="rank-grade human-grade ${likedSet.has(item.id) ? 'liked' : ''}">♥</span>
              <div>
                <div class="score-card-title">Human Score</div>
                <div class="ai-score-num"><span class="human-card-net">${netScore}</span><span class="ai-score-unit"> net</span></div>
                <div class="ai-score-label"><span class="human-card-up">${likesCount}</span> up · <span class="human-card-down">${dislikesCount}</span> down${likesRankStr ? ` · Ranked ${likesRankStr}` : ''}</div>
              </div>
            </div>
          </div>
          <a class="score-cards-link" href="${rankingsHref}">View leaderboard ↗</a>
        </div>`;

      // Build profile card (complexity, tiers, etc.). Satisfaction lived
      // here as a row of dots — removed, since it looked like a UI control
      // rather than data and confused visitors.
      const buildBody = hasBuildDetails ? `
        ${sideKv('Automation', humanize(item.automation_level))}
        ${sideKv('Complexity', humanize(item.complexity_tier))}
        ${sideKv('Time to build', humanize(item.time_to_build))}
        ${sideKv('Reliability', humanize(item.reliability))}
        ${sideKv('Cost tier', humanize(item.cost_tier))}
        ${sideKv('Context', humanize(item.context_tier))}
        ${sideKv('Source', humanize(item.source_available))}
      ` : '';
      const buildCard = sideCard('Builder profile', buildBody);

      // ---------- build the right sidebar (how it's built) ----------
      const techBody = hasTech ? `
        ${sideKv('Platform', item.platform)}
        ${sideKv('Trigger', item.trigger_type)}
        ${sideKv('Schedule', item.trigger_detail)}
        ${item.integrations?.length ? `<div class="side-subsection"><div class="side-sub-label">Integrations</div>${sideChipList(item.integrations, 'integration')}</div>` : ''}
        ${item.tools_used?.length ? `<div class="side-subsection"><div class="side-sub-label">Tools used</div>${sideChipList(item.tools_used, 'tool')}</div>` : ''}
        ${item.data_sources?.length ? `<div class="side-subsection"><div class="side-sub-label">Data sources</div>${sideChipList(item.data_sources)}</div>` : ''}
        ${item.output_channels?.length ? `<div class="side-subsection"><div class="side-sub-label">Outputs</div>${sideChipList(item.output_channels)}</div>` : ''}
      ` : '';
      const techCard = sideCard('Tech stack', techBody);

      const infraBody = hasInfra ? `
        ${sideKv('Model', item.model)}
        ${sideKv('Provider', item.model_provider)}
        ${sideKv('Deployment', item.deployment)}
        ${sideKv('Host', item.host)}
        ${sideKv('Context', item.context_window ? fmtNumber(item.context_window) + ' tokens' : null)}
        ${sideKv('Memory', item.memory_type)}
        ${sideKv('Tool use', item.tool_use == null ? null : (item.tool_use ? 'yes' : 'no'))}
        ${sideKv('RAG', item.rag == null ? null : (item.rag ? 'yes' : 'no'))}
        ${sideKv('Multi-agent', item.multi_agent == null ? null : (item.multi_agent ? 'yes' : 'no'))}
        ${sideKv('Output', item.output_format ? humanize(item.output_format) : null)}
        ${sideKv('Error rate', item.error_rate != null ? item.error_rate + '%' : null)}
      ` : '';
      const infraCard = sideCard('Infrastructure', infraBody);

      const codeBody = hasCode ? `
        ${item.github_url ? `<div class="side-kv"><span class="side-kv-label">GitHub</span><span class="side-kv-value"><a class="ext-link" href="${escapeHtml(item.github_url)}" target="_blank" rel="noopener">${escapeHtml((item.github_url || '').replace(/^https?:\/\/(www\.)?/, ''))}</a></span></div>` : ''}
        ${item.source_url ? `<div class="side-kv"><span class="side-kv-label">Gist / source</span><span class="side-kv-value"><a class="ext-link" href="${escapeHtml(item.source_url)}" target="_blank" rel="noopener">${escapeHtml((item.source_url || '').replace(/^https?:\/\/(www\.)?/, ''))}</a></span></div>` : ''}
      ` : '';
      const codeCard = sideCard('Source & code', codeBody);

      const tagsBody = hasTags ? sideChipList(item.tags) : '';
      const tagsCard = sideCard('Tags', tagsBody);

      // rankCard removed — AI/Human score cards now include rank info

      // ---------- gallery (secondary images, max 5) ----------
      // Author can add screenshots of the dashboard / terminal / output
      // from the detail page once posted. Stored as a JSON array on the
      // submission; mutated via PATCH gallery_add / gallery_remove.
      // Gallery section removed — all images now cycle in the hero carousel.
      // Keep author upload button inline below the hero.
      const GALLERY_MAX = 10;
      const isAuthor = !!item.is_author;
      const gallerySlotsLeft = GALLERY_MAX - rawGallery.length;
      const galleryAddHtml = isAuthor && gallerySlotsLeft > 0 ? `
        <div class="hero-add-image">
          <label class="gallery-add-inline" for="gallery-upload-${item.id}">
            <input type="file" id="gallery-upload-${item.id}" class="gallery-upload"
                   accept="image/png,image/jpeg,image/webp,image/gif" hidden />
            + Add image <span class="muted">(${gallerySlotsLeft} slot${gallerySlotsLeft === 1 ? '' : 's'} left)</span>
          </label>
          <div class="gallery-add-status muted"></div>
        </div>` : '';

      // ---------- comments (flat, handle-required) ----------
      // Anyone can comment but a twitter_handle is required. Author of the
      // card (via delete_token) can delete any comment. Rendered below the
      // Updates section so the article-style read flows: story → gallery →
      // updates → community comments.
      const commentsList = Array.isArray(item.comments) ? item.comments : [];
      const commentItemsHtml = commentsList.length
        ? commentsList.map((c) => {
            const name = c.display_name || ('@' + c.twitter_handle);
            const handleLink = `<a class="comment-handle" href="https://x.com/${escapeHtml(c.twitter_handle)}" target="_blank" rel="noopener">@${escapeHtml(c.twitter_handle)}</a>`;
            const nameBlock = c.display_name
              ? `<span class="comment-name">${escapeHtml(c.display_name)}</span> ${handleLink}`
              : handleLink;
            const removeBtn = isAuthor
              ? `<button class="comment-delete" type="button" data-comment-id="${c.id}" title="Delete this comment">×</button>`
              : '';
            return `
              <li class="comment-item" data-comment-id="${c.id}">
                <div class="comment-head">
                  <div class="comment-meta">
                    ${nameBlock}
                    <span class="comment-time muted">${escapeHtml(fmtDate(c.created_at))}</span>
                  </div>
                  ${removeBtn}
                </div>
                <p class="comment-body">${escapeHtml(c.body)}</p>
              </li>`;
          }).join('')
        : `<li class="comment-empty muted">No comments yet — be the first to chime in.</li>`;

      const commentsSectionHtml = `
        <section class="detail-section comments-section">
          <h2>Comments${commentsList.length ? ` <span class="tab-badge">${commentsList.length}</span>` : ''}</h2>
          <form class="comment-form" onsubmit="return false;">
            <input type="text" class="comment-name-input" maxlength="60"
                   placeholder="your name or @handle" />
            <textarea class="comment-body-input" rows="3" maxlength="600"
                      placeholder="What do you think? Ask a question, share a tip, tell them you love it."></textarea>
            <div class="comment-form-foot">
              <span class="comment-status muted"></span>
              <button class="comment-submit primary" type="button">Post comment</button>
            </div>
          </form>
          <ul class="comments-list">
            ${commentItemsHtml}
          </ul>
        </section>`;

      // ---------- "Why this agent?" highlights strip ----------
      // Only show genuinely impactful metrics — skip generic labels
      const highlights = [];
      if (item.time_saved_per_week) {
        highlights.push(`Saves ${item.time_saved_per_week}h every week`);
      }
      if (item.runs_completed) {
        highlights.push(`${fmtNumber(item.runs_completed)} runs completed`);
      }
      if (item.ai_grade) {
        const gradeWord = { S: 'Legendary', A: 'Elite', B: 'Solid', C: 'Rising', D: 'Starter', F: 'Needs Work' }[item.ai_grade];
        if (gradeWord) highlights.push(`${gradeWord} (Grade ${escapeHtml(item.ai_grade)})`);
      }
      if (item.running_since) {
        const since = Date.parse(item.running_since);
        if (Number.isFinite(since)) {
          const days = Math.floor((Date.now() - since) / 86400000);
          if (days > 30) highlights.push(`Running ${days} days`);
        }
      }
      if (item.approx_monthly_tokens >= 100000) {
        highlights.push(`${fmtNumber(item.approx_monthly_tokens)} tokens/mo`);
      }
      const highlightsSectionHtml = highlights.length ? `
          <section class="detail-section highlights-section">
            <ul class="highlights-list">
              ${highlights.slice(0, 3).map(h => `<li class="highlight-item">${h}</li>`).join('')}
            </ul>
          </section>` : '';

      // ---------- build the main overview panel ----------
      // No more tabs — story + gotchas + gallery + updates all live in one
      // long scrollable column so the detail page reads like an article,
      // not a SaaS dashboard. The image_prompt section is gone entirely —
      // the prompt is stored for re-gen but not surfaced to visitors.
      // Detail-page achievements — percentile-based from server rankings
      const detailAchievements = [];
      // Likes percentile (likes_rank / total_agents)
      const likesPct = (item.likes_rank && item.total_agents > 1)
        ? ((item.likes_rank - 1) / item.total_agents) * 100 : null;
      if (likesPct != null && likesPct <= 1) detailAchievements.push({ icon: '👑', title: 'Legend', desc: `Top 1% most liked (#${item.likes_rank} of ${item.total_agents})`, legendary: true });
      else if (likesPct != null && likesPct <= 10) detailAchievements.push({ icon: '❤️', title: 'Fan Favorite', desc: `Top 10% most liked (#${item.likes_rank} of ${item.total_agents})` });
      // AI score percentile (ai_rank / total_scored)
      const aiPct = (item.ai_rank && item.total_scored > 1)
        ? ((item.ai_rank - 1) / item.total_scored) * 100 : null;
      if (aiPct != null && aiPct <= 1) detailAchievements.push({ icon: '💎', title: 'Apex Agent', desc: `Top 1% AI score (#${item.ai_rank} of ${item.total_scored})`, legendary: true });
      else if (aiPct != null && aiPct <= 10) detailAchievements.push({ icon: '✨', title: 'Elite', desc: `Top 10% AI score (#${item.ai_rank} of ${item.total_scored})` });
      // Absolute metrics
      if (item.time_saved_per_week >= 10) detailAchievements.push({ icon: '⚡', title: 'Time Saver', desc: `Saves ${item.time_saved_per_week}h+ every week` });
      if (item.runs_completed >= 500) detailAchievements.push({ icon: '🏆', title: 'Powerhouse', desc: `${fmtNumber(item.runs_completed)} agent sessions completed` });
      if (item.cron_jobs >= 5) detailAchievements.push({ icon: '⏰', title: 'Cron King', desc: `${item.cron_jobs} cron jobs running` });
      if (item.tokens_total >= 1000000) detailAchievements.push({ icon: '🧠', title: 'Token Titan', desc: `${fmtNumber(item.tokens_total)} total tokens processed` });
      if (item.approx_monthly_tokens >= 1000000) detailAchievements.push({ icon: '🧠', title: 'Token Beast', desc: `${fmtNumber(item.approx_monthly_tokens)} tokens/mo` });
      if (item.verified) detailAchievements.push({ icon: '✅', title: 'Verified', desc: 'Builder-verified agent' });
      if (item.running_since) {
        const sinceDate = Date.parse(item.running_since);
        if (Number.isFinite(sinceDate) && Date.now() - sinceDate > 30 * 86400000) {
          detailAchievements.push({ icon: '🛡️', title: 'Battle Tested', desc: 'Running 30+ days' });
        }
      }
      const achievementsSectionHtml = detailAchievements.length ? `
          <section class="detail-section achievements-section">
            <h2>🏅 Achievements</h2>
            <div class="achievements-grid">
              ${detailAchievements.map((a) => `
                <div class="achievement-card${a.legendary ? ' achievement-legendary' : ''}">
                  <span class="achievement-icon">${a.icon}</span>
                  <div class="achievement-info">
                    <span class="achievement-title">${escapeHtml(a.title)}</span>
                    <span class="achievement-desc">${escapeHtml(a.desc)}</span>
                  </div>
                </div>`).join('')}
            </div>
          </section>` : '';

      const overviewPanel = `
        <div class="overview-panel">
          ${highlightsSectionHtml}
          ${achievementsSectionHtml}
          <section class="detail-section">
            <h2>Brain Analysis</h2>
            <div class="detail-story-wrap">${formatStory(item.story || item.description || '')}</div>
          </section>

          ${hasGotchas ? `
          <section class="detail-section">
            <h2>Gotchas &amp; lessons</h2>
            <ul class="gotcha-list">
              ${item.gotchas.map((g) => `<li>${escapeHtml(g)}</li>`).join('')}
            </ul>
          </section>` : ''}

          <section class="detail-section updates-section">
            <h2>Updates${updateCount ? ` <span class="tab-badge">${updateCount}</span>` : ''}</h2>
            ${renderUpdatesPanel(item)}
          </section>

          ${item.ai_rationale ? (() => {
            const raw = item.ai_rationale;
            // Split rationale into individual line items.
            // Format: "Phase 1: Novelty 4.0 (detail), Autonomy 6.0 (detail). Summary. Final 45."
            // Strategy: split on ), then on .  — each becomes its own bullet.
            const items = [];
            // First split on "), " to get dimension entries
            const chunks = raw.split(/\),\s*/);
            if (chunks.length >= 3) {
              // Structured format with parenthesized details
              chunks.forEach((chunk, i) => {
                let c = chunk.trim();
                // Strip leading "Phase N: " from the first chunk
                c = c.replace(/^Phase\s*\d+:\s*/i, '');
                if (i < chunks.length - 1) c += ')'; // restore stripped )
                // The last chunk may contain "). Summary. Final." — split on ". "
                if (i === chunks.length - 1) {
                  c.split(/\.\s*/).filter(s => s.trim().length > 2).forEach(s => {
                    let t = s.trim().replace(/\.$/, '');
                    if (t) items.push(t);
                  });
                } else {
                  if (c.length > 2) items.push(c);
                }
              });
            } else {
              // Fallback: split on ". "
              raw.split(/\.\s+/).filter(s => s.trim().length > 3).forEach(s => {
                items.push(s.trim().replace(/\.$/, ''));
              });
            }
            // Style each item: highlight dimension names and scores
            const bullets = items.map(item => {
              const styled = escapeHtml(item)
                .replace(/^([\w]+)\s+([\d.]+)/,
                  '<span class="breakdown-dim">$1</span> <span class="breakdown-score">$2</span>')
                .replace(/(\([^)]+\))/g, '<span class="breakdown-detail">$1</span>')
                .replace(/(Final)\s+([\d.]+)/,
                  '<span class="breakdown-dim breakdown-final">$1</span> <span class="breakdown-score breakdown-final">$2</span>')
                .replace(/(Grade\s+[SABCD])/,
                  '<span class="breakdown-grade">$1</span>');
              return `<li>${styled}</li>`;
            }).join('');
            return `
          <section class="detail-section ai-breakdown-section">
            <h2>AI Score Breakdown</h2>
            <ul class="ai-breakdown-list">${bullets}</ul>
          </section>`;
          })() : ''}

          ${(item.score_history && item.score_history.length > 0) || item.ai_score != null ? (() => {
            const histLen = (item.score_history || []).length;
            const aiVal = item.ai_score != null ? (Number.isInteger(item.ai_score) ? item.ai_score : item.ai_score.toFixed(1)) : '—';
            const netVal = (item.likes || 0) - (item.dislikes || 0);
            const avgScore = item.site_avg_score != null ? item.site_avg_score : '—';
            const avgLikes = item.site_avg_likes != null ? item.site_avg_likes : '—';
            const aiDiff = item.ai_score != null && item.site_avg_score != null
              ? (item.ai_score - item.site_avg_score).toFixed(1) : null;
            const likeDiff = item.site_avg_likes != null
              ? (netVal - item.site_avg_likes).toFixed(1) : null;
            const diffBadge = (val) => {
              if (val == null) return '';
              const n = Number(val);
              if (n > 0) return `<span class="score-diff score-diff-up">+${val}</span>`;
              if (n < 0) return `<span class="score-diff score-diff-down">${val}</span>`;
              return `<span class="score-diff">±0</span>`;
            };
            return `
          <section class="detail-section score-history-section">
            <h2>Score Overview</h2>
            <div class="score-overview-grid">
              <div class="score-overview-item">
                <div class="score-overview-label">AI Score</div>
                <div class="score-overview-val score-overview-ai">${aiVal}</div>
                <div class="score-overview-cmp">Site avg: ${avgScore} ${diffBadge(aiDiff)}</div>
              </div>
              <div class="score-overview-item">
                <div class="score-overview-label">Net Likes</div>
                <div class="score-overview-val score-overview-likes">${netVal}</div>
                <div class="score-overview-cmp">Site avg: ${avgLikes} ${diffBadge(likeDiff)}</div>
              </div>
            </div>
            <canvas class="score-history-canvas" id="score-history-chart"></canvas>
          </section>`;
          })() : ''}

          ${commentsSectionHtml}
        </div>`;

      // Hero CTA buttons — prominent links to the agent's website and/or GitHub
      const heroCtas = [];
      if (item.website) {
        heroCtas.push(`<a class="hero-cta hero-cta-primary" href="${escapeHtml(item.website)}" target="_blank" rel="noopener">Visit Agent ↗</a>`);
      }
      if (item.github_url) {
        heroCtas.push(`<a class="hero-cta hero-cta-github" href="${escapeHtml(item.github_url)}" target="_blank" rel="noopener">View on GitHub ↗</a>`);
      }
      if (item.source_url && !item.github_url) {
        heroCtas.push(`<a class="hero-cta hero-cta-github" href="${escapeHtml(item.source_url)}" target="_blank" rel="noopener">View Source ↗</a>`);
      }
      const heroCtaHtml = heroCtas.length
        ? `<div class="hero-cta-row">${heroCtas.join('')}</div>` : '';

      // Hero metrics strip — pull 2-3 best impact numbers into the hero
      // running_since is reliable (agents pull earliest session date).
      // Numeric counts are self-reported — show them but label accordingly.
      const heroMetrics = [];
      if (item.running_since) heroMetrics.push(`<div class="hero-metric"><span class="hero-metric-val">${escapeHtml(fmtDate(item.running_since))}</span><span class="hero-metric-lbl">running since</span></div>`);
      if (item.total_interactions && heroMetrics.length < 3) heroMetrics.push(`<div class="hero-metric"><span class="hero-metric-val">${fmtNumber(item.total_interactions)}</span><span class="hero-metric-lbl">interactions</span></div>`);
      if (item.tasks_completed && heroMetrics.length < 3) heroMetrics.push(`<div class="hero-metric"><span class="hero-metric-val">${fmtNumber(item.tasks_completed)}</span><span class="hero-metric-lbl">tasks done</span></div>`);
      if (item.runs_completed && heroMetrics.length < 3) heroMetrics.push(`<div class="hero-metric"><span class="hero-metric-val">${fmtNumber(item.runs_completed)}</span><span class="hero-metric-lbl">agent sessions</span></div>`);
      if (item.active_users && item.active_users > 1 && heroMetrics.length < 3) heroMetrics.push(`<div class="hero-metric"><span class="hero-metric-val">${fmtNumber(item.active_users)}</span><span class="hero-metric-lbl">active users</span></div>`);
      if (item.time_saved_per_week && heroMetrics.length < 3) heroMetrics.push(`<div class="hero-metric"><span class="hero-metric-val">${item.time_saved_per_week}h</span><span class="hero-metric-lbl">saved / week</span></div>`);
      if (item.approx_monthly_tokens && heroMetrics.length < 3) heroMetrics.push(`<div class="hero-metric"><span class="hero-metric-val">${fmtNumber(item.approx_monthly_tokens)}</span><span class="hero-metric-lbl">tokens / mo</span></div>`);
      if (item.hours_used && heroMetrics.length < 3) heroMetrics.push(`<div class="hero-metric"><span class="hero-metric-val">${fmtNumber(item.hours_used)}</span><span class="hero-metric-lbl">hours used</span></div>`);
      const metricsNote = heroMetrics.length && !item.verified ? '<span class="hero-metrics-note">self-reported</span>' : '';
      const heroMetricsHtml = heroMetrics.length
        ? `<div class="hero-metrics-strip">${heroMetrics.slice(0, 3).join('')}${metricsNote}</div>` : '';

      root.innerHTML = `
        <a class="back-link" href="/">← Back to feed</a>
        ${authorBanner}

        <div class="detail-hero">
          <div class="detail-media">${media}</div>
          ${galleryAddHtml}
          <div class="detail-hero-head">
            ${item.category ? `<span class="chip chip-category">${escapeHtml(item.category)}</span>` : ''}
            <h1>${escapeHtml(item.title)}</h1>
            ${item.verified ? '<span class="verified-badge detail-verified">Verified</span>' : ''}
            <p class="detail-pitch">${escapeHtml(item.pitch || '')}</p>
            ${heroCtaHtml}
            ${heroMetricsHtml}
          </div>
        </div>

        ${scoreCardsHtml}

        <div class="detail-layout">
          <aside class="detail-side detail-side-left">
            ${authorCard}
            ${engagementCard}
            ${metricHtml}
            ${buildCard}
            ${techCard}
            ${infraCard}
            ${codeCard}
            ${tagsCard}
          </aside>

          <div class="detail-main">
            ${overviewPanel}
          </div>
        </div>
      `;

      const likeBtn = root.querySelector('.like-btn');
      if (likeBtn) {
        likeBtn.addEventListener('click', (e) => {
          e.preventDefault();
          toggleLike(Number(likeBtn.dataset.id), likeBtn);
        });
      }
      const dislikeBtn = root.querySelector('.dislike-btn');
      if (dislikeBtn) {
        dislikeBtn.addEventListener('click', (e) => {
          e.preventDefault();
          toggleDislike(Number(dislikeBtn.dataset.id), dislikeBtn);
        });
      }

      // Human score card — click the card to like, synced with sidebar like-btn
      const humanCard = root.querySelector('.human-card-likeable');
      if (humanCard && likeBtn) {
        const doLike = () => {
          toggleLike(Number(humanCard.dataset.id), likeBtn);
          // Sync visual state back to the human-card
          requestAnimationFrame(() => {
            const heart = humanCard.querySelector('.human-grade');
            const netEl = humanCard.querySelector('.human-card-net');
            const upEl = humanCard.querySelector('.human-card-up');
            if (heart) heart.classList.toggle('liked', likedSet.has(Number(humanCard.dataset.id)));
            if (heart && likedSet.has(Number(humanCard.dataset.id))) {
              heart.classList.add('like-burst');
              heart.addEventListener('animationend', () => heart.classList.remove('like-burst'), { once: true });
            }
            // Update counts from the canonical like-btn
            const likeCt = likeBtn.querySelector('.count');
            const disCt = root.querySelector('.dislike-btn .count');
            const up = Number(likeCt?.textContent) || 0;
            const down = Number(disCt?.textContent) || 0;
            if (netEl) netEl.textContent = up - down;
            if (upEl) upEl.textContent = up;
          });
        };
        humanCard.addEventListener('click', doLike);
        humanCard.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); doLike(); } });
      }

      // ---------- gallery: author upload + remove ----------
      // Author clicks the "+ Add image" slot, picks a file, we base64 it,
      // POST /api/uploads to get a /u/<hash>.webp URL, then PATCH the
      // submission with gallery_add + the delete token. On success we
      // re-render the whole detail page so the new image shows.
      const galleryUpload = root.querySelector('.gallery-upload');
      if (galleryUpload) {
        galleryUpload.addEventListener('change', async (e) => {
          const file = e.target.files && e.target.files[0];
          if (!file) return;
          const statusEl = root.querySelector('.gallery-add-status');
          const setStatus = (msg) => { if (statusEl) statusEl.textContent = msg; };
          if (file.size > 5 * 1024 * 1024) {
            setStatus('file too big — 5 MB max.');
            return;
          }
          setStatus('uploading…');
          try {
            const b64 = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => {
                // Strip the "data:<mime>;base64," prefix.
                const s = String(reader.result || '');
                const comma = s.indexOf(',');
                resolve(comma >= 0 ? s.slice(comma + 1) : s);
              };
              reader.onerror = () => reject(reader.error);
              reader.readAsDataURL(file);
            });
            const up = await fetch('/api/uploads', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ data: b64, mime: file.type }),
            });
            if (!up.ok) {
              const { error } = await up.json().catch(() => ({}));
              throw new Error(error || 'upload failed');
            }
            const { url } = await up.json();
            const patch = await fetch(`/api/submissions/${id}`, {
              method: 'PATCH',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ token: deleteToken, gallery_add: url }),
            });
            if (!patch.ok) {
              const { error } = await patch.json().catch(() => ({}));
              throw new Error(error || 'patch failed');
            }
            const updated = await patch.json();
            // Re-render with the fresh submission payload so the new image
            // appears and slot count decrements. is_author isn't returned
            // from PATCH, so carry it forward from the prior render.
            updated.is_author = true;
            render(updated);
          } catch (err) {
            setStatus(String(err && err.message ? err.message : 'upload failed'));
          }
        });
      }
      root.querySelectorAll('.gallery-remove').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const url = btn.getAttribute('data-gallery-url');
          if (!url) return;
          const ok = window.confirm('Remove this image from the gallery?');
          if (!ok) return;
          btn.disabled = true;
          try {
            const res = await fetch(`/api/submissions/${id}`, {
              method: 'PATCH',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ token: deleteToken, gallery_remove: url }),
            });
            if (!res.ok) {
              const { error } = await res.json().catch(() => ({}));
              throw new Error(error || 'remove failed');
            }
            const updated = await res.json();
            updated.is_author = true;
            render(updated);
          } catch (err) {
            btn.disabled = false;
            alert(String(err && err.message ? err.message : 'remove failed'));
          }
        });
      });

      // Delete button — only present when the author has a delete token.
      const deleteBtn = root.querySelector('.delete-btn');
      if (deleteBtn) {
        deleteBtn.addEventListener('click', async () => {
          const ok = window.confirm(
            'Delete this post permanently? This cannot be undone.'
          );
          if (!ok) return;
          deleteBtn.disabled = true;
          deleteBtn.textContent = 'Deleting…';
          try {
            const res = await fetch(
              `/api/submissions/${id}?token=${encodeURIComponent(deleteToken)}`,
              { method: 'DELETE' }
            );
            if (!res.ok) throw new Error('delete failed');
            // Success → send the user back to the feed.
            location.href = '/';
          } catch {
            deleteBtn.disabled = false;
            deleteBtn.textContent = 'Delete post';
            alert('Could not delete. Your delete token may be invalid.');
          }
        });
      }

      // ---------- hero carousel (prev/next/dots + lightbox) ----------
      const heroCarousel = root.querySelector('.hero-carousel');
      if (heroCarousel) {
        const slides = Array.from(heroCarousel.querySelectorAll('.hero-slide'));
        const dots = Array.from(heroCarousel.querySelectorAll('.hero-dot'));
        const counter = heroCarousel.querySelector('.hero-carousel-counter');
        let current = 0;

        function goTo(idx) {
          slides[current]?.classList.remove('active');
          dots[current]?.classList.remove('active');
          current = ((idx % slides.length) + slides.length) % slides.length;
          slides[current]?.classList.add('active');
          dots[current]?.classList.add('active');
          if (counter) counter.textContent = `${current + 1} / ${slides.length}`;
        }

        heroCarousel.querySelector('.hero-carousel-prev')?.addEventListener('click', () => goTo(current - 1));
        heroCarousel.querySelector('.hero-carousel-next')?.addEventListener('click', () => goTo(current + 1));
        dots.forEach((dot) => dot.addEventListener('click', () => goTo(Number(dot.dataset.idx))));

        // Touch/swipe support
        let touchX = null;
        heroCarousel.addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX; }, { passive: true });
        heroCarousel.addEventListener('touchend', (e) => {
          if (touchX == null) return;
          const dx = e.changedTouches[0].clientX - touchX;
          if (Math.abs(dx) > 40) goTo(dx < 0 ? current + 1 : current - 1);
          touchX = null;
        }, { passive: true });

        // Lightbox — click any hero slide image to view full-size
        heroCarousel.addEventListener('click', (e) => {
          const img = e.target.closest('.hero-slide img');
          if (!img) return;
          const allUrls = Array.from(heroCarousel.querySelectorAll('.hero-slide img')).map(i => i.src);
          let lbIdx = allUrls.indexOf(img.src);
          if (lbIdx === -1) lbIdx = 0;
          openLightbox(allUrls, lbIdx);
        });
      }

      // Lightbox for single hero image (non-carousel)
      if (!heroCarousel) {
        const singleImg = root.querySelector('.detail-media img');
        if (singleImg) {
          singleImg.style.cursor = 'zoom-in';
          singleImg.addEventListener('click', () => openLightbox([singleImg.src], 0));
        }
      }

      // Shared lightbox function
      function openLightbox(allUrls, startIdx) {
        let lbIdx = startIdx;
        const overlay = document.createElement('div');
        overlay.className = 'lightbox-overlay';
        const lbImg = document.createElement('img');
        lbImg.className = 'lightbox-img';
        lbImg.src = allUrls[lbIdx];
        lbImg.alt = 'Full size';
        overlay.appendChild(lbImg);

        if (allUrls.length > 1) {
          const prevBtn = document.createElement('button');
          prevBtn.className = 'lightbox-prev';
          prevBtn.innerHTML = '&#8249;';
          prevBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            lbIdx = (lbIdx - 1 + allUrls.length) % allUrls.length;
            lbImg.src = allUrls[lbIdx];
          });
          const nextBtn = document.createElement('button');
          nextBtn.className = 'lightbox-next';
          nextBtn.innerHTML = '&#8250;';
          nextBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            lbIdx = (lbIdx + 1) % allUrls.length;
            lbImg.src = allUrls[lbIdx];
          });
          overlay.appendChild(prevBtn);
          overlay.appendChild(nextBtn);
        }

        const closeBtn = document.createElement('button');
        closeBtn.className = 'lightbox-close';
        closeBtn.innerHTML = '&times;';
        function closeLightbox() {
          overlay.remove();
          document.removeEventListener('keydown', onKey);
        }
        closeBtn.addEventListener('click', (ev) => { ev.stopPropagation(); closeLightbox(); });
        overlay.appendChild(closeBtn);

        overlay.addEventListener('click', (ev) => {
          if (ev.target === overlay) closeLightbox();
        });

        function onKey(ev) {
          if (ev.key === 'Escape') closeLightbox();
          if (ev.key === 'ArrowLeft' && allUrls.length > 1) { lbIdx = (lbIdx - 1 + allUrls.length) % allUrls.length; lbImg.src = allUrls[lbIdx]; }
          if (ev.key === 'ArrowRight' && allUrls.length > 1) { lbIdx = (lbIdx + 1) % allUrls.length; lbImg.src = allUrls[lbIdx]; }
        }
        document.addEventListener('keydown', onKey);
        document.body.appendChild(overlay);
      }

      // Post-an-update form (author only).
      const postBtn = root.querySelector('.post-update-btn');
      if (postBtn) {
        postBtn.addEventListener('click', async () => {
          const textarea = root.querySelector('.update-input');
          const statusEl = root.querySelector('.post-update-status');
          const body = (textarea?.value || '').trim();
          if (!body) {
            if (statusEl) statusEl.textContent = 'write something first';
            return;
          }
          postBtn.disabled = true;
          if (statusEl) statusEl.textContent = 'posting…';
          try {
            const res = await fetch(`/api/submissions/${id}/updates`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ body, token: deleteToken }),
            });
            if (!res.ok) {
              const { error } = await res.json().catch(() => ({}));
              throw new Error(error || 'post failed');
            }
            if (statusEl) statusEl.textContent = 'posted — pending your approval below.';
            textarea.value = '';
            // Re-fetch so the pending list updates.
            setTimeout(() => location.reload(), 600);
          } catch (err) {
            if (statusEl) statusEl.textContent = err.message || 'could not post';
            postBtn.disabled = false;
          }
        });
      }

      // Approve / reject handlers for pending updates (author only).
      async function actOnUpdate(updateId, action, btn) {
        const li = btn.closest('.update-item');
        if (li) li.classList.add('acting');
        btn.disabled = true;
        try {
          const res = await fetch(
            `/api/submissions/${id}/updates/${updateId}/action`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ action, token: deleteToken }),
            }
          );
          if (!res.ok) {
            const { error } = await res.json().catch(() => ({}));
            throw new Error(error || 'action failed');
          }
          // Easiest: refetch the page so both lists resync.
          location.reload();
        } catch (err) {
          btn.disabled = false;
          if (li) li.classList.remove('acting');
          alert(err.message || 'could not update');
        }
      }
      root.querySelectorAll('.approve-btn').forEach((btn) => {
        btn.addEventListener('click', () =>
          actOnUpdate(Number(btn.dataset.updateId), 'approve', btn)
        );
      });
      root.querySelectorAll('.reject-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          if (!window.confirm('Reject this update? It will be deleted permanently.')) return;
          actOnUpdate(Number(btn.dataset.updateId), 'reject', btn);
        });
      });

      // ---------- comments: post + delete ----------
      const commentSubmit = root.querySelector('.comment-submit');
      if (commentSubmit) {
        commentSubmit.addEventListener('click', async () => {
          const nameInput = root.querySelector('.comment-name-input');
          const bodyInput = root.querySelector('.comment-body-input');
          const statusEl = root.querySelector('.comment-status');
          const name = (nameInput?.value || '').trim();
          const body = (bodyInput?.value || '').trim();
          if (!name) { if (statusEl) statusEl.textContent = 'a name or @handle is required.'; return; }
          if (!body) { if (statusEl) statusEl.textContent = 'write something first.'; return; }
          commentSubmit.disabled = true;
          if (statusEl) statusEl.textContent = 'posting…';
          try {
            const res = await fetch(`/api/submissions/${id}/comments`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ name, body }),
            });
            if (!res.ok) {
              const { error } = await res.json().catch(() => ({}));
              throw new Error(error || 'post failed');
            }
            if (bodyInput) bodyInput.value = '';
            if (statusEl) statusEl.textContent = '';
            setTimeout(() => location.reload(), 200);
          } catch (err) {
            if (statusEl) statusEl.textContent = err.message || 'could not post';
            commentSubmit.disabled = false;
          }
        });
      }

      root.querySelectorAll('.comment-delete').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const cid = btn.dataset.commentId;
          if (!cid) return;
          btn.disabled = true;
          try {
            const res = await fetch(`/api/submissions/${id}/comments/${cid}?token=${encodeURIComponent(deleteToken || '')}`, {
              method: 'DELETE',
            });
            if (!res.ok) {
              const { error } = await res.json().catch(() => ({}));
              throw new Error(error || 'delete failed');
            }
            const li = btn.closest('.comment-item');
            if (li) li.remove();
          } catch (err) {
            btn.disabled = false;
            alert(err.message || 'could not delete comment');
          }
        });
      });
    }

    // Load /api/meta (verify price/enabled) in parallel with the submission so
    // the render call can show the verify button with the right copy.
    // When the author has a delete token, we pass it to the submission
    // endpoint so pending updates come back in the response.
    const subUrl = deleteToken
      ? `/api/submissions/${id}?token=${encodeURIComponent(deleteToken)}`
      : `/api/submissions/${id}`;
    Promise.all([
      fetch(subUrl).then((r) => (r.ok ? r.json() : Promise.reject())),
      fetch('/api/meta').then((r) => r.json()).catch(() => ({})),
    ])
      .then(([item, meta]) => {
        window.__meta = meta;
        render(item);
        setupDetailNav(id, root);
        // Draw score history sparkline
        const canvas = document.getElementById('score-history-chart');
        if (canvas) drawScoreHistory(canvas, item);
        // Badge popover toggle
        const badgeBtn = root.querySelector('.badge-btn');
        const badgePop = root.querySelector('.badge-popover');
        if (badgeBtn && badgePop) {
          badgeBtn.addEventListener('click', () => {
            badgePop.style.display = badgePop.style.display === 'none' ? 'block' : 'none';
          });
        }
        // Re-bind copy buttons for dynamically added elements
        root.querySelectorAll('.copy-btn').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const text = btn.dataset.copyText;
            if (!text) return;
            try { await navigator.clipboard.writeText(text); } catch {}
            btn.textContent = 'copied!';
            setTimeout(() => { btn.textContent = 'copy'; }, 1500);
          });
        });
      })
      .catch(() => {
        root.innerHTML = `<div class="empty">Couldn't load this use case. It may have been removed.</div>`;
      });

    // --- Next / Prev agent navigation ---
    function setupDetailNav(currentId, rootEl) {
      let feedIds = [];
      try {
        feedIds = JSON.parse(sessionStorage.getItem('dh_feed_ids') || '[]');
      } catch { /* ignore */ }

      if (feedIds.length === 0) {
        // Direct link — fetch recent agents to populate nav
        fetch('/api/submissions?sort=trending&limit=20')
          .then(r => r.json())
          .then(items => {
            if (Array.isArray(items)) {
              feedIds = items.map(it => it.id);
              try { sessionStorage.setItem('dh_feed_ids', JSON.stringify(feedIds)); } catch {}
              renderDetailNav(currentId, feedIds, rootEl);
            }
          })
          .catch(() => {});
        return;
      }
      renderDetailNav(currentId, feedIds, rootEl);
    }

    let _navKeyHandler = null;
    function renderDetailNav(currentId, feedIds, rootEl) {
      const idx = feedIds.indexOf(currentId);
      if (idx === -1) return;
      const prevId = idx > 0 ? feedIds[idx - 1] : null;
      const nextId = idx < feedIds.length - 1 ? feedIds[idx + 1] : null;
      if (!prevId && !nextId) return;

      const nav = document.createElement('nav');
      nav.className = 'detail-nav-bar';
      nav.innerHTML = `
        ${prevId ? `<a class="detail-nav-btn" href="/use-cases/${prevId}">← Prev</a>` : '<span></span>'}
        <span class="detail-nav-pos">${idx + 1} of ${feedIds.length}</span>
        ${nextId ? `<a class="detail-nav-btn" href="/use-cases/${nextId}">Next →</a>` : '<span></span>'}
      `;
      rootEl.appendChild(nav);

      // Keyboard navigation (ArrowLeft / ArrowRight)
      // Remove any previous listener to avoid stacking
      if (_navKeyHandler) document.removeEventListener('keydown', _navKeyHandler);
      _navKeyHandler = function (e) {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        if (e.key === 'ArrowLeft' && prevId) window.location.href = `/use-cases/${prevId}`;
        if (e.key === 'ArrowRight' && nextId) window.location.href = `/use-cases/${nextId}`;
      };
      document.addEventListener('keydown', _navKeyHandler);
    }
  }

  // ==========================================================
  // STATS PAGE
  // ==========================================================
  function initStats() {
    if (document.body.dataset.page !== 'stats') return;
    if (typeof Chart === 'undefined') return;

    Chart.defaults.color = '#8a93a6';
    Chart.defaults.borderColor = '#232836';
    Chart.defaults.font.family =
      '-apple-system, BlinkMacSystemFont, Inter, "Segoe UI", Roboto, sans-serif';

    const PALETTE = [
      '#ff7a59', '#ffb86b', '#ffd166', '#70e000',
      '#38b6ff', '#7c5cff', '#c879ff', '#ff4d6d',
      '#42d6a4', '#f77f00', '#a8dadc', '#e0aaff',
    ];

    function barChart(canvas, rows, horizontal) {
      return new Chart(canvas, {
        type: 'bar',
        data: {
          labels: rows.map((r) => r.label),
          datasets: [{
            label: 'count',
            data: rows.map((r) => r.count),
            backgroundColor: rows.map((_, i) => PALETTE[i % PALETTE.length]),
            borderWidth: 0,
            borderRadius: 6,
          }],
        },
        options: {
          indexAxis: horizontal ? 'y' : 'x',
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { grid: { color: '#1c2030' } },
            y: { grid: { color: '#1c2030' } },
          },
        },
      });
    }

    function donutChart(canvas, rows) {
      return new Chart(canvas, {
        type: 'doughnut',
        data: {
          labels: rows.map((r) => r.label),
          datasets: [{
            data: rows.map((r) => r.count),
            backgroundColor: rows.map((_, i) => PALETTE[i % PALETTE.length]),
            borderWidth: 0,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { position: 'bottom' } },
          cutout: '65%',
        },
      });
    }

    function lineChart(canvas, rows, label) {
      return new Chart(canvas, {
        type: 'line',
        data: {
          labels: rows.map((r) => r.label),
          datasets: [{
            label: label || 'agents',
            data: rows.map((r) => r.count),
            borderColor: '#ff7a59',
            backgroundColor: 'rgba(255,122,89,0.15)',
            fill: true,
            tension: 0.3,
            pointRadius: 2,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { grid: { color: '#1c2030' } },
            y: { grid: { color: '#1c2030' }, beginAtZero: true },
          },
        },
      });
    }

    const donutKeys = new Set(['by_deployment', 'by_trigger', 'by_memory', 'tool_use', 'rag']);
    const horizontalKeys = new Set(['by_integration', 'by_tool', 'by_model']);
    const lineKeys = new Set(['daily', 'cumulative']);
    const LINE_LABELS = {
      daily: 'new agents',
      cumulative: 'total agents',
    };

    loadHeadline().then((data) => {
      if (!data) return;
      document.querySelectorAll('canvas[data-chart]').forEach((canvas) => {
        const key = canvas.dataset.chart;
        const rows = data[key];
        if (!rows || rows.length === 0) {
          canvas.outerHTML = '<div class="empty-chart">no data yet</div>';
          return;
        }
        if (lineKeys.has(key)) lineChart(canvas, rows, LINE_LABELS[key] || key);
        else if (donutKeys.has(key)) donutChart(canvas, rows);
        else barChart(canvas, rows, horizontalKeys.has(key));
      });

      // GitHub repo stats section
      const ghSection = document.getElementById('github-stats');
      if (ghSection && data.github) {
        const gh = data.github;
        ghSection.style.display = '';
        const setText = (id, val) => {
          const el = document.getElementById(id);
          if (el && val != null) el.textContent = fmtNumber(val);
        };
        setText('gh-stars', gh.stars);
        setText('gh-forks', gh.forks);
        setText('gh-contributors', gh.contributors);
        const rankEl = document.getElementById('gh-rank');
        if (rankEl && gh.global_rank) rankEl.textContent = '#' + fmtNumber(gh.global_rank);

        // Star history chart
        const ghHistory = data.github_history;
        const starsCanvas = document.getElementById('gh-stars-chart');
        if (starsCanvas && Array.isArray(ghHistory) && ghHistory.length > 0) {
          new Chart(starsCanvas, {
            type: 'line',
            data: {
              labels: ghHistory.map((r) => r.date),
              datasets: [{
                label: 'stars',
                data: ghHistory.map((r) => r.stars),
                borderColor: '#ffd166',
                backgroundColor: 'rgba(255,209,102,0.12)',
                fill: true,
                tension: 0.3,
                pointRadius: 2,
              }],
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              plugins: { legend: { display: false } },
              scales: {
                x: { grid: { color: '#1c2030' } },
                y: { grid: { color: '#1c2030' } },
              },
            },
          });
        }
      }

      // Daily framework breakdown — stacked area/bar chart
      const dfCanvas = document.getElementById('daily-framework-chart');
      const df = data.daily_framework;
      if (dfCanvas && df && df.labels && df.labels.length > 0 && df.datasets) {
        const fwNames = Object.keys(df.datasets);
        new Chart(dfCanvas, {
          type: 'bar',
          data: {
            labels: df.labels,
            datasets: fwNames.map((fw, i) => ({
              label: fw,
              data: df.datasets[fw],
              backgroundColor: PALETTE[i % PALETTE.length],
              borderWidth: 0,
              borderRadius: 3,
            })),
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { position: 'bottom' } },
            scales: {
              x: { stacked: true, grid: { color: '#1c2030' } },
              y: { stacked: true, grid: { color: '#1c2030' }, beginAtZero: true },
            },
          },
        });
      }
    });
  }

  // ---------- rankings page ----------
  function initRankings() {
    const VIEWS = {
      ai: {
        url: '/api/rankings?limit=50',
        empty: 'No scored agents yet. Check back soon!',
      },
      liked: {
        url: '/api/submissions?sort=top&limit=50',
        empty: 'No liked agents yet. Head to the feed and smash some hearts.',
      },
    };

    let currentView = 'ai';
    let viewMode = 'grid'; // default to card grid view

    // Initialize view-toggle buttons
    function initViewToggle() {
      var toggleContainer = document.getElementById('view-toggle');
      if (!toggleContainer) return;
      toggleContainer.querySelectorAll('.view-toggle-btn').forEach(function(btn) {
        btn.classList.toggle('active', btn.dataset.mode === viewMode);
        btn.addEventListener('click', function() {
          var mode = btn.dataset.mode;
          if (mode === viewMode) return;
          viewMode = mode;
          toggleContainer.querySelectorAll('.view-toggle-btn').forEach(function(b) {
            b.classList.toggle('active', b.dataset.mode === viewMode);
          });
          loadRankings(currentView);
        });
      });
    }
    initViewToggle();

    function renderRankRow(item, rank, view) {
      var medals = ['\u{1F947}', '\u{1F948}', '\u{1F949}'];
      var rankLabel = rank <= 3
        ? '<span class="ranking-row-medal">' + medals[rank - 1] + '</span>'
        : '<span class="ranking-row-num">#' + rank + '</span>';

      var likes = Number(item.likes) || 0;
      var dislikes = Number(item.dislikes) || 0;
      var netLikes = likes - dislikes;
      var score = item.ai_score || 0;
      var scoreDisplay = Number.isInteger(score) ? score : score.toFixed(1);

      var scoreHtml;
      if (view === 'ai' && score) {
        scoreHtml = '<span class="ranking-row-score"><span class="ranking-row-score-num">' + scoreDisplay + '</span> <span class="ranking-row-score-label">AI</span></span>';
      } else {
        scoreHtml = '<span class="ranking-row-score ranking-row-score-likes">\u2665 ' + netLikes + '</span>';
      }

      var imgHtml = item.image_url
        ? '<div class="ranking-row-img"><img src="' + escapeHtml(item.image_url) + '" alt="" loading="lazy" referrerpolicy="no-referrer" /></div>'
        : '<div class="ranking-row-img ranking-row-img-placeholder"><span class="brand-mark">\u25C6</span></div>';

      var author = item.twitter_handle
        ? '<a class="ranking-row-author" href="https://x.com/' + escapeHtml(item.twitter_handle) + '" target="_blank" rel="noopener">@' + escapeHtml(item.twitter_handle) + '</a>'
        : item.display_name
          ? '<span class="ranking-row-author">' + escapeHtml(item.display_name) + '</span>'
          : '';

      return '<div class="ranking-row' + (rank <= 3 ? ' ranking-row-top' : '') + '" data-href="/use-cases/' + item.id + '">'
        + '<span class="ranking-row-rank">' + rankLabel + '</span>'
        + imgHtml
        + '<a class="ranking-row-title" href="/use-cases/' + item.id + '">' + escapeHtml(item.title) + '</a>'
        + '<span class="ranking-row-author-cell">' + author + '</span>'
        + scoreHtml
        + '<span class="ranking-row-actions">' + likeBtnHtml(item) + '</span>'
        + '</div>';
    }

    async function loadRankings(view) {
      const grid = document.getElementById('rankings-grid');
      if (!grid) return;

      const cfg = VIEWS[view] || VIEWS.ai;
      grid.innerHTML = '<div class="loading">Loading rankings\u2026</div>';

      try {
        const res = await fetch(cfg.url);
        const items = await res.json();

        if (!Array.isArray(items) || items.length === 0) {
          grid.innerHTML = '<p class="empty">' + cfg.empty + '</p>';
          return;
        }

        if (viewMode === 'list') {
          grid.className = 'rankings-list';
          grid.innerHTML = items.map(function(item, i) { return renderRankRow(item, i + 1, view); }).join('');
        } else {
          grid.className = 'rankings-grid';
          grid.innerHTML = items.map(function(item, i) { return renderRankCard(item, i + 1, view); }).join('');
        }

        // Wire up like buttons
        grid.querySelectorAll('.like-btn').forEach((btn) => {
          btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            toggleLike(Number(btn.dataset.id), btn);
          });
        });
        // Wire up dislike buttons
        grid.querySelectorAll('.dislike-btn').forEach((btn) => {
          btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            toggleDislike(Number(btn.dataset.id), btn);
          });
        });
        // Card click → detail (grid cards)
        grid.querySelectorAll('.ranking-card[data-href]').forEach((card) => {
          card.addEventListener('click', (e) => {
            if (e.target.closest('a, button')) return;
            location.href = card.dataset.href;
          });
        });
        // Row click → detail (list rows)
        grid.querySelectorAll('.ranking-row[data-href]').forEach(function(row) {
          row.addEventListener('click', function(e) {
            if (e.target.closest('a, button')) return;
            location.href = row.dataset.href;
          });
        });
      } catch (err) {
        grid.innerHTML = '<p class="empty">Failed to load rankings. Try refreshing.</p>';
      }
    }

    function renderRankCard(item, rank, view) {
      const medals = ['🥇', '🥈', '🥉'];
      const rankBadge = rank <= 3
        ? `<span class="ranking-medal">${medals[rank - 1]}</span>`
        : `<span class="ranking-num">#${rank}</span>`;

      const likes = Number(item.likes) || 0;
      const dislikes = Number(item.dislikes) || 0;
      const netLikes = likes - dislikes;
      const score = item.ai_score || 0;
      const scoreDisplay = Number.isInteger(score) ? score : score.toFixed(1);

      // Score display differs by view
      let scoreBlock;
      if (view === 'ai' && score) {
        scoreBlock = `<div class="ranking-score-block">
          <span class="ranking-score-num">${scoreDisplay}</span>
          <span class="ranking-score-label">AI Score</span>
        </div>`;
      } else {
        scoreBlock = `<div class="ranking-score-block">
          <span class="ranking-likes-num">♥ ${netLikes}</span>
        </div>`;
      }

      // Image
      const imgHtml = item.image_url
        ? `<div class="ranking-card-img"><img src="${escapeHtml(item.image_url)}" alt="" loading="lazy" referrerpolicy="no-referrer" /></div>`
        : `<div class="ranking-card-img ranking-card-placeholder"><span class="brand-mark">◆</span></div>`;

      // Author
      const author = item.twitter_handle
        ? `<a class="ranking-author" href="https://x.com/${escapeHtml(item.twitter_handle)}" target="_blank" rel="noopener">@${escapeHtml(item.twitter_handle)}</a>`
        : item.display_name
          ? `<span class="ranking-author">${escapeHtml(item.display_name)}</span>`
          : '';

      // Tags (max 3)
      const tags = Array.isArray(item.tags) ? item.tags : [];
      const tagHtml = tags.slice(0, 3).map(t => `<span class="chip">${escapeHtml(t)}</span>`).join('');

      return `
        <div class="ranking-card${rank <= 3 ? ' ranking-top' : ''}" data-href="/use-cases/${item.id}">
          ${rankBadge}
          ${imgHtml}
          <div class="ranking-card-body">
            <a class="ranking-card-title" href="/use-cases/${item.id}">${escapeHtml(item.title)}</a>
            ${item.pitch ? `<p class="ranking-card-pitch">${escapeHtml(item.pitch)}</p>` : ''}
            ${scoreBlock}
            ${tagHtml ? `<div class="chip-row">${tagHtml}</div>` : ''}
            <div class="ranking-card-foot">
              ${author}
              ${likeBtnHtml(item)}
            </div>
          </div>
        </div>`;
    }

    document.querySelectorAll('.rankings-tabs .tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        const view = tab.dataset.view;
        if (!view || view === currentView) return;
        currentView = view;
        document.querySelectorAll('.rankings-tabs .tab').forEach((t) => {
          t.classList.toggle('active', t === tab);
        });
        loadRankings(view);
      });
    });

    loadRankings(currentView);
  }

  // ---------- dispatch by page ----------
  const page = document.body.dataset.page;
  if (page === 'feed') initFeed();
  else if (page === 'detail') initDetail();
  else if (page === 'stats') initStats();
  else if (page === 'rankings') initRankings();
  // submit page has no JS beyond the shared copy button handler above
})();
