// Mirror boot.
//
// Loaded on the canonical origin it does nothing: cookies, same-origin fetches,
// and the service-worker proxy stay exactly as they are.
//
// Loaded on a dedicated mirror origin (a host you control, not a shared CDN) it
// sends /api calls to the canonical HTTPS origin, then to the configured
// fallbacks, and attaches the existing X-Noc-Session header. It does not read
// or write that token on a shared CDN origin. It does not open the WISP
// sockets; those are handshake-monitored by the origin (GET /api/transport)
// because a browser cannot speak HTTPS over a raw WISP TCP tunnel, and those
// sockets are not an HTTP reverse proxy.
//
// Static mirror pages opt in by including this file and leaving
// window.__NOC_HOST_ROLE unset:
//   <script src="https://nocturne.lol/mirror/boot.js"></script>
(function (root) {
    "use strict";

    var SHARED = [".jsdelivr.net", ".statically.io", ".githubusercontent.com"];
    var PRIMARY = { "nocturne.lol": 1, "www.nocturne.lol": 1, "localhost": 1, "127.0.0.1": 1 };
    var FALLBACKS = [];
    var SESSION_HEADER = "X-Noc-Session";
    var STORAGE_KEY = "noc-api-base";

    function hostnameOf(value) {
        try { return new URL(value).hostname.toLowerCase(); } catch (e) { return ""; }
    }

    function isSharedHost(hostname) {
        var host = String(hostname || "").toLowerCase().replace(/\.+$/, "");
        if (!host) return true;
        for (var i = 0; i < SHARED.length; i++) {
            var suffix = SHARED[i].slice(1);
            if (host === suffix || host.endsWith(SHARED[i])) return true;
        }
        return false;
    }

    function originOf(value) {
        try {
            var url = new URL(value);
            if (url.protocol !== "https:" && url.protocol !== "http:") return "";
            if (isSharedHost(url.hostname)) return "";
            return url.origin;
        } catch (e) { return ""; }
    }

    function createMirrorController(opts) {
        opts = opts || {};
        var pageOrigin = originOf(opts.pageOrigin || "");
        var pageHost = hostnameOf(pageOrigin);
        var shared = !pageOrigin || isSharedHost(pageHost) || opts.protocol === "blob:";
        var role = opts.role === "origin" ? "origin" : "static";
        var mode = (role === "origin" || PRIMARY[pageHost]) && !shared ? "origin" : (shared ? "blocked" : "static");
        var storage = opts.storage || null;
        var selected = "";
        var bases = [];

        function pushBase(value) {
            var origin = originOf(value);
            if (origin && bases.indexOf(origin) === -1) bases.push(origin);
        }
        pushBase(opts.apiBase || "https://nocturne.lol");
        var extras = opts.fallbacks || FALLBACKS;
        for (var i = 0; i < extras.length; i++) pushBase(extras[i]);
        if (opts.extraFallbacks) {
            for (var j = 0; j < opts.extraFallbacks.length; j++) pushBase(opts.extraFallbacks[j]);
        }

        function readCached() {
            if (!storage) return "";
            try { return originOf(storage.getItem(STORAGE_KEY) || ""); } catch (e) { return ""; }
        }
        function writeCached(value) {
            if (!storage) return;
            try { storage.setItem(STORAGE_KEY, value); } catch (e) {}
        }

        function current() {
            return mode === "static" ? (selected || readCached() || bases[0] || "") : pageOrigin;
        }

        function owns(url) {
            if (pageHost && url.host === pageHost) return true;
            for (var i = 0; i < bases.length; i++) {
                if (hostnameOf(bases[i]) === url.hostname) return true;
            }
            return false;
        }

        function isApiUrl(value) {
            try {
                var url = new URL(value, pageOrigin || "https://nocturne.lol");
                return (url.protocol === "https:" || url.protocol === "http:") && url.pathname.indexOf("/api/") === 0 && owns(url);
            } catch (e) { return false; }
        }

        function rewrite(value) {
            var raw = typeof value === "string" ? value : (value && value.url) || "";
            if (!raw) return { url: raw, api: false, block: false };
            var absolute;
            try { absolute = new URL(raw, pageOrigin || "https://nocturne.lol"); }
            catch (e) { return { url: raw, api: false, block: false }; }
            var api = (absolute.protocol === "https:" || absolute.protocol === "http:" || absolute.protocol === "ws:" || absolute.protocol === "wss:")
                && absolute.pathname.indexOf("/api/") === 0 && owns(absolute);
            if (!api) return { url: raw, api: false, block: false };
            if (mode === "blocked") return { url: raw, api: true, block: true };
            if (mode !== "static") return { url: raw, api: true, block: false };
            var base = current();
            if (!base) return { url: absolute.href, api: true, block: false };
            var target = new URL(base);
            var next = new URL(absolute.href);
            if (next.protocol === "ws:") next.protocol = target.protocol === "https:" ? "wss:" : "ws:";
            else if (next.protocol === "wss:") next.protocol = target.protocol === "https:" ? "wss:" : "ws:";
            else next.protocol = target.protocol;
            next.host = target.host;
            return { url: next.href, api: true, block: false };
        }

        function sessionToken() {
            if (mode === "blocked") return "";
            if (typeof opts.sessionToken === "string") return opts.sessionToken;
            return "";
        }

        function noteSuccess(base) {
            var origin = originOf(base);
            if (!origin) return;
            selected = origin;
            writeCached(origin);
        }

        function noteFailure(base) {
            var origin = originOf(base);
            if (selected === origin) selected = "";
            var cached = readCached();
            if (cached && cached === origin && storage) {
                try { storage.removeItem ? storage.removeItem(STORAGE_KEY) : storage.setItem(STORAGE_KEY, ""); } catch (e) {}
            }
        }

        function orderedBases() {
            var list = [];
            var cached = current();
            if (cached) list.push(cached);
            for (var i = 0; i < bases.length; i++) if (list.indexOf(bases[i]) === -1) list.push(bases[i]);
            return list;
        }

        return {
            mode: function () { return mode; },
            bases: function () { return bases.slice(); },
            current: current,
            isApiUrl: isApiUrl,
            rewrite: rewrite,
            sessionToken: sessionToken,
            noteSuccess: noteSuccess,
            noteFailure: noteFailure,
            orderedBases: orderedBases,
        };
    }

    root.NocturneMirror = { createMirrorController: createMirrorController, isSharedHost: isSharedHost };

    if (!root.document || !root.window) return;
    if (root.__nocMirrorInstalled) return;
    root.__nocMirrorInstalled = true;

    try {
        var pageProtocol = root.location.protocol === "blob:" ? "blob:" : root.location.protocol;
        var storage = null;
        try { storage = root.sessionStorage; } catch (e) { storage = null; }
        var controller = createMirrorController({
            role: root.__NOC_HOST_ROLE,
            pageOrigin: root.location.origin,
            protocol: pageProtocol,
            apiBase: root.__NOC_API_BASE || "https://nocturne.lol",
            fallbacks: FALLBACKS.concat(Array.isArray(root.__NOC_API_FALLBACKS) ? root.__NOC_API_FALLBACKS : []),
            storage: storage,
        });
        if (controller.mode() !== "blocked") {
            controller.sessionToken = function () {
                try { return root.localStorage.getItem("noc-session") || ""; } catch (e) { return ""; }
            };
        }
        var origFetch = root.fetch ? root.fetch.bind(root) : null;
        if (controller.mode() === "blocked" && origFetch) {
            root.fetch = function (input, init) {
                var raw = typeof input === "string" ? input : (input && input.url) || "";
                if (controller.isApiUrl(raw)) return Promise.reject(new Error("cdn origin cannot host the app"));
                return origFetch(input, init);
            };
            return;
        }
        if (controller.mode() !== "static" || !origFetch) return;

        var pending = selectBase(controller, origFetch);

        root.fetch = function (input, init) {
            var raw = typeof input === "string" ? input : (input && input.url) || "";
            if (!controller.isApiUrl(raw)) return origFetch(input, init);
            return pending.then(function () { return send(controller, origFetch, input, init); });
        };

        if (root.EventSource) {
            var OrigES = root.EventSource;
            var WrappedES = function (url, options) {
                var next = controller.rewrite(url);
                if (next.block) throw new Error("cdn origin cannot host the app");
                return new OrigES(next.url, options);
            };
            WrappedES.prototype = OrigES.prototype;
            root.EventSource = WrappedES;
        }

        if (root.WebSocket) {
            var OrigWS = root.WebSocket;
            var WrappedWS = function (url, protocols) {
                var next = controller.rewrite(String(url));
                if (next.block) throw new Error("cdn origin cannot host the app");
                if (!next.api) return protocols === undefined ? new OrigWS(url) : new OrigWS(url, protocols);
                return protocols === undefined ? new OrigWS(next.url) : new OrigWS(next.url, protocols);
            };
            WrappedWS.prototype = OrigWS.prototype;
            WrappedWS.CONNECTING = OrigWS.CONNECTING;
            WrappedWS.OPEN = OrigWS.OPEN;
            WrappedWS.CLOSING = OrigWS.CLOSING;
            WrappedWS.CLOSED = OrigWS.CLOSED;
            root.WebSocket = WrappedWS;
        }

        if (root.XMLHttpRequest) {
            var xhrOpen = root.XMLHttpRequest.prototype.open;
            var xhrSend = root.XMLHttpRequest.prototype.send;
            var xhrSet = root.XMLHttpRequest.prototype.setRequestHeader;
            root.XMLHttpRequest.prototype.setRequestHeader = function (name) {
                if (String(name).toLowerCase() === "x-noc-session") this.__nocSessionSet = true;
                return xhrSet.apply(this, arguments);
            };
            root.XMLHttpRequest.prototype.open = function (method, url) {
                var args = Array.prototype.slice.call(arguments);
                var next = controller.rewrite(String(url));
                this.__nocBlock = next.block;
                this.__nocApi = next.api && !next.block;
                if (next.api && !next.block) args[1] = next.url;
                return xhrOpen.apply(this, args);
            };
            root.XMLHttpRequest.prototype.send = function () {
                if (this.__nocBlock) throw new Error("cdn origin cannot host the app");
                if (this.__nocApi) {
                    var tok = controller.sessionToken();
                    if (tok && !this.__nocSessionSet) xhrSet.call(this, SESSION_HEADER, tok);
                }
                return xhrSend.apply(this, arguments);
            };
        }
    } catch (e) {}

    function withSession(init, token, crossOrigin) {
        var next = {};
        if (init) {
            for (var key in init) if (Object.prototype.hasOwnProperty.call(init, key)) next[key] = init[key];
        }
        var headers = new root.Headers(next.headers || {});
        if (token && !headers.has(SESSION_HEADER)) headers.set(SESSION_HEADER, token);
        next.headers = headers;
        if (crossOrigin && (next.credentials === "include" || next.credentials === "same-origin" || !next.credentials)) {
            next.credentials = "omit";
        }
        return next;
    }

    function send(controller, origFetch, input, init) {
        var raw = typeof input === "string" ? input : (input && input.url) || "";
        var plan = controller.rewrite(raw);
        if (plan.block) return Promise.reject(new Error("cdn origin cannot host the app"));
        if (!plan.api) return origFetch(input, init);
        if (typeof input !== "string") {
            var token = controller.sessionToken();
            var headers = new root.Headers(input.headers || undefined);
            if (init && init.headers) new root.Headers(init.headers).forEach(function (value, key) { headers.set(key, value); });
            if (token && !headers.has(SESSION_HEADER)) headers.set(SESSION_HEADER, token);
            var method = (init && init.method) || input.method || "GET";
            var body = init && Object.prototype.hasOwnProperty.call(init, "body") ? init.body : input.body;
            if (method === "GET" || method === "HEAD") body = undefined;
            return origFetch(plan.url, {
                method: method,
                headers: headers,
                body: body,
                credentials: "omit",
                cache: (init && init.cache) || input.cache,
                signal: (init && init.signal) || input.signal,
            }).then(function (response) {
                try { controller.noteSuccess(new root.URL(plan.url).origin); } catch (e) {}
                return response;
            });
        }
        var bases = controller.orderedBases();
        var body = init && init.body;
        var retryable = typeof input === "string" && (body == null || typeof body === "string" || (root.URLSearchParams && body instanceof root.URLSearchParams));
        function attempt(index) {
            var rewritten = controller.rewrite(raw);
            var target = new root.URL(rewritten.url);
            var cross = target.origin !== root.location.origin;
            var options = withSession(init, controller.sessionToken(), cross);
            return origFetch(target.href, options).then(function (response) {
                controller.noteSuccess(target.origin);
                return response;
            }, function (error) {
                controller.noteFailure(target.origin);
                if (!retryable || index + 1 >= bases.length) throw error;
                if (error && error.name === "AbortError") throw error;
                var failed = bases[index];
                controller.noteFailure(failed);
                var rest = bases.slice(index + 1);
                if (!rest.length) throw error;
                controller.noteSuccess(rest[0]);
                return attempt(index + 1);
            });
        }
        return attempt(0);
    }

    function selectBase(controller, fetchImpl) {
        var list = controller.orderedBases();
        var index = 0;
        function ping(base) {
            var ctrl = new root.AbortController();
            var timer = root.setTimeout(function () { ctrl.abort(); }, 2500);
            return fetchImpl(base + "/api/transport", { credentials: "omit", cache: "no-store", signal: ctrl.signal })
                .then(function (response) {
                    root.clearTimeout(timer);
                    if (!response.ok) throw new Error("status " + response.status);
                    return response.json();
                }, function (error) {
                    root.clearTimeout(timer);
                    throw error;
                })
                .then(function (body) {
                    if (!body || body.ok !== true || body.role !== "origin") throw new Error("not-origin");
                    controller.noteSuccess(base);
                });
        }
        function next() {
            if (index >= list.length) {
                if (list[0]) controller.noteSuccess(list[0]);
                return Promise.resolve();
            }
            var base = list[index++];
            return ping(base).catch(function () {
                controller.noteFailure(base);
                return next();
            });
        }
        return next();
    }
})(typeof globalThis !== "undefined" ? globalThis : this);
