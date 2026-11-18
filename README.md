# Now Playing Enhancer for Firefox

A small Firefox extension that enriches the media information Firefox shares with macOS Now Playing. It adds duration, playback progress and artwork for audio and video on any site, so Control Center, the lock screen, media widgets and notch apps can show the full picture.

## The problem

Firefox only publishes to macOS what a website hands to `navigator.mediaSession`. Many sites, YouTube included, never call `setPositionState()` in Firefox and give artwork Firefox doesn't load. The result is that macOS often receives only a title and artist:

| Field        | Without the extension | With the extension |
|--------------|-----------------------|--------------------|
| Title        | yes                   | yes                |
| Artist       | yes                   | yes                |
| Duration     | missing               | yes                |
| Elapsed time | missing               | yes                |
| Artwork      | missing               | yes (600×600)      |

## What it does

- Reads duration, position, playback rate and play/pause state from the `<video>` or `<audio>` element that's actually playing, and passes them to `navigator.mediaSession.setPositionState()`.
- Fetches artwork with extension privileges, center-crops it to a square JPEG and supplies it as a `data:` URL that Firefox always loads. On YouTube it uses the high-resolution video thumbnail.
- Fills in title and site name for sites that set no media metadata at all.

## Install (temporary)

1. Open `about:debugging#/runtime/this-firefox` in Firefox.
2. Click **Load Temporary Add-on…** and choose `extension/manifest.json`.
3. Reload any tab that is already playing media.

Temporary add-ons are removed when Firefox quits. For a permanent install, sign the extension for free as an unlisted add-on on [addons.mozilla.org](https://addons.mozilla.org/developers/), or use Firefox Developer Edition with `xpinstall.signatures.required` set to `false`.

Requires Firefox 128 or later on macOS.

## Files

```
extension/
├── manifest.json   extension manifest (Manifest V3)
├── page.js         runs in the page: syncs position state and merges metadata
├── bridge.js       relays artwork requests from the page to the background script
└── background.js   fetches, crops and encodes the artwork
```

`now-playing-enhancer.xpi` is the same four files packaged as a zip.
