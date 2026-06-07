require('dotenv').config();
const express = require('express');
const { ImapFlow } = require('imapflow');
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');
const store = require('./store');

// Load accounts: prefer env vars (Railway/production), fall back to accounts.js (local dev)
let accounts;
try { accounts = require('./accounts'); } catch(e) { accounts = []; }

// Build accounts from env vars if defined — overrides/supplements accounts.js
function makeAccount(id, name, email, color, icon, imapHost, smtpHost, userEnv, passEnv) {
  const user = process.env[userEnv] || email;
  const pass = process.env[passEnv] || '';
  if (!pass && accounts.find(a => a.id === id)) return null; // local accounts.js has it
  return { id, name, email: user, color, icon,
    imap: { host: imapHost, port: 993, secure: true, auth: { user, pass } },
    smtp: { host: smtpHost, port: 587, secure: false, auth: { user, pass } } };
}
const envAccounts = [
  makeAccount('gmail','Gmail','you@gmail.com','#EA4335','G','imap.gmail.com','smtp.gmail.com','GMAIL_USER','GMAIL_APP_PASSWORD'),
  makeAccount('account2','Account 2','','#FF6B35','2','imap.dreamhost.com','smtp.dreamhost.com','ACCT2_USER','ACCT2_PASSWORD'),
  makeAccount('account3','Account 3','','#F7931E','3','imap.dreamhost.com','smtp.dreamhost.com','ACCT3_USER','ACCT3_PASSWORD'),
  makeAccount('account4','Account 4','','#8B5CF6','4','imap.dreamhost.com','smtp.dreamhost.com','ACCT4_USER','ACCT4_PASSWORD'),
  makeAccount('account5','Account 5','','#10B981','5','imap.dreamhost.com','smtp.dreamhost.com','ACCT5_USER','ACCT5_PASSWORD'),
].filter(a => a && a.smtp.auth.pass);
if (envAccounts.length > 0 && accounts.length === 0) accounts = envAccounts;

// 1x1 transparent GIF
const PIXEL_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Return account list (no passwords)
app.get('/api/accounts', (req, res) => {
  res.json(accounts.map(({ id, name, email, color, icon }) => ({ id, name, email, color, icon })));
});

async function getImapClient(account) {
  const client = new ImapFlow({
    host: account.imap.host,
    port: account.imap.port,
    secure: account.imap.secure,
    auth: account.imap.auth,
    logger: false,
    tls: { rejectUnauthorized: false },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  });
  // Prevent unhandled error events from crashing the server
  client.on('error', () => {});
  await client.connect();
  return client;
}

