// V5-owned client mount slot. It only hides/reveals existing V3-rendered cards and edge rows;
// graph labels and model payloads stay untouched. All data comes from the same loopback origin.

/* global document, fetch, URLSearchParams */

const RELATION_TYPES = ['calls', 'reads', 'writes', 'imports', 'publishes', 'consumes', 'depends-on'];

function element(tag, { text, testid } = {}) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (testid) node.setAttribute('data-testid', testid);
  return node;
}

function option(value, label) {
  const node = document.createElement('option');
  node.value = value;
  node.textContent = label;
  return node;
}

function labelledSelect(labelText, testid, entries) {
  const label = element('label', { text: `${labelText} ` });
  const select = element('select', { testid });
  for (const [value, text] of entries) select.appendChild(option(value, text));
  label.appendChild(select);
  return { label, select };
}

function errorText(error) {
  return error && typeof error.message === 'string' ? error.message : 'request failed';
}

function relationKey(source, type, target) {
  return `${source}\u0000${type}\u0000${target}`;
}

function indexMetadata(payload) {
  const nodeById = new Map();
  for (const node of Array.isArray(payload.nodes) ? payload.nodes : []) {
    if (node && typeof node.id === 'string' && Array.isArray(node.claims) && Array.isArray(node.actors)) {
      nodeById.set(node.id, node);
    }
  }

  // V3 does not expose a relation id in the rendered list. Do not guess provenance when two
  // source/type/target tuples collide: an actor-filtered edge must fail closed instead.
  const relationByKey = new Map();
  for (const relation of Array.isArray(payload.relations) ? payload.relations : []) {
    if (!relation || typeof relation.source !== 'string' || typeof relation.target !== 'string' || typeof relation.type !== 'string') continue;
    const key = relationKey(relation.source, relation.type, relation.target);
    const entries = relationByKey.get(key) || [];
    entries.push(relation);
    relationByKey.set(key, entries);
  }
  return { nodeById, relationByKey };
}

function hasStaleState(node) {
  return Boolean(node?.stale?.claim || node?.stale?.status);
}

function hasConfidence(node, threshold) {
  if (threshold === null) return true;
  return node.claims.some((claim) => typeof claim.confidence === 'number' && claim.confidence >= threshold);
}

function hasActor(node, actor) {
  return actor === 'all' || node.actors.includes(actor);
}

function nodeMatches(node, values) {
  if (!node) return false;
  const stale = hasStaleState(node);
  if (values.stale === 'stale' && !stale) return false;
  if (values.stale === 'current' && stale) return false;
  const confidence = values.confidence === 'high' ? 0.8 : values.confidence === 'medium' ? 0.5 : null;
  return hasConfidence(node, confidence) && hasActor(node, values.actor);
}

function clearImpact(map) {
  for (const card of map.querySelectorAll('[data-node-id]')) {
    card.dataset.impact = 'false';
    delete card.dataset.impactReason;
    card.querySelector('[data-impact-marker]')?.remove();
  }
}

function renderImpact(map, impacted) {
  clearImpact(map);
  const byId = new Map(impacted.map((entry) => [entry.id, entry]));
  for (const card of map.querySelectorAll('[data-node-id]')) {
    const entry = byId.get(card.dataset.nodeId);
    if (!entry) continue;
    card.dataset.impact = 'true';
    card.dataset.impactReason = entry.reason;
    // A separate <mark> makes impact state readable without rewriting the node's existing label.
    const marker = element('mark', { text: ` impact: ${entry.reason}` });
    marker.setAttribute('data-impact-marker', 'true');
    card.querySelector('.node-toggle')?.appendChild(marker);
  }
}

function parsePaths(value) {
  return value.split(/[\n,]/).map((path) => path.trim()).filter(Boolean);
}

/**
 * Attach V5 filters and impact mode to the fixed client slot. The graph stays immutable; only
 * DOM visibility and V5-owned annotations change. The module has no persistence or external I/O.
 */
