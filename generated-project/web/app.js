/* Space Fractions - game client (UserClient in the DeploymentDiagram).
 *
 * Plain ES2020, no build step, no framework. Every screen in the executive
 * summary maps to a real backend call:
 *
 *   intro movie      (no call - it is the trailer for the game)
 *   main menu        GET  /play                     -> spec-verbatim endpoint
 *                    POST /api/v1/games             -> start a round (FR-1)
 *                    GET  /api/v1/help              -> View Help use case
 *                    GET  /api/v1/leaderboard       -> View Score (all time)
 *   question screens GET  /api/v1/games/{id}        -> display prompt (SequenceDiagram1)
 *                    POST /api/v1/games/{id}/answers-> submit answer -> check -> display result
 *                    POST /api/v1/games/{id}/pause|resume -> StateDiagram transitions
 *   ending scene     GET  /api/v1/games/{id}/score  -> real final score + feedback
 *                    POST /api/v1/games/{id}/gameover -> abandon the mission
 *
 * The backend is the GameComponent the project already had; this client invents
 * no data of its own (the one exception is the intro movie, which the spec names
 * but never specifies - see README).
 */
'use strict';

const CONFIG = window.SPACE_FRACTIONS_CONFIG || {};
const API_BASE = (CONFIG.apiBase || '').replace(/\/$/, '');

/** Session state - the game id returned by the backend. */
const state = {
  gameId: null,
  question: null,
  history: [],
  startedAt: 0,
  paused: false,
  busy: false,
};

// --------------------------------------------------------------------------
// tiny DOM helpers
// --------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);

function show(sceneId) {
  document.querySelectorAll('.scene').forEach((el) => el.classList.remove('active'));
  const scene = $(sceneId);
  if (scene) scene.classList.add('active');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function setStatus(message, kind = '') {
  const el = $('menu-status');
  el.textContent = message || '';
  el.className = `status ${kind}`;
}

async function api(path, options = {}) {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    method: options.method || 'GET',
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
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
// 1. intro movie
// --------------------------------------------------------------------------
$('btn-movie-continue').addEventListener('click', () => show('scene-menu'));
$('btn-movie-skip').addEventListener('click', () => show('scene-menu'));
$('btn-replay-intro').addEventListener('click', () => show('scene-intro'));

// --------------------------------------------------------------------------
// 2. main menu
// --------------------------------------------------------------------------
$('btn-start').addEventListener('click', startGame);

async function startGame() {
  if (state.busy) return;
  state.busy = true;
  setStatus('Contacting mission control...');
  const difficulty = $('input-difficulty').value || null;
  const questionCount = Number($('input-count').value) || 10;
  const username = $('input-name').value.trim() || null;

  try {
    // The spec-verbatim endpoint GET /play is the documented way to start a
    // game ("Play the game" -> { gameId: integer }). It already creates a game
    // with 10 questions, and returns the numeric spec id plus the real UUID.
    //
    // We call /play when the pilot chose the default round; for a custom round
    // (difficulty / question count) we call the richer POST /api/v1/games. This
    // avoids creating two games per click.
    const wantsDefault = !difficulty && questionCount === 10;
    let gameId;
    let created;

    if (wantsDefault) {
      const playResponse = await api('/play');
      gameId = playResponse.gameUid;
      // Fetch the prompt view for the game /play just created.
      created = await api(`/api/v1/games/${gameId}`);
      created.score = created.score || 0;
      created.totalQuestions = created.progress ? created.progress.total : 10;
      setStatus(`Mission started (spec /play returned integer gameId ${playResponse.gameId}).`, 'ok');
    } else {
      created = await api('/api/v1/games', {
        method: 'POST',
        body: { questionCount, difficulty, username },
      });
      gameId = created.gameId;
      setStatus('Mission started.', 'ok');
    }

    if (!gameId) throw new Error('the server did not return a game id');

    state.gameId = gameId;
    state.question = created.question;
    state.history = [];
    state.answered = created.progress ? created.progress.answered : 0;
    state.answeredTotal = created.progress ? created.progress.total : created.totalQuestions;
    state.startedAt = Date.now();
    state.paused = false;

    $('hud-score').textContent = `Score ${created.score || 0}`;
    $('hud-state').textContent = created.state || 'Playing';
    renderQuestion();
    renderHud();
    show('scene-question');
  } catch (err) {
    setStatus(`Could not start game: ${err.message}`, 'error');
  } finally {
    state.busy = false;
  }
}

// --------------------------------------------------------------------------
// 3. question screens
// --------------------------------------------------------------------------
function renderHud() {
  const total = state.question ? (state.answeredTotal ?? state.totalQuestions ?? 0) : 0;
  const answered = state.answered ?? 0;
  $('hud-progress').textContent = total
    ? `Question ${Math.min(answered + 1, total)} / ${total}`
    : 'Question 1 / 1';
  $('hud-state').textContent = state.paused ? 'Paused' : ($('hud-state').textContent || 'Playing');
}

function renderQuestion() {
  const q = state.question;
  const options = $('q-options');
  options.innerHTML = '';
  $('q-result').textContent = '';
  $('q-result').className = 'result';
  $('q-answer').value = '';
  $('q-answer').disabled = false;
  $('btn-submit').disabled = false;

  if (!q) {
    $('q-prompt').textContent = 'All questions answered - computing your score...';
    return;
  }

  $('q-prompt').textContent = q.prompt;
  (q.options || []).forEach((option) => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = option;
    btn.dataset.option = option;
    btn.addEventListener('click', () => {
      options.querySelectorAll('button').forEach((b) => b.classList.remove('chosen'));
      btn.classList.add('chosen');
      submitAnswer(option, btn);
    });
    li.appendChild(btn);
    options.appendChild(li);
  });
}

$('answer-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const answer = $('q-answer').value.trim();
  if (!answer) return;
  submitAnswer(answer, null);
});