// Global safety net for any stray unhandled rejections
process.on('uncaughtException', (err) => {
  if (err.code === 'ETIMEOUT' || err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') return;
  console.error('Uncaught exception:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason?.message || reason);
});

// Fetch emails for an account + folder
app.get('/api/emails/:accountId', async (req, res) => {
  const { accountId } = req.params;
  const folder = req.query.folder || 'INBOX';
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 25;

  const account = accounts.find(a => a.id === accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  if (!account.imap.auth.pass) return res.status(400).json({ error: 'No password configured for this account' });

  let client;
  try {
    client = await getImapClient(account);
    const mailbox = await client.mailboxOpen(folder);
    const total = mailbox.exists;

    if (total === 0) {
      await client.logout();
      return res.json({ emails: [], total: 0, page, limit });
    }

    // Calculate range from newest first
    const end = Math.max(1, total - (page - 1) * limit);
    const start = Math.max(1, end - limit + 1);

    const emails = [];
    for await (const msg of client.fetch(`${start}:${end}`, {
      uid: true, flags: true, envelope: true, bodyStructure: true,
    })) {
      emails.unshift({
        uid: msg.uid,
        seq: msg.seq,
        subject: msg.envelope.subject || '(no subject)',
        from: msg.envelope.from?.[0] ? `${msg.envelope.from[0].name || ''} <${msg.envelope.from[0].address}>`.trim() : 'Unknown',
        to: msg.envelope.to?.map(t => t.address).join(', ') || '',
        date: msg.envelope.date,
        seen: msg.flags.has('\\Seen'),
        flagged: msg.flags.has('\\Flagged'),
        hasAttachment: hasAttachment(msg.bodyStructure),
      });
    }

    await client.logout();
    res.json({ emails, total, page, limit, folder });
  } catch (err) {
    if (client) try { await client.logout(); } catch (_) {}
    res.status(500).json({ error: err.message });
  }
});

function hasAttachment(structure) {
  if (!structure) return false;
  if (structure.disposition === 'attachment') return true;
  if (structure.childNodes) return structure.childNodes.some(hasAttachment);
  return false;
}

// Fetch full email body
app.get('/api/emails/:accountId/:uid', async (req, res) => {
  const { accountId, uid } = req.params;
  const folder = req.query.folder || 'INBOX';

  const account = accounts.find(a => a.id === accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  let client;
  try {
    client = await getImapClient(account);
    await client.mailboxOpen(folder);

    let email = null;
    // Collect full message — do NOT run other commands inside the fetch loop
    for await (const msg of client.fetch({ uid: parseInt(uid) }, {
      uid: true, flags: true, envelope: true, source: true,
    }, { uid: true })) {
      const raw = msg.source.toString();
      const { text, html, attachments } = parseEmail(raw);
      email = {
        uid: msg.uid,
        subject: msg.envelope.subject || '(no subject)',
        from: msg.envelope.from?.[0] ? `${msg.envelope.from[0].name || ''} <${msg.envelope.from[0].address}>`.trim() : 'Unknown',
        to: msg.envelope.to?.map(t => `${t.name || ''} <${t.address}>`).join(', ') || '',
        cc: msg.envelope.cc?.map(t => t.address).join(', ') || '',
        date: msg.envelope.date,
        seen: true,
        flagged: msg.flags.has('\\Flagged'),
        html: html || null,
        text: text || '',
        attachments,
      };
    }

    // Mark as seen AFTER fetch loop is fully done
    if (email) {
      try { await client.messageFlagsAdd({ uid: parseInt(uid) }, ['\\Seen'], { uid: true }); } catch (_) {}
    }

    await client.logout();
    if (!email) return res.status(404).json({ error: 'Email not found' });
    res.json(email);
  } catch (err) {
    if (client) try { await client.logout(); } catch (_) {}
    res.status(500).json({ error: err.message });
  }
});

function parseEmail(raw) {
  const lines = raw.split('\r\n');
  let inHeader = true;
  let boundary = null;
  let contentType = '';
  let currentPart = null;
  let parts = [];
  let body = [];
  let headers = {};

  // Quick parse headers
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (inHeader) {
      if (line === '') { inHeader = false; continue; }
      const m = line.match(/^([^:]+):\s*(.*)/);
      if (m) headers[m[1].toLowerCase()] = m[2];
    } else {
      body.push(line);
    }
  }

  const ct = headers['content-type'] || '';
  const bm = ct.match(/boundary="?([^";]+)"?/i);
  boundary = bm ? bm[1] : null;

  if (!boundary) {
    // Simple single-part email
    const isBase64 = (headers['content-transfer-encoding'] || '').toLowerCase() === 'base64';
    const isHtml = ct.toLowerCase().includes('html');
    const decoded = isBase64 ? Buffer.from(body.join(''), 'base64').toString('utf8') : body.join('\r\n');
    return { text: isHtml ? '' : decoded, html: isHtml ? decoded : null, attachments: [] };
  }

  // Multipart
  const fullBody = body.join('\r\n');
  const segments = fullBody.split(new RegExp(`--${escapeRegex(boundary)}(?:--)?`));
  let text = '', html = null, attachments = [];

  for (const seg of segments) {
    if (!seg.trim() || seg.trim() === '--') continue;
    const [partHeaderStr, ...partBodyArr] = seg.split('\r\n\r\n');
    const partBody = partBodyArr.join('\r\n\r\n');
    const partHeaders = {};
    for (const line of partHeaderStr.split('\r\n')) {
      const m = line.match(/^([^:]+):\s*(.*)/);
      if (m) partHeaders[m[1].toLowerCase()] = m[2];
    }
    const pct = (partHeaders['content-type'] || '').toLowerCase();
    const pte = (partHeaders['content-transfer-encoding'] || '').toLowerCase();
    const decoded = pte === 'base64' ? Buffer.from(partBody.replace(/\s/g, ''), 'base64').toString('utf8')
      : pte === 'quoted-printable' ? decodeQP(partBody)
      : partBody;

    if (pct.includes('text/html')) html = decoded;
    else if (pct.includes('text/plain')) text = decoded;
    else if (partHeaders['content-disposition']?.includes('attachment')) {
      attachments.push({ name: extractFilename(partHeaders['content-disposition'] || partHeaders['content-type'] || ''), size: partBody.length });
    }
  }

  return { text, html, attachments };
}

function decodeQP(str) {
  return str.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function extractFilename(header) {
  const m = header.match(/(?:filename|name)="?([^";]+)"?/i);
  return m ? m[1] : 'attachment';
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Get folder list
app.get('/api/folders/:accountId', async (req, res) => {
  const { accountId } = req.params;
  const account = accounts.find(a => a.id === accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  if (!account.imap.auth.pass) return res.status(400).json({ error: 'No password configured' });

  let client;
  try {
    client = await getImapClient(account);
    const list = await client.list();  // returns array, not async iterable
    const folders = list.map(f => ({ path: f.path, name: f.name, delimiter: f.delimiter, flags: [...(f.flags || [])] }));
    await client.logout();
    res.json(folders);
  } catch (err) {
    if (client) try { await client.logout(); } catch (_) {}
    res.status(500).json({ error: err.message });
  }
});

// Send email
app.post('/api/send', async (req, res) => {
  const { accountId, to, cc, bcc, subject, body, isHtml, replyTo, trackOpen } = req.body;
  const account = accounts.find(a => a.id === accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  if (!account.smtp.auth.pass) return res.status(400).json({ error: 'No password configured for this account' });

  try {
    const transporter = nodemailer.createTransport({
      host: account.smtp.host,
      port: account.smtp.port,
      secure: account.smtp.secure,
      auth: account.smtp.auth,
      tls: { rejectUnauthorized: false },
    });

    let trackId = null;
    let finalBody = body;
    let finalHtml = isHtml ? body : null;

    // Inject tracking pixel if requested
    if (trackOpen) {
      const data = store.get();
      trackId = store.uuid();
      const publicUrl = data.settings.publicUrl || 'http://localhost:3000';
      const pixel = `<img src="${publicUrl}/track/open/${trackId}.gif" width="1" height="1" style="display:none;border:0" alt="">`;
      if (isHtml) {
        finalHtml = finalBody + pixel;
      } else {
        // Wrap plain text in basic HTML to allow pixel injection
        finalHtml = `<div style="font-family:sans-serif;font-size:14px;white-space:pre-wrap">${body.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>${pixel}`;
      }
      data.tracked_emails.push({
        id: trackId, accountId, from: account.email,
        to, subject, sentAt: new Date().toISOString(),
        opens: [], openCount: 0,
      });
      store.save();
    }

    const mailOptions = {
      from: `${account.name} <${account.email}>`,
      to, cc, bcc, subject,
      ...(finalHtml ? { html: finalHtml, text: body } : { text: body }),
      ...(replyTo ? { inReplyTo: replyTo, references: replyTo } : {}),
    };

    const info = await transporter.sendMail(mailOptions);

    // Auto-save recipients to contacts
    const emails = [to, cc, bcc].filter(Boolean).join(',').split(',').map(e => e.trim()).filter(Boolean);
    const data = store.get();
    for (const addr of emails) {
      const match = addr.match(/^(.+?)\s*<([^>]+)>$/) || [null, '', addr];
      const name = match[1]?.trim() || '';
      const email = match[2]?.trim() || addr;
      if (email && !data.contacts.find(c => c.email.toLowerCase() === email.toLowerCase())) {
        data.contacts.push({ id: store.uuid(), name, email, addedAt: new Date().toISOString() });
      }
    }
    store.save();

    res.json({ success: true, messageId: info.messageId, trackId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── TRACKING ────────────────────────────────────────────────────

// Serve 1x1 tracking pixel
app.get('/track/open/:id.gif', (req, res) => {
  const { id } = req.params;
  const data = store.get();
  const tracked = data.tracked_emails.find(t => t.id === id);
  if (tracked) {
    tracked.openCount = (tracked.openCount || 0) + 1;
    tracked.opens.push({
      at: new Date().toISOString(),
      ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
      ua: req.headers['user-agent'] || '',
    });
    // Sync open count to campaign stats
    if (tracked.campaignId) {
      const c = (data.campaigns || []).find(c => c.id === tracked.campaignId);
      if (c) c.stats.opens = (c.stats.opens || 0) + 1;
    }
    store.save();
  }
  res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, no-cache', 'Pragma': 'no-cache' });
  res.send(PIXEL_GIF);
});

app.get('/api/tracking', (req, res) => {
  res.json(store.get().tracked_emails.slice().reverse());
});

app.delete('/api/tracking/:id', (req, res) => {
  const data = store.get();
  data.tracked_emails = data.tracked_emails.filter(t => t.id !== req.params.id);
  store.save();
  res.json({ success: true });
});

// ─── CONTACTS ────────────────────────────────────────────────────

app.get('/api/contacts', (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  let contacts = store.get().contacts;
  if (q) contacts = contacts.filter(c => c.name.toLowerCase().includes(q) || c.email.toLowerCase().includes(q));
  res.json(contacts.sort((a, b) => a.name.localeCompare(b.name) || a.email.localeCompare(b.email)));
});

app.post('/api/contacts', (req, res) => {
  const { name, email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  const data = store.get();
  const existing = data.contacts.find(c => c.email.toLowerCase() === email.toLowerCase());
  if (existing) {
    existing.name = name || existing.name;
    store.save();
    return res.json(existing);
  }
  const contact = { id: store.uuid(), name: name || '', email, addedAt: new Date().toISOString() };
  data.contacts.push(contact);
  store.save();
  res.json(contact);
});

app.put('/api/contacts/:id', (req, res) => {
  const data = store.get();
  const contact = data.contacts.find(c => c.id === req.params.id);
  if (!contact) return res.status(404).json({ error: 'Not found' });
  Object.assign(contact, req.body);
  store.save();
  res.json(contact);
});

app.delete('/api/contacts/:id', (req, res) => {
  const data = store.get();
  data.contacts = data.contacts.filter(c => c.id !== req.params.id);
  store.save();
  res.json({ success: true });
});

// Settings (public URL for tracker)
app.get('/api/settings', (req, res) => res.json(store.get().settings));
app.post('/api/settings', (req, res) => {
  const data = store.get();
  Object.assign(data.settings, req.body);
  store.save();
  res.json(data.settings);
});

// Delete/move to trash
app.delete('/api/emails/:accountId/:uid', async (req, res) => {
  const { accountId, uid } = req.params;
  const folder = req.query.folder || 'INBOX';
  const account = accounts.find(a => a.id === accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  let client;
  try {
    client = await getImapClient(account);
    await client.mailboxOpen(folder);
    await client.messageDelete({ uid: parseInt(uid) }, { uid: true });
    await client.logout();
    res.json({ success: true });
  } catch (err) {
    if (client) try { await client.logout(); } catch (_) {}
    res.status(500).json({ error: err.message });
  }
});

// Toggle flag (star)
app.post('/api/emails/:accountId/:uid/flag', async (req, res) => {
  const { accountId, uid } = req.params;
  const { flagged, folder } = req.body;
  const account = accounts.find(a => a.id === accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  let client;
  try {
    client = await getImapClient(account);
    await client.mailboxOpen(folder || 'INBOX');
    if (flagged) {
      await client.messageFlagsAdd({ uid: parseInt(uid) }, ['\\Flagged'], { uid: true });
    } else {
      await client.messageFlagsRemove({ uid: parseInt(uid) }, ['\\Flagged'], { uid: true });
    }
    await client.logout();
    res.json({ success: true });
  } catch (err) {
    if (client) try { await client.logout(); } catch (_) {}
    res.status(500).json({ error: err.message });
  }
});

// Update password in .env at runtime
app.post('/api/accounts/:accountId/password', (req, res) => {
  const { accountId } = req.params;
  const { password } = req.body;
  const account = accounts.find(a => a.id === accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  account.imap.auth.pass = password;
  account.smtp.auth.pass = password;

  // Persist to .env
  const envPath = path.join(__dirname, '.env');
  let envContent = fs.readFileSync(envPath, 'utf8');
  const envKey = accountId === 'gmail' ? 'GMAIL_APP_PASSWORD'
    : accountId === 'artxtreme-smartin' ? 'DH1_PASSWORD'
    : accountId === 'artxtreme-support' ? 'DH2_PASSWORD'
    : accountId === 'mudpixel' ? 'DH3_PASSWORD'
    : 'DH4_PASSWORD';

  envContent = envContent.replace(new RegExp(`${envKey}=.*`), `${envKey}=${password}`);
  fs.writeFileSync(envPath, envContent);
  res.json({ success: true });
});

// ─── LISTS (AUDIENCES) ───────────────────────────────────────────────────────

app.get('/api/lists', (req, res) => {
  const data = store.get();
  const lists = (data.lists || []).map(l => ({
    ...l,
    subscriberCount: (l.subscribers || []).filter(s => s.status === 'subscribed').length,
    totalCount: (l.subscribers || []).length,
  }));
  res.json(lists);
});

app.post('/api/lists', (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const data = store.get();
  if (!data.lists) data.lists = [];
  const list = { id: store.uuid(), name, description: description || '', createdAt: new Date().toISOString(), subscribers: [] };
  data.lists.push(list);
  store.save();
  res.json(list);
});

app.put('/api/lists/:id', (req, res) => {
  const data = store.get();
  const list = (data.lists || []).find(l => l.id === req.params.id);
  if (!list) return res.status(404).json({ error: 'Not found' });
  if (req.body.name) list.name = req.body.name;
  if (req.body.description !== undefined) list.description = req.body.description;
  store.save();
  res.json(list);
});

app.delete('/api/lists/:id', (req, res) => {
  const data = store.get();
  data.lists = (data.lists || []).filter(l => l.id !== req.params.id);
  store.save();
  res.json({ success: true });
});

app.get('/api/lists/:id/subscribers', (req, res) => {
  const data = store.get();
  const list = (data.lists || []).find(l => l.id === req.params.id);
  if (!list) return res.status(404).json({ error: 'Not found' });
  let subs = list.subscribers || [];
  if (req.query.status) subs = subs.filter(s => s.status === req.query.status);
  if (req.query.q) {
    const lq = req.query.q.toLowerCase();
    subs = subs.filter(s => s.email.toLowerCase().includes(lq) || (s.name || '').toLowerCase().includes(lq));
  }
  res.json(subs);
});

app.post('/api/lists/:id/subscribers', (req, res) => {
  const data = store.get();
  const list = (data.lists || []).find(l => l.id === req.params.id);
  if (!list) return res.status(404).json({ error: 'Not found' });
  const { email, name, tags, metadata } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  if (!list.subscribers) list.subscribers = [];
  const existing = list.subscribers.find(s => s.email.toLowerCase() === email.toLowerCase());
  if (existing) {
    existing.name = name || existing.name;
    if (tags) existing.tags = tags;
    if (metadata) existing.metadata = { ...existing.metadata, ...metadata };
    existing.status = 'subscribed';
    store.save();
    return res.json(existing);
  }
  const sub = { id: store.uuid(), email, name: name || '', tags: tags || [], status: 'subscribed', addedAt: new Date().toISOString(), metadata: metadata || {}, openCount: 0, clickCount: 0 };
  list.subscribers.push(sub);
  store.save();
  res.json(sub);
});

app.put('/api/lists/:listId/subscribers/:subId', (req, res) => {
  const data = store.get();
  const list = (data.lists || []).find(l => l.id === req.params.listId);
  if (!list) return res.status(404).json({ error: 'List not found' });
  const sub = (list.subscribers || []).find(s => s.id === req.params.subId);
  if (!sub) return res.status(404).json({ error: 'Subscriber not found' });
  Object.assign(sub, req.body);
  store.save();
  res.json(sub);
});

app.delete('/api/lists/:listId/subscribers/:subId', (req, res) => {
  const data = store.get();
  const list = (data.lists || []).find(l => l.id === req.params.listId);
  if (!list) return res.status(404).json({ error: 'List not found' });
  list.subscribers = (list.subscribers || []).filter(s => s.id !== req.params.subId);
  store.save();
  res.json({ success: true });
});

app.post('/api/lists/:id/import', (req, res) => {
  const data = store.get();
  const list = (data.lists || []).find(l => l.id === req.params.id);
  if (!list) return res.status(404).json({ error: 'Not found' });
  const { subscribers } = req.body;
  if (!Array.isArray(subscribers)) return res.status(400).json({ error: 'subscribers array required' });
  if (!list.subscribers) list.subscribers = [];
  let added = 0, updated = 0, skipped = 0;
  for (const s of subscribers) {
    if (!s.email) { skipped++; continue; }
    const existing = list.subscribers.find(e => e.email.toLowerCase() === s.email.toLowerCase());
    if (existing) {
      if (s.name) existing.name = s.name;
      if (s.tags) existing.tags = [...new Set([...(existing.tags || []), ...s.tags])];
      updated++;
    } else {
      list.subscribers.push({ id: store.uuid(), email: s.email, name: s.name || '', tags: s.tags || [], status: 'subscribed', addedAt: new Date().toISOString(), metadata: {}, openCount: 0, clickCount: 0 });
      added++;
    }
  }
  store.save();
  res.json({ added, updated, skipped });
});

// ─── CAMPAIGNS ───────────────────────────────────────────────────────────────

app.get('/api/campaigns', (req, res) => res.json((store.get().campaigns || []).slice().reverse()));

app.get('/api/campaigns/:id', (req, res) => {
  const c = (store.get().campaigns || []).find(c => c.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  res.json(c);
});

app.post('/api/campaigns', (req, res) => {
  const { name, subject, fromEmail, fromName, replyTo, accountId, listId, html } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const data = store.get();
  if (!data.campaigns) data.campaigns = [];
  const c = {
    id: store.uuid(), name,
    subject: subject || '', fromEmail: fromEmail || '', fromName: fromName || '',
    replyTo: replyTo || '', accountId: accountId || '', listId: listId || '',
    html: html || '', status: 'draft',
    createdAt: new Date().toISOString(), sentAt: null, scheduledAt: null,
    stats: { sent: 0, delivered: 0, opens: 0, uniqueOpens: 0, clicks: 0, unsubscribes: 0 },
    clickMap: {}, recipientLog: [],
  };
  data.campaigns.push(c);
  store.save();
  res.json(c);
});

app.put('/api/campaigns/:id', (req, res) => {
  const data = store.get();
  const c = (data.campaigns || []).find(c => c.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  if (c.status === 'sent') return res.status(400).json({ error: 'Cannot edit sent campaign' });
  for (const k of ['name','subject','fromEmail','fromName','replyTo','accountId','listId','html','scheduledAt','status']) {
    if (req.body[k] !== undefined) c[k] = req.body[k];
  }
  store.save();
  res.json(c);
});

app.delete('/api/campaigns/:id', (req, res) => {
  const data = store.get();
  data.campaigns = (data.campaigns || []).filter(c => c.id !== req.params.id);
  store.save();
  res.json({ success: true });
});

app.get('/api/campaigns/:id/preview', (req, res) => {
  const c = (store.get().campaigns || []).find(c => c.id === req.params.id);
  if (!c) return res.status(404).send('Not found');
  const sample = { firstName: 'Preview', lastName: 'User', email: 'preview@example.com', fullName: 'Preview User', fromName: c.fromName };
  res.setHeader('Content-Type', 'text/html');
  res.send(resolveMergeTags(c.html, sample));
});

app.post('/api/campaigns/:id/test', async (req, res) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: 'to required' });
  const data = store.get();
  const c = (data.campaigns || []).find(c => c.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  const account = accounts.find(a => a.id === c.accountId);
  if (!account || !account.smtp.auth.pass) return res.status(400).json({ error: 'Account not configured' });
  const transporter = nodemailer.createTransport({ host: account.smtp.host, port: account.smtp.port, secure: account.smtp.secure, auth: account.smtp.auth, tls: { rejectUnauthorized: false } });
  const sample = { firstName: 'Test', lastName: 'User', email: to, fullName: 'Test User', fromName: c.fromName };
  let html = resolveMergeTags(c.html, sample);
  html += '<div style="text-align:center;padding:12px;font-size:11px;color:#aaa;font-family:sans-serif;border-top:1px solid #eee;margin-top:20px">[TEST EMAIL — not sent to list]</div>';
  try {
    await transporter.sendMail({ from: `${c.fromName} <${c.fromEmail || account.email}>`, to, subject: `[TEST] ${c.subject}`, html, text: htmlToText(html) });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function doSendCampaign(campaignId) {
  const data = store.get();
  const c = (data.campaigns || []).find(c => c.id === campaignId);
  if (!c || c.status === 'sent' || c.status === 'sending') return;
  const account = accounts.find(a => a.id === c.accountId);
  if (!account || !account.smtp.auth.pass) return;
  const list = (data.lists || []).find(l => l.id === c.listId);
  if (!list) return;
  const subscribers = (list.subscribers || []).filter(s => s.status === 'subscribed');
  if (!subscribers.length) return;
  const publicUrl = data.settings.publicUrl || 'http://localhost:3000';
  const cfg = getConfig();

  c.status = 'sending';
  c.sentAt = new Date().toISOString();
  c.stats.sent = subscribers.length;
  c.recipientLog = [];
  store.save();

  const transporter = nodemailer.createTransport({ host: account.smtp.host, port: account.smtp.port, secure: account.smtp.secure, auth: account.smtp.auth, tls: { rejectUnauthorized: false }, pool: true, maxConnections: 3 });
  let delivered = 0;
  for (const sub of subscribers) {
    try {
      const trackId = store.uuid();
      const parts = (sub.name || '').split(' ');
      const mergeVars = { firstName: parts[0] || sub.email.split('@')[0], lastName: parts.slice(1).join(' '), fullName: sub.name || sub.email, email: sub.email, fromName: c.fromName };
      let html = resolveMergeTags(c.html, mergeVars);
      html = injectClickTracking(html, c.id, publicUrl);
      const pixel = `<img src="${publicUrl}/track/open/${trackId}.gif" width="1" height="1" style="display:none;border:0" alt="">`;
      const unsubUrl = `${publicUrl}/unsubscribe/${list.id}/${sub.id}`;
      const addrLine = cfg.address ? `<div style="font-size:10px;color:#bbb;margin-bottom:4px">${cfg.address}</div>` : '';
      if (html.includes('{{unsubscribeUrl}}')) {
        html = html.replace(/\{\{unsubscribeUrl\}\}/g, unsubUrl);
        if (!html.includes(pixel.substring(0, 30))) html += pixel;
      } else {
        html += `<div style="text-align:center;padding:16px;font-size:11px;color:#aaa;font-family:sans-serif">${addrLine}<a href="${unsubUrl}" style="color:#aaa">Unsubscribe</a>${pixel}</div>`;
      }
      await transporter.sendMail({
        from: `${c.fromName} <${c.fromEmail || account.email}>`,
        to: sub.name ? `${sub.name} <${sub.email}>` : sub.email,
        subject: resolveMergeTags(c.subject, mergeVars),
        html, text: htmlToText(html),
        ...(c.replyTo ? { replyTo: c.replyTo } : {}),
      });
      data.tracked_emails.push({ id: trackId, accountId: c.accountId, campaignId: c.id, from: c.fromEmail || account.email, to: sub.email, subject: c.subject, sentAt: new Date().toISOString(), opens: [], openCount: 0 });
      c.recipientLog.push({ subId: sub.id, email: sub.email, trackId, status: 'sent', sentAt: new Date().toISOString() });
      delivered++;
      if (delivered % 10 === 0) store.save();
      await new Promise(r => setTimeout(r, 250));
    } catch (err) {
      c.recipientLog.push({ subId: sub.id, email: sub.email, status: 'failed', error: err.message });
    }
  }
  c.status = 'sent';
  c.stats.delivered = delivered;
  store.save();
  console.log(`Campaign "${c.name}" sent: ${delivered}/${subscribers.length} delivered`);
}

app.post('/api/campaigns/:id/send', async (req, res) => {
  const data = store.get();
  const c = (data.campaigns || []).find(c => c.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  if (c.status === 'sent') return res.status(400).json({ error: 'Already sent' });
  const account = accounts.find(a => a.id === c.accountId);
  if (!account || !account.smtp.auth.pass) return res.status(400).json({ error: 'Account not configured' });
  const list = (data.lists || []).find(l => l.id === c.listId);
  if (!list) return res.status(400).json({ error: 'Audience not found' });
  const subscribers = (list.subscribers || []).filter(s => s.status === 'subscribed');
  if (!subscribers.length) return res.status(400).json({ error: 'No active subscribers' });
  res.json({ success: true, count: subscribers.length });
  doSendCampaign(req.params.id);
});

// Click tracking redirect
app.get('/track/click/:campaignId/:linkId', (req, res) => {
  const { campaignId, linkId } = req.params;
  const url = req.query.url ? decodeURIComponent(req.query.url) : null;
  const data = store.get();
  const c = (data.campaigns || []).find(c => c.id === campaignId);
  if (c) {
    if (!c.clickMap) c.clickMap = {};
    if (!c.clickMap[linkId]) c.clickMap[linkId] = { url: url || '', count: 0 };
    c.clickMap[linkId].count++;
    c.stats.clicks = (c.stats.clicks || 0) + 1;
    store.save();
  }
  if (url) res.redirect(url);
  else res.status(400).send('No URL');
});

// Unsubscribe page
app.get('/unsubscribe/:listId/:subId', (req, res) => {
  const data = store.get();
  const list = (data.lists || []).find(l => l.id === req.params.listId);
  if (!list) return res.status(404).send('<h2>Invalid link</h2>');
  const sub = (list.subscribers || []).find(s => s.id === req.params.subId);
  if (sub) { sub.status = 'unsubscribed'; sub.unsubscribedAt = new Date().toISOString(); store.save(); }
  res.send(`<!DOCTYPE html><html><head><title>Unsubscribed</title></head><body style="font-family:sans-serif;text-align:center;padding:60px;background:#f5f5f5"><div style="max-width:400px;margin:0 auto;background:#fff;padding:40px;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.1)"><div style="font-size:48px">✓</div><h2 style="color:#333;margin:16px 0 8px">Unsubscribed</h2><p style="color:#777">You've been removed from this list and won't receive further emails.</p></div></body></html>`);
});


function resolveMergeTags(html, vars) {
  return (html || '').replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] != null ? vars[key] : '');
}

function injectClickTracking(html, campaignId, publicUrl) {
  let i = 0;
  return (html || '').replace(/href="(https?:\/\/[^"]+)"/g, (_, url) => {
    const linkId = `l${i++}`;
    return `href="${publicUrl}/track/click/${campaignId}/${linkId}?url=${encodeURIComponent(url)}"`;
  });
}

function htmlToText(html) {
  return (html || '').replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// ─── WHITE-LABEL CONFIG ──────────────────────────────────────────────────────

const CONFIG_FILE = path.join(__dirname, 'config.json');
function getConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}
app.get('/api/config', (req, res) => res.json(getConfig()));
app.post('/api/config', (req, res) => {
  const cfg = { ...getConfig(), ...req.body };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  res.json(cfg);
});

// ─── PUBLIC SUBSCRIBE FORM ───────────────────────────────────────────────────

function subscribePageHtml(list, cfg, { success, error } = {}) {
  const brand = cfg.brandName || "Sherwin's Domain";
  const accent = cfg.primaryColor || '#f9b21b';
  const logo = cfg.logoText || '✉';
  const esc2 = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  if (success) return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Subscribed!</title><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:40px 20px;background:#f4f4f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center">
<div style="max-width:420px;width:100%;background:#fff;border-radius:12px;padding:40px;text-align:center;box-shadow:0 4px 20px rgba(0,0,0,.08)">
  <div style="width:64px;height:64px;background:${accent};border-radius:50%;margin:0 auto 20px;line-height:64px;font-size:30px">✓</div>
  <h2 style="margin:0 0 10px;color:#1a1a1a;font-size:22px">You're subscribed!</h2>
  <p style="margin:0;color:#666;font-size:15px;line-height:1.6">Thanks for subscribing to <strong>${esc2(list.name)}</strong>. You'll receive emails soon.</p>
  ${cfg.websiteUrl ? `<a href="${esc2(cfg.websiteUrl)}" style="display:inline-block;margin-top:20px;color:${accent};text-decoration:none;font-size:14px">← Back to website</a>` : ''}
</div></body></html>`;
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Subscribe — ${esc2(list.name)}</title><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:40px 20px;background:#f4f4f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center">
<div style="max-width:420px;width:100%;background:#fff;border-radius:12px;padding:40px;box-shadow:0 4px 20px rgba(0,0,0,.08)">
  <div style="text-align:center;margin-bottom:24px">
    <div style="width:48px;height:48px;background:${accent};border-radius:10px;margin:0 auto 12px;line-height:48px;font-size:22px;text-align:center">${esc2(logo)}</div>
    <div style="font-size:11px;color:#999;text-transform:uppercase;letter-spacing:1px">${esc2(brand)}</div>
  </div>
  <h2 style="margin:0 0 6px;color:#1a1a1a;font-size:20px;text-align:center">${esc2(list.name)}</h2>
  ${list.description ? `<p style="margin:0 0 24px;color:#888;font-size:14px;text-align:center">${esc2(list.description)}</p>` : '<div style="margin-bottom:24px"></div>'}
  ${error === 'email_required' ? '<div style="background:#fef2f2;color:#dc2626;padding:10px 14px;border-radius:6px;font-size:13px;margin-bottom:16px">Please enter a valid email address.</div>' : ''}
  <form method="post">
    <input type="text" name="firstName" placeholder="First name (optional)" style="width:100%;padding:11px 14px;border:1px solid #e5e5e5;border-radius:6px;font-size:14px;box-sizing:border-box;margin-bottom:10px;outline:none;font-family:inherit">
    <input type="email" name="email" placeholder="Email address *" required style="width:100%;padding:11px 14px;border:1px solid #e5e5e5;border-radius:6px;font-size:14px;box-sizing:border-box;margin-bottom:14px;outline:none;font-family:inherit">
    <button type="submit" style="width:100%;padding:13px;background:${accent};color:#000;border:none;border-radius:6px;font-size:15px;font-weight:700;cursor:pointer;font-family:inherit">Subscribe →</button>
  </form>
  <p style="margin:16px 0 0;color:#ccc;font-size:11px;text-align:center">${cfg.address ? esc2(cfg.address) : ''}</p>
</div></body></html>`;
}

app.get('/subscribe/:listId', (req, res) => {
  const data = store.get();
  const list = (data.lists || []).find(l => l.id === req.params.listId);
  if (!list) return res.status(404).send('<h2 style="font-family:sans-serif;text-align:center;margin-top:60px">Signup form not found</h2>');
  res.send(subscribePageHtml(list, getConfig(), { error: req.query.error }));
});

app.post('/subscribe/:listId', (req, res) => {
  const data = store.get();
  const list = (data.lists || []).find(l => l.id === req.params.listId);
  if (!list) return res.status(404).send('List not found');
  const { email, firstName, lastName } = req.body;
  if (!email || !email.includes('@')) return res.redirect(`/subscribe/${req.params.listId}?error=email_required`);
  if (!list.subscribers) list.subscribers = [];
  const existing = list.subscribers.find(s => s.email.toLowerCase() === email.trim().toLowerCase());
  if (!existing) {
    list.subscribers.push({ id: store.uuid(), email: email.trim(), name: [firstName, lastName].filter(Boolean).join(' ').trim(), tags: [], status: 'subscribed', addedAt: new Date().toISOString(), metadata: { source: 'web-form' }, openCount: 0, clickCount: 0 });
  } else {
    existing.status = 'subscribed';
  }
  store.save();
  res.send(subscribePageHtml(list, getConfig(), { success: true }));
});

// ─── CAMPAIGN SCHEDULER ──────────────────────────────────────────────────────

async function schedulerTick() {
  const data = store.get();
  const now = new Date();
  const due = (data.campaigns || []).filter(c => c.status === 'scheduled' && c.scheduledAt && new Date(c.scheduledAt) <= now);
  for (const c of due) {
    console.log(`Scheduler: firing campaign "${c.name}" scheduled for ${c.scheduledAt}`);
    await doSendCampaign(c.id);
  }
}
setInterval(schedulerTick, 60000);
setTimeout(schedulerTick, 4000); // check once on startup for any past-due campaigns

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Email dashboard running at http://localhost:${PORT}`));
