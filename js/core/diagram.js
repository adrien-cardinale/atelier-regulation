(function (App) {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const CORNER_RADIUS = 6;
  const MIN_LOOP_OFFSET = 14;
  const LOOP_OFFSET_RATIO = 0.02;
  const ROW_GAP = 56;
  const LOOP_SPACE = 70;
  const SIDE_VECTORS = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] };
  const MARKER_VARIANTS = ['default', 'loop', 'active'];
  let instanceCount = 0;

  function svgElement(tag, attributes, parent) {
    const node = document.createElementNS(SVG_NS, tag);
    Object.keys(attributes || {}).forEach((name) => node.setAttribute(name, attributes[name]));
    if (parent) parent.appendChild(node);
    return node;
  }

  function htmlElement(tag, className, parent, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    if (parent) parent.appendChild(node);
    return node;
  }

  function percent(value, total) {
    return (value / total) * 100 + '%';
  }

  function placeColumns(node, box, spec) {
    node.style.setProperty('--x', percent(box.x, spec.width));
    node.style.setProperty('--w', percent(box.w, spec.width));
  }

  function setVariable(node, name, value) {
    const text = value.toFixed(1) + 'px';
    if (node.style.getPropertyValue(name) !== text) node.style.setProperty(name, text);
  }

  function rowKey(block) {
    if (block.row !== undefined) return Number(block.row);
    return Number(block.y) || 0;
  }

  function groupRows(blocks) {
    const rows = new Map();
    blocks.forEach((block) => {
      const key = rowKey(block);
      if (!rows.has(key)) rows.set(key, []);
      rows.get(key).push(block.id);
    });
    return Array.from(rows.keys()).sort((a, b) => a - b).map((key) => rows.get(key));
  }

  function zoneMembers(zone, blocks) {
    if (Array.isArray(zone.blocks)) return zone.blocks.filter((id) => blocks.some((block) => block.id === id));
    return blocks.filter((block) => {
      const centerX = block.x + block.w / 2;
      const centerY = (block.y || 0) + (block.h || 0) / 2;
      return centerX >= zone.x && centerX <= zone.x + zone.w && centerY >= zone.y && centerY <= zone.y + zone.h;
    }).map((block) => block.id);
  }

  function needsLoopLane(edge) {
    if (!edge.loop || edge.fromSide === 'top') return false;
    return isVertical(edge.fromSide) === isVertical(edge.toSide);
  }

  function anchorPoint(box, side) {
    if (side === 'left') return { x: box.x, y: box.y + box.h / 2 };
    if (side === 'right') return { x: box.x + box.w, y: box.y + box.h / 2 };
    if (side === 'top') return { x: box.x + box.w / 2, y: box.y };
    return { x: box.x + box.w / 2, y: box.y + box.h };
  }

  function defaultSides(from, to) {
    if (to.x >= from.x + from.w) return ['right', 'left'];
    if (to.x + to.w <= from.x) return ['left', 'right'];
    if (to.y >= from.y + from.h) return ['bottom', 'top'];
    return ['top', 'bottom'];
  }

  function isVertical(side) {
    return side === 'top' || side === 'bottom';
  }

  function offsetPoint(point, side, distance) {
    const vector = SIDE_VECTORS[side];
    return { x: point.x + vector[0] * distance, y: point.y + vector[1] * distance };
  }

  function directRoute(start, end, sides) {
    if (!isVertical(sides[0]) && !isVertical(sides[1])) {
      const middle = (start.x + end.x) / 2;
      return { points: [start, { x: middle, y: start.y }, { x: middle, y: end.y }, end] };
    }
    if (isVertical(sides[0]) && isVertical(sides[1])) {
      const middle = (start.y + end.y) / 2;
      return { points: [start, { x: start.x, y: middle }, { x: end.x, y: middle }, end] };
    }
    if (isVertical(sides[0])) return { points: [start, { x: start.x, y: end.y }, end] };
    return { points: [start, { x: end.x, y: start.y }, end] };
  }

  function bottomLane(from, to, lanes) {
    return Math.max(lanes.bottom, Math.max(from.y + from.h, to.y + to.h) + lanes.offset);
  }

  function loopRoute(start, end, sides, from, to, lanes) {
    if (isVertical(sides[0]) && sides[0] === sides[1]) {
      const lane = sides[0] === 'bottom' ? bottomLane(from, to, lanes) : Math.min(from.y, to.y) - lanes.offset;
      return { points: [start, { x: start.x, y: lane }, { x: end.x, y: lane }, end], labelSegment: 1 };
    }
    if (sides[0] !== 'right' || sides[1] !== 'left') return directRoute(start, end, sides);
    const lane = bottomLane(from, to, lanes);
    const out = offsetPoint(start, sides[0], lanes.offset);
    const into = offsetPoint(end, sides[1], lanes.offset);
    return { points: [start, out, { x: out.x, y: lane }, { x: into.x, y: lane }, into, end], labelSegment: 2 };
  }

  function samePoint(a, b) {
    return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5;
  }

  function isCollinear(a, b, c) {
    return (Math.abs(a.x - b.x) < 0.5 && Math.abs(b.x - c.x) < 0.5) ||
      (Math.abs(a.y - b.y) < 0.5 && Math.abs(b.y - c.y) < 0.5);
  }

  function simplify(points) {
    const unique = points.filter((point, index) => index === 0 || !samePoint(point, points[index - 1]));
    return unique.filter((point, index) =>
      index === 0 || index === unique.length - 1 || !isCollinear(unique[index - 1], point, unique[index + 1]));
  }

  function towards(from, to, distance) {
    const length = Math.hypot(to.x - from.x, to.y - from.y) || 1;
    const ratio = Math.min(distance, length / 2) / length;
    return { x: from.x + (to.x - from.x) * ratio, y: from.y + (to.y - from.y) * ratio };
  }

  function roundedPath(points) {
    let path = 'M ' + points[0].x + ' ' + points[0].y;
    for (let index = 1; index < points.length - 1; index += 1) {
      const before = towards(points[index], points[index - 1], CORNER_RADIUS);
      const after = towards(points[index], points[index + 1], CORNER_RADIUS);
      path += ' L ' + before.x + ' ' + before.y + ' Q ' + points[index].x + ' ' + points[index].y + ' ' + after.x + ' ' + after.y;
    }
    const last = points[points.length - 1];
    return path + ' L ' + last.x + ' ' + last.y;
  }

  function longestSegment(points) {
    let best = 0;
    let bestLength = -1;
    for (let index = 0; index < points.length - 1; index += 1) {
      const length = Math.hypot(points[index + 1].x - points[index].x, points[index + 1].y - points[index].y);
      if (length > bestLength) {
        bestLength = length;
        best = index;
      }
    }
    return best;
  }

  function readValue(readout, result, k) {
    try {
      if (typeof readout.key === 'function') return readout.key(result, k);
      const series = result[readout.key];
      return Array.isArray(series) ? series[k] : series;
    } catch (error) {
      return NaN;
    }
  }

  function formatReadout(readout, result, k) {
    return result ? App.formatValue(readValue(readout, result, k), readout.format) : '—';
  }

  function createMarkers(svg, prefix) {
    const defs = svgElement('defs', {}, svg);
    const ids = {};
    MARKER_VARIANTS.forEach((variant) => {
      ids[variant] = prefix + '-' + variant;
      const marker = svgElement('marker', {
        id: ids[variant], viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse'
      }, defs);
      svgElement('path', { d: 'M 0 0 L 10 5 L 0 10 z', class: 'edge-arrow edge-arrow-' + variant }, marker);
    });
    return ids;
  }

  function buildZone(stage, zone, blocks) {
    const node = htmlElement('div', 'diagram-zone', stage);
    htmlElement('span', 'diagram-zone-label', node, zone.label);
    return { node: node, members: zoneMembers(zone, blocks) };
  }

  function buildReadouts(node, block) {
    const readouts = block.readouts || [];
    if (!readouts.length) return [];
    const list = htmlElement('dl', 'block-readouts', node);
    return readouts.map((readout) => {
      const item = htmlElement('div', 'block-readout', list);
      htmlElement('dt', 'block-readout-label', item, readout.label);
      return { readout: readout, element: htmlElement('dd', 'block-readout-value', item, '—') };
    });
  }

  function buildHead(node, block, step) {
    const head = htmlElement('button', 'block-head', node);
    head.type = 'button';
    head.setAttribute('aria-label', 'Bloc ' + block.title + ' : afficher son explication et son code');
    htmlElement('span', 'block-title', head, block.title);
    if (step) {
      const badge = htmlElement('span', 'block-step', head, String(step));
      badge.title = 'Étape ' + step + ' du cycle';
    }
  }

  function buildBlock(stage, block, spec, cycle, handlers) {
    const node = htmlElement('article', 'diagram-block kind-' + (block.kind || 'process'), stage);
    node.dataset.blockId = block.id;
    placeColumns(node, block, spec);
    buildHead(node, block, cycle.indexOf(block.id) + 1);
    if ((block.lines || []).length) {
      const lines = htmlElement('div', 'block-lines', node);
      block.lines.forEach((line) => htmlElement('div', 'block-line', lines, line));
    }
    const params = htmlElement('div', 'block-params', node);
    const count = handlers.renderParams ? handlers.renderParams(params, block.id) : 0;
    if (!count) params.remove();
    const readouts = buildReadouts(node, block);
    node.addEventListener('click', (event) => {
      if (event.target.closest('.block-params')) return;
      handlers.onSelect(block.id);
    });
    return { node: node, readouts: readouts };
  }

  function buildEdge(svg, stage, edge) {
    const group = svgElement('g', { class: 'edge' + (edge.loop ? ' edge-loop' : '') }, svg);
    const path = svgElement('path', {}, group);
    const view = { edge: edge, group: group, path: path, label: null, value: null };
    if (!edge.label && !edge.readout) return view;
    view.label = htmlElement('div', 'edge-label' + (edge.loop ? ' edge-label-loop' : ''), stage);
    if (edge.label) htmlElement('span', 'edge-label-name', view.label, edge.label);
    if (edge.readout) {
      if (edge.label) view.label.appendChild(document.createTextNode(' = '));
      view.value = htmlElement('span', 'edge-label-value', view.label, '—');
    }
    return view;
  }

  function resolveCycle(spec) {
    const ids = spec.blocks.map((block) => block.id);
    const cycle = Array.isArray(spec.cycle) ? spec.cycle : ids;
    return cycle.filter((id) => ids.indexOf(id) >= 0);
  }

  function create(container, spec, handlers) {
    instanceCount += 1;
    container.textContent = '';
    const cycle = resolveCycle(spec);
    const stage = htmlElement('div', 'diagram-stage', container);
    stage.setAttribute('role', 'group');
    stage.setAttribute('aria-label', 'Schéma bloc du système');
    const zoneViews = (spec.zones || []).map((zone) => buildZone(stage, zone, spec.blocks));
    const rows = groupRows(spec.blocks);
    const rowOf = {};
    rows.forEach((row, index) => row.forEach((id) => { rowOf[id] = index; }));
    zoneViews.forEach((zone) => {
      const indices = zone.members.map((id) => rowOf[id]);
      zone.firstRow = indices.length ? Math.min.apply(null, indices) : -1;
      zone.lastRow = indices.length ? Math.max.apply(null, indices) : -1;
    });
    const hasLoopLane = spec.edges.some(needsLoopLane);
    const svg = svgElement('svg', { class: 'diagram-edges', 'aria-hidden': 'true', focusable: 'false' }, stage);
    const markers = createMarkers(svg, 'diagram-arrow-' + instanceCount);
    const edgeViews = spec.edges.map((edge) => buildEdge(svg, stage, edge));
    const blockViews = {};
    spec.blocks.forEach((block) => { blockViews[block.id] = buildBlock(stage, block, spec, cycle, handlers); });
    let activeId = null;
    let frame = null;

    function markerFor(view) {
      if (activeId && view.edge.from === activeId) return markers.active;
      return view.edge.loop ? markers.loop : markers.default;
    }

    function placeLabel(label, a, b) {
      label.classList.toggle('is-vertical', Math.abs(a.y - b.y) >= 0.5);
      label.style.left = (a.x + b.x) / 2 + 'px';
      label.style.top = (a.y + b.y) / 2 + 'px';
    }

    function routeEdge(view, boxes, lanes) {
      const edge = view.edge;
      const from = boxes[edge.from];
      const to = boxes[edge.to];
      if (!from || !to) return;
      const fallback = defaultSides(from, to);
      const sides = [edge.fromSide || fallback[0], edge.toSide || fallback[1]];
      const start = anchorPoint(from, sides[0]);
      const end = anchorPoint(to, sides[1]);
      const route = edge.loop ? loopRoute(start, end, sides, from, to, lanes) : directRoute(start, end, sides);
      const points = simplify(route.points);
      view.path.setAttribute('d', roundedPath(points));
      view.path.setAttribute('marker-end', 'url(#' + markerFor(view) + ')');
      if (!view.label) return;
      const segment = route.labelSegment !== undefined && route.points.length === points.length
        ? route.labelSegment
        : longestSegment(points);
      placeLabel(view.label, points[segment], points[segment + 1]);
    }

    function readMetrics(width) {
      const scale = width / spec.width;
      const font = parseFloat(getComputedStyle(stage).fontSize) || 13;
      return {
        scale: scale,
        edge: font * 0.6,
        titleBand: font * 2,
        pad: Math.max(font * 0.9, 12 * scale),
        padX: Math.max(font * 1.1, 22 * scale),
        spacing: font * 1.2,
        rowGap: Math.max(ROW_GAP * scale, font * 4),
        loopSpace: hasLoopLane ? Math.max(LOOP_SPACE * scale, font * 4.5) : 0
      };
    }

    function rowGapBefore(index, metrics) {
      const starts = zoneViews.some((zone) => zone.firstRow === index);
      const endsBefore = index > 0 && zoneViews.some((zone) => zone.lastRow === index - 1);
      const zoneGap = (endsBefore ? metrics.pad : 0) + (starts ? metrics.titleBand + metrics.pad : 0) + (endsBefore && starts ? metrics.spacing : 0);
      return index === 0 ? zoneGap : Math.max(metrics.rowGap, zoneGap);
    }

    function placeRows(metrics) {
      spec.blocks.forEach((block) => setVariable(blockViews[block.id].node, '--min-h', (block.h || 0) * metrics.scale));
      const heights = {};
      spec.blocks.forEach((block) => { heights[block.id] = blockViews[block.id].node.offsetHeight; });
      const boxes = {};
      let cursor = metrics.edge;
      rows.forEach((row, index) => {
        cursor += rowGapBefore(index, metrics);
        const rowHeight = Math.max.apply(null, row.map((id) => heights[id]));
        row.forEach((id) => {
          const node = blockViews[id].node;
          const top = cursor + (rowHeight - heights[id]) / 2;
          setVariable(node, '--top', top);
          boxes[id] = { x: node.offsetLeft, y: top, w: node.offsetWidth, h: heights[id] };
        });
        cursor += rowHeight;
      });
      return { boxes: boxes, bottom: cursor };
    }

    function placeZones(boxes, metrics, width) {
      let bottom = 0;
      zoneViews.forEach((zone) => {
        const members = zone.members.map((id) => boxes[id]).filter(Boolean);
        zone.node.hidden = !members.length;
        if (!members.length) return;
        const left = Math.max(0, Math.min.apply(null, members.map((box) => box.x)) - metrics.padX);
        const right = Math.min(width, Math.max.apply(null, members.map((box) => box.x + box.w)) + metrics.padX);
        const top = Math.min.apply(null, members.map((box) => box.y)) - metrics.pad - metrics.titleBand;
        const zoneBottom = Math.max.apply(null, members.map((box) => box.y + box.h)) + metrics.pad;
        setVariable(zone.node, '--x', left);
        setVariable(zone.node, '--y', top);
        setVariable(zone.node, '--w', right - left);
        setVariable(zone.node, '--h', zoneBottom - top);
        bottom = Math.max(bottom, zoneBottom);
      });
      return bottom;
    }

    function layout() {
      frame = null;
      if (!stage.isConnected || getComputedStyle(svg).display === 'none') return;
      const width = stage.clientWidth;
      if (!width) return;
      const metrics = readMetrics(width);
      const placed = placeRows(metrics);
      const contentBottom = Math.max(placed.bottom, placeZones(placed.boxes, metrics, width));
      const height = contentBottom + (metrics.loopSpace || metrics.edge * 2);
      setVariable(stage, '--stage-h', height);
      svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
      svg.setAttribute('width', width);
      svg.setAttribute('height', height);
      const lanes = {
        bottom: contentBottom + metrics.loopSpace / 2,
        offset: Math.max(MIN_LOOP_OFFSET, width * LOOP_OFFSET_RATIO)
      };
      edgeViews.forEach((view) => routeEdge(view, placed.boxes, lanes));
    }

    function scheduleLayout() {
      if (frame === null) frame = requestAnimationFrame(layout);
    }

    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(scheduleLayout) : null;
    if (observer) {
      observer.observe(stage);
      Object.keys(blockViews).forEach((id) => observer.observe(blockViews[id].node));
    } else {
      window.addEventListener('resize', scheduleLayout);
    }
    scheduleLayout();

    function toggleBlocks(className, id) {
      Object.keys(blockViews).forEach((blockId) => blockViews[blockId].node.classList.toggle(className, blockId === id));
    }

    function setActive(id) {
      activeId = id || null;
      toggleBlocks('is-active', activeId);
      edgeViews.forEach((view) => {
        const flowing = Boolean(activeId) && view.edge.from === activeId;
        view.group.classList.toggle('is-flowing', flowing);
        if (view.label) view.label.classList.toggle('is-flowing', flowing);
        if (view.path.hasAttribute('d')) view.path.setAttribute('marker-end', 'url(#' + markerFor(view) + ')');
      });
    }

    function updateReadouts(result, k) {
      Object.keys(blockViews).forEach((id) => {
        blockViews[id].readouts.forEach((item) => { item.element.textContent = formatReadout(item.readout, result, k); });
      });
      edgeViews.forEach((view) => {
        if (view.value) view.value.textContent = formatReadout(view.edge.readout, result, k);
      });
    }

    function destroy() {
      if (observer) observer.disconnect();
      else window.removeEventListener('resize', scheduleLayout);
      if (frame !== null) cancelAnimationFrame(frame);
      container.textContent = '';
    }

    return {
      cycle: cycle,
      setSelected: (id) => toggleBlocks('is-selected', id),
      setLinked: (id) => toggleBlocks('is-linked', id),
      setError: (id) => toggleBlocks('has-error', id),
      setActive: setActive,
      updateReadouts: updateReadouts,
      relayout: scheduleLayout,
      destroy: destroy
    };
  }

  App.diagram = { create: create };
})(window.App = window.App || {});
