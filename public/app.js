// DiscoverHermes frontend — vanilla JS, no build step.
//
// Page-aware: checks <body data-page="..."> and runs only the code for
// whichever page is loaded (feed, detail, stats, submit).

(function () {
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
      return data;
    } catch {
      return null;
    }
  }

  // ---------- likes: shared liked-id set across pages ----------
  const LIKED_KEY = 'dh_liked_ids_v1';
  const likedSet = new Set(JSON.parse(localStorage.getItem(LIKED_KEY) || '[]'));
  const saveLiked = () => localStorage.setItem(LIKED_KEY, JSON.stringify([...likedSet]));

  async function toggleLike(id, btn) {
    const wasLiked = likedSet.has(id);
    const countEl = btn.querySelector('.count');
    const current = Number(countEl.textContent) || 0;

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
    }
    saveLiked();

    try {
      const res = await fetch(`/api/submissions/${id}/like`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ unlike: wasLiked }),
      });
      if (res.ok) {
        const data = await res.json();
        countEl.textContent = data.likes;
      }
    } catch {
      /* optimistic UI is fine */
    }
  }

  function likeBtnHtml(item) {
    const liked = likedSet.has(item.id);
    return `
      <button class="like-btn ${liked ? 'liked' : ''}" data-id="${item.id}"
              aria-pressed="${liked}">
        <span class="heart"></span>
        <span class="count">${item.likes}</span>
      </button>`;
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
      return `
        <div class="card-media">
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
    if (item.category) chips.push(['category', item.category]);
    if (Array.isArray(item.integrations) && item.integrations[0]) {
      chips.push(['integration', item.integrations[0]]);
    }
    if (item.model) chips.push(['model', item.model]);
    else if (item.platform) chips.push(['platform', item.platform]);
    if (item.time_saved_per_week) chips.push(['hours', `${item.time_saved_per_week}h/wk saved`]);
    else if (item.runs_completed) chips.push(['runs', `${fmtNum(item.runs_completed)} runs`]);
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
    const state = {
      sort:        'trending',
      category:    '',
      q:           '',
      verified:    false,
      integration: initialParams.get('integration') || '',
      tool:        initialParams.get('tool') || '',
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

    function cardHtml(item, extraClass = '') {
      const fresh = isNew(item);
      const cls = ['card'];
      if (fresh) cls.push('is-new');
      if (extraClass) cls.push(extraClass);
      const badge = fresh
        ? `<span class="new-badge">New</span>`
        : (extraClass.includes('is-trending') ? `<span class="trending-badge">🔥 Trending</span>` : '');
      // Gallery indicator — show image count if agent has multiple images
      const gallery = Array.isArray(item.gallery) ? item.gallery : [];
      const galleryCount = (item.image_url ? 1 : 0) + gallery.length;
      const galleryBadge = galleryCount > 1
        ? `<span class="gallery-badge" title="${galleryCount} images">📷 ${galleryCount}</span>` : '';
      // AI grade badge — show letter grade when scored
      const gradeBadge = item.ai_grade
        ? `<span class="grade-badge grade-${item.ai_grade.toLowerCase()}">${escapeHtml(item.ai_grade)}</span>` : '';
      return `
        <div class="${cls.join(' ')}" data-href="/use-cases/${item.id}" data-id="${item.id}">
          ${badge}${galleryBadge}
          ${mediaBlock(item)}
          <div class="card-body">
            <h3 class="card-title">${escapeHtml(item.title)}</h3>
            <p class="card-pitch">${escapeHtml(item.pitch || item.description || '')}</p>
            <div class="chip-row">${chipRow(item)}</div>
            <div class="card-foot">
              <span class="card-author">${handleBlock(item)}${verifiedBadge(item)}${gradeBadge}</span>
              ${likeBtnHtml(item)}
            </div>
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
      // Skeleton loading cards — shimmer while the API responds
      feedEl.classList.remove('feed-loaded');
      feedEl.innerHTML = Array.from({ length: 6 }, () => `
        <div class="card skeleton">
          <div class="card-media skeleton-shimmer"></div>
          <div class="card-body">
            <div class="skeleton-line" style="width:80%"></div>
            <div class="skeleton-line" style="width:60%"></div>
            <div class="skeleton-line short" style="width:40%"></div>
          </div>
        </div>`).join('');
      renderFilterBanner();
      const params = new URLSearchParams();
      params.set('sort', state.sort);
      if (state.category) params.set('category', state.category);
      if (state.q) params.set('q', state.q);
      if (state.verified) params.set('verified', '1');
      if (state.integration) params.set('integration', state.integration);
      if (state.tool) params.set('tool', state.tool);
      try {
        const res = await fetch('/api/submissions?' + params.toString());
        const items = await res.json();
        if (!Array.isArray(items) || items.length === 0) {
          feedEl.innerHTML = `
            <div class="empty">
              <div class="empty-icon">◆</div>
              <p>${state.q || state.category
                ? 'No matches found. Try a different filter.'
                : 'Nothing here yet.'}</p>
              <a class="empty-cta" href="/submit">Be the first to post →</a>
            </div>`;
          return;
        }
        // Mark top 3 as trending when viewing the trending sort
        const trendingIds = new Set();
        if (state.sort === 'trending' && items.length > 1) {
          items.slice(0, 3).forEach((it) => trendingIds.add(it.id));
        }
        feedEl.innerHTML = items.map((item, i) => {
          const extra = trendingIds.has(item.id) ? 'is-trending' : '';
          return cardHtml(item, extra).replace('<div class="card', `<div style="--i:${i}" class="card`);
        }).join('');
        feedEl.classList.add('feed-loaded');
      } catch {
        feedEl.innerHTML = `
          <div class="empty">
            <div class="empty-icon">◆</div>
            <p>Couldn't load the feed.</p>
            <button class="empty-cta" onclick="location.reload()">Refresh →</button>
          </div>`;
      }
    }

    // Like click — event delegation (prevent navigation to detail page)
    feedEl.addEventListener('click', async (e) => {
      const btn = e.target.closest('.like-btn');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      toggleLike(Number(btn.dataset.id), btn);
    });

    // Card click — navigate to detail page.
    // Cards are <div> (not <a>) to avoid invalid nested-anchor HTML which
    // breaks DOM rendering.  We delegate clicks here instead.
    feedEl.addEventListener('click', (e) => {
      // Skip if the click was on an interactive child (link, button)
      if (e.target.closest('a') || e.target.closest('button')) return;
      const card = e.target.closest('.card[data-href]');
      if (card) window.location.href = card.dataset.href;
    });

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
    const VISIBLE_CAP = 6;
    fetch('/api/meta').then((r) => r.json()).then((meta) => {
      const populated = Array.isArray(meta.category_counts) ? meta.category_counts : [];
      // Hide the whole row if nothing is populated yet — no point rendering
      // just an "All" pill with nothing to filter to.
      if (populated.length === 0) {
        catRow.style.display = 'none';
        return;
      }

      function makePill(name, count, cls = 'pill') {
        const btn = document.createElement('button');
        btn.className = cls;
        btn.dataset.category = name || '';
        btn.innerHTML = name
          ? `${escapeHtml(name)}<span class="pill-count">${count}</span>`
          : 'All';
        return btn;
      }

      // "All" is always first and always active on load.
      const allBtn = makePill('', 0);
      allBtn.classList.add('active');
      catRow.appendChild(allBtn);

      const visible = populated.slice(0, VISIBLE_CAP);
      const overflow = populated.slice(VISIBLE_CAP);
      visible.forEach((c) => catRow.appendChild(makePill(c.name, c.count)));

      // Overflow toggle — only if there's something to hide.
      if (overflow.length > 0) {
        const moreBtn = document.createElement('button');
        moreBtn.className = 'pill pill-more';
        moreBtn.type = 'button';
        moreBtn.textContent = `More (${overflow.length}) ↓`;
        catRow.appendChild(moreBtn);

        const hiddenPills = overflow.map((c) => {
          const pill = makePill(c.name, c.count, 'pill pill-hidden');
          catRow.appendChild(pill);
          return pill;
        });

        moreBtn.addEventListener('click', () => {
          const nowOpen = !moreBtn.classList.contains('open');
          moreBtn.classList.toggle('open', nowOpen);
          hiddenPills.forEach((p) => p.classList.toggle('pill-hidden', !nowOpen));
          moreBtn.textContent = nowOpen
            ? 'Less ↑'
            : `More (${overflow.length}) ↓`;
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
            [...feedEl.querySelectorAll('.card[data-id]')].map((n) => Number(n.dataset.id))
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
            wrapper.innerHTML = cardHtml(item, 'just-arrived');
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

    loadHeadline();
    loadFeed();
    startLivePoll();
    loadFeatured();
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
      const media = item.video_url
        ? `<video src="${escapeHtml(item.video_url)}" controls playsinline></video>`
        : item.image_url
        ? `<img src="${escapeHtml(item.image_url)}" alt="" referrerpolicy="no-referrer" />`
        : `<div class="placeholder-big">◆</div>`;

      const hasTech =
        item.integrations?.length || item.tools_used?.length ||
        item.data_sources?.length || item.output_channels?.length ||
        item.trigger_type || item.platform;

      const hasInfra =
        item.model || item.model_provider || item.deployment || item.host ||
        item.context_window || item.memory_type || item.tool_use != null || item.rag != null;

      const hasMetrics =
        item.running_since || item.time_saved_per_week || item.runs_completed ||
        item.hours_used || item.approx_monthly_tokens;

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
        const trimmed = raw.trim();

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

        function scoreImportance(s) {
          let n = 0;
          if (/\d/.test(s)) n += 3;
          const caps = (s.match(/\b[A-Z][a-z]{2,}/g) || []).length;
          n += Math.min(caps, 3) * 2;
          if (s.length >= 30 && s.length <= 150) n += 1;
          if (s.length < 20) n -= 1;
          return n;
        }

        // Collect all sentences across all paragraphs to find the two best.
        const allSentences = rawParas.flatMap(tokenizeSentences);
        const boldSet = new Set();

        if (allSentences.length > 0) {
          // Always bold the first sentence.
          boldSet.add(allSentences[0].text);
          if (allSentences.length > 1) {
            // Bold the highest-scoring remaining sentence.
            let best = allSentences[1], bestScore = -Infinity;
            for (let i = 1; i < allSentences.length; i++) {
              const sc = scoreImportance(allSentences[i].text);
              if (sc > bestScore) { bestScore = sc; best = allSentences[i]; }
            }
            boldSet.add(best.text);
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
               <p class="muted">Check back — this agent is still evolving. Builders post what's new here every week.</p>
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
        : '';
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
          <div class="author-posted muted">Posted ${escapeHtml((item.created_at || '').split(' ')[0] || '')}</div>
        </div>`;

      // Engagement card — like button + share button
      const shareHref = item.share_tweet_url ? escapeHtml(item.share_tweet_url) : '#';
      const engagementCard = `
        <div class="side-card engagement-card">
          <div class="engagement-row">
            ${likeBtnHtml(item).replace('class="like-btn"', 'class="like-btn like-btn-big"')}
            <a class="share-btn" href="${shareHref}" target="_blank" rel="noopener" title="Share on X">
              <span class="share-icon">↗</span> Share
            </a>
          </div>
        </div>`;

      // At-a-glance metric card — big numbers for the impact
      const metricHtml = hasMetrics ? `
        <div class="side-card metric-card">
          <h3>At a glance</h3>
          <div class="side-metrics">
            ${item.time_saved_per_week ? `<div class="side-metric"><span class="side-metric-val">${item.time_saved_per_week}h</span><span class="side-metric-lbl">saved / week</span></div>` : ''}
            ${item.runs_completed ? `<div class="side-metric"><span class="side-metric-val">${fmtNumber(item.runs_completed)}</span><span class="side-metric-lbl">runs</span></div>` : ''}
            ${item.hours_used ? `<div class="side-metric"><span class="side-metric-val">${fmtNumber(item.hours_used)}</span><span class="side-metric-lbl">hours used</span></div>` : ''}
            ${item.approx_monthly_tokens ? `<div class="side-metric"><span class="side-metric-val">${fmtNumber(item.approx_monthly_tokens)}</span><span class="side-metric-lbl">tokens / mo</span></div>` : ''}
            ${item.running_since ? `<div class="side-metric wide"><span class="side-metric-val">${escapeHtml(item.running_since)}</span><span class="side-metric-lbl">running since</span></div>` : ''}
          </div>
        </div>` : '';

      // AI score card — includes a deep-link to the full rankings page so
      // visitors can jump from "this one got a 78/B+" to "how does that
      // stack up against every other agent in the category?"
      const rankingsHref = item.category
        ? `/rankings?category=${encodeURIComponent(item.category)}`
        : '/rankings';
      const aiCard = hasAiScore ? `
        <div class="side-card ai-card">
          <h3>AI Score</h3>
          <div class="ai-card-row">
            <span class="rank-grade grade-${item.ai_grade || 'C'}">${escapeHtml(item.ai_grade || '—')}</span>
            <div>
              <div class="ai-score-num">${item.ai_score}<span class="ai-score-unit">/100</span></div>
              <div class="score-bar"><div class="score-fill" style="width: ${item.ai_score}%"></div></div>
            </div>
          </div>
          ${item.featured && item.featured_reason ? `<p class="ai-featured muted">★ ${escapeHtml(item.featured_reason)}</p>` : ''}
          <a class="ai-rankings-link" href="${rankingsHref}">
            See ${item.category ? escapeHtml(item.category) + ' ' : ''}rankings ↗
          </a>
        </div>` : '';

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
      ` : '';
      const infraCard = sideCard('Infrastructure', infraBody);

      const codeBody = hasCode ? `
        ${item.github_url ? `<div class="side-kv"><span class="side-kv-label">GitHub</span><span class="side-kv-value"><a class="ext-link" href="${escapeHtml(item.github_url)}" target="_blank" rel="noopener">${escapeHtml((item.github_url || '').replace(/^https?:\/\/(www\.)?/, ''))}</a></span></div>` : ''}
        ${item.source_url ? `<div class="side-kv"><span class="side-kv-label">Gist / source</span><span class="side-kv-value"><a class="ext-link" href="${escapeHtml(item.source_url)}" target="_blank" rel="noopener">${escapeHtml((item.source_url || '').replace(/^https?:\/\/(www\.)?/, ''))}</a></span></div>` : ''}
      ` : '';
      const codeCard = sideCard('Source & code', codeBody);

      const tagsBody = hasTags ? sideChipList(item.tags) : '';
      const tagsCard = sideCard('Tags', tagsBody);

      // Rankings + community card — always show (even 0 likes is meaningful).
      // Rank is rendered as "#N of M" so visitors see the size of the pool.
      // total_agents = all approved submissions (the Likes pool).
      // total_scored = approved submissions with an ai_score (the AI pool).
      const likesRankStr = item.likes_rank != null
        ? (item.total_agents ? `#${item.likes_rank} of ${item.total_agents}` : `#${item.likes_rank}`)
        : null;
      const aiRankStr = item.ai_rank != null
        ? (item.total_scored ? `#${item.ai_rank} of ${item.total_scored}` : `#${item.ai_rank}`)
        : null;
      const rankCard = `
        <div class="side-card rank-card">
          <h3>Community</h3>
          ${sideKv('Likes', String(Number(item.likes) || 0))}
          ${likesRankStr ? sideKv('Likes rank', likesRankStr) : ''}
          ${aiRankStr ? sideKv('AI score rank', aiRankStr) : ''}
          <a class="ai-rankings-link" href="/rankings">View all rankings ↗</a>
        </div>`;

      // ---------- gallery (secondary images, max 5) ----------
      // Author can add screenshots of the dashboard / terminal / output
      // from the detail page once posted. Stored as a JSON array on the
      // submission; mutated via PATCH gallery_add / gallery_remove.
      const GALLERY_MAX = 5;
      const galleryList = Array.isArray(item.gallery) ? item.gallery : [];
      const isAuthor = !!item.is_author;
      const galleryItemsHtml = galleryList.map((url, idx) => `
        <figure class="gallery-item">
          <img src="${escapeHtml(url)}" alt="Gallery image ${idx + 1}"
               loading="lazy" referrerpolicy="no-referrer" />
          ${isAuthor ? `
          <button class="gallery-remove" type="button"
                  data-gallery-url="${escapeHtml(url)}"
                  title="Remove from gallery">×</button>` : ''}
        </figure>`).join('');
      const galleryAddSlotHtml = isAuthor && galleryList.length < GALLERY_MAX ? `
        <label class="gallery-add" for="gallery-upload-${item.id}">
          <input type="file" id="gallery-upload-${item.id}" class="gallery-upload"
                 accept="image/png,image/jpeg,image/webp,image/gif" hidden />
          <div class="gallery-add-inner">
            <span class="gallery-add-icon">+</span>
            <span class="gallery-add-label">
              Add image<br>
              <span class="muted">${GALLERY_MAX - galleryList.length} slot${GALLERY_MAX - galleryList.length === 1 ? '' : 's'} left</span>
            </span>
          </div>
          <div class="gallery-add-status muted"></div>
        </label>` : '';
      const hasGallerySection = galleryList.length > 0 || isAuthor;
      const carouselSlides = galleryList.map((url, i) => `
        <div class="carousel-slide${i === 0 ? ' active' : ''}" data-idx="${i}">
          <img src="${escapeHtml(url)}" alt="Gallery image ${i + 1}" loading="lazy" referrerpolicy="no-referrer" />
          ${isAuthor ? `<button class="gallery-remove carousel-remove" type="button" data-gallery-url="${escapeHtml(url)}" title="Remove image">×</button>` : ''}
        </div>`).join('');
      const carouselDots = galleryList.length > 1
        ? `<div class="carousel-dots">${galleryList.map((_, i) => `<button class="carousel-dot${i === 0 ? ' active' : ''}" data-idx="${i}" type="button"></button>`).join('')}</div>`
        : '';
      const gallerySectionHtml = hasGallerySection ? `
        <section class="detail-section gallery-section">
          <h2>Gallery${galleryList.length ? ` <span class="tab-badge">${galleryList.length}/${GALLERY_MAX}</span>` : ''}</h2>
          ${galleryList.length === 0 && isAuthor
            ? `<p class="muted gallery-empty">Show off what you built — upload screenshots of the dashboard, terminal output, Telegram chat, whatever is most visual. Up to ${GALLERY_MAX} images.</p>`
            : ''}
          ${galleryList.length > 0 ? `
          <div class="gallery-carousel">
            <div class="carousel-track">
              ${carouselSlides}
            </div>
            ${galleryList.length > 1 ? `
            <button class="carousel-prev" type="button" aria-label="Previous">&#8249;</button>
            <button class="carousel-next" type="button" aria-label="Next">&#8250;</button>` : ''}
            ${carouselDots}
          </div>` : ''}
          ${galleryAddSlotHtml ? `<div class="gallery-add-wrap">${galleryAddSlotHtml}</div>` : ''}
        </section>` : '';

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

      // ---------- build the main overview panel ----------
      // No more tabs — story + gotchas + gallery + updates all live in one
      // long scrollable column so the detail page reads like an article,
      // not a SaaS dashboard. The image_prompt section is gone entirely —
      // the prompt is stored for re-gen but not surfaced to visitors.
      const overviewPanel = `
        <div class="overview-panel">
          <section class="detail-section">
            <h2>The story</h2>
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
      const heroMetrics = [];
      if (item.time_saved_per_week) heroMetrics.push(`<div class="hero-metric"><span class="hero-metric-val">${item.time_saved_per_week}h</span><span class="hero-metric-lbl">saved / week</span></div>`);
      if (item.runs_completed) heroMetrics.push(`<div class="hero-metric"><span class="hero-metric-val">${fmtNumber(item.runs_completed)}</span><span class="hero-metric-lbl">runs</span></div>`);
      if (item.approx_monthly_tokens) heroMetrics.push(`<div class="hero-metric"><span class="hero-metric-val">${fmtNumber(item.approx_monthly_tokens)}</span><span class="hero-metric-lbl">tokens / mo</span></div>`);
      if (item.hours_used && heroMetrics.length < 3) heroMetrics.push(`<div class="hero-metric"><span class="hero-metric-val">${fmtNumber(item.hours_used)}</span><span class="hero-metric-lbl">hours used</span></div>`);
      if (item.running_since && heroMetrics.length < 3) heroMetrics.push(`<div class="hero-metric"><span class="hero-metric-val">${escapeHtml(item.running_since)}</span><span class="hero-metric-lbl">running since</span></div>`);
      const heroMetricsHtml = heroMetrics.length
        ? `<div class="hero-metrics-strip">${heroMetrics.slice(0, 3).join('')}</div>` : '';

      root.innerHTML = `
        <a class="back-link" href="/">← Back to feed</a>
        ${authorBanner}

        <div class="detail-hero">
          <div class="detail-media">${media}</div>
          <div class="detail-hero-head">
            ${item.category ? `<span class="chip chip-category">${escapeHtml(item.category)}</span>` : ''}
            <h1>${escapeHtml(item.title)}${verifiedBadge(item)}</h1>
            <p class="detail-pitch">${escapeHtml(item.pitch || '')}</p>
            ${heroCtaHtml}
            ${heroMetricsHtml}
          </div>
        </div>

        ${gallerySectionHtml}

        <div class="detail-layout">
          <aside class="detail-side detail-side-left">
            ${authorCard}
            ${engagementCard}
            ${rankCard}
            ${metricHtml}
            ${aiCard}
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

      // ---------- gallery carousel ----------
      const carousel = root.querySelector('.gallery-carousel');
      if (carousel) {
        const slides = Array.from(carousel.querySelectorAll('.carousel-slide'));
        const dots = Array.from(carousel.querySelectorAll('.carousel-dot'));
        let current = 0;

        function goTo(idx) {
          slides[current]?.classList.remove('active');
          dots[current]?.classList.remove('active');
          current = ((idx % slides.length) + slides.length) % slides.length;
          slides[current]?.classList.add('active');
          dots[current]?.classList.add('active');
        }

        carousel.querySelector('.carousel-prev')?.addEventListener('click', () => goTo(current - 1));
        carousel.querySelector('.carousel-next')?.addEventListener('click', () => goTo(current + 1));
        dots.forEach((dot) => dot.addEventListener('click', () => goTo(Number(dot.dataset.idx))));

        // Touch/swipe support
        let touchX = null;
        carousel.addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX; }, { passive: true });
        carousel.addEventListener('touchend', (e) => {
          if (touchX == null) return;
          const dx = e.changedTouches[0].clientX - touchX;
          if (Math.abs(dx) > 40) goTo(dx < 0 ? current + 1 : current - 1);
          touchX = null;
        }, { passive: true });
      }

      // Post-an-update form (author only).
      const postBtn = root.querySelector('.post-update-btn');
      if (postBtn) {
        postBtn.addEventListener('click', async () => {
          const textarea = root.querySelector('.update-input');
          const statusEl = root.querySelector('.post-update-status');
          const body = (textarea?.value || '').trim();
          if (!body) {
            statusEl.textContent = 'write something first';
            return;
          }
          postBtn.disabled = true;
          statusEl.textContent = 'posting…';
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
            statusEl.textContent = 'posted — pending your approval below.';
            textarea.value = '';
            // Re-fetch so the pending list updates.
            setTimeout(() => location.reload(), 600);
          } catch (err) {
            statusEl.textContent = err.message || 'could not post';
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
      })
      .catch(() => {
        root.innerHTML = `<div class="empty">Couldn't load this use case. It may have been removed.</div>`;
      });
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
    const horizontalKeys = new Set(['by_integration', 'by_tool', 'by_skill', 'by_plugin', 'by_model', 'by_host']);
    const lineKeys = new Set(['daily', 'cumulative', 'cumulative_tokens']);
    const LINE_LABELS = {
      daily: 'new agents',
      cumulative: 'total agents',
      cumulative_tokens: 'tokens processed',
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
    });
  }

  // ---------- dispatch by page ----------
  const page = document.body.dataset.page;
  if (page === 'feed') initFeed();
  else if (page === 'detail') initDetail();
  else if (page === 'stats') initStats();
  // submit page has no JS beyond the shared copy button handler above
})();
