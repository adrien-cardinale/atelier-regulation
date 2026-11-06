(function (App) {
  const LOG_SLIDER_STEPS = 400;
  let controlCount = 0;

  function isInteger(param) {
    return !param.log && Number.isInteger(param.step) && Number.isInteger(param.min);
  }

  function clamp(param, value) {
    const bounded = Math.min(param.max, Math.max(param.min, value));
    return isInteger(param) ? Math.round(bounded) : bounded;
  }

  function toSlider(param, value) {
    if (!param.log) return value;
    const low = Math.log10(param.min);
    const high = Math.log10(param.max);
    return Math.round(((Math.log10(value) - low) / (high - low)) * LOG_SLIDER_STEPS);
  }

  function fromSlider(param, position) {
    if (!param.log) return clamp(param, Number(position));
    const low = Math.log10(param.min);
    const high = Math.log10(param.max);
    const value = Math.pow(10, low + (Number(position) / LOG_SLIDER_STEPS) * (high - low));
    return Number(App.significantDigits(value, 3));
  }

  function displayValue(param, value) {
    if (isInteger(param)) return String(Math.round(value));
    return App.significantDigits(value, 4);
  }

  function element(tag, className, parent) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (parent) parent.appendChild(node);
    return node;
  }

  function buildLabel(param, inputId) {
    const label = element('label', 'param-label');
    label.htmlFor = inputId;
    const symbol = element('span', 'param-symbol', label);
    symbol.textContent = param.symbol || param.id;
    const text = element('span', 'param-text', label);
    text.textContent = param.label;
    if (param.log) {
      const badge = element('span', 'param-badge', label);
      badge.textContent = 'log';
      badge.title = 'Curseur en échelle logarithmique';
    }
    return label;
  }

  function buildCompactLabel(param, inputId) {
    const label = element('label', 'param-label-compact');
    label.htmlFor = inputId;
    const symbol = element('span', 'param-symbol', label);
    symbol.textContent = param.symbol || param.id;
    if (param.unit) label.appendChild(buildUnit(param));
    label.title = param.label + (param.unit ? ' (' + param.unit + ')' : '') + (param.log ? ' · échelle logarithmique' : '');
    return label;
  }

  function buildSlider(param) {
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'param-slider';
    slider.min = param.log ? 0 : param.min;
    slider.max = param.log ? LOG_SLIDER_STEPS : param.max;
    slider.step = param.log ? 1 : param.step;
    slider.setAttribute('aria-label', param.label + ' (curseur)');
    return slider;
  }

  function buildNumber(param, inputId) {
    const number = document.createElement('input');
    number.type = 'number';
    number.id = inputId;
    number.className = 'param-number';
    number.min = param.min;
    number.max = param.max;
    number.step = param.log ? 'any' : param.step;
    number.inputMode = 'decimal';
    number.setAttribute('aria-label', param.label + (param.unit ? ' (' + param.unit + ')' : ''));
    return number;
  }

  function buildUnit(param) {
    const unit = element('span', 'param-unit');
    unit.textContent = param.unit || '';
    return unit;
  }

  function createInputs(param, model) {
    controlCount += 1;
    const inputId = 'param-' + param.id + '-' + controlCount;
    const slider = buildSlider(param);
    const number = buildNumber(param, inputId);

    slider.addEventListener('input', () => model.set(param.id, fromSlider(param, slider.value)));
    number.addEventListener('input', () => {
      const value = Number(number.value);
      if (number.value !== '' && Number.isFinite(value) && value >= param.min && value <= param.max) {
        model.set(param.id, clamp(param, value), number);
      }
    });
    number.addEventListener('change', () => {
      const value = Number(number.value);
      model.set(param.id, Number.isFinite(value) && number.value !== '' ? clamp(param, value) : model.get(param.id));
    });

    function render(value, source) {
      slider.value = toSlider(param, value);
      slider.setAttribute('aria-valuetext', displayValue(param, value) + ' ' + (param.unit || ''));
      if (source !== number) number.value = displayValue(param, value);
    }

    return { inputId: inputId, slider: slider, number: number, render: render };
  }

  function buildControl(param, model) {
    const inputs = createInputs(param, model);
    const row = element('div', 'param-row');
    row.dataset.paramId = param.id;
    row.appendChild(buildLabel(param, inputs.inputId));
    const line = element('div', 'param-inputs', row);
    line.append(inputs.slider, inputs.number, buildUnit(param));
    return { id: param.id, row: row, render: inputs.render };
  }

  function buildCompactControl(param, model) {
    const inputs = createInputs(param, model);
    const row = element('div', 'param-row param-row-compact');
    row.dataset.paramId = param.id;
    inputs.number.classList.add('param-number-compact');
    row.append(buildCompactLabel(param, inputs.inputId), inputs.number, inputs.slider);
    return { id: param.id, row: row, render: inputs.render };
  }

  function groupParams(params) {
    const groups = [];
    params.forEach((param) => {
      const name = param.group || 'Paramètres';
      let group = groups.find((item) => item.name === name);
      if (!group) {
        group = { name: name, params: [] };
        groups.push(group);
      }
      group.params.push(param);
    });
    return groups;
  }

  function isInline(param) {
    return Boolean(param.block) && !param.advanced;
  }

  function defaultValues(params) {
    const values = {};
    params.forEach((param) => { values[param.id] = param.default; });
    return values;
  }

  function sanitise(params, stored) {
    const values = defaultValues(params);
    params.forEach((param) => {
      const value = stored ? Number(stored[param.id]) : NaN;
      if (Number.isFinite(value)) values[param.id] = clamp(param, value);
    });
    return values;
  }

  function createModel(params, initialValues, onChange) {
    const values = sanitise(params, initialValues);
    const views = new Map();

    function controlsFor(id) {
      const list = [];
      views.forEach((controls) => controls.filter((control) => control.id === id).forEach((control) => list.push(control)));
      return list;
    }

    function pruneDetached() {
      views.forEach((controls, container) => {
        if (!container.isConnected) views.delete(container);
      });
    }

    function renderAll() {
      pruneDetached();
      views.forEach((controls) => controls.forEach((control) => control.render(values[control.id])));
    }

    const model = {
      get: (id) => values[id],
      values: () => Object.assign({}, values),
      set: function (id, value, source) {
        if (values[id] === value) {
          controlsFor(id).forEach((control) => control.render(value, source));
          return;
        }
        values[id] = value;
        controlsFor(id).forEach((control) => control.render(value, source));
        onChange(model.values(), id);
      },
      reset: function () {
        Object.assign(values, defaultValues(params));
        renderAll();
        onChange(model.values(), null);
      },
      renderGroups: function (container, predicate) {
        container.textContent = '';
        const controls = [];
        groupParams(params.filter(predicate || (() => true))).forEach((group) => {
          const fieldset = element('fieldset', 'param-group', container);
          const legend = element('legend', 'param-group-title', fieldset);
          legend.textContent = group.name;
          group.params.forEach((param) => {
            const control = buildControl(param, model);
            fieldset.appendChild(control.row);
            controls.push(control);
          });
        });
        views.set(container, controls);
        renderAll();
        return controls.length;
      },
      renderSubset: function (container, predicate, variant) {
        container.textContent = '';
        const builder = variant === 'compact' ? buildCompactControl : buildControl;
        const controls = params.filter(predicate).map((param) => {
          const control = builder(param, model);
          container.appendChild(control.row);
          return control;
        });
        views.set(container, controls);
        renderAll();
        return controls.length;
      }
    };
    return model;
  }

  App.params = { createModel: createModel, defaultValues: defaultValues, isInline: isInline };
})(window.App = window.App || {});
