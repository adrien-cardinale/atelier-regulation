(function (App) {
  const systems = [];
  const listeners = [];
  const REQUIRED_FIELDS = ['id', 'name', 'code', 'params', 'diagram', 'plots', 'timeKey'];
  let currentId = null;

  function missingFields(definition) {
    return REQUIRED_FIELDS.filter((field) => definition[field] === undefined);
  }

  function registerSystem(definition) {
    const missing = missingFields(definition);
    if (missing.length) {
      throw new Error('Système « ' + (definition.id || '?') + ' » incomplet : ' + missing.join(', '));
    }
    if (getSystem(definition.id)) {
      throw new Error('Système déjà enregistré : ' + definition.id);
    }
    systems.push(Object.assign({ subtitle: '', description: '', readouts: [] }, definition));
  }

  function getSystem(id) {
    return systems.find((system) => system.id === id) || null;
  }

  function getCurrentSystem() {
    return getSystem(currentId);
  }

  function setCurrentSystem(id) {
    const system = getSystem(id) || systems[0] || null;
    currentId = system ? system.id : null;
    listeners.forEach((listener) => listener(system));
    return system;
  }

  function onSystemChange(listener) {
    listeners.push(listener);
  }

  function significantDigits(value, digits) {
    if (value === 0) return '0';
    const magnitude = Math.abs(value);
    if (magnitude >= 1e5 || magnitude < 1e-3) return value.toExponential(digits - 1);
    return String(Number(value.toPrecision(digits)));
  }

  function formatValue(value, format) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
    if (typeof format === 'function') return format(value);
    if (typeof format === 'number') return value.toFixed(format);
    if (format === 'int') return String(Math.round(value));
    if (format === 'percent') return value.toFixed(1) + ' %';
    return significantDigits(value, 4);
  }

  App.systems = systems;
  App.registerSystem = registerSystem;
  App.getSystem = getSystem;
  App.getCurrentSystem = getCurrentSystem;
  App.setCurrentSystem = setCurrentSystem;
  App.onSystemChange = onSystemChange;
  App.formatValue = formatValue;
  App.significantDigits = significantDigits;
})(window.App = window.App || {});
