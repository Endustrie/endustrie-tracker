// Listen-link handling: recognize YouTube and Dropbox URLs and derive
// embeddable / streamable forms. Everything else opens in a new tab.
export function parseLink(url) {
  let u;
  try { u = new URL(url); } catch (e) { return {type: 'invalid'}; }
  if (!/^https?:$/.test(u.protocol)) return {type: 'invalid'};

  if (/(^|\.)youtube\.com$/i.test(u.hostname) || u.hostname === 'youtu.be') {
    let id = null;
    if (u.hostname === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
    else if (u.searchParams.get('v')) id = u.searchParams.get('v');
    else {
      const m = /^\/(shorts|embed|live)\/([\w-]{6,})/.exec(u.pathname);
      if (m) id = m[2];
    }
    if (id && /^[\w-]{6,}$/.test(id)) {
      return {type: 'youtube', id, embed: `https://www.youtube-nocookie.com/embed/${id}?autoplay=1`};
    }
    return {type: 'link'};
  }

  if (/(^|\.)dropbox\.com$/i.test(u.hostname) || u.hostname === 'dl.dropboxusercontent.com') {
    const raw = new URL(url);
    raw.hostname = 'dl.dropboxusercontent.com';
    raw.searchParams.delete('dl');
    raw.searchParams.set('raw', '1');
    const audio = /\.(mp3|wav|m4a|aif|aiff|flac|ogg)$/i.test(u.pathname);
    return {type: 'dropbox', stream: raw.toString(), audio};
  }

  return {type: 'link'};
}

export function linkBadge(url) {
  const t = parseLink(url).type;
  return t === 'youtube' ? 'YT' : t === 'dropbox' ? 'DBX' : 'LINK';
}
