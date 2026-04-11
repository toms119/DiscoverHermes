// DiscoverHermes frontend — vanilla JS, no build step.
//
// Two pages share this file:
//   - index.html: renders the feed, handles likes, handles sort toggle
//   - submit.html: just needs the "copy prompt" button
// Everything else is static HTML.

(function () {
  // ---------- shared: copy-to-clipboard button ----------
  document.querySelectorAll('.copy-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const target = document.getElementById(btn.dataset.copyTarget);
      if (!target) return;
      try {
        await navigator.clipboard.writeText(target.innerText);
        const original = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => (btn.textContent = original), 1500);
      } catch {
        btn.textContent = 'Press Ctrl+C';
      }
    });
  });

  // ---------- feed page only ----------
  const feedEl = document.getElementById('feed');
  if (!feedEl) return;

  const LIKED_KEY = 'dh_liked_ids_v1';
  const likedSet = new Set(JSON.parse(localStorage.getItem(LIKED_KEY) || '[]'));
  const saveLiked = () => localStorage.setItem(LIKED_KEY, JSON.stringify([...likedSet]));

  let currentSort = 'new';

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[c]);
  }

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
    if (!item.twitter_handle) return `<span class="handle">anonymous</span>`;
    const h = escapeHtml(item.twitter_handle);
    return `<a class="handle" href="https://twitter.com/${h}" target="_blank" rel="noopener">@${h}</a>`;
  }

  function cardHtml(item) {
    const liked = likedSet.has(item.id);
    return `
      <article class="card" data-id="${item.id}">
        ${mediaBlock(item)}
        <div class="card-body">
          <h3 class="card-title">${escapeHtml(item.title)}</h3>
          <p class="card-desc">${escapeHtml(item.description)}</p>
          <div class="card-foot">
            ${handleBlock(item)}
            <button class="like-btn ${liked ? 'liked' : ''}" data-id="${item.id}"
                    aria-pressed="${liked}">
              <span class="heart"></span>
              <span class="count">${item.likes}</span>
            </button>
          </div>
        </div>
      </article>
    `;
  }

  async function loadFeed() {
    feedEl.innerHTML = '<div class="loading">Loading the feed…</div>';
    try {
      const res = await fetch(`/api/submissions?sort=${currentSort === 'top' ? 'top' : 'new'}`);
      const items = await res.json();
      if (!Array.isArray(items) || items.length === 0) {
        feedEl.innerHTML = `
          <div class="empty">
            Nothing here yet. <a href="/submit" style="color:var(--accent)">Be the first to post →</a>
          </div>`;
        return;
      }
      feedEl.innerHTML = items.map(cardHtml).join('');
    } catch (err) {
      feedEl.innerHTML = `<div class="empty">Couldn't load the feed. Refresh to try again.</div>`;
    }
  }

  // Event delegation for likes — one listener for the whole feed.
  feedEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('.like-btn');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    const wasLiked = likedSet.has(id);
    const countEl = btn.querySelector('.count');
    const current = Number(countEl.textContent) || 0;

    // Optimistic toggle
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
      /* ignore — optimistic UI is fine */
    }
  });

  // Sort toggle
  const sortBtn = document.getElementById('sort-toggle');
  if (sortBtn) {
    sortBtn.addEventListener('click', () => {
      currentSort = currentSort === 'new' ? 'top' : 'new';
      sortBtn.textContent = `Showing: ${currentSort === 'new' ? 'newest' : 'most liked'}`;
      sortBtn.dataset.sort = currentSort;
      loadFeed();
    });
  }

  loadFeed();
})();
