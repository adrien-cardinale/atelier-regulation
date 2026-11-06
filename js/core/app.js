(function (App) {
  const STORAGE_PREFIX = 'regulation-lab:v1:';
  const PARAM_THROTTLE_MS = 50;
  const EDITOR_DEBOUNCE_MS = 500;
  const PLAY_DURATION_S = 10;
  const FAST_PHASE_MS = 180;
  const DETAILED_PHASE_MS = 750;
  const STEP_SWEEP_MS = 130;
  const MAX_FRAME_MS = 100;
  const KIND_LABELS = { process: 'Système physique', measure: 'Mesure', estimate: 'Algorithme', io: 'Entrée / sortie' };

  const state = {
    system: null,
    model: null,
    diagram: null,
    plots: null,
    editor: null,
    result: null,
    k: 0,
    playing: false,
    playCursor: 0,
    playFrame: null,
    lastFrameAt: 0,
    phaseClock: 0,
    phase: -1,
    speed: 1,
    detailed: false,
    sweepTimer: null,
    selectedBlock: null,
    explainedId: undefined,
    autoRun: true,
    pendingRun: false,
    runTimer: null,
    lastRunAt: 0,
    markerFrame: null
  };
  const dom = {};

  function byId(id) {
    return document.getElementById(id);
  }

  function storageGet(key) {
    try {
      return window.localStorage.getItem(STORAGE_PREFIX + key);
    } catch (error) {
      return null;
    }
  }

  function storageSet(key, value) {
    try {
      if (value === null) window.localStorage.removeItem(STORAGE_PREFIX + key);
      else window.localStorage.setItem(STORAGE_PREFIX + key, value);
    } catch (error) {
      return;
    }
  }

  function storedJson(key) {
    try {
      return JSON.parse(storageGet(key) || 'null');
    } catch (error) {
      return null;
    }
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function collectDom() {
    ['system-tabs', 'system-subtitle', 'python-status', 'run-time', 'theme-toggle', 'reset-all', 'banner',
      'diagram', 'params-advanced', 'params-summary', 'params-section', 'reset-params', 'system-description',
      'readouts', 'play', 'step-back', 'step-forward', 'speed', 'detailed-cycle', 'scrubber', 'scrubber-label',
      'plots', 'auto-run', 'run', 'reset-code', 'download-code', 'editor', 'console-output', 'console-status',
      'code-summary-status', 'code-section', 'code-modified', 'about-title', 'skip-to-code', 'explain-title',
      'explain-kind', 'explain-tag', 'explain-follow', 'explain-equations', 'explain-info']
      .forEach((id) => { dom[id] = byId(id); });
  }

  function showBanner(message, level) {
    const item = element('p', 'banner-item banner-' + (level || 'error'));
    item.appendChild(element('strong', '', level === 'warning' ? 'Attention · ' : 'Erreur · '));
    item.appendChild(document.createTextNode(message));
    dom.banner.appendChild(item);
    dom.banner.hidden = false;
  }

  function preferredTheme() {
    const stored = storageGet('theme');
    if (stored === 'light' || stored === 'dark') return stored;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    dom['theme-toggle'].setAttribute('aria-pressed', String(theme === 'dark'));
    dom['theme-toggle'].querySelector('.theme-label').textContent = theme === 'dark' ? 'Sombre' : 'Clair';
    if (state.editor) state.editor.setDark(theme === 'dark');
    if (state.plots) state.plots.refreshTheme();
  }

  function toggleTheme() {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    storageSet('theme', next);
    applyTheme(next);
  }

  function watchSystemTheme() {
    if (!window.matchMedia) return;
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (event) => {
      if (!storageGet('theme')) applyTheme(event.matches ? 'dark' : 'light');
    });
  }

  function setPythonStatus(status, text) {
    dom['python-status'].dataset.status = status;
    dom['python-status'].querySelector('.status-text').textContent = text;
    dom.run.disabled = status === 'error';
  }

  function renderConsole(outcome, warnings) {
    const output = dom['console-output'];
    output.textContent = '';
    outcome.output.forEach((entry) => output.appendChild(element('span', 'console-' + entry.stream, entry.text + '\n')));
    warnings.forEach((warning) => output.appendChild(element('span', 'console-warning', '⚠ ' + warning + '\n')));
    if (!outcome.ok) output.appendChild(element('span', 'console-error', outcome.error.message + '\n'));
    output.scrollTop = output.scrollHeight;
    const ms = Math.round(outcome.ms);
    const text = outcome.ok
      ? '✓ OK · ' + ms + ' ms'
      : '✕ Erreur' + (outcome.error.line ? ' · ligne ' + outcome.error.line : '') + ' · résultat précédent conservé';
    [dom['console-status'], dom['code-summary-status']].forEach((status) => {
      status.dataset.status = outcome.ok ? 'ok' : 'error';
      status.textContent = text;
    });
    dom['run-time'].textContent = ms + ' ms';
  }

  function resultLength() {
    const time = state.result && state.result[state.system.timeKey];
    return Array.isArray(time) ? time.length : 0;
  }

  function renderReadouts() {
    dom.readouts.textContent = '';
    state.system.readouts.forEach((readout) => {
      const tile = element('div', 'readout-tile');
      if (readout.hint) tile.title = readout.hint;
      tile.appendChild(element('span', 'readout-tile-label', readout.label));
      const valueLine = element('span', 'readout-tile-value');
      let value = NaN;
      try {
        value = state.result ? readout.compute(state.result) : NaN;
      } catch (error) {
        value = NaN;
      }
      valueLine.appendChild(element('span', 'readout-number', App.formatValue(value, readout.format)));
      if (readout.unit) valueLine.appendChild(element('span', 'readout-unit', readout.unit));
      tile.appendChild(valueLine);
      dom.readouts.appendChild(tile);
    });
  }

  function scheduleMarker() {
    if (state.markerFrame !== null) return;
    state.markerFrame = requestAnimationFrame(() => {
      state.markerFrame = null;
      const time = state.result && state.result[state.system.timeKey];
      if (state.plots && time) state.plots.setMarker(time[state.k]);
    });
  }

  function formatTime(seconds) {
    return Number.isFinite(seconds) ? App.significantDigits(seconds, 4) + ' s' : '—';
  }

  function applyK(k) {
    const length = resultLength();
    state.k = Math.max(0, Math.min(length - 1, Math.round(k)));
    if (!length) return;
    dom.scrubber.value = state.k;
    const time = state.result[state.system.timeKey][state.k];
    const label = 'k = ' + state.k + ' / ' + (length - 1) + ' · t = ' + formatTime(time);
    dom['scrubber-label'].textContent = label;
    dom.scrubber.setAttribute('aria-valuetext', label);
    state.diagram.updateReadouts(state.result, state.k);
    scheduleMarker();
  }

  function updateScrubberRange() {
    const length = resultLength();
    dom.scrubber.max = Math.max(0, length - 1);
    [dom.scrubber, dom.play, dom['step-back'], dom['step-forward']].forEach((control) => { control.disabled = length === 0; });
  }

  function validateResult(result) {
    const time = result[state.system.timeKey];
    if (!Array.isArray(time) || !time.length) {
      return 'simulate(p) doit retourner la clé « ' + state.system.timeKey + ' » (vecteur temps non vide).';
    }
    return null;
  }

  function handleSuccess(outcome) {
    state.result = outcome.result;
    const missing = state.plots.render(outcome.result);
    const warnings = missing.map((key) => 'Clé absente du résultat : « ' + key + ' » (trace ignorée).');
    renderReadouts();
    updateScrubberRange();
    applyK(state.k);
    state.diagram.setError(null);
    state.editor.clearError();
    renderConsole(outcome, warnings);
  }

  function handleFailure(outcome) {
    const blockId = state.editor.markError(outcome.error.line);
    state.diagram.setError(blockId);
    renderConsole(outcome, []);
  }

  function runNow() {
    clearTimeout(state.runTimer);
    state.runTimer = null;
    if (!App.python.isReady()) {
      state.pendingRun = true;
      return;
    }
    state.pendingRun = false;
    state.lastRunAt = performance.now();
    const outcome = App.python.run(state.editor.getCode(), state.model.values());
    if (outcome.ok) {
      const problem = validateResult(outcome.result);
      if (problem) {
        handleFailure({ ok: false, error: { message: problem, line: null }, output: outcome.output, ms: outcome.ms });
        return;
      }
      handleSuccess(outcome);
      return;
    }
    handleFailure(outcome);
  }

  function requestThrottledRun() {
    const elapsed = performance.now() - state.lastRunAt;
    if (elapsed >= PARAM_THROTTLE_MS) {
      runNow();
      return;
    }
    if (state.runTimer === null) state.runTimer = setTimeout(runNow, PARAM_THROTTLE_MS - elapsed);
  }

  function storageKey(suffix) {
    return state.system.id + ':' + suffix;
  }

  function onParamsChange(values) {
    storageSet(storageKey('params'), JSON.stringify(values));
    requestThrottledRun();
  }

  function isCodeModified(code) {
    return code !== state.system.code;
  }

  function onCodeInput(code) {
    const modified = isCodeModified(code);
    storageSet(storageKey('code'), modified ? code : null);
    dom['code-modified'].hidden = !modified;
  }

  function onCodeChange() {
    if (state.autoRun) runNow();
  }

  function onCursorBlock(blockId) {
    state.diagram.setLinked(blockId);
    const target = blockId || state.selectedBlock;
    if (target) state.editor.highlightBlock(target, false);
    else state.editor.clearHighlight();
  }

  function findBlock(id) {
    return state.system.diagram.blocks.find((block) => block.id === id) || null;
  }

  function cycle() {
    return state.diagram ? state.diagram.cycle : [];
  }

  function displayedBlockId() {
    if (state.selectedBlock) return state.selectedBlock;
    if (state.phase >= 0) return cycle()[state.phase];
    const first = state.system.diagram.blocks[0];
    return cycle()[0] || (first ? first.id : null);
  }

  function fillExplain(block) {
    dom['explain-title'].textContent = block ? block.title : '—';
    dom['explain-kind'].className = 'kind-badge kind-' + ((block && block.kind) || 'process');
    dom['explain-kind'].textContent = block ? KIND_LABELS[block.kind] || '' : '';
    dom['explain-equations'].textContent = '';
    ((block && block.lines) || []).forEach((line) => dom['explain-equations'].appendChild(element('div', 'equation', line)));
    dom['explain-equations'].hidden = !(block && block.lines && block.lines.length);
    dom['explain-info'].innerHTML = block && block.info ? block.info : '<p class="muted">Pas d\'explication détaillée pour ce bloc.</p>';
  }

  function explainTag(id) {
    if (state.selectedBlock) return { mode: 'selected', text: 'Bloc sélectionné' };
    const index = cycle().indexOf(id);
    if (state.phase >= 0 && index >= 0) return { mode: 'active', text: 'Étape ' + (index + 1) + ' / ' + cycle().length + ' du cycle' };
    return { mode: 'idle', text: 'Début du cycle · cliquez un bloc pour le sélectionner' };
  }

  function renderExplain() {
    const id = displayedBlockId();
    if (id !== state.explainedId) {
      state.explainedId = id;
      fillExplain(findBlock(id));
    }
    const tag = explainTag(id);
    dom['explain-tag'].dataset.mode = tag.mode;
    dom['explain-tag'].textContent = tag.text;
    dom['explain-follow'].hidden = !state.selectedBlock;
  }

  function revealCode(id) {
    if (!dom['code-section'].open) dom['code-section'].open = true;
    state.editor.refresh();
    state.editor.highlightBlock(id, true);
  }

  function selectBlock(id) {
    const block = findBlock(id);
    state.selectedBlock = block ? id : null;
    state.diagram.setSelected(state.selectedBlock);
    renderExplain();
    if (block) revealCode(id);
    else state.editor.clearHighlight();
  }

  function setPhase(index) {
    state.phase = index >= 0 && index < cycle().length ? index : -1;
    state.diagram.setActive(state.phase >= 0 ? cycle()[state.phase] : null);
    renderExplain();
  }

  function cancelSweep() {
    clearTimeout(state.sweepTimer);
    state.sweepTimer = null;
  }

  function sweepCycle() {
    cancelSweep();
    const count = cycle().length;
    let index = 0;
    function next() {
      setPhase(index);
      index += 1;
      state.sweepTimer = index < count ? setTimeout(next, STEP_SWEEP_MS / state.speed) : null;
    }
    if (count) next();
  }

  function lastIndex() {
    return resultLength() - 1;
  }

  function advancePhase(direction) {
    const count = cycle().length;
    let k = state.k;
    let phase = state.phase + direction;
    if (!count) {
      k += direction;
      phase = -1;
    } else if (phase >= count) {
      phase = 0;
      k += 1;
    } else if (phase < 0) {
      phase = count - 1;
      k -= 1;
    }
    if (k < 0 || k > lastIndex()) return false;
    if (k !== state.k) applyK(k);
    setPhase(phase);
    return true;
  }

  function updatePlayButton() {
    dom.play.setAttribute('aria-pressed', String(state.playing));
    dom.play.querySelector('.play-label').textContent = state.playing ? 'Pause' : 'Lecture';
    dom.play.querySelector('.play-icon').textContent = state.playing ? '❚❚' : '▶';
  }

  function stopPlaying() {
    state.playing = false;
    if (state.playFrame !== null) cancelAnimationFrame(state.playFrame);
    state.playFrame = null;
    updatePlayButton();
  }

  function playDetailed(elapsed) {
    state.phaseClock += elapsed;
    if (state.phaseClock < DETAILED_PHASE_MS) return;
    state.phaseClock = 0;
    if (!advancePhase(1)) stopPlaying();
  }

  function playFast(elapsed) {
    const length = resultLength();
    state.playCursor += elapsed * Math.max(1, length / PLAY_DURATION_S) / 1000;
    state.phaseClock += elapsed;
    const count = cycle().length;
    if (count) {
      const phase = Math.floor(state.phaseClock / FAST_PHASE_MS) % count;
      if (phase !== state.phase) setPhase(phase);
    }
    if (state.playCursor >= length - 1) {
      applyK(length - 1);
      stopPlaying();
      return;
    }
    if (Math.floor(state.playCursor) !== state.k) applyK(Math.floor(state.playCursor));
  }

  function playFrame(now) {
    state.playFrame = null;
    if (!state.playing) return;
    const elapsed = Math.min(MAX_FRAME_MS, now - state.lastFrameAt) * state.speed;
    state.lastFrameAt = now;
    if (state.detailed) playDetailed(elapsed);
    else playFast(elapsed);
    if (state.playing) state.playFrame = requestAnimationFrame(playFrame);
  }

  function atEnd() {
    const count = cycle().length;
    return state.k >= lastIndex() && (!state.detailed || !count || state.phase >= count - 1);
  }

  function startPlaying() {
    if (!resultLength()) return;
    cancelSweep();
    if (atEnd()) {
      applyK(0);
      setPhase(-1);
    }
    if (state.detailed && state.phase < 0) setPhase(0);
    state.playCursor = state.k;
    state.phaseClock = 0;
    state.lastFrameAt = performance.now();
    state.playing = true;
    updatePlayButton();
    state.playFrame = requestAnimationFrame(playFrame);
  }

  function togglePlay() {
    if (state.playing) stopPlaying();
    else startPlaying();
  }

  function stepBy(direction) {
    stopPlaying();
    if (!resultLength()) return;
    if (state.detailed) {
      cancelSweep();
      advancePhase(direction);
      return;
    }
    const target = state.k + direction;
    if (target < 0 || target > lastIndex()) return;
    applyK(target);
    sweepCycle();
  }

  function setDetailed(enabled) {
    state.detailed = enabled;
    state.phaseClock = 0;
    dom['detailed-cycle'].setAttribute('aria-pressed', String(enabled));
    storageSet('detailed', enabled ? '1' : '0');
  }

  function setSpeed(value) {
    const speed = Number(value);
    state.speed = Number.isFinite(speed) && speed > 0 ? speed : 1;
    dom.speed.value = String(state.speed);
    storageSet('speed', String(state.speed));
  }

  function renderTabs() {
    dom['system-tabs'].textContent = '';
    App.systems.forEach((system) => {
      const tab = element('button', 'tab', system.name);
      tab.type = 'button';
      tab.setAttribute('role', 'tab');
      tab.dataset.systemId = system.id;
      tab.addEventListener('click', () => App.setCurrentSystem(system.id));
      dom['system-tabs'].appendChild(tab);
    });
  }

  function markActiveTab(id) {
    dom['system-tabs'].querySelectorAll('.tab').forEach((tab) => {
      const active = tab.dataset.systemId === id;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    });
  }

  function onTabKeydown(event) {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const index = App.systems.indexOf(state.system);
    const step = event.key === 'ArrowRight' ? 1 : -1;
    const next = App.systems[(index + step + App.systems.length) % App.systems.length];
    App.setCurrentSystem(next.id);
    dom['system-tabs'].querySelector('[data-system-id="' + next.id + '"]').focus();
  }

  function renderParamsSummary() {
    const symbols = state.system.params.filter((param) => !App.params.isInline(param)).map((param) => param.symbol || param.id);
    dom['params-summary'].textContent = symbols.join(' · ');
    if (!symbols.length) dom['params-advanced'].appendChild(element('p', 'muted', 'Tous les paramètres se règlent dans les blocs du schéma.'));
  }

  function renderBlockParams(container, blockId) {
    return state.model.renderSubset(container, (param) => App.params.isInline(param) && param.block === blockId, 'compact');
  }

  function referenceItem(reference) {
    const item = element('li', 'reference');
    item.appendChild(element('span', 'reference-authors', reference.authors + ' (' + reference.year + '). '));
    const title = reference.url ? element('a', 'reference-title', reference.title) : element('span', 'reference-title', reference.title);
    if (reference.url) {
      title.href = reference.url;
      title.target = '_blank';
      title.rel = 'noopener';
    }
    item.appendChild(title);
    item.appendChild(document.createTextNode('. ' + reference.where + '.'));
    if (reference.note) item.appendChild(element('span', 'reference-note', ' ' + reference.note));
    return item;
  }

  function renderDescription(system) {
    const container = dom['system-description'];
    container.innerHTML = system.description;
    if (!system.references || !system.references.length) return;
    const block = element('div', 'references');
    block.appendChild(element('h3', 'references-title', 'Références'));
    const list = element('ol', 'references-list');
    system.references.forEach((reference) => list.appendChild(referenceItem(reference)));
    block.appendChild(list);
    container.appendChild(block);
  }

  function mountSystem(system) {
    stopPlaying();
    cancelSweep();
    if (state.plots) state.plots.destroy();
    if (state.diagram) state.diagram.destroy();
    state.system = system;
    state.result = null;
    state.k = 0;
    state.phase = -1;
    state.selectedBlock = null;
    state.explainedId = undefined;
    storageSet('system', system.id);
    markActiveTab(system.id);
    window.scrollTo(0, 0);
    document.title = system.name + ' · Atelier de régulation';
    dom['system-subtitle'].textContent = system.subtitle;
    dom['about-title'].textContent = 'À propos · ' + system.name;
    renderDescription(system);
    state.model = App.params.createModel(system.params, storedJson(system.id + ':params'), onParamsChange);
    state.model.renderGroups(dom['params-advanced'], (param) => !App.params.isInline(param));
    renderParamsSummary();
    state.diagram = App.diagram.create(dom.diagram, system.diagram, { onSelect: selectBlock, renderParams: renderBlockParams });
    state.plots = App.plots.create(dom.plots, system.plots, system.id);
    const code = storageGet(system.id + ':code') || system.code;
    state.editor.setCode(code);
    dom['code-modified'].hidden = !isCodeModified(code);
    renderExplain();
    renderReadouts();
    updateScrubberRange();
    dom['scrubber-label'].textContent = 'k = — · t = —';
    dom['console-output'].textContent = '';
    dom['console-status'].textContent = '';
    dom['code-summary-status'].textContent = '';
    state.diagram.updateReadouts(null, 0);
    runNow();
  }

  function resetCode() {
    state.editor.setCode(state.system.code);
    onCodeInput(state.system.code);
    runNow();
  }

  function resetAll() {
    const modified = isCodeModified(state.editor.getCode());
    if (modified && !window.confirm('Réinitialiser les paramètres et le code ? Vos modifications du code seront perdues.')) return;
    state.editor.setCode(state.system.code);
    onCodeInput(state.system.code);
    state.model.reset();
    runNow();
  }

  function downloadCode() {
    state.editor.download(state.system.id + '.py');
  }

  function setAutoRun(enabled) {
    state.autoRun = enabled;
    storageSet('autorun', enabled ? '1' : '0');
  }

  function onCodeSectionToggle() {
    if (!dom['code-section'].open) return;
    state.editor.refresh();
    if (state.selectedBlock) state.editor.highlightBlock(state.selectedBlock, true);
  }

  function onDiagramKeydown(event) {
    if (event.key === 'Escape' && state.selectedBlock) selectBlock(null);
  }

  function bindTimeline() {
    dom.play.addEventListener('click', togglePlay);
    dom['step-back'].addEventListener('click', () => stepBy(-1));
    dom['step-forward'].addEventListener('click', () => stepBy(1));
    dom.scrubber.addEventListener('input', () => {
      stopPlaying();
      cancelSweep();
      applyK(Number(dom.scrubber.value));
    });
    setSpeed(storageGet('speed') || 1);
    dom.speed.addEventListener('change', () => setSpeed(dom.speed.value));
    setDetailed(storageGet('detailed') === '1');
    dom['detailed-cycle'].addEventListener('click', () => setDetailed(!state.detailed));
  }

  function bindControls() {
    dom['theme-toggle'].addEventListener('click', toggleTheme);
    dom['reset-all'].addEventListener('click', resetAll);
    dom['reset-params'].addEventListener('click', () => state.model.reset());
    dom['reset-code'].addEventListener('click', resetCode);
    dom['download-code'].addEventListener('click', downloadCode);
    dom.run.addEventListener('click', runNow);
    dom['system-tabs'].addEventListener('keydown', onTabKeydown);
    dom['explain-follow'].addEventListener('click', () => selectBlock(null));
    dom.diagram.addEventListener('keydown', onDiagramKeydown);
    dom['code-section'].addEventListener('toggle', onCodeSectionToggle);
    dom['skip-to-code'].addEventListener('click', () => { dom['code-section'].open = true; });
    bindTimeline();
    dom['auto-run'].checked = storageGet('autorun') !== '0';
    setAutoRun(dom['auto-run'].checked);
    dom['auto-run'].addEventListener('change', () => setAutoRun(dom['auto-run'].checked));
  }

  function createEditor() {
    state.editor = App.editor.create(dom.editor, {
      dark: document.documentElement.dataset.theme === 'dark',
      debounceMs: EDITOR_DEBOUNCE_MS,
      onInput: onCodeInput,
      onChange: onCodeChange,
      onCursorBlock: onCursorBlock,
      onRunRequest: runNow
    });
    if (state.editor.isFallback) showBanner('CodeMirror est indisponible : l\'éditeur fonctionne en mode texte simple.', 'warning');
  }

  function checkLibraries() {
    if (typeof window.Plotly === 'undefined') showBanner('Plotly n\'a pas pu être chargé depuis cdn.plot.ly : les graphes sont désactivés.', 'warning');
  }

  function loadPython() {
    setPythonStatus('loading', 'Python : démarrage…');
    App.python.load((step) => setPythonStatus('loading', 'Python : ' + step))
      .then(() => {
        setPythonStatus('ready', 'Python prêt');
        if (state.pendingRun) runNow();
      })
      .catch((error) => {
        setPythonStatus('error', 'Python indisponible');
        showBanner('Pyodide n\'a pas pu démarrer (' + (error && error.message ? error.message : error) + '). Vérifiez votre connexion à cdn.jsdelivr.net puis rechargez la page. Les calculs sont impossibles sans Python.', 'error');
      });
  }

  function start() {
    collectDom();
    applyTheme(preferredTheme());
    watchSystemTheme();
    checkLibraries();
    createEditor();
    bindControls();
    if (!App.systems.length) {
      showBanner('Aucun système enregistré.', 'error');
      return;
    }
    renderTabs();
    App.onSystemChange(mountSystem);
    App.setCurrentSystem(storageGet('system'));
    loadPython();
  }

  App.start = start;
})(window.App = window.App || {});
