// V4-owned, bounded evidence inspector. It only consumes the fixed graph projection and its own
// `/api/evidence` endpoint; every element is assembled with textContent, never innerHTML.

/* global document, fetch, Element, URL, window */

const DEEP_LINK_PARAM = 'evidence';

function el(tag, options) {
  const node = document.createElement(tag);
  if (options?.text !== undefined) node.textContent = options.text;
  if (options?.testid) node.setAttribute('data-testid', options.testid);
  return node;
}

function relationKey(source, type, target) {
  return JSON.stringify([source, type, target]);
}

function inspectorShell(slot, target) {
  const panel = el('section', { testid: 'evidence-inspector' });
  panel.setAttribute('data-evidence-target', target ?? '');
  return panel;
}

function renderMessage(slot, message, target) {
  const panel = inspectorShell(slot, target);
  panel.appendChild(el('h2', { text: 'Evidence inspector' }));
  panel.appendChild(el('p', { text: message }));
  slot.replaceChildren(panel);
}

function provenanceText(provenance) {
  const created = provenance.created_at ? ` · captured ${provenance.created_at}` : '';
  return `${provenance.actor}${created}`;
}

function renderClaimList(panel, claims) {
  if (claims.length === 0) return;
  panel.appendChild(el('h3', { text: 'Claims' }));
  const list = el('ul');
  for (const claim of claims) {
    const item = el('li');
    item.appendChild(
      el('p', {
        text: `${claim.type} · ${claim.status} · ${provenanceText(claim.provenance)} · confidence ${claim.confidence}`,
      }),
    );
    item.appendChild(el('p', { text: claim.text }));
    list.appendChild(item);
  }
  panel.appendChild(list);
}

function certaintyText(certainty) {
  return certainty === 'known'
    ? 'known · deterministic relation evidence'
    : `${certainty} · not deterministic; no fact is implied`;
}

function renderRelationList(panel, relations) {
  if (relations.length === 0) return;
  panel.appendChild(el('h3', { text: 'Relations' }));
  const list = el('ul');
  for (const relation of relations) {
    const item = el('li');
    item.appendChild(el('p', { text: `relation evidence · ${relation.id}` }));
    item.appendChild(
      el('p', {
        text: `${relation.type} → ${relation.target} · ${certaintyText(relation.certainty)} · ${provenanceText(relation.provenance)}`,
      }),
    );
    list.appendChild(item);
  }
  panel.appendChild(list);
}

function renderEvidenceList(panel, payload) {
  panel.appendChild(el('h3', { text: 'Evidence identities' }));
  if (payload.evidence.length === 0) {
    panel.appendChild(
      el('p', {
        text: 'No evidence was captured for this selection. Partial or unknown relations remain non-deterministic.',
      }),
    );
    return;
  }

  const excerpts = new Map(payload.excerpts.map((excerpt) => [excerpt.index, excerpt]));
  const list = el('ol');
  payload.evidence.forEach((evidence, index) => {
    const item = el('li');
    const location = evidence.symbol ? `${evidence.path}#${evidence.symbol}` : evidence.path;
    item.appendChild(el('p', { text: location }));
    item.appendChild(
      el('p', {
        text: `commit ${evidence.commit} · blob ${evidence.blob_hash} · extract ${evidence.extract_hash}`,
      }),
    );
    item.appendChild(el('p', { text: `analyzer ${evidence.analyzer}@${evidence.analyzer_version}` }));

    const excerpt = excerpts.get(index);
    if (excerpt?.status === 'available') {
      item.appendChild(
        el('p', {
          text: excerpt.truncated
            ? 'Current local source prefix (bounded, text-only, truncated; identity above is authoritative)'
            : 'Current local source prefix (bounded and text-only; identity above is authoritative)',
        }),
      );
      item.appendChild(el('pre', { text: excerpt.text ?? '' }));
    } else {
      item.appendChild(el('p', { text: 'Source excerpt unavailable; no fallback file was read.' }));
    }
    list.appendChild(item);
  });
  panel.appendChild(list);
}

function renderInspection(slot, payload) {
  const panel = inspectorShell(slot, payload.target);
  panel.appendChild(el('h2', { text: `Evidence: ${payload.target}` }));
  panel.appendChild(
    el('p', {
      text: `${payload.matched} on ${payload.node.kind} ${payload.node.title} (${payload.node.id})`,
    }),
  );
  renderClaimList(panel, payload.claims);
  renderRelationList(panel, payload.relations);
  renderEvidenceList(panel, payload);
  slot.replaceChildren(panel);
}

function updateDeepLink(target) {
  const url = new URL(window.location.href);
  url.searchParams.set(DEEP_LINK_PARAM, target);
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}

function bindExactRelationTargets(graph, map) {
  const idsByDisplayEdge = new Map();
  for (const edge of graph.projection.edges) {
    const key = relationKey(edge.source, edge.type, edge.target);
    const ids = idsByDisplayEdge.get(key) ?? [];
    ids.push(edge.id);
    idsByDisplayEdge.set(key, ids);
  }

  for (const edge of map.querySelectorAll('[data-edge-source][data-edge-type][data-edge-target]')) {
    const key = relationKey(
      edge.getAttribute('data-edge-source'),
      edge.getAttribute('data-edge-type'),
      edge.getAttribute('data-edge-target'),
    );
    const ids = idsByDisplayEdge.get(key) ?? [];
    if (ids.length === 1) edge.setAttribute('data-evidence-target', ids[0]);
    else edge.setAttribute('data-evidence-unresolved', 'true');
  }
}

function deepLinkTarget() {
  const url = new URL(window.location.href);
  const targets = url.searchParams.getAll(DEEP_LINK_PARAM);
  return targets.length === 1 && targets[0] ? targets[0] : null;
}

/** Mount V4's isolated inspector into its fixed evidence slot. */
export function mountEvidenceFeature({ graph, map, slot }) {
  let requestNumber = 0;

  const select = async (target, updateLink) => {
    const request = ++requestNumber;
    if (updateLink) updateDeepLink(target);
    renderMessage(slot, 'Loading bounded evidence metadata…', target);

    try {
      const response = await fetch(`/api/evidence?target=${encodeURIComponent(target)}`, {
        headers: { accept: 'application/json' },
      });
      const payload = await response.json();
      if (request !== requestNumber) return;
      if (!response.ok) {
        renderMessage(slot, `Evidence selection is unavailable: ${payload.error ?? response.status}`, target);
        return;
      }
      renderInspection(slot, payload);
    } catch {
      if (request === requestNumber) renderMessage(slot, 'Evidence selection could not be loaded.', target);
    }
  };

  bindExactRelationTargets(graph, map);
  renderMessage(slot, 'Select a node or relation to inspect its evidence.', null);

  map.addEventListener('click', (event) => {
    const origin = event.target instanceof Element ? event.target : null;
    if (!origin) return;

    const relation = origin.closest('[data-evidence-target]');
    if (relation && map.contains(relation)) {
      const target = relation.getAttribute('data-evidence-target');
      if (target) void select(target, true);
      return;
    }
    const unresolvedRelation = origin.closest('[data-evidence-unresolved]');
    if (unresolvedRelation && map.contains(unresolvedRelation)) {
      renderMessage(slot, 'Relation identity is ambiguous; no guessed node evidence was selected.', null);
      return;
    }
    const node = origin.closest('[data-node-id]');
    if (node && map.contains(node)) {
      const target = node.getAttribute('data-node-id');
      if (target) void select(target, true);
    }
  });

  const target = deepLinkTarget();
  if (target) void select(target, false);
}
