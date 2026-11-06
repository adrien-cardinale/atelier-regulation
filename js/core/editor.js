(function (App) {
  const START_MARKER = /^\s*#\s*>>>\s*block:\s*([\w-]+)/;
  const END_MARKER = /^\s*#\s*<<<\s*block:\s*([\w-]+)/;
  const LIGHT_THEME = 'default';
  const DARK_THEME = 'material-darker';

  function parseRegions(code) {
    const regions = [];
    const open = {};
    code.split('\n').forEach((line, index) => {
      const start = line.match(START_MARKER);
      const end = line.match(END_MARKER);
      if (start) open[start[1]] = index;
      if (end && open[end[1]] !== undefined) {
        regions.push({ id: end[1], from: open[end[1]], to: index });
        delete open[end[1]];
      }
    });
    return regions;
  }

  function regionAtLine(regions, line) {
    const region = regions.find((item) => line >= item.from && line <= item.to);
    return region ? region.id : null;
  }

  function debounce(fn, delay) {
    let timer = null;
    const debounced = function () {
      const args = arguments;
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(null, args), delay);
    };
    debounced.cancel = () => clearTimeout(timer);
    return debounced;
  }

  function createCodeMirror(container, options) {
    return window.CodeMirror(container, {
      value: '',
      mode: 'python',
      theme: options.dark ? DARK_THEME : LIGHT_THEME,
      lineNumbers: true,
      indentUnit: 4,
      tabSize: 4,
      indentWithTabs: false,
      styleActiveLine: true,
      matchBrackets: true,
      lineWrapping: false,
      screenReaderLabel: 'Éditeur de code Python',
      extraKeys: {
        Tab: (cm) => cm.execCommand(cm.somethingSelected() ? 'indentMore' : 'insertSoftTab'),
        'Shift-Tab': 'indentLess',
        'Ctrl-Enter': () => options.onRunRequest(),
        'Cmd-Enter': () => options.onRunRequest()
      }
    });
  }

  function createTextareaFallback(container, options) {
    const area = document.createElement('textarea');
    area.className = 'editor-fallback';
    area.spellcheck = false;
    area.setAttribute('aria-label', 'Éditeur de code Python');
    container.appendChild(area);
    const handlers = { change: [], cursorActivity: [] };
    area.addEventListener('input', () => handlers.change.forEach((fn) => fn()));
    area.addEventListener('keyup', () => handlers.cursorActivity.forEach((fn) => fn()));
    area.addEventListener('click', () => handlers.cursorActivity.forEach((fn) => fn()));
    area.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) options.onRunRequest();
    });
    return {
      getValue: () => area.value,
      setValue: (value) => { area.value = value; },
      on: (name, fn) => handlers[name] && handlers[name].push(fn),
      getCursor: () => ({ line: area.value.slice(0, area.selectionStart).split('\n').length - 1 }),
      hasFocus: () => document.activeElement === area,
      fallback: true
    };
  }

  function create(container, options) {
    const cm = window.CodeMirror ? createCodeMirror(container, options) : createTextareaFallback(container, options);
    let regions = [];
    let highlighted = { id: null, lines: [] };
    let errorLine = null;
    let silent = false;
    const notifyChange = debounce((code) => options.onChange(code), options.debounceMs || 500);

    function clearHighlight() {
      if (cm.fallback) return;
      highlighted.lines.forEach((handle) => cm.removeLineClass(handle, 'background', 'cm-block-highlight'));
      highlighted = { id: null, lines: [] };
    }

    function highlightBlock(id, scroll) {
      if (cm.fallback) return;
      clearHighlight();
      const region = regions.find((item) => item.id === id);
      if (!region) return;
      const lines = [];
      for (let line = region.from; line <= region.to; line += 1) {
        lines.push(cm.addLineClass(line, 'background', 'cm-block-highlight'));
      }
      highlighted = { id: id, lines: lines };
      if (scroll) cm.scrollIntoView({ from: { line: region.from, ch: 0 }, to: { line: region.to, ch: 0 } }, 60);
    }

    function clearError() {
      if (cm.fallback || errorLine === null) return;
      cm.removeLineClass(errorLine, 'background', 'cm-error-line');
      errorLine = null;
    }

    function markError(line) {
      clearError();
      if (cm.fallback || !line || line > cm.lineCount()) return null;
      errorLine = cm.addLineClass(line - 1, 'background', 'cm-error-line');
      return regionAtLine(regions, line - 1);
    }

    function setCode(code) {
      silent = true;
      clearError();
      clearHighlight();
      notifyChange.cancel();
      cm.setValue(code);
      regions = parseRegions(code);
      silent = false;
      if (cm.clearHistory) cm.clearHistory();
    }

    cm.on('change', () => {
      if (silent) return;
      const code = cm.getValue();
      regions = parseRegions(code);
      if (highlighted.id) highlightBlock(highlighted.id, false);
      options.onInput(code);
      notifyChange(code);
    });

    cm.on('cursorActivity', () => {
      if (silent || !cm.hasFocus()) return;
      options.onCursorBlock(regionAtLine(regions, cm.getCursor().line));
    });

    return {
      getCode: () => cm.getValue(),
      setCode: setCode,
      highlightBlock: highlightBlock,
      clearHighlight: clearHighlight,
      markError: markError,
      clearError: clearError,
      blockAtLine: (line) => regionAtLine(regions, line - 1),
      setDark: (dark) => cm.setOption && cm.setOption('theme', dark ? DARK_THEME : LIGHT_THEME),
      refresh: () => cm.refresh && cm.refresh(),
      flush: () => notifyChange.cancel(),
      download: (filename) => App.plots.downloadText(filename, cm.getValue(), 'text/x-python'),
      isFallback: Boolean(cm.fallback)
    };
  }

  App.editor = { create: create, parseRegions: parseRegions };
})(window.App = window.App || {});
