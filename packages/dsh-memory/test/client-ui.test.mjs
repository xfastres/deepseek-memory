import assert from 'node:assert/strict';
import { test } from 'node:test';

function reactStub(overrides = {}) {
  return {
    createElement(type, props, ...children) { return { type, props, children }; },
    Fragment: Symbol('Fragment'),
    useEffect() {},
    useRef(value) { return { current: value === undefined ? null : value }; },
    useState(value) { return [Object.hasOwn(overrides, 'value') ? overrides.value : value, () => {}]; },
  };
}

/** Load the client bundle and return the module plus the captured <style> text. */
async function load(overrides) {
  let registration;
  globalThis.window = { __ModuleLoader__: { load(value) { registration = value; } } };
  const styles = [];
  globalThis.document = {
    createElement() { return { dataset: {}, textContent: '', remove() {} }; },
    head: { append(element) { styles.push(element); } },
  };
  await import(`../client.js?ui=${Date.now()}-${Math.random()}`);
  const plugin = registration.factory((specifier) => {
    if (specifier !== 'react') throw new Error(`unexpected module ${specifier}`);
    return reactStub(overrides);
  });
  return { plugin, styles };
}

function mount(plugin) {
  const registrations = [];
  const ctx = {
    effect() { return () => {}; },
    get(name) { return name === 'sessions' ? { kind: 'sessions' } : undefined; },
    locale: { register() { return () => {}; }, bind() { return (key) => key; } },
    slots: { inject(_name, callback) { return callback(); }, register(options, render) { registrations.push({ options, render }); return () => {}; } },
  };
  plugin.apply(ctx);
  return registrations;
}

/** Render the registered main slot into a plain element tree (no DOM involved). */
function renderMain(registrations) {
  const main = registrations.find((entry) => entry.options.name === 'main');
  const element = main.render();
  return element.type(element.props);
}

function walk(node, visit) {
  if (node === null || node === undefined) return;
  if (typeof node === 'string') { visit(node); return; }
  if (typeof node !== 'object') return;
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

const cssOf = (styles) => styles.map((style) => style.textContent).join('\n');

test('the page styles cover focus, status, loading, overflow and responsive rules', async () => {
  const { plugin, styles } = await load();
  mount(plugin);
  const css = cssOf(styles);
  for (const rule of [
    ':focus-visible', '.dm-skeleton', '.dm-statusline', '.dm-dot', '.dm-ledger-list',
    'overflow-wrap:anywhere', 'min-width:0', 'scrollbar-gutter:stable',
    'prefers-reduced-motion', '@media(max-width:720px)', '@media(max-width:600px)', 'dm-primary',
  ]) {
    assert.ok(css.includes(rule), `stylesheet is missing ${rule}`);
  }
  // The focus ring must be one shared rule, not scattered per component.
  assert.match(css, /\.dm-page :is\(button, a, summary, select, textarea, \[tabindex\]\):focus-visible/u);
  // Contrast: status must be conveyed by text plus a dot, never by colour alone.
  assert.match(css, /\.dm-statusline\[data-status="ok"\] \.dm-dot/u);
});

test('the loading state renders a skeleton and never fabricates memory rows', async () => {
  const { plugin } = await load();
  const tree = renderMain(mount(plugin));
  assert.equal(tree.props.className, 'dm-page');
  assert.equal(tree.props['aria-busy'], true);
  const classes = [];
  const roles = [];
  walk(tree, (node) => {
    if (node.props && typeof node.props.className === 'string') classes.push(node.props.className);
    if (node.props && typeof node.props.role === 'string') roles.push(node.props.role);
  });
  assert.ok(classes.some((value) => value.includes('dm-skeleton')), 'a skeleton is shown while loading');
  assert.ok(!classes.some((value) => value.includes('dm-turn') || value.includes('dm-review-card')), 'no fabricated cards');
  assert.ok(roles.includes('status'), 'the loading text is announced');
  assert.ok(!roles.includes('alert'), 'no fake error is announced');
  // Loading must be honest: no fabricated memory data in the tree.
  const texts = [];
  walk(tree, (node) => { if (typeof node === 'string') texts.push(node); });
  assert.ok(!texts.some((value) => /M-\d{8}/u.test(value)), 'no memory ids before data arrives');
});

test('the header marks one primary action and disables the refresh while loading', async () => {
  const { plugin } = await load();
  const tree = renderMain(mount(plugin));
  const buttons = [];
  walk(tree, (node) => { if (node.type === 'button') buttons.push(node); });
  const primary = buttons.filter((button) => String(button.props.className).includes('dm-primary'));
  assert.equal(primary.length, 1, 'exactly one primary action in the header');
  assert.equal(primary[0].props.disabled, true, 'refresh is disabled while the first read is in flight');
  const quiet = buttons.filter((button) => String(button.props.className).includes('dm-quiet'));
  assert.equal(quiet.length, 1, 'the Host test action is visually secondary');
  assert.equal(quiet[0].props.disabled, false, 'the Host test action stays available');
});

test('the status line pairs its text with a decorative dot and a machine-readable state', async () => {
  const { plugin } = await load();
  const tree = renderMain(mount(plugin));
  let line = null;
  let dot = null;
  walk(tree, (node) => {
    if (node.props && String(node.props.className).includes('dm-statusline')) line = node;
    if (node.props && String(node.props.className).includes('dm-dot')) dot = node;
  });
  assert.ok(line, 'the page renders a status line');
  assert.equal(line.props['data-status'], 'probing');
  assert.ok(dot, 'the status line carries a dot');
  assert.equal(dot.props['aria-hidden'], true, 'the dot is decorative: the text carries the meaning');
  const texts = [];
  walk(line, (node) => { if (typeof node === 'string') texts.push(node); });
  assert.ok(texts.some((value) => value.length > 0), 'the status line still has a readable message');
});
