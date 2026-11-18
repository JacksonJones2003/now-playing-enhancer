// Runs in the page's own JS world. Firefox only forwards to macOS Now Playing
// what the page gives navigator.mediaSession, and many sites (YouTube included)
// never call setPositionState() in Firefox and give artwork Firefox can't load.
// This fills in duration/position/playback state from the real <video>/<audio>
// element and supplies artwork as a pre-decoded square image.
(() => {
  if (window.__nowPlayingEnhancer || !("mediaSession" in navigator)) return;
  window.__nowPlayingEnhancer = true;

  const ms = navigator.mediaSession;
  const proto = MediaSession.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, "metadata");
  if (!desc?.get || !desc?.set) return;
  const nativeGet = desc.get;
  const nativeSet = desc.set;

  let pageMeta = null;      // last metadata the page itself set
  let appliedKey = "";      // what we last pushed, to avoid redundant updates
  let activeMedia = null;   // the element actually playing
  let lastSync = { at: 0, pos: 0 };
  const artCache = new Map(); // candidate-list key -> data: URL (or null on failure)
  const inflight = new Set();

  // Remember whatever the page sets, then layer our fixes on top.
  Object.defineProperty(proto, "metadata", {
    configurable: true,
    enumerable: desc.enumerable,
    get() { return nativeGet.call(this); },
    set(v) {
      pageMeta = v;
      appliedKey = "";
      nativeSet.call(this, v);
      queueEnhance();
    },
  });

  // ---- which media element is playing -------------------------------------
  const nativePlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) {
    activeMedia = this;          // catches detached `new Audio()` players too
    watch(this);
    return nativePlay.apply(this, args);
  };

  const watched = new WeakSet();
  function watch(el) {
    if (watched.has(el)) return;
    watched.add(el);
    for (const t of ["play", "playing", "pause", "seeked", "ratechange", "durationchange", "loadedmetadata", "emptied"]) {
      el.addEventListener(t, onMediaEvent);
    }
    el.addEventListener("timeupdate", onTimeUpdate);
  }

  // Media events don't bubble, but capture on window sees attached elements.
  for (const t of ["play", "playing", "loadedmetadata"]) {
    window.addEventListener(t, (e) => {
      if (e.target instanceof HTMLMediaElement) { watch(e.target); onMediaEvent(e); }
    }, true);
  }

  function onMediaEvent(e) {
    const el = e.target;
    if ((e.type === "play" || e.type === "playing") || (!activeMedia && !el.paused)) activeMedia = el;
    if (el !== activeMedia) return;
    syncPosition(true);
    if (e.type === "play" || e.type === "playing" || e.type === "loadedmetadata") queueEnhance();
  }

  function onTimeUpdate(e) {
    const el = e.target;
    if (!activeMedia || (activeMedia.paused && !el.paused)) activeMedia = el;
    if (el !== activeMedia) return;
    // macOS extrapolates from the playback rate, so we only need to resync
    // occasionally or when position drifts (e.g. ads, buffering stalls).
    const now = performance.now();
    const expected = lastSync.pos + ((now - lastSync.at) / 1000) * (el.paused ? 0 : el.playbackRate);
    if (now - lastSync.at > 5000 || Math.abs(el.currentTime - expected) > 1.5) syncPosition(false);
  }

  // ---- duration / elapsed time / play state ---------------------------------
  function syncPosition() {
    const m = activeMedia;
    if (!m) return;
    try { ms.playbackState = m.paused ? "paused" : "playing"; } catch {}
    const duration = m.duration;
    if (!Number.isFinite(duration) || duration <= 0) return; // live streams
    const position = Math.min(Math.max(m.currentTime || 0, 0), duration);
    try {
      ms.setPositionState({ duration, position, playbackRate: m.playbackRate || 1 });
      lastSync = { at: performance.now(), pos: position };
    } catch {}
  }

  // ---- artwork ----------------------------------------------------------------
  const onYouTube = /(^|\.)youtube\.com$/.test(location.hostname) && !location.hostname.startsWith("music.");

  // On YouTube, prefer the video ID in the page's own artwork URLs: YouTube can
  // set the new video's metadata before the address bar changes, so the URL
  // may still point at the previous video.
  function youtubeId(meta) {
    if (!onYouTube) return null;
    for (const a of meta?.artwork || []) {
      const m = /ytimg\.com\/vi(?:_webp)?\/([\w-]{6,})\//.exec(a?.src || "");
      if (m) return m[1];
    }
    const v = new URLSearchParams(location.search).get("v");
    if (v) return v;
    const m = location.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]{6,})/);
    return m ? m[1] : null;
  }

  function areaOf(sizes) {
    const m = /(\d+)x(\d+)/i.exec(sizes || "");
    return m ? +m[1] * +m[2] : 0;
  }

  function artworkCandidates(meta) {
    const urls = [];
    const id = youtubeId(meta);
    if (id) urls.push(`https://i.ytimg.com/vi/${id}/maxresdefault.jpg`, `https://i.ytimg.com/vi/${id}/hqdefault.jpg`);
    const art = meta?.artwork ? [...meta.artwork] : [];
    art.sort((a, b) => areaOf(b.sizes) - areaOf(a.sizes));
    for (const a of art) if (a?.src) urls.push(new URL(a.src, location.href).href);
    // og:image and posters go stale on single-page sites like YouTube.
    if (!id && !art.length) {
      const og = document.querySelector('meta[property="og:image"], meta[name="twitter:image"]')?.content;
      if (og) urls.push(new URL(og, location.href).href);
      if (activeMedia?.poster) urls.push(new URL(activeMedia.poster, location.href).href);
    }
    return [...new Set(urls)].filter((u) => /^https?:/.test(u));
  }

  let reqId = 0;
  function requestArtwork(urls) {
    return new Promise((resolve) => {
      const id = ++reqId;
      const onReply = (e) => {
        if (e.source !== window || e.data?.__npe !== "artwork-reply" || e.data.id !== id) return;
        window.removeEventListener("message", onReply);
        clearTimeout(timer);
        resolve(e.data.dataURL);
      };
      const timer = setTimeout(() => { window.removeEventListener("message", onReply); resolve(null); }, 20000);
      window.addEventListener("message", onReply);
      window.postMessage({ __npe: "artwork-request", id, urls }, "*");
    });
  }

  // ---- merge it all into the metadata Firefox publishes ----------------------
  const failures = new Map(); // artKey -> { count, retryAt }
  let enhanceTimer = 0;
  function queueEnhance() {
    clearTimeout(enhanceTimer);
    enhanceTimer = setTimeout(enhance, 150);
  }

  function fetchArtwork(artKey, candidates) {
    const f = failures.get(artKey);
    if (inflight.has(artKey) || (f && Date.now() < f.retryAt)) return;
    inflight.add(artKey);
    requestArtwork(candidates).then((dataURL) => {
      inflight.delete(artKey);
      if (dataURL) {
        failures.delete(artKey);
        artCache.set(artKey, dataURL);
        if (artCache.size > 30) artCache.delete(artCache.keys().next().value);
      } else {
        // Retry later (2s, 4s, 8s ... up to 60s) instead of giving up for good.
        const count = (f?.count || 0) + 1;
        failures.set(artKey, { count, retryAt: Date.now() + Math.min(60000, 1000 * 2 ** count) });
        console.debug("[Now Playing Enhancer] artwork fetch failed, will retry:", candidates);
      }
      queueEnhance();
    });
  }

  function currentArtKey() {
    return artworkCandidates(pageMeta).join("|");
  }

  function enhance() {
    if (!activeMedia) return;
    const base = pageMeta;
    const title = base?.title || document.title || location.hostname;
    const artist = base?.artist || (base ? "" : location.hostname.replace(/^www\./, ""));
    const album = base?.album || "";
    const candidates = artworkCandidates(base);
    const artKey = candidates.join("|");
    const dataURL = artCache.get(artKey);

    if (artKey && !dataURL) {
      fetchArtwork(artKey, candidates);
      if (base && !appliedKey) return; // page metadata is already live; wait for artwork
    }

    const key = [title, artist, album, artKey, !!dataURL].join("\u0000");
    if (key === appliedKey) return;

    const artwork = [];
    if (dataURL) artwork.push({ src: dataURL, sizes: "600x600", type: "image/jpeg" });
    for (const a of base?.artwork || []) artwork.push({ src: a.src, sizes: a.sizes, type: a.type });
    if (!artwork.length && candidates[0]) artwork.push({ src: candidates[0] });

    try {
      nativeSet.call(ms, new MediaMetadata({ title, artist, album, artwork }));
      appliedKey = key;
    } catch {}
    syncPosition();
  }

  // YouTube fires this after switching videos without a page load.
  window.addEventListener("yt-navigate-finish", queueEnhance);
  window.addEventListener("popstate", queueEnhance);

  // Self-heal every 2s while something is playing: catch address/title
  // changes, retry failed artwork, and re-apply artwork if it was overwritten.
  let lastHref = location.href;
  let lastTitle = document.title;
  setInterval(() => {
    if (!activeMedia || activeMedia.paused) return;
    let stale = false;
    if (location.href !== lastHref) { lastHref = location.href; stale = true; }
    if (!pageMeta && document.title !== lastTitle) { lastTitle = document.title; stale = true; }
    const artKey = currentArtKey();
    const wanted = artCache.get(artKey);
    const shown = nativeGet.call(ms)?.artwork?.[0]?.src;
    if (artKey && (!wanted || shown !== wanted)) stale = true;
    if (stale) { appliedKey = ""; queueEnhance(); }
  }, 2000);
})();
