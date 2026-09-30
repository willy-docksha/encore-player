// Looks up a YouTube video or Google Drive file title for the playlist.
const UA = { 'User-Agent': 'Mozilla/5.0' };

async function lookup(type, id) {
  if (type === 'yt') {
    const r = await fetch('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + id));
    return r.ok ? (await r.json()).title : null;
  }
  const r = await fetch(`https://drive.google.com/file/d/${id}/view`, { headers: UA });
  const m = (await r.text()).match(/<title>([\s\S]*?)<\/title>/);
  if (!m) return null;
  let t = m[1].replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/ - Google Drive$/, '').trim();
  if (!t || t.startsWith('Google Drive')) return null;
  return t.includes('.') ? t.slice(0, t.lastIndexOf('.')) : t;
}

export async function GET(request) {
  const q = new URL(request.url).searchParams;
  const type = q.get('type'), id = q.get('id') || '';
  if (!['yt', 'drive'].includes(type) || !/^[\w-]{6,}$/.test(id)) return new Response('Bad request', { status: 400 });
  let title = null;
  try { title = await lookup(type, id); } catch {}
  return Response.json({ title }, { headers: { 'Cache-Control': 'public, s-maxage=86400' } });
}
