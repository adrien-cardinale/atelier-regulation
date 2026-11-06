(function (App) {
  const PLOT_HEIGHT = 240;
  const SERIES_COLORS = ['series-1', 'series-2', 'series-3'];
  const MODE_BAR_REMOVED = ['select2d', 'lasso2d', 'autoScale2d', 'toggleSpikelines', 'hoverCompareCartesian', 'hoverClosestCartesian'];

  function cssVariable(name) {
    return getComputedStyle(document.documentElement).getPropertyValue('--' + name).trim();
  }

  function readTheme() {
    return {
      text: cssVariable('text-secondary'),
      muted: cssVariable('text-muted'),
      grid: cssVariable('plot-grid'),
      axis: cssVariable('plot-axis'),
      surface: cssVariable('surface-1'),
      border: cssVariable('border-strong'),
      marker: cssVariable('plot-marker'),
      font: cssVariable('font-sans'),
      mono: cssVariable('font-mono'),
      colors: {
        'series-1': cssVariable('series-1'),
        'series-2': cssVariable('series-2'),
        'series-3': cssVariable('series-3'),
        truth: cssVariable('plot-truth'),
        muted: cssVariable('plot-muted'),
        reference: cssVariable('plot-reference')
      }
    };
  }

  function withAlpha(color, alpha) {
    const hex = color.replace('#', '');
    if (hex.length !== 6) return color;
    const channels = [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
    return 'rgba(' + channels.join(',') + ',' + alpha + ')';
  }

  function isSeries(value) {
    return Array.isArray(value) && value.length > 0;
  }

  function resolveSeries(result, key) {
    if (typeof key === 'function') return key(result);
    return result[key];
  }

  function bandBounds(band, values, result) {
    if (band.upperKey && band.lowerKey) {
      return { upper: resolveSeries(result, band.upperKey), lower: resolveSeries(result, band.lowerKey) };
    }
    const spreadKey = band.varianceKey || band.sigmaKey;
    const spread = resolveSeries(result, spreadKey);
    if (!isSeries(spread)) return null;
    const center = band.center === undefined
      ? values
      : (typeof band.center === 'number' ? new Array(spread.length).fill(band.center) : resolveSeries(result, band.center));
    const factor = band.n || 2;
    const sigma = spread.map((value) => (band.varianceKey ? Math.sqrt(Math.max(value, 0)) : value) * factor);
    return {
      upper: center.map((value, index) => value + sigma[index]),
      lower: center.map((value, index) => value - sigma[index])
    };
  }

  function traceColor(trace, index, theme) {
    const slot = trace.color || SERIES_COLORS[index % SERIES_COLORS.length];
    return theme.colors[slot] || slot;
  }

  function buildBand(trace, x, bounds, color, groupId) {
    const fill = withAlpha(color, 0.14);
    const common = { x: x, type: 'scatter', mode: 'lines', line: { width: 0, color: fill }, hoverinfo: 'skip', legendgroup: groupId };
    return [
      Object.assign({}, common, { y: bounds.upper, showlegend: false }),
      Object.assign({}, common, {
        y: bounds.lower, fill: 'tonexty', fillcolor: fill,
        name: trace.band.name || '±' + (trace.band.n || 2) + 'σ', showlegend: Boolean(trace.band.name)
      })
    ];
  }

  function buildMainTrace(trace, x, y, color, groupId) {
    const kind = trace.kind || 'line';
    const base = {
      x: x, y: y, name: trace.name, legendgroup: groupId, type: 'scatter', yhoverformat: '.4g'
    };
    if (kind === 'markers') {
      return Object.assign(base, {
        mode: 'markers',
        marker: { size: trace.size || 4, color: color, opacity: trace.opacity === undefined ? 0.55 : trace.opacity }
      });
    }
    return Object.assign(base, {
      mode: 'lines',
      line: { width: trace.width || 2, color: color, shape: kind === 'step' ? 'hv' : 'linear', dash: trace.dash || 'solid' },
      opacity: trace.opacity === undefined ? 1 : trace.opacity
    });
  }

  function buildTraces(spec, result, theme, missing) {
    const x = result[spec.xKey];
    if (!isSeries(x)) {
      missing.push(spec.xKey);
      return [];
    }
    const traces = [];
    spec.traces.forEach((trace, index) => {
      const y = resolveSeries(result, trace.key);
      if (!isSeries(y)) {
        if (typeof trace.key === 'string') missing.push(trace.key);
        return;
      }
      const color = traceColor(trace, index, theme);
      const groupId = spec.id + '-' + index;
      if (trace.band) {
        const bounds = bandBounds(trace.band, y, result);
        if (bounds && isSeries(bounds.upper)) traces.push.apply(traces, buildBand(trace, x, bounds, color, groupId));
      }
      traces.push(buildMainTrace(trace, x, y, color, groupId));
    });
    return traces;
  }

  function resolveLevel(line, result) {
    const value = typeof line.value === 'function' ? line.value(result) : (typeof line.value === 'string' ? result[line.value] : line.value);
    return Number(value) * (line.scale || 1);
  }

  function referenceShapes(spec, result, theme) {
    return (spec.hlines || []).map((line) => resolveLevel(line, result)).filter(Number.isFinite).map((level) => ({
      type: 'line', xref: 'paper', x0: 0, x1: 1, yref: 'y', y0: level, y1: level,
      line: { color: theme.colors.reference, width: 1, dash: 'dot' }, layer: 'below'
    }));
  }

  function markerShape(time, theme) {
    return {
      type: 'line', xref: 'x', yref: 'paper', x0: time, x1: time, y0: 0, y1: 1,
      line: { color: theme.marker, width: 1.5 }
    };
  }

  function axis(theme, title) {
    return {
      title: { text: title, font: { size: 11, color: theme.muted }, standoff: 6 },
      gridcolor: theme.grid, linecolor: theme.axis, zerolinecolor: theme.axis, zerolinewidth: 1,
      tickfont: { size: 10, color: theme.muted, family: theme.mono }, showline: true, ticks: '', automargin: true, hoverformat: '.4g'
    };
  }

  function buildLayout(spec, theme, shapes, showLegend, revision) {
    return {
      height: PLOT_HEIGHT,
      margin: { l: 52, r: 12, t: showLegend ? 30 : 10, b: 38 },
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
      font: { family: theme.font, size: 11, color: theme.text },
      showlegend: showLegend,
      legend: { orientation: 'h', x: 0, xanchor: 'left', y: 1.02, yanchor: 'bottom', font: { size: 11, color: theme.text }, bgcolor: 'rgba(0,0,0,0)' },
      hovermode: 'x unified',
      hoverlabel: { bgcolor: theme.surface, bordercolor: theme.border, font: { family: theme.mono, size: 11, color: theme.text } },
      xaxis: Object.assign(axis(theme, spec.xLabel || 't (s)'), { spikemode: 'across', spikecolor: theme.axis, spikethickness: 1 }),
      yaxis: axis(theme, spec.yLabel || ''),
      shapes: shapes,
      uirevision: revision
    };
  }

  function legendEntryCount(traces) {
    return traces.filter((trace) => trace.showlegend !== false).length;
  }

  function toCsv(spec, result) {
    const keys = [spec.xKey].concat(spec.traces.map((trace) => trace.key).filter((key) => typeof key === 'string' && isSeries(result[key])));
    const rows = [keys.join(',')];
    const length = result[spec.xKey].length;
    for (let index = 0; index < length; index += 1) {
      rows.push(keys.map((key) => result[key][index]).join(','));
    }
    return rows.join('\n');
  }

  function downloadText(filename, text, type) {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([text], { type: type }));
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  function buildCard(container, spec, onCsv) {
    const card = document.createElement('section');
    card.className = 'plot-card';
    const header = document.createElement('header');
    header.className = 'plot-header';
    const title = document.createElement('h3');
    title.className = 'plot-title';
    title.textContent = spec.title;
    const csv = document.createElement('button');
    csv.type = 'button';
    csv.className = 'button button-ghost button-small';
    csv.textContent = 'CSV';
    csv.title = 'Télécharger les données de ce graphe';
    csv.setAttribute('aria-label', 'Télécharger les données du graphe ' + spec.title + ' en CSV');
    csv.addEventListener('click', onCsv);
    header.append(title, csv);
    const plot = document.createElement('div');
    plot.className = 'plot-area';
    plot.setAttribute('role', 'img');
    plot.setAttribute('aria-label', 'Graphe : ' + spec.title);
    card.append(header, plot);
    container.appendChild(card);
    return plot;
  }

  function create(container, specs, revision) {
    container.textContent = '';
    const available = typeof window.Plotly !== 'undefined';
    let lastResult = null;
    let lastTime = null;
    let theme = readTheme();
    const views = specs.map((spec) => ({
      spec: spec,
      element: buildCard(container, spec, () => lastResult && downloadText(revision + '-' + spec.id + '.csv', toCsv(spec, lastResult), 'text/csv')),
      fixedShapes: []
    }));
    const observer = available && typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver((entries) => entries.forEach((entry) => {
        if (entry.target.dataset.rendered) window.Plotly.Plots.resize(entry.target);
      }))
      : null;
    views.forEach((view) => {
      if (!available) view.element.textContent = 'Plotly indisponible : graphes désactivés.';
      if (observer) observer.observe(view.element);
    });

    function shapesFor(view) {
      return lastTime === null ? view.fixedShapes : view.fixedShapes.concat([markerShape(lastTime, theme)]);
    }

    function render(result) {
      const missing = [];
      if (!available) return missing;
      lastResult = result;
      views.forEach((view) => {
        const traces = buildTraces(view.spec, result, theme, missing);
        view.fixedShapes = referenceShapes(view.spec, result, theme);
        const layout = buildLayout(view.spec, theme, shapesFor(view), legendEntryCount(traces) > 1, revision);
        window.Plotly.react(view.element, traces, layout, { responsive: true, displaylogo: false, displayModeBar: 'hover', modeBarButtonsToRemove: MODE_BAR_REMOVED });
        view.element.dataset.rendered = '1';
      });
      return Array.from(new Set(missing));
    }

    function setMarker(time) {
      lastTime = Number.isFinite(time) ? time : null;
      if (!available) return;
      views.forEach((view) => {
        if (view.element.dataset.rendered) window.Plotly.relayout(view.element, { shapes: shapesFor(view) });
      });
    }

    function refreshTheme() {
      theme = readTheme();
      if (lastResult) render(lastResult);
    }

    function destroy() {
      if (observer) observer.disconnect();
      if (available) views.forEach((view) => window.Plotly.purge(view.element));
      container.textContent = '';
    }

    return { render: render, setMarker: setMarker, refreshTheme: refreshTheme, destroy: destroy };
  }

  App.plots = { create: create, downloadText: downloadText };
})(window.App = window.App || {});
