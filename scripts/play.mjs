const [trackId, quality = 'lossless'] = process.argv.slice(2);
if (!trackId || !/^\d+$/.test(trackId)) {
  console.error('Usage: npm run play -- <numeric-track-id> [standard|exhigh|lossless|hires]');
  process.exit(2);
}

const base = process.env.BRIDGE_CONTROL_BASE_URL || 'http://127.0.0.1:38501';
const response = await fetch(`${base}/v1/play`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ trackId, quality }),
});
const body = await response.json().catch(() => ({ ok: false, message: 'Invalid JSON response' }));
console.log(JSON.stringify(body, null, 2));
if (!response.ok) process.exitCode = 1;
