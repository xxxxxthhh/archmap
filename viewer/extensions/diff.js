// V6-owned client diff mode. It consumes only the loopback `/api/diff` report and keeps every
// returned display value as inert text; it never derives provenance, certainty, or status facts.

/* global document, fetch, URLSearchParams */

function element(tag, { text, testid } = {}) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (testid) node.setAttribute('data-testid', testid);
  return node;
}

function object(value) {
  return value !== null && typeof value === 'object' ? value : {};
}

function string(value, fallback = 'unavailable') {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function message(text, testid) {
  return element('p', { text, ...(testid ? { testid } : {}) });
}

function nodeSummary(summary) {
  const value = object(summary);
  const item = element('li');
  item.appendChild(element('p', { text: string(value.title) }));
  item.appendChild(message(`id: ${string(value.id)} · kind: ${string(value.kind)} · slug: ${string(value.slug)}`));
  return item;
}

function relationSummary(summary) {
  const value = object(summary);
  const item = element('li');
  item.appendChild(element('p', { text: `${string(value.type)} → ${string(value.target)}` }));
  // Certainty is printed only from the report; the client does not translate it into a stronger
  // factual claim or attach a provenance that V2 did not return.
  item.appendChild(message(`id: ${string(value.id)} · owner: ${string(value.node)} · certainty: ${string(value.certainty)}`));
  return item;
}

function claimSummary(summary) {
  const value = object(summary);
  const item = element('li');
  item.appendChild(element('p', { text: string(value.text) }));
  // Status is likewise the exact V2 field. In particular, this view deliberately does not infer
  // authorship/provenance from claim type or from the surrounding architecture graph.
  item.appendChild(message(`id: ${string(value.id)} · owner: ${string(value.node)} · type: ${string(value.type)} · status: ${string(value.status)}`));
  return item;
}

function changedSummary(change, renderSummary) {
  const value = object(change);
  const item = element('li');
  const before = element('section');
  before.appendChild(element('h5', { text: 'Before' }));
  before.appendChild(renderSummary(value.before));
  const after = element('section');
  after.appendChild(element('h5', { text: 'After' }));
  after.appendChild(renderSummary(value.after));
  item.append(before, after);
  return item;
}

function bucket(kind, state, entries, renderSummary) {
  const section = element('section', { testid: `diff-${kind}-${state}` });
  section.appendChild(element('h4', { text: `${state} (${entries.length})` }));
  if (entries.length === 0) {
    section.appendChild(message('None.'));
    return section;
  }
  const list = element('ul');
  for (const entry of entries) {
    list.appendChild(state === 'changed' ? changedSummary(entry, renderSummary) : renderSummary(entry));
  }
  section.appendChild(list);
  return section;
}

function stream(title, kind, value, renderSummary, states) {
  const section = element('section', { testid: `diff-${kind}` });
  section.appendChild(element('h3', { text: title }));
  const source = object(value);
  for (const state of states) {
    section.appendChild(bucket(kind, state, array(source[state]), renderSummary));
  }
  return section;
}

function isIdentity(report) {
  return report.identical === true && typeof report.base === 'string' && typeof report.head === 'string';
}

function renderReport(results, report) {
  const value = object(report);
  results.replaceChildren();
  results.dataset.diffState = 'ready';
  results.appendChild(
    message(`Resolved base ${string(value.base)} → head ${string(value.head)}`, 'diff-resolution'),
  );

  if (isIdentity(value)) {
    const empty = element('section', { testid: 'diff-empty' });
    empty.appendChild(element('h3', { text: 'No architectural changes' }));
    empty.appendChild(message('Both references resolve to the same commit, so the V2 diff is empty.'));
    results.appendChild(empty);
    return;
  }

  results.append(
    stream('Nodes', 'nodes', value.nodes, nodeSummary, ['added', 'removed', 'changed']),
    stream('Relations', 'relations', value.relations, relationSummary, ['added', 'removed', 'changed']),
    stream('Claims', 'claims', value.claims, claimSummary, ['added', 'removed', 'changed', 'stale']),
  );
}

function renderError(results, detail) {
  results.replaceChildren();
  results.dataset.diffState = 'error';
  const failure = element('section', { testid: 'diff-error' });
  failure.appendChild(element('h3', { text: 'Could not load architecture diff' }));
  failure.appendChild(message(detail));
  results.appendChild(failure);
}

/** Mount V6's isolated read-only diff mode into the pre-assigned client slot. */
export function mountDiffFeature({ slot }) {
  slot.replaceChildren();
  const panel = element('section', { testid: 'viewer-diff' });
  panel.appendChild(element('h2', { text: 'Architecture diff' }));
  panel.appendChild(
    message('Compare two committed architecture models. This view is read-only and uses the V2 diff report unchanged.'),
  );

  const form = element('form', { testid: 'diff-form' });
  form.noValidate = true;
  const baseLabel = element('label', { text: 'Base ref ' });
  const base = element('input', { testid: 'diff-base' });
  base.name = 'base';
  base.autocomplete = 'off';
  baseLabel.appendChild(base);
  const headLabel = element('label', { text: 'Head ref ' });
  const head = element('input', { testid: 'diff-head' });
  head.name = 'head';
  head.autocomplete = 'off';
  headLabel.appendChild(head);
  const run = element('button', { text: 'Compare commits', testid: 'run-diff' });
  run.type = 'submit';
  form.append(baseLabel, headLabel, run);

  const status = element('p', { testid: 'diff-status' });
  status.setAttribute('aria-live', 'polite');
  const results = element('div', { testid: 'diff-results' });
  results.dataset.diffState = 'idle';
  panel.append(form, status, results);
  slot.appendChild(panel);

  let request = 0;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const currentRequest = ++request;
    const params = new URLSearchParams({ base: base.value, head: head.value });
    run.disabled = true;
    status.textContent = 'Loading architecture diff…';
    results.replaceChildren();
    results.dataset.diffState = 'loading';

    void fetch(`/api/diff?${params.toString()}`, { headers: { accept: 'application/json' } })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (currentRequest !== request) return;
        if (!response.ok) {
          renderError(results, string(object(payload).error, `request failed (${response.status})`));
          status.textContent = 'Architecture diff is unavailable.';
          return;
        }
        if (typeof payload !== 'object' || payload === null) {
          renderError(results, 'The diff response was not a JSON object.');
          status.textContent = 'Architecture diff is unavailable.';
          return;
        }
        renderReport(results, payload);
        status.textContent = isIdentity(payload)
          ? 'No architectural changes between these resolved references.'
          : 'Architecture diff loaded.';
      })
      .catch(() => {
        if (currentRequest !== request) return;
        renderError(results, 'The loopback diff request failed.');
        status.textContent = 'Architecture diff is unavailable.';
      })
      .finally(() => {
        if (currentRequest === request) run.disabled = false;
      });
  });
}
