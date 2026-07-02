import puppeteer from 'puppeteer';
import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';

const jobId = process.env.JOB_ID;
const targetUrl = process.env.TARGET_URL;
const callbackBaseUrl = process.env.CALLBACK_URL;
const aiProvider = (process.env.AI_PROVIDER || 'openai').toLowerCase();
const openaiKey = process.env.OPENAI_API_KEY;
const geminiKey = process.env.GEMINI_API_KEY;
const callbackSecret = process.env.CALLBACK_SECRET || '';

async function postCallback(data) {
  const url = `${callbackBaseUrl}/${encodeURIComponent(jobId)}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Callback-Secret': callbackSecret,
      },
      body: JSON.stringify(data),
    });
    if (!res.ok) console.error('Callback error:', res.status, await res.text());
  } catch (e) {
    console.error('Callback fetch error:', e.message);
  }
}

async function progress(step, message, percent) {
  console.log(`[${percent}%] [${step}] ${message}`);
  await postCallback({ status: 'progress', step, message, percent });
}

function basicAnalysis(url, pageInfo) {
  return {
    url,
    title: pageInfo.title || null,
    loadTime: pageInfo.loadTime || null,
    scores: { overall: 50, performance: 50, design: 50, security: 50, seo: 50 },
    summary: 'Basic analysis (no AI key configured)',
    risks: url.startsWith('http://') ? ['Site not using HTTPS'] : [],
    warnings: ['No AI key configured for detailed analysis'],
    recommendations: ['Configure an AI provider for detailed analysis'],
    positives: url.startsWith('https://') ? ['Site uses HTTPS'] : [],
    screenshots: pageInfo.screenshots,
  };
}

async function analyzeWithAI(screenshots, pageInfo, url) {
  const prompt = `You are a professional website analyst. Analyze this website and return a JSON object (no markdown, pure JSON only):
{
  "scores": { "overall": 0-100, "performance": 0-100, "design": 0-100, "security": 0-100, "seo": 0-100 },
  "summary": "2-3 sentence summary",
  "risks": ["critical issue 1", ...],
  "warnings": ["warning 1", ...],
  "recommendations": ["improvement 1", ...],
  "positives": ["strength 1", ...]
}

Website info:
- URL: ${url}
- Title: ${pageInfo.title || 'N/A'}
- Load time: ${pageInfo.loadTime ? pageInfo.loadTime + 'ms' : 'N/A'}
- Links: ${pageInfo.linkCount || 'N/A'}
- HTTPS: ${url.startsWith('https') ? 'Yes' : 'No'}

Screenshots attached. Analyze design quality, performance indicators, security posture, and SEO.`;

  try {
    if (aiProvider === 'gemini' && geminiKey) {
      const genAI = new GoogleGenerativeAI(geminiKey);
      const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
      const parts = [{ text: prompt }];
      if (screenshots.top) parts.push({ inlineData: { mimeType: 'image/jpeg', data: screenshots.top } });
      const result = await model.generateContent(parts);
      const text = result.response.text().trim().replace(/```json\n?|\n?```/g, '').trim();
      return JSON.parse(text);
    } else if (openaiKey) {
      const openai = new OpenAI({ apiKey: openaiKey });
      const imageContent = [];
      if (screenshots.top) imageContent.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${screenshots.top}`, detail: 'low' } });
      if (screenshots.full) imageContent.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${screenshots.full}`, detail: 'low' } });
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, ...imageContent] }],
        max_tokens: 1500,
        response_format: { type: 'json_object' },
      });
      return JSON.parse(response.choices[0].message.content || '{}');
    }
  } catch (e) {
    console.error('AI analysis error:', e.message);
  }
  return null;
}

async function main() {
  let finalUrl = targetUrl;
  if (!finalUrl.startsWith('http://') && !finalUrl.startsWith('https://')) finalUrl = 'https://' + finalUrl;

  await progress('starting', 'Starting browser...', 5);
  let browser;
  const screenshots = { top: null, bottom: null, full: null };
  const pageInfo = { title: null, loadTime: null, linkCount: 0 };

  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 768 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    await progress('navigating', `Navigating to ${finalUrl}...`, 20);
    const startTime = Date.now();
    await page.goto(finalUrl, { waitUntil: 'networkidle2', timeout: 30000 }).catch(async () => {
      await page.goto(finalUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    });
    pageInfo.loadTime = Date.now() - startTime;
    pageInfo.title = await page.title();
    pageInfo.linkCount = await page.$$eval('a', (els) => els.length);

    await progress('screenshot_top', 'Capturing top screenshot...', 35);
    screenshots.top = (await page.screenshot({ type: 'jpeg', quality: 70 })).toString('base64');

    await progress('scrolling', 'Scrolling page...', 45);
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        let totalHeight = 0;
        const distance = 300;
        const timer = setInterval(() => {
          window.scrollBy(0, distance);
          totalHeight += distance;
          if (totalHeight >= document.body.scrollHeight) { clearInterval(timer); resolve(); }
        }, 100);
      });
    });

    await progress('screenshot_bottom', 'Capturing bottom screenshot...', 55);
    screenshots.bottom = (await page.screenshot({ type: 'jpeg', quality: 70 })).toString('base64');

    await progress('screenshot_full', 'Capturing full-page screenshot...', 65);
    screenshots.full = (await page.screenshot({ type: 'jpeg', quality: 55, fullPage: true })).toString('base64');

    await browser.close(); browser = null;

    await progress('analyzing', 'Analyzing with AI...', 75);
    const aiResult = await analyzeWithAI(screenshots, pageInfo, finalUrl);

    await progress('finishing', 'Finishing up...', 95);

    const result = aiResult
      ? { url: finalUrl, title: pageInfo.title, loadTime: pageInfo.loadTime, scores: aiResult.scores, summary: aiResult.summary, risks: aiResult.risks || [], warnings: aiResult.warnings || [], recommendations: aiResult.recommendations || [], positives: aiResult.positives || [], screenshots }
      : basicAnalysis(finalUrl, { ...pageInfo, screenshots });

    await postCallback({ status: 'completed', result });
    console.log('Scan complete!');
  } catch (err) {
    console.error('Scan error:', err.message);
    if (browser) await browser.close().catch(() => {});
    await postCallback({ status: 'failed', errorMessage: err.message });
    process.exit(1);
  }
}

main();
