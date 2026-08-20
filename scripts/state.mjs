const base = process.env.BRIDGE_CONTROL_BASE_URL || 'http://127.0.0.1:38501';
const response = await fetch(`${base}/v1/state`);
const body = await response.json().catch(() => ({ ok: false, message: 'Invalid JSON response' }));
console.log(JSON.stringify(body, null, 2));
if (!response.ok) process.exitCode = 1;
