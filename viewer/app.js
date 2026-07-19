// archmap loopback viewer — interactive architecture map (Issue #30).
//
// Fetches the read-only display-graph projection from the same origin and renders it as a set of
// collapsible groups (one per node kind) whose node cards expand to show claims and outgoing
// edges. The whole DOM is built with createElement + textContent — never innerHTML and never an
// inline handler — so even though the projection is already neutralized server-side, no field can
// re-enter as active markup on the client. The CSP additionally blocks any remote fetch.

/* global document, fetch, URL, window */

import { mountViewerFeatures } from './features.js';

// Kinds in structural-outermost-first order; only kinds present in the graph render a group.
const KIND_ORDER = ['system', 'component', 'module', 'store', 'external'];
const VIEW_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VIEW_ID_ERROR = 'View must be a lowercase slug using letters, digits, and single hyphens.';

function el(tag, opts) {
  const node = document.createElement(tag);
  if (opts && opts.text !== undefined) node.textContent = opts.text;
  if (opts && opts.className) node.className = opts.className;
  if (opts && opts.testid) node.setAttribute('data-testid', opts.testid);
  return node;
}

function setStatus(message) {
  const status = document.getElementById('status');
  status.textContent = message;
  status.hidden = false;
}

function pageViewSelection() {
  const url = new URL(window.location.href);
  const values = url.searchParams.getAll('view');
  if (values.length === 0 || (values.length === 1 && values[0].trim() === '')) {
    return { ok: true, id: null };
  }
  if (values.length !== 1 || !VIEW_ID_PATTERN.test(values[0])) {
    return { ok: false, id: null };
  }
  return { ok: true, id: values[0] };
}

function navigateToView(viewId) {
  const url = new URL(window.location.href);
  if (viewId === null) url.searchParams.delete('view');
  else url.searchParams.set('view', viewId);
  window.location.assign(`${url.pathname}${url.search}${url.hash}`);
}

function mountViewSelector(selection) {
  const slot = document.getElementById('view-selector-slot');
  if (!slot) throw new Error('missing view selector slot');

  const form = el('form', { className: 'view-selector', testid: 'view-form' });
  form.noValidate = true;
  const label = el('label', { text: 'View ' });
  const input = el('input', { testid: 'view-id' });
  input.type = 'text';
  input.name = 'view';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = 'example-view';
  input.value = selection.id ?? '';
  label.appendChild(input);

  const apply = el('button', { text: 'Apply' });
  apply.type = 'submit';
  const useDefault = el('button', { text: 'Default', testid: 'view-default' });
  useDefault.type = 'button';
  const error = el('p', { className: 'view-error', testid: 'view-error' });
  error.setAttribute('aria-live', 'polite');

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = input.value.trim();
    if (value === '') {
      navigateToView(null);
      return;
    }
    if (!VIEW_ID_PATTERN.test(value)) {
      error.textContent = VIEW_ID_ERROR;
      return;
    }
    error.textContent = '';
    navigateToView(value);
  });
  useDefault.addEventListener('click', () => navigateToView(null));

  form.append(label, apply, useDefault, error);
  slot.replaceChildren(form);
  if (!selection.ok) error.textContent = VIEW_ID_ERROR;
}

// Build the expandable detail for one node: claims and outgoing edges. Returns a hidden element
// the caller toggles.
function nodeDetail(node, edgesBySource) {
  const detail = el('div', { className: 'node-detail' });
  detail.hidden = true;

  const claims = node.claims || [];
  if (claims.length > 0) {
    const list = el('ul', { className: 'claims' });
    for (const claim of claims) {
      const item = el('li');
      const tag = el('span', { className: 'claim-tag', text: `[${claim.type}/${claim.status}]` });
      item.appendChild(tag);
      item.appendChild(document.createTextNode(' '));
      item.appendChild(document.createTextNode(claim.text));
      list.appendChild(item);
    }
    detail.appendChild(list);
  }

  const outgoing = edgesBySource.get(node.id) || [];
  if (outgoing.length > 0) {
    const list = el('ul', { className: 'edges' });
    for (const edge of outgoing) {
      const marker = edge.certainty === 'known' ? '→' : '⇢';
      const item = el('li', { text: `${marker} ${edge.type} ${edge.target}` });
      // The relation identity is data-only; V4 can delegate selection from the map without
      // parsing display text or guessing which source claim an edge represents.
      item.setAttribute('data-edge-source', edge.source);
      item.setAttribute('data-edge-type', edge.type);
      item.setAttribute('data-edge-target', edge.target);
      list.appendChild(item);
    }
    detail.appendChild(list);
  }

  if (detail.childElementCount === 0) {
    detail.appendChild(el('p', { className: 'empty', text: 'no claims or relations' }));
  }
  return detail;
}