async function submitAnswer(answer, buttonEl) {
  if (state.busy || !state.gameId || !state.question) return;
  state.busy = true;
  $('q-options').querySelectorAll('button').forEach((b) => { b.disabled = true; });
  $('q-answer').disabled = true;
  $('btn-submit').disabled = true;

  const timeMs = Date.now() - state.startedAt;
  try {
    const result = await api(`/api/v1/games/${state.gameId}/answers`, {
      method: 'POST',
      body: { questionId: state.question.id, answer, timeMs },
    });

    state.history.push({
      prompt: state.question.prompt,
      answer,
      correct: result.correct,
      correctOption: result.correctOption,
    });

    // Colour the option buttons from the real grading result.
    $('q-options').querySelectorAll('button').forEach((b) => {
      if (b.dataset.option === result.correctOption) b.classList.add('right');
      else if (buttonEl === b) b.classList.add('wrong');
    });

    $('q-result').className = `result ${result.correct ? 'correct' : 'wrong'}`;
    $('q-result').innerHTML = result.correct
      ? `Correct! +${result.awarded} points<span class="explain">Score is now ${result.score}.</span>`
      : `Not quite.<span class="explain">The correct answer is ${result.correctOption}. No penalty - this is a learning tool.</span>`;

    $('hud-score').textContent = `Score ${result.score}`;
    state.answered = result.progress ? result.progress.answered : (state.answered || 0) + 1;
    state.answeredTotal = result.progress ? result.progress.total : state.answeredTotal;
    state.question = result.question;
    $('hud-state').textContent = result.state || 'Playing';
    renderHud();

    if (result.state === 'GameOver' || (result.feedback && result.feedback.completed)) {
      await finishGame(result.feedback);
      return;
    }

    // Short pause so the learner can read the feedback before the next prompt.
    setTimeout(() => {
      state.startedAt = Date.now();
      renderQuestion();
      state.busy = false;
    }, result.correct ? 700 : 1500);
  } catch (err) {
    $('q-result').className = 'result wrong';
    $('q-result').textContent = `Could not submit answer: ${err.message}`;
    $('q-options').querySelectorAll('button').forEach((b) => { b.disabled = false; });
    $('q-answer').disabled = false;
    $('btn-submit').disabled = false;
    state.busy = false;
  }
}

// --------------------------------------------------------------------------
// StateDiagram transitions: pause() / resume() / gameOver()
// --------------------------------------------------------------------------
$('btn-pause').addEventListener('click', async () => {
  if (!state.gameId) return;
  try {
    const res = await api(`/api/v1/games/${state.gameId}/pause`, { method: 'POST' });
    state.paused = true;
    $('hud-state').textContent = res.state;
    $('btn-pause').hidden = true;
    $('btn-resume').hidden = false;
  } catch (err) {
    $('q-result').className = 'result wrong';
    $('q-result').textContent = `Pause failed: ${err.message}`;
  }
});

$('btn-resume').addEventListener('click', async () => {
  if (!state.gameId) return;
  try {
    const res = await api(`/api/v1/games/${state.gameId}/resume`, { method: 'POST' });
    state.paused = false;
    state.startedAt = Date.now();
    $('hud-state').textContent = res.state;
    $('btn-resume').hidden = true;
    $('btn-pause').hidden = false;
  } catch (err) {
    $('q-result').className = 'result wrong';
    $('q-result').textContent = `Resume failed: ${err.message}`;
  }
});

