/* Apple Music integration.
 *
 * - Catalog search via the public iTunes Search API (no account needed) -> 30 s previews.
 * - "Connect Apple Music" via MusicKit JS v3 (needs an Apple Developer token) -> your library,
 *   playlists and catalog; tracks load into the decks through their non-DRM previews.
 *
 * Full-length Apple Music streams are DRM protected (FairPlay). Apple does not let third-party
 * apps route them into their own audio engine, so they cannot be beat-matched or have FX applied.
 */
import { settings } from './engine.js';

const isNative = () => !!window.DJNative;
export function proxied(url) { return isNative() ? '/__proxy?url=' + encodeURIComponent(url) : url; }

function art(url, size = 120) { return url ? url.replace('{w}', size).replace('{h}', size).replace(/\d+x\d+bb/, `${size}x${size}bb`) : ''; }

function jsonp(url) {
  return new Promise((res, rej) => {
    const cb = '__itcb' + Math.random().toString(36).slice(2);
    const s = document.createElement('script');
    window[cb] = (d) => { res(d); delete window[cb]; s.remove(); };
    s.onerror = () => { rej(new Error('network')); delete window[cb]; s.remove(); };
    s.src = url + '&callback=' + cb;
    document.head.appendChild(s);
  });
}

export async function searchCatalogPreviews(term) {
  const url = `https://itunes.apple.com/search?media=music&entity=song&limit=50&country=${encodeURIComponent(settings.storefront || 'us')}&term=${encodeURIComponent(term)}`;
  let data;
  if (isNative()) { const r = await fetch(proxied(url)); data = await r.json(); }
  else data = await jsonp(url);
  return (data.results || []).filter(r => r.previewUrl).map(r => ({
    id: 'am-' + r.trackId, source: 'apple', title: r.trackName, artist: r.artistName, album: r.collectionName,
    artwork: art(r.artworkUrl100), previewUrl: r.previewUrl, fullDuration: (r.trackTimeMillis || 0) / 1000, preview: true,
  }));
}

/* ---------------- MusicKit ---------------- */
let mk = null;
function loadScript(src) {
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.async = true; s.onload = res; s.onerror = () => rej(new Error('Could not load MusicKit (offline?)')); document.head.appendChild(s); });
}

export function isConnected() { return !!(mk && mk.isAuthorized); }

export async function connect() {
  const token = (settings.appleToken || '').trim();
  if (!token) throw new Error('Add your Apple Music developer token in Settings first.');
  if (!window.MusicKit) {
    await loadScript('https://js-cdn.music.apple.com/musickit/v3/musickit.js');
    if (!window.MusicKit) await new Promise(r => document.addEventListener('musickitloaded', r, { once: true }));
  }
  mk = await window.MusicKit.configure({ developerToken: token, app: { name: 'DJ Free', build: '1.0.0' } });
  await mk.authorize();
  if (mk.storefrontId) settings.storefront = mk.storefrontId;
  return mk.isAuthorized;
}
export async function disconnect() { if (mk) { try { await mk.unauthorize(); } catch (e) { /* ignore */ } } }

function mapSong(s) {
  const cat = s.relationships && s.relationships.catalog && s.relationships.catalog.data && s.relationships.catalog.data[0];
  const a = (cat && cat.attributes) || s.attributes || {};
  const prev = (a.previews && a.previews[0] && a.previews[0].url) || '';
  return { id: 'am-' + (cat ? cat.id : s.id), source: 'apple', title: a.name, artist: a.artistName, album: a.albumName,
    artwork: a.artwork ? art(a.artwork.url) : '', previewUrl: prev, fullDuration: (a.durationInMillis || 0) / 1000, preview: true };
}

async function api(path, params) {
  const r = await mk.api.music(path, params);
  return r.data;
}

export async function librarySongs(offset = 0) {
  const d = await api('/v1/me/library/songs', { limit: 100, offset, include: 'catalog' });
  return { tracks: (d.data || []).map(mapSong).filter(t => t.previewUrl), next: d.next ? offset + 100 : null };
}

export async function playlists() {
  const d = await api('/v1/me/library/playlists', { limit: 100 });
  return (d.data || []).map(p => ({ id: p.id, name: p.attributes.name, artwork: p.attributes.artwork ? art(p.attributes.artwork.url) : '' }));
}

export async function playlistTracks(id) {
  const out = []; let offset = 0;
  for (let i = 0; i < 10; i++) {
    const d = await api(`/v1/me/library/playlists/${id}/tracks`, { limit: 100, offset, include: 'catalog' });
    out.push(...(d.data || []).map(mapSong).filter(t => t.previewUrl));
    if (!d.next) break; offset += 100;
  }
  return out;
}

export async function catalogSearch(term) {
  const sf = mk.storefrontId || settings.storefront || 'us';
  const d = await api(`/v1/catalog/${sf}/search`, { term, types: 'songs', limit: 25 });
  return ((d.results && d.results.songs && d.results.songs.data) || []).map(mapSong).filter(t => t.previewUrl);
}
