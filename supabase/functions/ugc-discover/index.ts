// UGC creator discovery: searches Instagram through Apify and stores every creator found in
// public.ugc_discover, where the dashboard filters them. Admin-only; the Apify token lives in
// the APIFY_TOKEN function secret and never reaches the browser.
//
// POST { action: 'start', query, kind: 'user' | 'hashtag', limit }  -> { id }
// POST { action: 'poll', id }                                        -> { status, found?, error? }
// Apify runs can take minutes, so the browser polls instead of waiting on one long request.
import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const APIFY = 'https://api.apify.com/v2';
const ACTOR = {
  user: 'apify~instagram-search-scraper',
  hashtag: 'apify~instagram-hashtag-scraper',
  profile: 'apify~instagram-profile-scraper',
};
const DAILY_SEARCHES = 40;
const DAY = 864e5;

const AR_RE = /[\u0600-\u06FF]/;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_RE = /(?:\+?20[\s-]?|0)1[0125][\s-]?\d{3,4}[\s-]?\d{4}/;
const SPONSOR_RE = /#(?:ad|ads|sponsored|partner|partnership|paidpartnership|collab|gifted|pr)(?![\w])|\b(?:sponsored|in collaboration with|collab with|use (?:my )?code|discount code|promo code)\b|إعلان|اعلان|برعاية|بالتعاون مع|كود خصم|كود الخصم|استخدمي كود|استخدم كود/i;

// deno-lint-ignore no-explicit-any
type Any = any;
const num = (v: unknown) => (typeof v === 'number' && isFinite(v) && v >= 0 ? v : null);
const first = (...v: unknown[]) => v.find((x) => x !== undefined && x !== null && x !== '');
const median = (a: number[]) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const round = (v: number | null, d = 2) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
const handle = (s: unknown) => String(s || '').trim().replace(/^@/, '').toLowerCase();

async function apify(path: string, token: string, init?: RequestInit) {
  const sep = path.includes('?') ? '&' : '?';
  const r = await fetch(`${APIFY}${path}${sep}token=${encodeURIComponent(token)}`, init);
  const text = await r.text();
  if (!r.ok) {
    let msg = text.slice(0, 300);
    try { msg = JSON.parse(text)?.error?.message || msg; } catch { /* keep text */ }
    throw new Error(`Apify ${r.status}: ${msg}`);
  }
  return text ? JSON.parse(text) : null;
}
const startRun = async (actor: string, input: unknown, token: string) =>
  (await apify(`/acts/${actor}/runs`, token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })).data;
const getRun = async (id: string, token: string) => (await apify(`/actor-runs/${id}`, token)).data;
const items = async (datasetId: string, token: string): Promise<Any[]> =>
  (await apify(`/datasets/${datasetId}/items?clean=true&format=json`, token)) || [];