$('btn-quit').addEventListener('click', async () => {
  if (!state.gameId) return show('scene-menu');
  try {
    const res = await api(`/api/v1/games/${state.gameId}/gameover`, { method: 'POST' });
    await finishGame(res.feedback);
  } catch (err) {
    setStatus(`Could not end mission: ${err.message}`, 'error');
    show('scene-menu');
  }
});

// --------------------------------------------------------------------------
// 4. ending scene with real score
// --------------------------------------------------------------------------
async function finishGame(feedbackFromAnswer) {
  let feedback = feedbackFromAnswer || null;
  if (!feedback && state.gameId) {
    try {
      feedback = await api(`/api/v1/games/${state.gameId}/score`);
    } catch (_) { /* fall through to whatever we have */ }
  }
  feedback = feedback || {};

  const score = feedback.score ?? 0;
  const total = feedback.totalQuestions ?? state.history.length;
  const correct = feedback.correctAnswers ?? state.history.filter((h) => h.correct).length;
  const accuracy = typeof feedback.accuracy === 'number'
    ? feedback.accuracy
    : (total ? correct / total : 0);

  $('ending-score').textContent = String(score);
  $('ending-correct').textContent = `${correct} / ${total}`;
  $('ending-accuracy').textContent = `${Math.round(accuracy * 100)}%`;
  $('ending-state').textContent = feedback.state || 'GameOver';
  $('ending-message').textContent =
    feedback.message || `You scored ${score} points. Nice flying!`;
  $('ending-emoji').textContent = accuracy >= 0.8 ? '\u{1F680}' : accuracy >= 0.5 ? '\u{1F31F}' : '\u{1F4AA}';

  const tbody = $('review-table').querySelector('tbody');
  tbody.innerHTML = '';
  state.history.forEach((h) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escapeHtml(h.prompt)}</td><td>${escapeHtml(String(h.answer))}</td>`
      + `<td class="${h.correct ? 'ok' : 'no'}">${h.correct ? 'yes' : 'no'}</td>`
      + `<td>${escapeHtml(String(h.correctOption ?? ''))}</td>`;
    tbody.appendChild(tr);
  });
  if (state.history.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4">No answers recorded for this mission.</td></tr>';
  }

  state.busy = false;
  show('scene-ending');
}

$('btn-play-again').addEventListener('click', () => {
  resetRound();
  startGame();
});
$('btn-ending-menu').addEventListener('click', () => {
  resetRound();
  show('scene-menu');
});

function resetRound() {
  state.gameId = null;
  state.question = null;
  state.history = [];
  state.answered = 0;
  state.answeredTotal = undefined;
  state.paused = false;
  $('btn-pause').hidden = false;
  $('btn-resume').hidden = true;
}

// --------------------------------------------------------------------------
// View Help (UseCaseDiagram) and View Score / leaderboard
// --------------------------------------------------------------------------
$('btn-help').addEventListener('click', async () => {
  const panel = $('menu-panel');
  panel.hidden = false;
  panel.innerHTML = '<h2>Help</h2><p>Loading...</p>';
  try {
    const help = await api('/api/v1/help');
    const steps = (help.steps || []).map((s) => `<li>${escapeHtml(s)}</li>`).join('');
    const tips = (help.tips || []).map((s) => `<li>${escapeHtml(s)}</li>`).join('');
    panel.innerHTML = `<h2>${escapeHtml(help.topic || 'Fractions')}</h2>`
      + `<ul>${steps}</ul>${tips ? `<h3>Tips</h3><ul>${tips}</ul>` : ''}`;
  } catch (err) {
    panel.innerHTML = `<h2>Help</h2><p class="status error">Could not load help: ${escapeHtml(err.message)}</p>`;
  }
});

$('btn-leaderboard').addEventListener('click', async () => {
  const panel = $('menu-panel');
  panel.hidden = false;
  panel.innerHTML = '<h2>Leaderboard</h2><p>Loading...</p>';
  try {
    const board = await api('/api/v1/leaderboard?limit=10');
    const rows = (board.entries || [])
      .map((e) => `<tr><td>${escapeHtml(e.username || 'anonymous')}</td><td>${e.score}</td>`
        + `<td>${escapeHtml(e.state || '')}</td></tr>`)
      .join('');
    panel.innerHTML = '<h2>Top scores</h2>'
      + (rows
        ? `<table><thead><tr><th>Pilot</th><th>Score</th><th>State</th></tr></thead><tbody>${rows}</tbody></table>`
        : '<p>No completed missions yet. Be the first cadet!</p>');
  } catch (err) {
    panel.innerHTML = `<h2>Leaderboard</h2><p class="status error">Could not load scores: ${escapeHtml(err.message)}</p>`;
  }
});

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

// Boot into the intro movie, per the executive summary's opening scene.
show('scene-intro');
