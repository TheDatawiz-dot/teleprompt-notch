// Makes "no network requests" enforced rather than promised.
//
// The app has no networking code and no dependencies that could add any, but
// "we did not write any" is a claim about today's source, not a property of the
// program. A renderer that loads a remote font, a future dependency that phones
// home, or a stray absolute URL in markup would all quietly break the promise
// the README makes.
//
// So every request leaving the app's session is refused unless it is the app
// loading its own files. The policy is a pure predicate here so it can be
// tested; main.js installs it on Electron's session.

// Schemes the app legitimately uses to load itself and its own assets.
const LOCAL_SCHEMES = ['file:', 'devtools:', 'blob:', 'data:', 'chrome-extension:'];

function isLocalRequest(url) {
  if (typeof url !== 'string' || !url) return false;
  const lower = url.toLowerCase();
  return LOCAL_SCHEMES.some((scheme) => lower.startsWith(scheme));
}

// True when the request must be refused.
function shouldBlock(url) {
  return !isLocalRequest(url);
}

// Installs the guard on an Electron session. `onBlocked` is called with each
// refused URL so an unexpected one is visible rather than silent.
function install(session, onBlocked) {
  if (!session || !session.webRequest) return false;
  session.webRequest.onBeforeRequest((details, callback) => {
    if (shouldBlock(details.url)) {
      if (onBlocked) onBlocked(details.url);
      callback({ cancel: true });
      return;
    }
    callback({});
  });
  return true;
}

module.exports = { isLocalRequest, shouldBlock, install, LOCAL_SCHEMES };
