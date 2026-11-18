// Fetches artwork with extension privileges (no CORS), center-crops it to a
// square JPEG and returns a data: URL that Firefox can always load.
const cache = new Map();

async function toSquareDataURL(url) {
  if (cache.has(url)) return cache.get(url);
  const res = await fetch(url, { credentials: "omit" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const bmp = await createImageBitmap(await res.blob());
  // YouTube serves a 120x90 grey placeholder when maxresdefault doesn't exist.
  if (bmp.width <= 120) throw new Error("placeholder image");
  const side = Math.min(bmp.width, bmp.height);
  const out = Math.min(side, 600);
  const canvas = new OffscreenCanvas(out, out);
  canvas.getContext("2d").drawImage(
    bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, out, out
  );
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 });
  const dataURL = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
  if (cache.size > 50) cache.delete(cache.keys().next().value);
  cache.set(url, dataURL);
  return dataURL;
}

browser.runtime.onMessage.addListener(async (msg) => {
  if (msg?.type !== "npe-artwork") return;
  for (const url of msg.urls) {
    try {
      return { url, dataURL: await toSquareDataURL(url) };
    } catch (e) { /* try next candidate */ }
  }
  return { dataURL: null };
});
