// Decides where the window opens, as a pure function of the saved position and
// the displays currently attached.
//
// Two things this has to get right, both of which the naive version got wrong.
//
// A laptop that was docked when the position was saved may not be docked now.
// Clamping a remembered x of 3000 against the built-in display's width leaves
// the window hanging off the right-hand edge — technically "on screen" by its
// top-left corner, useless in practice. The whole window has to fit.
//
// And the notch: there is nothing to detect here, which is the honest finding.
// macOS already excludes the menu bar — which on a notched Mac is the strip the
// camera housing sits in — from a display's workArea. Opening just below
// workArea.y therefore sits directly under the notch on machines that have one,
// and directly under the menu bar on machines that do not, with no special
// casing. Electron does not expose NSScreen.safeAreaInsets, and reaching for it
// would buy nothing: this window is far wider than the notch, so it is never
// competing with it for space.

const TOP_GAP = 6; // breathing room below the menu bar

function fits(display, size) {
  return display.workArea.width >= size.width && display.workArea.height >= size.height;
}

// The display a remembered point belongs to, or null if that screen is gone.
//
// Matched against the display's full bounds rather than its work area: a window
// can legitimately have been left overlapping the menu bar or the dock, and
// those points still belong to that screen. Using the work area here would
// misread "slightly behind the dock" as "that monitor is unplugged" and throw
// the user's chosen position away. Clamping into the work area happens after.
function displayContaining(displays, x, y) {
  return displays.find((d) => {
    const b = d.bounds;
    return x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height;
  }) || null;
}

function clampToDisplay(display, size, x, y) {
  const a = display.workArea;
  // When the window is larger than the work area, prefer showing its top-left
  // rather than pushing the title bar off screen.
  const maxX = Math.max(a.x, a.x + a.width - size.width);
  const maxY = Math.max(a.y, a.y + a.height - size.height);
  return {
    x: Math.round(Math.min(Math.max(x, a.x), maxX)),
    y: Math.round(Math.min(Math.max(y, a.y), maxY))
  };
}

// `displays` is Electron's screen.getAllDisplays() shape; `primary` is the one
// screen.getPrimaryDisplay() returned.
function placeWindow({ saved, size, displays, primary, topGap = TOP_GAP }) {
  const screens = (displays && displays.length ? displays : [primary]).filter(Boolean);
  const home = primary || screens[0];
  if (!home) return { x: 0, y: 0, display: null, reason: 'no-display' };

  const hasSaved = saved
    && Number.isFinite(saved.x) && Number.isFinite(saved.y);

  if (!hasSaved) {
    const centred = home.workArea.x + (home.workArea.width - size.width) / 2;
    const placed = clampToDisplay(home, size, centred, home.workArea.y + topGap);
    return { ...placed, display: home, reason: 'centred-under-menu-bar' };
  }

  // A remembered position only makes sense on the screen it was remembered on.
  const target = displayContaining(screens, saved.x, saved.y);
  if (!target) {
    const centred = home.workArea.x + (home.workArea.width - size.width) / 2;
    const placed = clampToDisplay(home, size, centred, home.workArea.y + topGap);
    return { ...placed, display: home, reason: 'saved-display-gone' };
  }

  const placed = clampToDisplay(target, size, saved.x, saved.y);
  const moved = placed.x !== Math.round(saved.x) || placed.y !== Math.round(saved.y);
  return { ...placed, display: target, reason: moved ? 'clamped-into-view' : 'restored' };
}

module.exports = { placeWindow, displayContaining, clampToDisplay, fits, TOP_GAP };
