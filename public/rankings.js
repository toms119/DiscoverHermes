(function() {
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

  async function loadRankings(view) {
    const tbody = document.getElementById('rankings-body');
    if (!tbody) return;

    const cfg = VIEWS[view] || VIEWS.ai;
    tbody.innerHTML = '<tr><td colspan="5" class="loading">Loading rankings…</td></tr>';

    try {
      const res = await fetch(cfg.url);
      const items = await res.json();

      if (!Array.isArray(items) || items.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="empty">${cfg.empty}</td></tr>`;
        return;
      }

      tbody.innerHTML = items.map((item, i) => renderRow(item, i + 1, view)).join('');
    } catch (err) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty">Failed to load rankings. Try refreshing.</td></tr>';
    }
  }

  function renderRow(item, rank, view) {
    const likes = Number(item.likes) || 0;
    const likesCell = `<td class="col-hide-mobile"><span class="rank-likes ${likes === 0 ? 'zero' : ''}">${likes}</span></td>`;

    let scoreCell;
    if (view === 'ai') {
      const grade = item.ai_grade || 'C';
      const score = item.ai_score || 0;
      scoreCell = `
        <td>
          <div style="display: flex; align-items: center; gap: 12px;">
            <span class="rank-grade grade-${grade}">${grade}</span>
            <div>
              <div class="rank-score">${score}</div>
              <div class="score-bar"><div class="score-fill" style="width: ${score}%"></div></div>
            </div>
          </div>
        </td>`;
    } else {
      const grade = item.ai_grade ? `<span class="rank-grade grade-${item.ai_grade}" title="AI grade">${item.ai_grade}</span>` : '';
      scoreCell = `
        <td>
          <div style="display: flex; align-items: center; gap: 12px;">
            <span class="rank-likes" style="font-size: 22px;">${likes}</span>
            ${grade}
          </div>
        </td>`;
    }

    const meta = item.twitter_handle
      ? `<a href="https://x.com/${escapeHtml(item.twitter_handle)}" target="_blank" rel="noopener" style="color: var(--accent); font-weight: 600;">@${escapeHtml(item.twitter_handle)}</a>`
      : item.display_name
        ? `<span>${escapeHtml(item.display_name)}</span>`
        : `<span style="color: var(--text-dim);">Anonymous</span>`;

    return `
      <tr class="${rank <= 3 ? 'rank-top-3' : ''}">
        <td class="rank-row">${rank}</td>
        <td>
          <a class="rank-title" href="/use-cases/${item.id}">${escapeHtml(item.title)}</a>
          <div class="chip-row" style="margin-top: 4px;">
            ${item.tags && item.tags.slice(0, 2).map(t => `<span class="chip">${escapeHtml(t)}</span>`).join('') || ''}
          </div>
        </td>
        ${scoreCell}
        ${likesCell}
        <td class="rank-meta col-hide-mobile">${meta}</td>
      </tr>
    `;
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
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
})();