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
      return `
        <div class="card-media">
          <img src="${escapeHtml(item.image_url)}" alt=""
               loading="lazy" referrerpolicy="no-referrer"
               onerror="this.parentElement.outerHTML='<div class=&quot;card-media placeholder&quot;>◆</div>'" />
        </div>`;
    }
    return `<div class="card-media placeholder">◆</div>`;
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
    // Only the chips that actually exist — no empty slots.
    const chips = [];
    if (item.category) chips.push(['category', item.category]);
    if (item.platform) chips.push(['platform', item.platform]);
    if (item.trigger_type) chips.push(['trigger', item.trigger_type]);
    if (item.deployment) chips.push(['deployment', item.deployment]);
    if (item.time_saved_per_week) chips.push(['hours', `${item.time_saved_per_week}h/wk saved`]);
    if (Array.isArray(item.integrations) && item.integrations[0]) {
      chips.push(['integration', item.integrations[0]]);
    }
    return chips
      .slice(0, 4)
      .map(([k, v]) => `<span class="chip chip-${k}">${escapeHtml(v)}</span>`)
      .join('');
  }

  // ==========================================================
  // FEED PAGE
  // ==========================================================
  function initFeed() {
    const feedEl = document.getElementById('feed');
    if (!feedEl) return;

    const state = { sort: 'trending', category: '', q: '', verified: false };
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
      const badge = fresh ? `<span class="new-badge">New</span>` : '';
      return `
        <a class="${cls.join(' ')}" href="/use-cases/${item.id}" data-id="${item.id}">
          ${badge}
          ${mediaBlock(item)}
          <div class="card-body">
            <h3 class="card-title">${escapeHtml(item.title)}${verifiedBadge(item)}</h3>
            <p class="card-pitch">${escapeHtml(item.pitch || item.description || '')}</p>
            <div class="chip-row">${chipRow(item)}</div>
            <div class="card-foot">
              ${handleBlock(item)}
              ${likeBtnHtml(item)}
            </div>
          </div>
        </a>`;
    }

    async function loadFeed() {
      feedEl.innerHTML = '<div class="loading">Loading the feed…</div>';
      const params = new URLSearchParams();
      params.set('sort', state.sort);
      if (state.category) params.set('category', state.category);
      if (state.q) params.set('q', state.q);
      if (state.verified) params.set('verified', '1');
      try {
        const res = await fetch('/api/submissions?' + params.toString());
        const items = await res.json();
        if (!Array.isArray(items) || items.length === 0) {
          feedEl.innerHTML = `
            <div class="empty">
              ${state.q || state.category
                ? 'No matches. Try a different filter.'
                : 'Nothing here yet. <a href="/submit" style="color:var(--accent)">Be the first to post →</a>'}
            </div>`;
          return;
        }
        feedEl.innerHTML = items.map(cardHtml).join('');
      } catch {
        feedEl.innerHTML = `<div class="empty">Couldn't load the feed. Refresh to try again.</div>`;
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

    // Category pills — populated from /api/meta
    const catRow = document.getElementById('category-filters');
    fetch('/api/meta').then((r) => r.json()).then((meta) => {
      meta.categories.forEach((cat) => {
        const btn = document.createElement('button');
        btn.className = 'pill';
        btn.dataset.category = cat;
        btn.textContent = cat;
        catRow.appendChild(btn);
      });
      catRow.addEventListener('click', (e) => {
        const pill = e.target.closest('.pill');
        if (!pill) return;
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
        item.complexity_tier || item.satisfaction;

      const hasGotchas = Array.isArray(item.gotchas) && item.gotchas.length > 0;
      const hasCode = item.github_url || item.source_url;
      const hasAiScore = item.ai_score != null;
      const hasTags = Array.isArray(item.tags) && item.tags.length > 0;
      const approvedUpdates = Array.isArray(item.updates) ? item.updates : [];
      const pendingUpdates = Array.isArray(item.pending_updates) ? item.pending_updates : [];
      const updateCount = approvedUpdates.length;

      // Satisfaction is a 1..5 integer — render as filled/empty dots so it
      // reads at a glance without pulling in an icon font.
      function satisfactionDots(n) {
        const v = Math.max(0, Math.min(5, Number(n) || 0));
        return '●'.repeat(v) + '○'.repeat(5 - v);
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
      function sideChipList(arr) {
        if (!Array.isArray(arr) || arr.length === 0) return '';
        return `<div class="side-chips">${arr.map((v) => `<span class="chip">${escapeHtml(v)}</span>`).join('')}</div>`;
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
        ? `<a class="side-link" href="https://x.com/${escapeHtml(item.twitter_handle)}" target="_blank" rel="noopener">@${escapeHtml(item.twitter_handle)}</a>`
        : '';
      const websiteLink = item.website
        ? `<a class="side-link" href="${escapeHtml(item.website)}" target="_blank" rel="noopener">${escapeHtml((item.website || '').replace(/^https?:\/\//, '').replace(/\/$/, ''))}</a>`
        : '';
      const authorCard = `
        <div class="side-card author-card">
          <div class="author-row">
            <div class="author-avatar">${escapeHtml(creatorInitials || '?')}</div>
            <div class="author-meta">
              <div class="author-name">${escapeHtml(creatorName)}</div>
              ${item.verified ? `<span class="verified-badge">Verified</span>` : ''}
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

      // AI score card
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
        </div>` : '';

      // Build profile card (satisfaction, complexity, etc.)
      const buildBody = hasBuildDetails ? `
        ${item.satisfaction ? `<div class="side-kv"><span class="side-kv-label">Satisfaction</span><span class="side-kv-value sat-dots" title="${item.satisfaction} / 5">${satisfactionDots(item.satisfaction)}</span></div>` : ''}
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
        ${item.integrations?.length ? `<div class="side-subsection"><div class="side-sub-label">Integrations</div>${sideChipList(item.integrations)}</div>` : ''}
        ${item.tools_used?.length ? `<div class="side-subsection"><div class="side-sub-label">Tools used</div>${sideChipList(item.tools_used)}</div>` : ''}
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

      // ---------- build the main overview panel ----------
      const overviewPanel = `
        <div class="overview-panel">
          <section class="detail-section">
            <h2>The story</h2>
            <p class="detail-story">${escapeHtml(item.story || item.description || '')}</p>
          </section>

          ${hasGotchas ? `
          <section class="detail-section">
            <h2>Gotchas &amp; lessons</h2>
            <ul class="gotcha-list">
              ${item.gotchas.map((g) => `<li>${escapeHtml(g)}</li>`).join('')}
            </ul>
          </section>` : ''}

          ${item.image_prompt ? `
          <section class="detail-section">
            <h2>Image prompt</h2>
            <p class="muted">This hero image was generated by the agent itself from this prompt:</p>
            <pre class="image-prompt">${escapeHtml(item.image_prompt)}</pre>
          </section>` : ''}
        </div>`;

      root.innerHTML = `
        ${authorBanner}

        <div class="detail-hero">
          <div class="detail-media">${media}</div>
          <div class="detail-hero-head">
            ${item.category ? `<span class="chip chip-category">${escapeHtml(item.category)}</span>` : ''}
            <h1>${escapeHtml(item.title)}${verifiedBadge(item)}</h1>
            <p class="detail-pitch">${escapeHtml(item.pitch || '')}</p>
          </div>
        </div>

        <div class="detail-layout">
          <aside class="detail-side detail-side-left">
            ${authorCard}
            ${engagementCard}
            ${metricHtml}
            ${aiCard}
            ${buildCard}
          </aside>

          <div class="detail-main">
            <div class="detail-tabs" role="tablist">
              <button class="d-tab active" type="button" data-tab="overview" role="tab">Overview</button>
              <button class="d-tab" type="button" data-tab="updates" role="tab">
                Updates${updateCount ? `<span class="tab-badge">${updateCount}</span>` : ''}
              </button>
            </div>
            <div class="tab-panel" data-panel="overview">${overviewPanel}</div>
            <div class="tab-panel hidden" data-panel="updates">${renderUpdatesPanel(item)}</div>
          </div>

          <aside class="detail-side detail-side-right">
            ${techCard}
            ${infraCard}
            ${codeCard}
            ${tagsCard}
          </aside>
        </div>
      `;

      // Wire up tab switching
      const tabs = root.querySelectorAll('.d-tab');
      const panels = root.querySelectorAll('.tab-panel');
      tabs.forEach((tab) => {
        tab.addEventListener('click', () => {
          const target = tab.dataset.tab;
          tabs.forEach((t) => t.classList.toggle('active', t === tab));
          panels.forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== target));
        });
      });

      const likeBtn = root.querySelector('.like-btn');
      if (likeBtn) {
        likeBtn.addEventListener('click', (e) => {
          e.preventDefault();
          toggleLike(Number(likeBtn.dataset.id), likeBtn);
        });
      }

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
    });
  }

  // ---------- dispatch by page ----------
  const page = document.body.dataset.page;
  if (page === 'feed') initFeed();
  else if (page === 'detail') initDetail();
  else if (page === 'stats') initStats();
  // submit page has no JS beyond the shared copy button handler above
})();
