// Cloudflare Pages Function — proxy ke KomikNesia API + AES-256-CBC decrypt
const API_BASE = 'https://api-be.komiknesia.my.id/api';
const BASE_URL = 'https://komiknesia.id';

function genDeviceId() {
  const rand = Math.random().toString(36).slice(2, 10);
  const time = Date.now().toString(36).slice(-6);
  return `dv_${rand}${time}`;
}

async function decryptData(encryptedBase64, time) {
  let r = Number(time);
  for (let i = 0; i < 5; i++) r = r / 2;
  let keyStr = r.toFixed(8);
  if (keyStr.length < 32) keyStr = keyStr.padEnd(32, '0');
  else if (keyStr.length > 32) keyStr = keyStr.substring(0, 32);

  const raw = Uint8Array.from(atob(encryptedBase64), c => c.charCodeAt(0));
  const iv = raw.slice(0, 16);
  const ciphertext = raw.slice(16);

  const keyData = new TextEncoder().encode(keyStr);
  const key = await crypto.subtle.importKey('raw', keyData, { name: 'AES-CBC' }, false, ['decrypt']);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, ciphertext);
  return JSON.parse(new TextDecoder().decode(decrypted));
}

async function fetchApi(path, queryStr = '') {
  const url = `${API_BASE}${path}${queryStr ? '?' + queryStr : ''}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'X-Device-Id': genDeviceId(),
      'Referer': `${BASE_URL}/`
    }
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API HTTP ${res.status}: ${text.slice(0, 120)}`);
  }
  const json = await res.json();
  if (json.encrypted && json.data && json.time) {
    return decryptData(json.data, json.time);
  }
  return json;
}

function normType(t) {
  if (!t) return 'Manhwa';
  const s = String(t).toLowerCase();
  if (s.includes('manhwa')) return 'Manhwa';
  if (s.includes('manhua')) return 'Manhua';
  if (s.includes('manga')) return 'Manga';
  return t;
}

function normalizeManga(item) {
  return {
    id: item.id,
    title: item.title,
    slug: item.slug,
    type: normType(item.content_type || item.type),
    status: item.status,
    rating: Number(item.rating) || 0,
    views: Number(item.views) || Number(item.total_views) || 0,
    cover: item.thumbnail || item.cover_background || item.cover || '',
    synopsis: item.synopsis || item.sinopsis || '',
    genres: (item.genres || []).map(g => (typeof g === 'string' ? g : (g.name || ''))).filter(Boolean)
  };
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Content-Type': 'application/json',
  'Cache-Control': 'public, max-age=120'
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}

export async function onRequest({ request, params }) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

  const url = new URL(request.url);
  const seg = params.path || [];
  const path = '/' + seg.join('/');

  try {
    // /api/latest?limit=30&page=1
    if (path === '/latest') {
      const page = url.searchParams.get('page') || '1';
      const limit = url.searchParams.get('limit') || '30';
      const data = await fetchApi('/manga', `page=${page}&limit=${limit}`);
      const list = data.manga || data.data || [];
      return json({
        page: Number(data.currentPage) || Number(page),
        totalPages: Number(data.totalPages) || 1,
        results: list.map(normalizeManga)
      });
    }

    // /api/search?q=...
    if (path === '/search') {
      const q = (url.searchParams.get('q') || '').trim();
      const page = url.searchParams.get('page') || '1';
      if (!q) return json({ results: [] });
      let items = [];
      try {
        const d = await fetchApi('/manga/search', `query=${encodeURIComponent(q)}&page=${page}`);
        items = d.local || [];
      } catch (_) { /* fallback */ }
      if (!items.length) {
        try {
          const d = await fetchApi('/manga', `page=${page}&limit=20&search=${encodeURIComponent(q)}`);
          items = d.manga || d.data || [];
        } catch (_) {}
      }
      return json({ results: items.map(normalizeManga) });
    }

    // /api/manga/slug/<slug>
    if (seg[0] === 'manga' && seg[1] === 'slug' && seg.length >= 3) {
      const slug = decodeURIComponent(seg.slice(2).join('/'));
      const d = await fetchApi(`/manga/slug/${encodeURIComponent(slug)}`);
      const m = d.manga || d.data || d;
      if (!m || !m.id) return json({ error: `Komik "${slug}" tidak ditemukan` }, 404);
      return json({
        manga: {
          ...normalizeManga(m),
          alternativeName: m.alternative_name,
          author: m.author,
          lastChapter: m.last_chapter
        }
      });
    }

    // /api/manga/<id>/chapters
    if (seg[0] === 'manga' && seg[2] === 'chapters') {
      const id = seg[1];
      const d = await fetchApi(`/manga/${id}/chapters`);
      const list = Array.isArray(d) ? d : (d.chapters || d.data || []);
      return json({
        mangaId: Number(id),
        chapters: list.map(ch => ({
          id: ch.id,
          title: ch.title,
          chapterNumber: ch.chapter_number ?? ch.number,
          slug: ch.slug,
          imageCount: ch.image_count,
          views: ch.views,
          createdAt: ch.created_at
        }))
      });
    }

    // /api/chapters/slug/<slug>
    if (seg[0] === 'chapters' && seg[1] === 'slug' && seg.length >= 3) {
      const slug = decodeURIComponent(seg.slice(2).join('/'));
      const d = await fetchApi(`/chapters/slug/${encodeURIComponent(slug)}`);
      const chData = d.data || d;
      const images = chData.images || [];
      return json({
        chapterSlug: slug,
        chapterNumber: chData.number ?? chData.chapter_number,
        totalImages: images.length,
        images: images.map((u, i) => ({
          page: i + 1,
          url: typeof u === 'string' ? u : (u.url || u.image || '')
        })).filter(x => x.url)
      });
    }

    return json({ error: 'Route not found', path }, 404);
  } catch (err) {
    return json({ error: err.message || 'Internal error' }, 500);
  }
    }
