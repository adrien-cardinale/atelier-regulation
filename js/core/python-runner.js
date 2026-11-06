(function (App) {
  const PYODIDE_INDEX = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/';
  const USER_FILENAME = '<editeur>';
  const HELPERS = String.raw`
import numpy as _np

def _app_to_plain(value):
    if isinstance(value, _np.ndarray):
        return value.tolist()
    if isinstance(value, _np.generic):
        return value.item()
    if isinstance(value, (list, tuple)):
        return [_app_to_plain(item) for item in value]
    if isinstance(value, dict):
        return {str(key): _app_to_plain(item) for key, item in value.items()}
    return value

def _app_call(namespace, params):
    simulate = namespace.get("simulate")
    if simulate is None or not callable(simulate):
        raise NameError("La fonction simulate(p) n'est pas définie dans le code.")
    result = simulate(dict(params))
    if not isinstance(result, dict):
        raise TypeError("simulate(p) doit retourner un dict, pas " + type(result).__name__ + ".")
    return _app_to_plain(result)
`;

  let pyodide = null;
  let loadingPromise = null;
  let outputBuffer = [];

  function captureOutput(stream) {
    return { batched: (text) => outputBuffer.push({ stream: stream, text: text }) };
  }

  async function initialise(onProgress) {
    if (typeof window.loadPyodide !== 'function') {
      throw new Error('Le script Pyodide n\'a pas pu être chargé depuis le CDN (cdn.jsdelivr.net).');
    }
    onProgress('Téléchargement de Pyodide…');
    const instance = await window.loadPyodide({ indexURL: PYODIDE_INDEX });
    onProgress('Chargement de numpy…');
    await instance.loadPackage('numpy');
    onProgress('Préparation…');
    instance.setStdout(captureOutput('stdout'));
    instance.setStderr(captureOutput('stderr'));
    instance.runPython(HELPERS, { filename: '<app>' });
    pyodide = instance;
    return instance;
  }

  function load(onProgress) {
    if (!loadingPromise) loadingPromise = initialise(onProgress || function () {});
    return loadingPromise;
  }

  function isReady() {
    return pyodide !== null;
  }

  function destroyProxy(value) {
    if (value && typeof value.destroy === 'function') value.destroy();
  }

  function isInternalFrame(line) {
    return /^\s*File "\/lib\//.test(line) || /^\s*File "<app>"/.test(line);
  }

  function cleanTraceback(message) {
    const lines = String(message).split('\n');
    const kept = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (isInternalFrame(lines[index])) {
        while (index + 1 < lines.length && /^\s{4,}/.test(lines[index + 1])) index += 1;
        continue;
      }
      kept.push(lines[index]);
    }
    return kept.join('\n').trim();
  }

  function findErrorLine(message) {
    const pattern = /File "(?:<editeur>|<exec>)", line (\d+)/g;
    let match;
    let line = null;
    while ((match = pattern.exec(message)) !== null) line = Number(match[1]);
    return line;
  }

  function execute(code, params) {
    const namespace = pyodide.toPy({});
    let pyParams = null;
    let caller = null;
    let pyResult = null;
    try {
      pyodide.runPython(code, { globals: namespace, filename: USER_FILENAME });
      pyParams = pyodide.toPy(params);
      caller = pyodide.globals.get('_app_call');
      pyResult = caller(namespace, pyParams);
      return pyResult.toJs({ dict_converter: Object.fromEntries });
    } finally {
      destroyProxy(pyResult);
      destroyProxy(caller);
      destroyProxy(pyParams);
      destroyProxy(namespace);
    }
  }

  function describeError(error) {
    const raw = error && error.message ? error.message : String(error);
    return { message: cleanTraceback(raw), line: findErrorLine(raw) };
  }

  function run(code, params) {
    if (!pyodide) return { ok: false, error: { message: 'Python n\'est pas encore prêt.', line: null }, output: [], ms: 0 };
    outputBuffer = [];
    const started = performance.now();
    try {
      const result = execute(code, params);
      return { ok: true, result: result, output: outputBuffer, ms: performance.now() - started };
    } catch (error) {
      return { ok: false, error: describeError(error), output: outputBuffer, ms: performance.now() - started };
    }
  }

  App.python = { load: load, isReady: isReady, run: run };
})(window.App = window.App || {});
