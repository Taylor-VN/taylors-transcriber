/**
 * Backend transport shim.
 *
 * Normally the desktop shell injects `window.pywebview.api`. When no native GUI
 * backend is available the app falls back to running in a browser, and the same
 * API is exposed over authenticated localhost HTTP instead. This installs a
 * proxy at `window.pywebview.api` that speaks that HTTP bridge, so every
 * existing caller keeps working without knowing which mode it is in.
 *
 * Loaded before the other scripts and resolves `window.bridgeReady` once the
 * transport is settled.
 */

(function () {
  const API_PREFIX = '/__api/';

  // Under the real desktop shell pywebview injects its own object; leave it be.
  function hasNativeBridge() {
    return !!(window.pywebview && window.pywebview.api);
  }

  async function fetchConfig() {
    try {
      // Bounded: a hung request must not stop the UI from binding at all.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2500);
      const res = await fetch('/__api/config', { cache: 'no-store', signal: controller.signal })
        .finally(() => clearTimeout(timer));
      if (!res.ok) return null;
      const cfg = await res.json();
      // Returned even when the bridge is off: that answer still tells us our
      // own server is serving the page, which rules static mode out.
      return cfg && cfg.ok ? cfg : null;
    } catch (e) {
      return null; // opened as a file:// page, or no server — static mode
    }
  }

  /**
   * Waits for the desktop shell to inject its js_api.
   *
   * pywebview attaches `window.pywebview.api` after the document loads, so a
   * script that decides at parse time sees no bridge and writes the app off as
   * static — which is why anything called during startup (the installed-font
   * list) found no backend while everything called later worked.
   */
  function waitForNativeBridge(timeoutMs) {
    if (hasNativeBridge()) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        window.removeEventListener('pywebviewready', onReady);
        clearInterval(poll);
        clearTimeout(timer);
        resolve(ok);
      };
      const onReady = () => finish(hasNativeBridge());
      // The event is the fast path; the poll covers shells that inject without
      // firing it, and the timeout keeps a browser from waiting forever.
      window.addEventListener('pywebviewready', onReady);
      const poll = setInterval(() => { if (hasNativeBridge()) finish(true); }, 50);
      const timer = setTimeout(() => finish(false), timeoutMs);
    });
  }

  function makeHttpApi(token) {
    const call = async (method, args) => {
      const res = await fetch(API_PREFIX + method, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Token': token },
        body: JSON.stringify({ args: args })
      });

      let payload;
      try {
        payload = await res.json();
      } catch (e) {
        throw new Error(`Backend returned a malformed response (HTTP ${res.status}).`);
      }
      if (!payload.ok) throw new Error(payload.error || `Backend error (HTTP ${res.status}).`);
      return payload.result;
    };

    // A Proxy means the method list lives in one place — the backend — rather
    // than being duplicated here and drifting out of sync.
    return new Proxy({}, {
      get(_target, prop) {
        if (typeof prop !== 'string') return undefined;
        // Callers feature-detect with truthiness checks, so every name must
        // return something callable.
        return (...args) => call(prop, args);
      },
      has() {
        return true;
      }
    });
  }

  window.bridgeReady = (async () => {
    if (hasNativeBridge()) {
      window.bridgeMode = 'native';
      return 'native';
    }

    const cfg = await fetchConfig();
    if (!cfg) {
      // No server answered, so nothing can arrive later either: file:// page.
      window.bridgeMode = 'static';
      return 'static';
    }

    if (!cfg.bridge || !cfg.token) {
      // Our server is serving the page but the HTTP bridge is off — the desktop
      // shell, which passes js_api natively and injects it once loading ends.
      if (await waitForNativeBridge(10000)) {
        window.bridgeMode = 'native';
        return 'native';
      }
      window.bridgeMode = 'static';
      return 'static';
    }

    // Deliberately not exposed over HTTP: these three need a native file dialog.
    // In a browser, text exports and project files should be downloaded by the
    // page — and projects opened through a file input — rather than written or
    // read server-side at a guessed path. Leaving them absent makes app.js take
    // its download / file-input path.
    const NATIVE_ONLY = new Set(['save_text_file', 'project_save', 'project_open']);

    const api = makeHttpApi(cfg.token);
    window.pywebview = window.pywebview || {};
    window.pywebview.api = new Proxy(api, {
      get(target, prop) {
        if (NATIVE_ONLY.has(prop)) return undefined;
        return target[prop];
      },
      has(_t, prop) {
        return !NATIVE_ONLY.has(prop);
      }
    });

    window.bridgeMode = 'http';
    return 'http';
  })();
})();