export async function mountFiltersFeature({ graph, map, slot }) {
  slot.replaceChildren();
  const heading = element('h2', { text: 'Filters and impact', testid: 'filters-heading' });
  const description = element('p', {
    text: 'Read-only visibility controls. Provenance, certainty, and claim labels remain unchanged.',
  });
  const controls = element('div', { testid: 'filter-controls' });
  const stale = labelledSelect('Stale state', 'filter-stale', [
    ['all', 'all'],
    ['stale', 'stale only'],
    ['current', 'current only'],
  ]);
  const confidence = labelledSelect('Claim confidence', 'filter-confidence', [
    ['all', 'any'],
    ['high', 'at least 0.8'],
    ['medium', 'at least 0.5'],
  ]);
  const actor = labelledSelect('Provenance/source', 'filter-provenance', [
    ['all', 'all'],
    ['analyzer', 'analyzer'],
    ['agent', 'agent'],
    ['human', 'human'],
    ['unknown', 'unknown / legacy'],
  ]);
  const relation = labelledSelect('Relation type', 'filter-relation', [
    ['all', 'all'],
    ...RELATION_TYPES.map((type) => [type, type]),
  ]);
  controls.append(stale.label, confidence.label, actor.label, relation.label);

  const empty = element('p', {
    text: 'No nodes match these filters. The architecture model is unchanged.',
    testid: 'filter-empty',
  });
  empty.hidden = true;

  const impactLabel = element('label', { text: 'Changed paths ' });
  const impactInput = element('input', { testid: 'impact-paths' });
  impactInput.type = 'text';
  impactInput.placeholder = 'src/api.ts, src/worker.ts';
  impactLabel.appendChild(impactInput);
  const impactButton = element('button', { text: 'Show impact', testid: 'run-impact' });
  impactButton.type = 'button';
  const impactResults = element('div', { testid: 'impact-results' });
  const status = element('p', { testid: 'filter-status' });

  slot.append(heading, description, controls, empty, impactLabel, impactButton, impactResults, status);

  // Impact has no dependency on the asynchronous filter metadata. Register it before that
  // metadata request so an immediate user click cannot be lost while the filter facets load.
  impactButton.addEventListener('click', async () => {
    const paths = parsePaths(impactInput.value);
    if (paths.length === 0) {
      impactResults.textContent = 'Enter at least one repository-relative path.';
      clearImpact(map);
      return;
    }
    const query = new URLSearchParams();
    for (const path of paths) query.append('path', path);
    try {
      const response = await fetch(`/api/impact?${query.toString()}`, { headers: { accept: 'application/json' } });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || response.status);
      const impacted = Array.isArray(body.impacted) ? body.impacted.filter((entry) => entry && typeof entry.id === 'string') : [];
      renderImpact(map, impacted);
      const list = element('ul');
      for (const entry of impacted) list.appendChild(element('li', { text: `${entry.title} — ${entry.reason}` }));
      impactResults.replaceChildren(
        element('p', { text: `Impact: ${impacted.length} node(s) affected.` }),
        list,
      );
    } catch (error) {
      clearImpact(map);
      impactResults.textContent = `Could not load impact: ${errorText(error)}`;
    }
  });

  let payload;
  try {
    const response = await fetch('/api/viewer-filters', { headers: { accept: 'application/json' } });
    payload = await response.json();
    if (!response.ok) throw new Error(payload.error || response.status);
  } catch (error) {
    status.textContent = `Could not load filter metadata: ${errorText(error)}`;
    return;
  }

  const metadata = indexMetadata(payload);
  const values = () => ({
    stale: stale.select.value,
    confidence: confidence.select.value,
    actor: actor.select.value,
    relation: relation.select.value,
  });

  const applyFilters = () => {
    const selected = values();
    const visibleNodes = new Map();
    for (const card of map.querySelectorAll('[data-node-id]')) {
      const visible = nodeMatches(metadata.nodeById.get(card.dataset.nodeId), selected);
      card.hidden = !visible;
      visibleNodes.set(card.dataset.nodeId, visible);
    }

    for (const group of map.querySelectorAll('.group')) {
      group.hidden = ![...group.querySelectorAll('[data-node-id]')].some((card) => !card.hidden);
    }

    let visibleEdges = 0;
    for (const edge of map.querySelectorAll('[data-edge-source][data-edge-type][data-edge-target]')) {
      const typeMatches = selected.relation === 'all' || edge.dataset.edgeType === selected.relation;
      const endpointsVisible = visibleNodes.get(edge.dataset.edgeSource) && visibleNodes.get(edge.dataset.edgeTarget);
      const matches = metadata.relationByKey.get(relationKey(edge.dataset.edgeSource, edge.dataset.edgeType, edge.dataset.edgeTarget)) || [];
      const exactRelation = matches.length === 1 ? matches[0] : null;
      const actorMatches = selected.actor === 'all' || (exactRelation && exactRelation.actor === selected.actor);
      const visible = Boolean(typeMatches && endpointsVisible && actorMatches);
      edge.hidden = !visible;
      if (visible) visibleEdges += 1;
    }

    const visibleCount = [...visibleNodes.values()].filter(Boolean).length;
    empty.hidden = visibleCount !== 0;
    status.textContent = `${visibleCount}/${graph.projection.nodes.length} nodes and ${visibleEdges}/${graph.projection.edges.length} relations visible`;
  };

  for (const select of [stale.select, confidence.select, actor.select, relation.select]) {
    select.addEventListener('change', applyFilters);
  }
  applyFilters();
}
