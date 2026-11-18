// Isolated-world relay between the page script and the background script.
window.addEventListener("message", async (e) => {
  if (e.source !== window || e.data?.__npe !== "artwork-request") return;
  let reply = { dataURL: null };
  try { reply = await browser.runtime.sendMessage({ type: "npe-artwork", urls: e.data.urls }); } catch {}
  window.postMessage({ __npe: "artwork-reply", id: e.data.id, dataURL: reply?.dataURL ?? null }, "*");
});
