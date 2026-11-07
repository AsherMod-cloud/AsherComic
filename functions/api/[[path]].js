// Cloudflare Pages Function — proxy ke Shinigami API
const API_URL = 'https://api.shngm.io/v1';
const ASSETS_URL = 'https://assets.shngm.id';
const BASE_URL = 'https://11.shinigami.asia';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

async function sh(endpoint) {
  const url = endpoint.startsWith('http') ? endpoint : `${API_URL}${endpoint}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': USER_AGENT,
        'Referer': `${BASE_URL}/`,
        'Origin': BASE_URL,
        'Accept': 'application/json, text/plain, */*'
      }
    });
    clearTimeout(t);
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Shinigami HTTP ${res.status}: ${txt.slice(0, 100) || res.statusText}`);
    }
    return res.json();
  } catch (err) {
    clearTimeout(t);
    throw err;
  }
}

function formatStatus(n) {
  return ({ 1: 'Ongoing', 2: 'Completed', 3: 'Hiatus' })[n] || 'Unknown';
}

function determineType(tax, countryId) {
  if (Array.isArray(tax.Format) && tax.Format[0]?.name) {
    const f = String(tax.Format[0].name).toLowerCase();
    if (f.includes('manhwa')) return 'Manhwa';
    if (f.includes('manhua')) return 'Manhua';
    if (f.includes('manga')) return 'Manga';
  }
  if (countryId === 'KR') return 'Manhwa';
  if (countryId === 'CN') return 'Manhua';
  if (countryId === 'JP') return 'Manga';
  return 'Manhwa';
}

function normalizeManga(item) {
  const tax = item.taxonomy || {};
  const genres = Array.isArray(tax.Genre) ? tax.Genre.map(g => g.name) : [];
  const authors = Array.isArray(tax.Author) ? tax.Author.map(a => a.name) : [];
  return {
    id: item.manga_id,
    slug: item.manga_id,       // pakai UUID sebagai slug
    title: item.title,
    alternativeName: item.alternative_title || null,
    author: authors.join(', ') || null,
    type: determineType(tax, item.country_id),
    country: item.country_id || null,
    status: formatStatus(item.status),
    rating: item.user_rate ?? null,
    views: item.view_count || 0,
    cover: item.cover_image_url || item.cover_portrait_url || null,
    synopsis: item.description || '',
    genres,
    releaseYear: item.release_year || null,
    latestChapter: item.latest_chapter_number ?? null,
    latestChapterId: item.latest_chapter_id || null
  };
}

async function resolveMangaId(target) {
  const s = String(target).trim();
  const m = s.match(UUID_RE);
  if (m) return m[0];
  const clean = s.replace(/[-_]/g, ' ').replace(/\/+$/, '').trim();
  const j = await sh(`/manga/list?q=${encodeURIComponent(clean)}&page=1&page_size=5`);
  if (!j.data || !j.data.length) throw new Error(`Komik "${target}" tidak ditemukan di Shinigami`);
  return j.data[0].manga_id;
}

async function getAllChapters(mangaId) {
  const first = await sh(`/chapter/${mangaId}/list?page=1&page_size=200&sort_by=chapter_number&sort_order=desc`);
  const list = [...(first.data || [])];
  const total = Math.min(first.meta?.total_page || 1, 10);
  if (total > 1) {
    const pages = await Promise.all(
      Array.from({ length: total - 1 }, (_, i) =>
        sh(`/chapter/${mangaId}/list?page=${i + 2}&page_size=200&sort_by=chapter_number&sort_order=desc`)
          .catch(() => ({ data: [] }))
      )
    );
    for (const p of pages) if (Array.isArray(p.data)) list.push(...p.data);
  }
  return list;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Content-Type': 'application/json',
  'Cache-Control': 'public, max-age=120'
};
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: CORS });

export async function onRequest({ request, params }) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

  const url = new URL(request.url);
  const seg = params.path || [];
  const path = '/' + seg.join('/');

  try {
    // /api/latest?limit=30
    if (path === '/latest') {
      const limit = url.searchParams.get('limit') || '30';
      const [latest, popular] = await Promise.all([
        sh(`/manga/list?page=1&page_size=${limit}&sort_by=latest&sort_order=desc`),
        sh(`/manga/list?page=1&page_size=10&sort_by=view_count&sort_order=desc`).catch(() => ({ data: [] }))
      ]);
      return json({
        page: 1,
        totalPages: 1,
        results: (latest.data || []).map(normalizeManga),
        popular: (popular.data || []).map(normalizeManga)
      });
    }

    // /api/search?q=...
    if (path === '/search') {
      const q = (url.searchParams.get('q') || '').trim();
      if (!q) return json({ results: [] });
      const j = await sh(`/manga/list?q=${encodeURIComponent(q)}&page=1&page_size=20`);
      return json({ results: (j.data || []).map(normalizeManga) });
    }

    // /api/manga/slug/<uuid|title>
    if (seg[0] === 'manga' && seg[1] === 'slug' && seg.length >= 3) {
      const id = await resolveMangaId(decodeURIComponent(seg.slice(2).join('/')));
      const j = await sh(`/manga/detail/${id}`);
      if (!j.data) return json({ error: 'Manga tidak ditemukan' }, 404);
      return json({ manga: normalizeManga(j.data) });
    }

    // /api/manga/<id>/chapters
    if (seg[0] === 'manga' && seg[2] === 'chapters') {
      const id = await resolveMangaId(seg[1]);
      const list = await getAllChapters(id);
      return json({
        mangaId: id,
        chapters: list.map(ch => ({
          id: ch.chapter_id,
          slug: ch.chapter_id,
          chapterNumber: ch.chapter_number,
          title: ch.chapter_title || '',
          imageCount: null,
          views: ch.view_count || 0,
          createdAt: ch.release_date || null
        }))
      });
    }

    // /api/chapters/slug/<chapter_id>
    if (seg[0] === 'chapters' && seg[1] === 'slug' && seg.length >= 3) {
      const chapterId = decodeURIComponent(seg.slice(2).join('/'));
      const j = await sh(`/chapter/detail/${chapterId}`);
      if (!j.data) return json({ error: 'Chapter tidak ditemukan' }, 404);
      const d = j.data;
      const base = d.base_url || ASSETS_URL;
      const chPath = (d.chapter?.path || '').replace(/^\/+|\/+$/g, '');
      const files = Array.isArray(d.chapter?.data) ? d.chapter.data : [];
      return json({
        chapterSlug: chapterId,
        chapterNumber: d.chapter_number,
        chapterTitle: d.chapter_title || '',
        mangaId: d.manga_id,
        prevChapterId: d.prev_chapter_id || null,
        prevChapterNumber: d.prev_chapter_number ?? null,
        nextChapterId: d.next_chapter_id || null,
        nextChapterNumber: d.next_chapter_number ?? null,
        totalImages: files.length,
        images: files.map((f, i) => ({ page: i + 1, url: `${base}/${chPath}/${f}` }))
      });
    }

    return json({ error: 'Route not found', path }, 404);
  } catch (err) {
    return json({ error: err.message || 'Internal error' }, 500);
  }
}