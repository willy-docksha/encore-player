// Streams a public Google Drive file so the <audio> player can play and seek it.
const PASS = ['content-type', 'content-length', 'content-range', 'accept-ranges'];
const UA = { 'User-Agent': 'Mozilla/5.0' };

export async function GET(request) {
  const id = new URL(request.url).searchParams.get('id') || '';
  if (!/^[\w-]{10,}$/.test(id)) return new Response('Bad id', { status: 400 });

  const range = request.headers.get('range');
  const headers = { ...UA, ...(range ? { Range: range } : {}) };
  let res = await fetch(`https://drive.usercontent.google.com/download?id=${id}&export=download`, { headers });

  // Large files return a virus-scan confirmation page; follow its form.
  if ((res.headers.get('content-type') || '').startsWith('text/html')) {
    const page = await res.text();
    const fields = Object.fromEntries([...page.matchAll(/name="([^"]+)" value="([^"]*)"/g)].map(m => [m[1], m[2]]));
    if (!fields.confirm) return new Response('File tidak publik atau tidak bisa diunduh', { status: 403 });
    res = await fetch('https://drive.usercontent.google.com/download?' + new URLSearchParams(fields), { headers });
  }
  if (!res.ok) return new Response('Drive error', { status: res.status });

  const out = new Headers({ 'Cache-Control': 'private, max-age=3600' });
  PASS.forEach(h => res.headers.get(h) && out.set(h, res.headers.get(h)));
  if (!out.has('accept-ranges')) out.set('accept-ranges', 'bytes');
  return new Response(res.body, { status: res.status, headers: out });
}
