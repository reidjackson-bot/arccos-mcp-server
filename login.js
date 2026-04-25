#!/usr/bin/env node
// File: login.js
//
// One-time helper to obtain an Arccos `accessKey` from email + password.
// Run with: ARCCOS_EMAIL=... ARCCOS_PASSWORD=... node login.js
//
// The printed accessKey + userId go into Railway as ARCCOS_ACCESS_KEY and
// ARCCOS_USER_ID respectively. After that, this script is never needed again
// unless you change your password or get logged out everywhere.
//
// The accessKey is long-lived; the password is NOT stored anywhere.

const email = process.env.ARCCOS_EMAIL;
const password = process.env.ARCCOS_PASSWORD;

if (!email || !password) {
  console.error('Usage: ARCCOS_EMAIL=you@example.com ARCCOS_PASSWORD=yourpw node login.js');
  process.exit(1);
}

const resp = await fetch('https://authentication.arccosgolf.com/accessKeys', {
  method: 'POST',
  headers: {
    'Accept': 'application/json',
    'Content-Type': 'application/json;charset=utf-8',
    'Origin': 'https://dashboard.arccosgolf.com',
    'Referer': 'https://dashboard.arccosgolf.com/',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
  },
  body: JSON.stringify({
    email,
    password,
    signedInByFacebook: 'F',
  }),
});

if (!resp.ok) {
  const text = await resp.text();
  console.error(`Login failed (${resp.status}): ${text}`);
  process.exit(1);
}

const data = await resp.json();
console.log('\n=== Arccos login successful ===\n');
console.log('Set these in Railway env vars:\n');
console.log(`  ARCCOS_USER_ID=${data.userId || data.user_id || '<see response below>'}`);
console.log(`  ARCCOS_ACCESS_KEY=${data.accessKey || data.access_key || '<see response below>'}`);
console.log('\nFull response (for inspection):');
console.log(JSON.stringify(data, null, 2));
