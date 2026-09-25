/* Space Fractions - AdminClient (DeploymentDiagram: GameServer -- AdminClient).
 *
 * Drives the real AdminComponent surface. Every action below is a real HTTP
 * call; nothing is faked client-side.
 *
 *   POST /oauth/token                        -> sign in (password grant, section F)
 *   GET  /api/v1/admin/whoami                -> prove the token is an admin token
 *   GET  /api/v1/admin/questions             -> list WITH answer keys
 *   POST /api/v1/admin/questions             -> AdminComponent -> QuestionComponent create
 *   PUT  /api/v1/admin/questions/{id}        -> SequenceDiagram2: Admin ->> Question : update()
 *   DELETE /api/v1/admin/questions/{id}      -> deactivate
 *   GET  /api/v1/admin/questions/search?q=   -> Elasticsearch-backed search
 *   GET  /api/v1/admin/games/stats           -> section G completion rate
 *
 * The token endpoint lives on UserComponent (USER_PORT 8083 in the compose file).
 * GameComponent proxies it at the same-origin path `POST /oauth/token` (see
 * services/game/src/routes/uiRoutes.js), so the default below works with no
 * configuration. Set PUBLIC_USER_API_BASE to point the screen straight at
 * UserComponent instead.
 */
'use strict';

const CONFIG = window.SPACE_FRACTIONS_CONFIG || {};
const API_BASE = (CONFIG.apiBase || '').replace(/\/$/, '');
// Same origin by default: GameComponent serves /oauth/token as a proxy to
// UserComponent. Only overridden when the operator sets PUBLIC_USER_API_BASE.
const USER_BASE = (CONFIG.userApiBase || '').replace(/\/$/, '');
const TOKEN_KEY = 'spacefractions.admin.token';

const state = { token: localStorage.getItem(TOKEN_KEY) || null, editingId: null };

const $ = (id) => document.getElementById(id);

