const test = require('node:test');
const assert = require('node:assert');
const { placeWindow, displayContaining, TOP_GAP } = require('../src/window-position');

const SIZE = { width: 460, height: 300 };

// The machine this was developed on, in logical points.
const BUILTIN = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1470, height: 956 },
  workArea: { x: 0, y: 32, width: 1470, height: 825 }
};
// A display to the right of the built-in one, as a dock typically arranges it.
const EXTERNAL = {
  id: 2,
  bounds: { x: 1470, y: 0, width: 2560, height: 1440 },
  workArea: { x: 1470, y: 25, width: 2560, height: 1415 }
};

test('with no saved position the window centres under the menu bar', () => {
  const p = placeWindow({ saved: null, size: SIZE, displays: [BUILTIN], primary: BUILTIN });
  assert.equal(p.x, 505, 'the measured centre on this display');
  assert.equal(p.y, BUILTIN.workArea.y + TOP_GAP);
  assert.equal(p.reason, 'centred-under-menu-bar');
});

test('opening below workArea.y is what puts it under the notch', () => {
  // macOS excludes the menu bar — the strip containing the camera housing —
  // from workArea, so this needs no notch-specific code.
  const p = placeWindow({ saved: null, size: SIZE, displays: [BUILTIN], primary: BUILTIN });
  assert.ok(p.y > BUILTIN.bounds.y, 'never overlaps the menu bar / notch region');
  assert.ok(p.y >= BUILTIN.workArea.y);
});

test('nulls from a fresh settings file are treated as no saved position', () => {
  const p = placeWindow({ saved: { x: null, y: null }, size: SIZE, displays: [BUILTIN], primary: BUILTIN });
  assert.equal(p.reason, 'centred-under-menu-bar');
});

test('a remembered position on an attached display is restored exactly', () => {
  const p = placeWindow({ saved: { x: 300, y: 400 }, size: SIZE, displays: [BUILTIN], primary: BUILTIN });
  assert.deepEqual({ x: p.x, y: p.y }, { x: 300, y: 400 });
  assert.equal(p.reason, 'restored');
});

test('a position remembered on an external display is honoured while docked', () => {
  const p = placeWindow({
    saved: { x: 2000, y: 500 }, size: SIZE,
    displays: [BUILTIN, EXTERNAL], primary: BUILTIN
  });
  assert.equal(p.display.id, EXTERNAL.id);
  assert.deepEqual({ x: p.x, y: p.y }, { x: 2000, y: 500 });
});

test('undocking brings the window back instead of stranding it off screen', () => {
  // Regression: clamping 2000 against the built-in display left the window
  // hanging past the right edge, visible only by its top-left corner.
  const p = placeWindow({
    saved: { x: 2000, y: 500 }, size: SIZE,
    displays: [BUILTIN], primary: BUILTIN
  });
  assert.equal(p.reason, 'saved-display-gone');
  assert.equal(p.x, 505, 'recentred on the remaining display');
  assert.ok(p.x + SIZE.width <= BUILTIN.workArea.x + BUILTIN.workArea.width,
    'and wholly on screen');
});

test('the entire window is kept on screen, not just its corner', () => {
  const p = placeWindow({
    saved: { x: 1460, y: 900 }, size: SIZE, // 10pt from the right edge
    displays: [BUILTIN], primary: BUILTIN
  });
  assert.ok(p.x + SIZE.width <= BUILTIN.workArea.x + BUILTIN.workArea.width,
    `right edge at ${p.x + SIZE.width} exceeds ${BUILTIN.workArea.x + BUILTIN.workArea.width}`);
  assert.ok(p.y + SIZE.height <= BUILTIN.workArea.y + BUILTIN.workArea.height,
    'bottom edge stays above the dock');
  assert.equal(p.reason, 'clamped-into-view');
});

test('a negative saved position is pulled back on screen', () => {
  const p = placeWindow({ saved: { x: -800, y: -600 }, size: SIZE, displays: [BUILTIN], primary: BUILTIN });
  assert.ok(p.x >= BUILTIN.workArea.x);
  assert.ok(p.y >= BUILTIN.workArea.y, 'never behind the menu bar');
});

test('a window larger than the display shows its top-left rather than its middle', () => {
  const tiny = {
    id: 9,
    bounds: { x: 0, y: 0, width: 400, height: 300 },
    workArea: { x: 0, y: 25, width: 400, height: 250 }
  };
  const p = placeWindow({ saved: null, size: SIZE, displays: [tiny], primary: tiny });
  assert.equal(p.x, tiny.workArea.x);
  assert.equal(p.y, tiny.workArea.y);
});

test('placement is deterministic for identical input', () => {
  // The apparent "moving window" was display scaling changing between
  // observations, not nondeterminism here.
  const args = { saved: null, size: SIZE, displays: [BUILTIN, EXTERNAL], primary: BUILTIN };
  const a = placeWindow(args);
  const b = placeWindow(args);
  assert.deepEqual({ x: a.x, y: a.y }, { x: b.x, y: b.y });
});

test('the centre follows the display scaling mode, which is why coordinates differed', () => {
  // Same physical panel, two scaled modes: the logical width changes, so the
  // centred x legitimately changes with it.
  const scaled = { id: 3, bounds: { x: 0, y: 0, width: 1280, height: 832 }, workArea: { x: 0, y: 32, width: 1280, height: 700 } };
  const wide = placeWindow({ saved: null, size: SIZE, displays: [BUILTIN], primary: BUILTIN });
  const narrow = placeWindow({ saved: null, size: SIZE, displays: [scaled], primary: scaled });
  assert.equal(wide.x, 505);
  assert.equal(narrow.x, 410);
});

test('no displays at all does not throw', () => {
  assert.doesNotThrow(() => placeWindow({ saved: null, size: SIZE, displays: [], primary: null }));
});

test('displayContaining picks the right screen and reports absence', () => {
  assert.equal(displayContaining([BUILTIN, EXTERNAL], 100, 100).id, BUILTIN.id);
  assert.equal(displayContaining([BUILTIN, EXTERNAL], 2000, 100).id, EXTERNAL.id);
  assert.equal(displayContaining([BUILTIN], 2000, 100), null);
});

test('a position left overlapping the dock keeps its display, and is nudged up', () => {
  // Regression: matching the saved point against the work area treated a window
  // sitting over the dock as belonging to a disconnected screen, discarding the
  // user's position and recentring it.
  const p = placeWindow({ saved: { x: 200, y: 900 }, size: SIZE, displays: [BUILTIN], primary: BUILTIN });
  assert.equal(p.reason, 'clamped-into-view', 'the display is still there');
  assert.equal(p.x, 200, 'the horizontal position the user chose is kept');
  assert.ok(p.y < 900, 'and it is lifted clear of the dock');
});