// Profile objects differ slightly between Apify actors; read both naming styles.
function normalize(p: Any) {
  const username = handle(first(p.username, p.userName));
  if (!/^[a-z0-9._]{1,30}$/.test(username)) return null;
  const bio = String(first(p.biography, p.bio) ?? '');
  const followers = num(first(p.followersCount, p.followers_count, p.edge_followed_by?.count, p.followers) as number);
  const raw: Any[] = first(p.latestPosts, p.posts, p.recentPosts) as Any[] || [];
  const posts = raw.slice(0, 12).map((x: Any) => {
    const likes = num(first(x.likesCount, x.like_count, x.likes) as number);
    const views = num(first(x.videoViewCount, x.videoPlayCount, x.video_view_count, x.playCount, x.views) as number);
    const type = String(first(x.type, x.media_type) ?? '');
    const video = /video|clip|reel/i.test(type) || x.productType === 'clips' || views != null;
    const short = first(x.shortCode, x.shortcode, x.code);
    return {
      url: first(x.url, short ? `https://www.instagram.com/p/${short}/` : null),
      thumb: first(x.displayUrl, x.thumbnailUrl, x.display_url, x.thumbnail_url),
      video, likes, comments: num(first(x.commentsCount, x.comments_count, x.comments) as number), views,
      ts: first(x.timestamp, x.taken_at_timestamp ? new Date(x.taken_at_timestamp * 1000).toISOString() : null),
      caption: String(first(x.caption, x.text) ?? '').slice(0, 300),
    };
  });
  let num_ = 0, den = 0; const fers: number[] = []; const vs: number[] = [];
  for (const x of posts) {
    if (x.likes != null && x.views) { num_ += x.likes + (x.comments || 0); den += x.views; }
    if (x.likes != null && followers) fers.push((x.likes + (x.comments || 0)) / followers * 100);
    if (x.views) vs.push(x.views);
  }
  const liked = posts.filter((x) => x.likes != null);
  const caps = posts.map((x) => x.caption).filter((c) => c.trim());
  const times = posts.map((x) => Date.parse(String(x.ts))).filter((t) => !isNaN(t));
  return {
    username,
    full_name: (first(p.fullName, p.full_name) as string) ?? null,
    biography: bio || null,
    followers,
    follows: num(first(p.followsCount, p.follows_count) as number),
    posts_count: num(first(p.postsCount, p.mediaCount, p.media_count) as number),
    is_business: (first(p.isBusinessAccount, p.is_business_account) as boolean) ?? null,
    category: (first(p.businessCategoryName, p.category_name, p.category) as string) ?? null,
    verified: (first(p.verified, p.is_verified) as boolean) ?? null,
    private: (first(p.private, p.is_private) as boolean) ?? null,
    external_url: (first(p.externalUrl, p.external_url) as string) ?? null,
    profile_pic_url: (first(p.profilePicUrlHD, p.profilePicUrl, p.profile_pic_url_hd, p.profile_pic_url) as string) ?? null,
    email: ((first(p.businessEmail, p.public_email, p.email) as string) || (bio.match(EMAIL_RE) || [])[0]) ?? null,
    phone: ((first(p.businessPhoneNumber, p.public_phone_number, p.contact_phone_number) as string) || (bio.match(PHONE_RE) || [])[0]) ?? null,
    er: round(den ? num_ / den * 100 : null),
    fer: round(fers.length ? fers.reduce((a, b) => a + b, 0) / fers.length : null, 3),
    median_views: vs.length ? Math.round(median(vs)!) : null,
    avg_likes: round(liked.length ? liked.reduce((a, x) => a + x.likes!, 0) / liked.length : null, 1),
    avg_comments: round(liked.length ? liked.reduce((a, x) => a + (x.comments || 0), 0) / liked.length : null, 1),
    last_post_at: times.length ? new Date(Math.max(...times)).toISOString() : null,
    video_share: round(posts.length ? posts.filter((x) => x.video).length / posts.length : null),
    ar_share: round(caps.length ? caps.filter((c) => AR_RE.test(c)).length / caps.length : null),
    sponsored_posts: posts.filter((x) => SPONSOR_RE.test(x.caption)).length,
    recent_posts: posts,
  };
}
const hasDetails = (p: Any) => num(first(p.followersCount, p.followers_count, p.edge_followed_by?.count) as number) != null;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const url = Deno.env.get('SUPABASE_URL')!;
  const user = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } });
  const { data: isAdmin } = await user.rpc('ci_is_admin');
  if (!isAdmin) return json({ error: 'Only dashboard admins can search Instagram.' }, 403);
  const token = Deno.env.get('APIFY_TOKEN');
  if (!token) return json({ error: 'Creator search is not connected yet: add the APIFY_TOKEN secret in Supabase.', code: 'no_token' }, 412);
  const db = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  let body: Any = {};
  try { body = await req.json(); } catch { /* empty */ }

  if (body.action === 'start') {
    const kind = body.kind === 'hashtag' ? 'hashtag' : 'user';
    let query = String(body.query || '').trim().slice(0, 80);
    if (kind === 'hashtag') query = query.replace(/^#/, '').replace(/\s+/g, '');
    if (query.length < 2) return json({ error: 'Type at least 2 characters to search.' }, 400);
    const limit = Math.max(5, Math.min(100, Math.round(Number(body.limit) || 30)));
    const { count } = await db.from('ugc_searches').select('id', { count: 'exact', head: true }).gte('created_at', new Date(Date.now() - DAY).toISOString());
    if ((count ?? 0) >= DAILY_SEARCHES) return json({ error: `Daily limit of ${DAILY_SEARCHES} searches reached. It resets within 24 hours.` }, 429);
    const { data: me } = await user.auth.getUser();
    try {
      const run = kind === 'user'
        ? await startRun(ACTOR.user, { search: query, searchType: 'user', searchLimit: limit }, token)
        : await startRun(ACTOR.hashtag, { hashtags: [query], resultsLimit: Math.min(limit * 3, 300) }, token);
      const { data, error } = await db.from('ugc_searches').insert({ query, kind, requested: limit, run_id: run.id, user_id: me.user?.id }).select('id').single();
      if (error) throw error;
      return json({ id: data.id });
    } catch (e) {
      await db.from('ugc_searches').insert({ query, kind, requested: limit, status: 'failed', error: String((e as Error).message).slice(0, 500), user_id: me.user?.id, finished_at: new Date().toISOString() });
      return json({ error: (e as Error).message }, 502);
    }
  }

  if (body.action === 'poll') {
    const { data: s } = await db.from('ugc_searches').select('*').eq('id', Number(body.id)).single();
    if (!s) return json({ error: 'Search not found.' }, 404);
    if (s.status !== 'running') return json({ status: s.status, found: s.found, error: s.error });
    const fail = async (msg: string) => {
      await db.from('ugc_searches').update({ status: 'failed', error: msg.slice(0, 500), finished_at: new Date().toISOString() }).eq('id', s.id);
      return json({ status: 'failed', error: msg });
    };
    try {
      const run = await getRun(s.run_id, token);
      if (['READY', 'RUNNING'].includes(run.status)) return json({ status: 'running', stage: s.stage });
      if (run.status !== 'SUCCEEDED') return fail(`Instagram search ${run.status.toLowerCase()}. Try again or use fewer results.`);
      const got = await items(run.defaultDatasetId, token);

      let profiles: Any[] = [];
      if (s.stage === 'search') {
        const names = [...new Set((s.kind === 'user' ? got.map((x) => x.username) : got.map((x) => first(x.ownerUsername, x.owner?.username))).map(handle).filter(Boolean))].slice(0, s.requested);
        profiles = s.kind === 'user' ? got.filter(hasDetails) : [];
        const missing = names.filter((n) => !profiles.some((p) => handle(p.username) === n));
        if (missing.length) {
          // Search results without follower counts or posts: fetch the full profiles next.
          const next = await startRun(ACTOR.profile, { usernames: missing }, token);
          const n0 = profiles.length ? await save(db, profiles, s) : 0;
          await db.from('ugc_searches').update({ stage: 'profiles', run_id: next.id, usernames: names, found: n0 }).eq('id', s.id);
          return json({ status: 'running', stage: 'profiles' });
        }
      } else {
        profiles = got;
      }
      const n = await save(db, profiles, s);
      const { data: prev } = await db.from('ugc_searches').select('found').eq('id', s.id).single();
      const found = (prev?.found || 0) + n;
      await db.from('ugc_searches').update({ status: 'done', found, finished_at: new Date().toISOString() }).eq('id', s.id);
      return json({ status: 'done', found });
    } catch (e) {
      return fail((e as Error).message);
    }
  }
  return json({ error: 'Unknown action.' }, 400);
});

async function save(db: Any, profiles: Any[], s: Any) {
  const rows = profiles.map(normalize).filter((r): r is NonNullable<typeof r> => !!r && !r.private);
  if (!rows.length) return 0;
  const tag = `${s.kind === 'hashtag' ? '#' : ''}${s.query}`;
  const { data: old } = await db.from('ugc_discover').select('username,found_by').in('username', rows.map((r) => r.username));
  const prev = new Map((old || []).map((o: Any) => [o.username, o.found_by || []]));
  const out = rows.map((r) => ({ ...r, found_by: [...new Set([...(prev.get(r.username) || []), tag])].slice(-20), updated_at: new Date().toISOString() }));
  const { error } = await db.from('ugc_discover').upsert(out, { onConflict: 'username' });
  if (error) throw error;
  return out.length;
}
