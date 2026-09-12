import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, vi, afterEach } from 'vitest';
import worker, { type Env, verifySignature, cleanArticles, buildNews, sendLine, broadcastDailyNews, explicitCount, preferences, deliverReplies, planRequest, closeBrackets } from '../src/index';

const makeEnv = (): Env => ({ AI: { run: vi.fn() }, LINE_CHANNEL_SECRET: 'test-secret', LINE_CHANNEL_ACCESS_TOKEN: 'test-token', TAVILY_API_KEY: 'test-tavily' });
async function signed(raw: string, secret = 'test-secret') {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw)));
  return btoa(String.fromCharCode(...bytes));
}
const article = { title: 'キングダム ハーツの新情報', url: 'https://example.com/news/article-1', content: '新しいゲーム情報が発表された。詳細は後日公開予定。' };
afterEach(() => vi.restoreAllMocks());
describe('game news worker', () => {
  it('health GET and HEAD never call external services or broadcast', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    for (const method of ['GET', 'HEAD']) {
      const ctx = createExecutionContext();
      expect((await worker.fetch(new Request('https://example.com/', { method }), makeEnv(), ctx)).status).toBe(200);
      await waitOnExecutionContext(ctx);
    }
    expect(spy).not.toHaveBeenCalled();
  });
  it('verifies exact raw body and rejects modified body, wrong secret and malformed signature', async () => {
    const raw = '{"events":[]}';
    const signature = await signed(raw);
    expect(await verifySignature(raw, signature, 'test-secret')).toBe(true);
    expect(await verifySignature(raw + ' ', signature, 'test-secret')).toBe(false);
    expect(await verifySignature(raw, signature, 'wrong')).toBe(false);
    expect(await verifySignature(raw, 'bad', 'test-secret')).toBe(false);
  });
  it('rejects unsigned requests without AI or network calls', async () => {
    const env = makeEnv();
    const spy = vi.spyOn(globalThis, 'fetch');
    expect((await worker.fetch(new Request('https://example.com/', { method: 'POST', body: '{"events":[]}' }), env, createExecutionContext())).status).toBe(401);
    expect(env.AI.run).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
  });
  it('fails closed if channel secret is absent', async () => {
    expect((await worker.fetch(new Request('https://example.com/', { method: 'POST' }), { ...makeEnv(), LINE_CHANNEL_SECRET: '' }, createExecutionContext())).status).toBe(503);
  });
  it('accepts LINE verification events and rejects signed malformed JSON', async () => {
    for (const [body, status] of [['{"events":[]}', 200], ['{', 400]] as const) {
      expect((await worker.fetch(new Request('https://example.com/', { method: 'POST', headers: { 'x-line-signature': await signed(body) }, body }), makeEnv(), createExecutionContext())).status).toBe(status);
    }
  });
  it('deduplicates tracking URLs and excludes unsafe or empty results', () => {
    expect(cleanArticles([article, { ...article, url: article.url + '?utm_source=test#top' }, { ...article, url: 'javascript:alert(1)' }, { ...article, content: '' }])).toEqual([article]);
  });
  it('treats a portal reprint of the same headline under a different URL as one article', () => {
    const reprint = { ...article, url: 'https://news.example.co.jp/articles/abc123' };
    expect(cleanArticles([article, reprint])).toEqual([article]);
    const distinct = { ...article, title: '全く別の見出しのニュース記事', url: 'https://example.com/other' };
    expect(cleanArticles([article, distinct])).toEqual([article, distinct]);
  });
  it('closeBrackets trims a trailing unmatched bracket without touching balanced ones', () => {
    expect(closeBrackets('速報「新情報が決定」（ABEMA TI')).toBe('速報「新情報が決定」');
    expect(closeBrackets('普通の見出し')).toBe('普通の見出し');
    expect(closeBrackets('謎の閉じ』カッコ')).toBe('謎の閉じカッコ');
  });
  it('does not chop a fallback sentence at a quoted title ending in "！" or "？"', async () => {
    const env = makeEnv();
    const content = '東山奈央さんが、アニメ「名探偵プリキュア！」でキュアアルカナ・シャドウ役を演じる森亜るるかの声を担当していることが分かった。放送は9月13日を予定している。';
    vi.mocked(env.AI.run).mockResolvedValueOnce({ response: JSON.stringify({ topic: '声優' }) }).mockResolvedValueOnce({ response: '[0]' }).mockRejectedValueOnce(new Error('AI unavailable'));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ results: [{ title: '東山奈央「森亜るるかの理解者として」', url: 'https://example.com/interview', content }] }));
    const texts = await buildNews('声優の記事を1件', false, env);
    expect(texts[0]).toContain('森亜るるかの声を担当していることが分かった');
  });
  it('expands search, filters irrelevant articles and formats a bounded reply', async () => {
    const env = makeEnv();
    vi.mocked(env.AI.run).mockResolvedValueOnce({ response: JSON.stringify({ topic: 'ディズニー', expanded: 'キングダム ハーツ ニュース', timeRange: 'week' }) }).mockResolvedValueOnce({ response: '[0]' }).mockResolvedValueOnce({ response: JSON.stringify({ headline: 'キングダム ハーツ、新情報を発表', highlights: ['詳細は後日公開予定'] }) });
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ results: [article] }));
    const result = await buildNews('ディズニーのゲーム', false, env);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(spy.mock.calls[0][1]?.body))).toMatchObject({ time_range: 'week', search_depth: 'basic' });
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('キングダム ハーツの新情報');
    expect(result[0]).toContain('記事を読む ↗\nhttps://example.com/news/article-1');
    expect(result[0].match(/https:\/\//g)).toHaveLength(1);
    expect(result[0].length).toBeLessThanOrEqual(4900);
  });
  it('does not substitute irrelevant news for an unknown game', async () => {
    const env = makeEnv();
    vi.mocked(env.AI.run).mockResolvedValueOnce({ response: '' }).mockResolvedValueOnce({ response: '[]' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ results: [article] }));
    expect((await buildNews('存在しないゲームXYZ123', false, env))[0]).toContain('関連する記事が見つかりません');
  });
  it('uses a source excerpt if summary AI fails', async () => {
    const env = makeEnv();
    vi.mocked(env.AI.run).mockResolvedValueOnce({ response: '[0]' }).mockRejectedValueOnce(new Error('AI unavailable'));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ results: [article] }));
    expect((await buildNews('ゲームニュース', true, env))[0]).toContain('新しいゲーム情報が発表された');
  });
  it('reports LINE HTTP errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 401 }));
    await expect(sendLine('reply', {}, makeEnv())).rejects.toThrow('LINE reply HTTP 401');
  });
  it('daily news uses day search and includes summaries in broadcast', async () => {
    const env = makeEnv();
    vi.mocked(env.AI.run).mockResolvedValueOnce({ response: '[0]' }).mockResolvedValueOnce({ response: JSON.stringify({ headline: '新情報を発表', highlights: ['詳細は後日公開予定'] }) });
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ results: [article] })).mockResolvedValueOnce(new Response('{}'));
    await broadcastDailyNews(env);
    expect(JSON.parse(String(spy.mock.calls[0][1]?.body)).time_range).toBe('day');
    expect(String(spy.mock.calls[1][0])).toContain('/broadcast');
    expect(JSON.parse(String(spy.mock.calls[1][1]?.body)).messages[0].text).toContain('新しいゲーム情報が発表された');
  });
  it('does not broadcast on upstream failure', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 429 }));
    await expect(broadcastDailyNews(makeEnv())).rejects.toThrow('All searches failed');
    expect(spy).toHaveBeenCalledTimes(1);
  });
  it('signed text event replies exactly once; LINE failure never reuses token', async () => {
    const env = makeEnv();
    vi.mocked(env.AI.run).mockResolvedValue({ response: '' });
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => String(url).includes('tavily') ? Response.json({ results: [] }) : new Response('{}', { status: 400 }));
    const body = JSON.stringify({ events: [{ type: 'message', message: { type: 'text', text: 'テスト' }, replyToken: 'reply-token' }] });
    const ctx = createExecutionContext();
    expect((await worker.fetch(new Request('https://example.com/', { method: 'POST', headers: { 'x-line-signature': await signed(body) }, body }), env, ctx)).status).toBe(200);
    await expect(waitOnExecutionContext(ctx)).rejects.toThrow();
    expect(spy.mock.calls.filter(c => String(c[0]).includes('/message/reply'))).toHaveLength(1);
  });
  it('parses specified counts including full-width and Japanese numbers', () => {
    expect(explicitCount('ディズニーの記事を5件')).toBe(5);
    expect(explicitCount('５件を短く')).toBe(5);
    expect(explicitCount('五件')).toBe(5);
    expect(explicitCount('十二本')).toBe(12);
    expect(explicitCount('Switch 2のニュース')).toBeUndefined();
  });
  it('explicit count overrides mistaken model count and formatting is preserved', async () => {
    const env = makeEnv();
    vi.mocked(env.AI.run).mockResolvedValue({ response: JSON.stringify({ topic: 'ディズニー', count: 3, combined: true, style: '短く', timeRange: 'month' }) });
    const query = 'ディズニーの記事を5件、1つのメッセージにまとめて短く';
    expect(await preferences(query, env)).toMatchObject({ count: 5, combined: true, style: query, timeRange: 'month' });
  });
  it('ignores a model-invented display style not present in the original request', async () => {
    const env = makeEnv();
    // The model must never be allowed to introduce "見出しだけ" (headline only) on its own.
    vi.mocked(env.AI.run).mockResolvedValue({ response: JSON.stringify({ topic: 'ゲーム', style: '見出しだけ', kind: 'news' }) });
    const prefs = await preferences('ゲームのニュースを3件教えて', env);
    expect(prefs.style).not.toContain('見出しだけ');
    expect(prefs.style).toBe('ゲームのニュースを3件教えて');
  });
  it('collapses a model over-split of a single theme back into one group (regression: 3件 must not become 9 messages)', async () => {
    const env = makeEnv();
    // Simulates the observed bug: a single-theme request gets split by the model into 3 groups.
    vi.mocked(env.AI.run).mockResolvedValue({ response: JSON.stringify({ combined: false, groups: [
      { topic: '名探偵プリキュア 映画情報', count: 3, explicitCount: true, kind: 'news', timeRange: 'week' },
      { topic: '名探偵プリキュア 声優情報', count: 3, explicitCount: true, kind: 'news', timeRange: 'week' },
      { topic: '名探偵プリキュア 放送情報', count: 3, explicitCount: true, kind: 'news', timeRange: 'week' },
    ] }) });
    const plan = await planRequest('名探偵プリキュアに関するニュースを3件', env);
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0].count).toBe(3);
    expect(plan.groups[0].topic).toBe('名探偵プリキュアに関するニュースを3件');
  });
  it('sends exactly 3 messages (not 9) for a single-theme 3-article request even when the model over-splits', async () => {
    const env = makeEnv();
    vi.mocked(env.AI.run).mockResolvedValueOnce({ response: JSON.stringify({ combined: false, groups: [
      { topic: 'A', count: 3, explicitCount: true, kind: 'news', timeRange: 'week' },
      { topic: 'B', count: 3, explicitCount: true, kind: 'news', timeRange: 'week' },
      { topic: 'C', count: 3, explicitCount: true, kind: 'news', timeRange: 'week' },
    ] }) })
      .mockResolvedValueOnce({ response: '[0,1,2]' })
      .mockResolvedValue({ response: JSON.stringify({ headline: '新情報を発表', highlights: ['詳細は後日公開予定'] }) });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ results: Array.from({ length: 3 }, (_, i) => ({ ...article, title: `${article.title} その${i}`, url: `https://example.com/${i}` })) }));
    const texts = await buildNews('名探偵プリキュアに関するニュースを3件', false, env);
    expect(texts).toHaveLength(3);
    texts.forEach(t => expect(t.match(/https:\/\//g)).toHaveLength(1));
  });
  it('skips redelivered webhook events without sending or calling any external service', async () => {
    const env = makeEnv();
    const spy = vi.spyOn(globalThis, 'fetch');
    const body = JSON.stringify({ events: [{ type: 'message', message: { type: 'text', text: 'テスト' }, replyToken: 'reply-token', deliveryContext: { isRedelivery: true } }] });
    const ctx = createExecutionContext();
    expect((await worker.fetch(new Request('https://example.com/', { method: 'POST', headers: { 'x-line-signature': await signed(body) }, body }), env, ctx)).status).toBe(200);
    await waitOnExecutionContext(ctx);
    expect(env.AI.run).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
  });
  it('returns five articles as five messages, each with one source link', async () => {
    const env = makeEnv();
    vi.mocked(env.AI.run).mockResolvedValueOnce({ response: JSON.stringify({ topic: 'ゲーム' }) }).mockResolvedValueOnce({ response: '[0,1,2,3,4]' }).mockResolvedValue({ response: JSON.stringify({ headline: '新作ゲームを発表', highlights: ['新しい遊び方が登場'] }) });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ results: Array.from({ length: 5 }, (_, i) => ({ ...article, title: `${article.title} その${i}`, url: `https://example.com/${i}` })) }));
    const texts = await buildNews('ゲームの記事を5件', false, env);
    expect(texts).toHaveLength(5);
    texts.forEach(text => expect(text.match(/https:\/\//g)).toHaveLength(1));
    texts.forEach(text => expect(text.split('\n')[0]).not.toMatch(/\d+\s*\/\s*\d+/));
  });
  it('fills in a second highlight from the article body when the model returns only a thin one', async () => {
    const env = makeEnv();
    const richArticle = { title: '声優インタビュー特集記事', url: 'https://example.com/interview', content: '東山奈央さんが新作アニメについて語った。撮影は来月から開始される予定です。' };
    vi.mocked(env.AI.run).mockResolvedValueOnce({ response: JSON.stringify({ topic: '声優' }) }).mockResolvedValueOnce({ response: '[0]' }).mockResolvedValueOnce({ response: JSON.stringify({ headline: '声優インタビュー特集記事', highlights: ['東山奈央さんが新作アニメについて語った。'] }) });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ results: [richArticle] }));
    const texts = await buildNews('声優の記事を1件', false, env);
    expect(texts[0]).toContain('東山奈央さんが新作アニメについて語った');
    expect(texts[0]).toContain('撮影は来月から開始される予定です');
  });
  it('drops a search result that is the same headline as an already-selected article from another outlet', async () => {
    const env = makeEnv();
    const reprint = { ...article, title: article.title, url: 'https://news.example.co.jp/articles/xyz789' };
    const distinct = { ...article, title: '名探偵プリキュア 声優コメント特集', url: 'https://example.com/interview' };
    vi.mocked(env.AI.run).mockResolvedValueOnce({ response: JSON.stringify({ topic: '名探偵プリキュア' }) }).mockResolvedValueOnce({ response: '[0,1]' }).mockResolvedValue({ response: JSON.stringify({ headline: '新情報を発表', highlights: ['詳細は後日公開予定'] }) });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ results: [article, reprint, distinct] }));
    const texts = await buildNews('名探偵プリキュアの記事を2件', false, env);
    // Only 2 distinct articles existed after de-duplication, so selectRelevant only ever saw 2 candidates.
    expect(texts).toHaveLength(2);
    expect(new Set(texts.map(t => t.match(/https:\/\/\S+/)?.[0])).size).toBe(2);
  });
  it('combines only when requested and explains article shortages', async () => {
    const env = makeEnv();
    vi.mocked(env.AI.run).mockResolvedValueOnce({ response: JSON.stringify({ topic: 'ゲーム', combined: true }) }).mockResolvedValueOnce({ response: '[0,1]' }).mockResolvedValue({ response: JSON.stringify({ headline: '新作発表', highlights: [] }) });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ results: [article, { ...article, title: 'キングダム ハーツの続報', url: 'https://example.com/second' }] }));
    const texts = await buildNews('記事を5件、1つのメッセージにまとめて、見出しだけ', false, env);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('確認できた関連記事は2件');
    expect(texts[0].match(/https:\/\//g)).toHaveLength(2);
  });
  it('delivers more than five messages in API-compliant batches to the originating chat', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}'));
    await deliverReplies(Array.from({ length: 12 }, (_, i) => `article ${i}`), 'reply-token', makeEnv(), 'test-user');
    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy.mock.calls.map(c => JSON.parse(String(c[1]?.body)).messages.length)).toEqual([5, 5, 2]);
    expect(JSON.parse(String(spy.mock.calls[1][1]?.body)).to).toBe('test-user');
    expect(JSON.parse(String(spy.mock.calls[1][1]?.body)).replyToken).toBeUndefined();
  });
  it('keeps anime and game requests separate with per-topic counts and timeless recommendations', async () => {
    const env = makeEnv();
    vi.mocked(env.AI.run).mockResolvedValue({ response: JSON.stringify({ combined: false, groups: [
      { topic: '葬送のフリーレンみたいなアニメ', count: 2, explicitCount: true, timeRange: null, kind: 'recommendation' },
      { topic: 'ゼルダみたいなゲーム', count: 3, explicitCount: true, timeRange: null, kind: 'recommendation' },
    ] }) });
    const plan = await planRequest('フリーレンみたいなアニメの記事2件とゼルダみたいなゲームの記事3件', env);
    expect(plan.groups.map(g => g.count)).toEqual([2, 3]);
    expect(plan.groups.map(g => g.timeRange)).toEqual([null, null]);
    expect(plan.groups[0].topic).toContain('アニメ');
    expect(plan.groups[1].topic).toContain('ゲーム');
  });
  it('processes multiple domains without appending game keywords to anime searches', async () => {
    const env = makeEnv();
    vi.mocked(env.AI.run).mockImplementation(async (_model, input) => {
      if (input.messages[0].content.includes('依頼を分解')) return { response: JSON.stringify({ groups: [{ topic: 'アニメの新作', timeRange: 'week' }, { topic: 'ゲームの新作', timeRange: 'week' }] }) };
      if (input.messages[0].content.includes('整数配列')) return { response: '[0]' };
      return { response: JSON.stringify({ headline: '新作の情報', highlights: ['新情報を公開'] }) };
    });
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ results: [article] }));
    const texts = await buildNews('アニメとゲームの情報', false, env);
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain('📺 アニメ');
    expect(texts[1]).toContain('🎮 ゲーム');
    expect(JSON.parse(String(spy.mock.calls[0][1]?.body)).query).toBe('アニメ');
  });
  it('does not output a release claim invented by the summary model', async () => {
    const env = makeEnv();
    vi.mocked(env.AI.run).mockResolvedValueOnce({ response: { topic: 'ゲーム' } }).mockResolvedValueOnce({ response: { ids: [0] } }).mockResolvedValueOnce({ response: { headline: '本日リリース', highlights: ['無料で配信開始しました'] } });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ results: [article] }));
    const texts = await buildNews('ゲームの記事を1件', false, env);
    expect(texts[0]).not.toContain('無料で配信開始');
    expect(texts[0]).not.toContain('本日リリース');
    expect(texts[0]).toContain('新しいゲーム情報が発表された');
  });
  it('excludes news homepages and archive pages before selection', async () => {
    const env = makeEnv();
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ results: [{ ...article, url: 'https://example.com/' }, { ...article, url: 'https://example.com/archives/tag/games' }, { ...article, title: 'ゲームニュース アーカイブ', url: 'https://automaton-media.com/articles/newsjp' }] }));
    const texts = await buildNews('ゲームニュース', true, env);
    expect(texts[0]).toContain('関連する記事が見つかりません');
    expect(env.AI.run).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