function nodeCard(node, edgesBySource) {
  const card = el('li', { className: 'node-card', testid: `node-${node.id}` });
  // Stable data identity lets the evidence and filter features attach delegated behavior without
  // changing this V3 renderer or taking a lease on another feature's client module.
  card.setAttribute('data-node-id', node.id);

  const toggle = el('button', { className: 'node-toggle' });
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', 'false');
  const caret = el('span', { className: 'caret', text: '▸' });
  toggle.appendChild(caret);
  toggle.appendChild(document.createTextNode(' '));
  toggle.appendChild(el('span', { className: 'node-title', text: node.title }));

  const detail = nodeDetail(node, edgesBySource);
  toggle.addEventListener('click', () => {
    const open = detail.hidden;
    detail.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    caret.textContent = open ? '▾' : '▸';
  });

  card.appendChild(toggle);
  card.appendChild(detail);
  return card;
}

// A collapsible group of node cards for one kind. Only the first group starts expanded.
function kindGroup(kind, nodes, edgesBySource, expanded) {
  const section = el('section', { className: 'group', testid: `group-${kind}` });

  const header = el('button', { className: 'group-toggle', testid: `group-toggle-${kind}` });
  header.type = 'button';
  header.setAttribute('aria-expanded', String(expanded));
  const caret = el('span', { className: 'caret', text: expanded ? '▾' : '▸' });
  header.appendChild(caret);
  header.appendChild(document.createTextNode(' '));
  header.appendChild(el('span', { className: 'group-name', text: `${kind} (${nodes.length})` }));

  const body = el('ul', { className: 'group-body', testid: `group-body-${kind}` });
  body.hidden = !expanded;
  for (const node of nodes) body.appendChild(nodeCard(node, edgesBySource));

  header.addEventListener('click', () => {
    const open = body.hidden;
    body.hidden = !open;
    header.setAttribute('aria-expanded', String(open));
    caret.textContent = open ? '▾' : '▸';
  });

  section.appendChild(header);
  section.appendChild(body);
  return section;
}

function viewerFeatureSlots() {
  const slots = {
    evidence: document.getElementById('viewer-slot-evidence'),
    filters: document.getElementById('viewer-slot-filters'),
    diff: document.getElementById('viewer-slot-diff'),
  };
  for (const [name, slot] of Object.entries(slots)) {
    if (!slot) throw new Error(`missing viewer feature slot "${name}"`);
  }
  return slots;
}

async function render(graph) {
  const map = document.getElementById('map');
  const edgesBySource = new Map();
  for (const edge of graph.projection.edges) {
    if (!edgesBySource.has(edge.source)) edgesBySource.set(edge.source, []);
    edgesBySource.get(edge.source).push(edge);
  }

  const byKind = new Map();
  for (const node of graph.projection.nodes) {
    if (!byKind.has(node.kind)) byKind.set(node.kind, []);
    byKind.get(node.kind).push(node);
  }

  const kinds = KIND_ORDER.filter((k) => byKind.has(k));
  let firstExpanded = false;
  for (const kind of kinds) {
    const expanded = !firstExpanded;
    firstExpanded = true;
    map.appendChild(kindGroup(kind, byKind.get(kind), edgesBySource, expanded));
  }

  const stats = graph.projection.stats;
  setStatus(`view "${graph.view.id}" · ${stats.visible_nodes}/${stats.total_nodes} nodes · ${stats.visible_edges} edges`);
  map.hidden = false;
  await mountViewerFeatures({ graph, map, slots: viewerFeatureSlots() });
}

async function load(viewId) {
  try {
    const endpoint = viewId === null ? '/api/graph' : `/api/graph?view=${encodeURIComponent(viewId)}`;
    const res = await fetch(endpoint, { headers: { accept: 'application/json' } });
    const body = await res.json();
    if (!res.ok) {
      setStatus(`Could not load map: ${body.error || res.status}`);
      return;
    }
    await render(body);
  } catch (err) {
    setStatus(`Could not load map: ${err && err.message ? err.message : 'network error'}`);
  }
}

const selection = pageViewSelection();
mountViewSelector(selection);
if (selection.ok) void load(selection.id);
else setStatus(`Could not load map: ${VIEW_ID_ERROR}`);