function setStatus(id, message, kind = '') {
  const el = $(id);
  el.textContent = message || '';
  el.className = `status ${kind}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

async function api(path, options = {}) {
  const base = options.userApi ? USER_BASE : API_BASE;
  const headers = { ...(options.headers || {}) };
  if (options.body) headers['content-type'] = 'application/json';
  if (options.auth) headers.authorization = `Bearer ${state.token}`;

  const res = await fetch(`${base}${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (_) { body = null; }
  if (!res.ok) {
    const err = new Error((body && (body.error_description || body.error)) || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

// --------------------------------------------------------------------------
// authentication
// --------------------------------------------------------------------------
$('btn-login').addEventListener('click', async () => {
  const pasted = $('admin-token').value.trim();
  setStatus('admin-auth-status', 'Signing in...');
  try {
    if (pasted) {
      state.token = pasted;
    } else {
      const form = new URLSearchParams({
        grant_type: 'password',
        username: $('admin-username').value.trim(),
        password: $('admin-password').value,
      });
      const base = USER_BASE;
      const res = await fetch(`${base}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error((body && body.error_description) || `HTTP ${res.status}`);
      state.token = body.access_token;
    }

    localStorage.setItem(TOKEN_KEY, state.token);

    // Prove the token really carries the admin role + update_questions scope.
    const who = await api('/api/v1/admin/whoami', { auth: true });
    $('admin-who').textContent = `${who.username} (${(who.roles || []).join(', ')})`;
    setStatus('admin-auth-status', 'Signed in.', 'ok');
    $('admin-main').hidden = false;
    await loadQuestions();
  } catch (err) {
    state.token = null;
    localStorage.removeItem(TOKEN_KEY);
    setStatus('admin-auth-status', `Sign in failed: ${err.message}`, 'error');
  }
});

$('btn-logout').addEventListener('click', () => {
  state.token = null;
  localStorage.removeItem(TOKEN_KEY);
  $('admin-main').hidden = true;
  $('admin-who').textContent = '';
  setStatus('admin-auth-status', 'Signed out.', 'ok');
});

// --------------------------------------------------------------------------
// question list + editor
// --------------------------------------------------------------------------
$('btn-refresh').addEventListener('click', loadQuestions);
$('btn-search').addEventListener('click', searchQuestions);
$('admin-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') searchQuestions(); });

async function loadQuestions() {
  setStatus('admin-list-status', 'Loading question bank...');
  try {
    const difficulty = $('admin-filter').value;
    const query = difficulty ? `?limit=100&difficulty=${encodeURIComponent(difficulty)}` : '?limit=100';
    const body = await api(`/api/v1/admin/questions${query}`, { auth: true });
    renderList(body.questions || [], body.total);
    setStatus('admin-list-status', '', '');
  } catch (err) {
    setStatus('admin-list-status', `Could not load questions: ${err.message}`, 'error');
  }
}

async function searchQuestions() {
  const q = $('admin-search').value.trim();
  if (!q) return loadQuestions();
  setStatus('admin-list-status', `Searching for "${q}"...`);
  try {
    const body = await api(`/api/v1/admin/questions/search?q=${encodeURIComponent(q)}`, { auth: true });
    const results = (body.results || []).map((r) => ({
      id: r.id,
      prompt: r.prompt,
      options: r.options,
      correctOption: r.correctOption,
      difficulty: r.difficulty,
      tags: r.tags,
    }));
    renderList(results, results.length, `Elasticsearch (${body.engine || 'n/a'})`);
    setStatus('admin-list-status', `${results.length} match(es).`, 'ok');
  } catch (err) {
    setStatus('admin-list-status', `Search failed: ${err.message}`, 'error');
  }
}

function renderList(questions, total, sourceLabel) {
  const container = $('admin-list');
  if (!questions.length) {
    container.innerHTML = '<p class="hint">No questions. Create one on the right.</p>';
    return;
  }
  container.innerHTML = `${sourceLabel ? `<p class="hint">Source: ${escapeHtml(sourceLabel)}</p>` : ''}`
    + (typeof total === 'number' ? `<p class="hint">${total} question(s)</p>` : '')
    + questions.map((q) => `
      <div class="q-item">
        <div>
          <strong>${escapeHtml(q.prompt)}</strong>
          <div class="meta">
            id <code>${escapeHtml(String(q.id))}</code> &middot;
            ${escapeHtml(q.difficulty || 'n/a')} &middot;
            options: ${escapeHtml((q.options || []).join(' | '))} &middot;
            answer: <code>${escapeHtml(String(q.correctOption ?? 'hidden'))}</code>
          </div>
        </div>
        <div class="q-actions">
          <button class="btn" data-edit="${escapeHtml(String(q.id))}">Edit</button>
          <button class="btn ghost" data-delete="${escapeHtml(String(q.id))}">Deactivate</button>
        </div>
      </div>`).join('');

  container.querySelectorAll('[data-edit]').forEach((btn) => {
    btn.addEventListener('click', () => beginEdit(questions.find((q) => String(q.id) === btn.dataset.edit)));
  });
  container.querySelectorAll('[data-delete]').forEach((btn) => {
    btn.addEventListener('click', () => deactivate(btn.dataset.delete));
  });
}

function beginEdit(question) {
  if (!question) return;
  state.editingId = question.id;
  $('form-title').textContent = `Update question ${question.id}`;
  $('f-prompt').value = question.prompt || '';
  $('f-options').value = (question.options || []).join(', ');
  $('f-correct').value = question.correctOption || '';
  $('f-difficulty').value = question.difficulty || 'medium';
  $('f-tags').value = (question.tags || []).join(', ');
  setStatus('admin-save-status', '');
}

$('btn-new').addEventListener('click', () => {
  state.editingId = null;
  $('form-title').textContent = 'Create question';
  ['f-prompt', 'f-options', 'f-correct', 'f-tags'].forEach((id) => { $(id).value = ''; });
  $('f-difficulty').value = 'medium';
  setStatus('admin-save-status', '');
});

$('btn-save').addEventListener('click', async () => {
  const payload = {
    prompt: $('f-prompt').value.trim(),
    options: $('f-options').value.split(',').map((s) => s.trim()).filter(Boolean),
    correctOption: $('f-correct').value.trim(),
    difficulty: $('f-difficulty').value,
    tags: $('f-tags').value.split(',').map((s) => s.trim()).filter(Boolean),
  };

  if (payload.prompt.length < 3) return setStatus('admin-save-status', 'Prompt must be at least 3 characters.', 'error');
  if (payload.options.length < 2) return setStatus('admin-save-status', 'At least 2 options are required.', 'error');
  if (!payload.options.includes(payload.correctOption)) {
    return setStatus('admin-save-status', 'Correct option must be one of the options.', 'error');
  }

  setStatus('admin-save-status', 'Saving...');
  try {
    if (state.editingId) {
      await api(`/api/v1/admin/questions/${encodeURIComponent(state.editingId)}`, {
        method: 'PUT', body: payload, auth: true,
      });
      setStatus('admin-save-status', `Updated ${state.editingId}.`, 'ok');
    } else {
      const created = await api('/api/v1/admin/questions', { method: 'POST', body: payload, auth: true });
      setStatus('admin-save-status', `Created ${created.id || created.questionId || 'question'}.`, 'ok');
    }
    $('btn-new').click();
    await loadQuestions();
  } catch (err) {
    setStatus('admin-save-status', `Save failed: ${err.message}`, 'error');
  }
});

async function deactivate(questionId) {
  setStatus('admin-list-status', `Deactivating ${questionId}...`);
  try {
    await api(`/api/v1/admin/questions/${encodeURIComponent(questionId)}`, { method: 'DELETE', auth: true });
    setStatus('admin-list-status', `Deactivated ${questionId}.`, 'ok');
    await loadQuestions();
  } catch (err) {
    setStatus('admin-list-status', `Deactivate failed: ${err.message}`, 'error');
  }
}

// --------------------------------------------------------------------------
// stats (section G)
// --------------------------------------------------------------------------
$('btn-stats').addEventListener('click', async () => {
  try {
    const stats = await api('/api/v1/admin/games/stats', { auth: true });
    $('admin-stats').innerHTML = `Games total: <strong>${stats.gamesTotal}</strong> &middot; `
      + `completed: <strong>${stats.gamesCompleted}</strong> &middot; `
      + `completion rate: <strong>${Math.round((stats.completionRate || 0) * 100)}%</strong>`;
  } catch (err) {
    $('admin-stats').textContent = `Could not load stats: ${err.message}`;
  }
});

// Resume a session if a token is already stored.
if (state.token) {
  (async () => {
    try {
      const who = await api('/api/v1/admin/whoami', { auth: true });
      $('admin-who').textContent = `${who.username} (${(who.roles || []).join(', ')})`;
      $('admin-main').hidden = false;
      setStatus('admin-auth-status', 'Restored previous session.', 'ok');
      await loadQuestions();
    } catch (_) {
      state.token = null;
      localStorage.removeItem(TOKEN_KEY);
    }
  })();
}
