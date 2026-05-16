const express  = require('express');
const cors     = require('cors');
const fetch    = require('node-fetch');
const fs       = require('fs');
const path     = require('path');
const crypto   = require('crypto');
const session  = require('express-session');
const bcrypt   = require('bcryptjs');

const app      = express();
const PORT     = process.env.PORT || 3000;
const DATA_DIR  = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'clients.json');
if (!fs.existsSync(DATA_DIR))  fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '{"clients":[]}');

// ── Core middleware ───────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(session({
  secret:            process.env.SESSION_SECRET || 'change-me-in-production',
  resave:            false,
  saveUninitialized: false,
  cookie:            { httpOnly: true, maxAge: 24 * 60 * 60 * 1000 }   // 24 h
}));

// Public static assets (login pages, etc.) — protected views are NOT in public/
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth guards ───────────────────────────────────────────────────────────────
function requireCoach(req, res, next) {
  if (req.session && req.session.isCoach) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  res.redirect('/login');
}

function requireClient(req, res, next) {
  if (req.session && req.session.clientId) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  res.redirect('/client/login');
}

// ── Data helpers ──────────────────────────────────────────────────────────────
function readData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return { clients: [] }; }
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function stripHash(client) {
  if (!client) return client;
  const { passwordHash, ...safe } = client;
  safe.hasPassword = !!passwordHash;   // let the coach UI show password status
  return safe;
}

// ── Root ──────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  if (req.session && req.session.isCoach) return res.redirect('/coach');
  res.redirect('/login');
});

// ── Coach login / logout ──────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  if (req.session && req.session.isCoach) return res.redirect('/coach');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', (req, res) => {
  const { password } = req.body;
  const coachPassword = process.env.COACH_PASSWORD;
  if (!coachPassword) {
    return res.status(500).send('Server misconfigured: COACH_PASSWORD environment variable is not set.');
  }
  if (password === coachPassword) {
    req.session.isCoach = true;
    return res.redirect('/coach');
  }
  res.redirect('/login?error=1');
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ── Coach dashboard (protected) ───────────────────────────────────────────────
app.get('/coach', requireCoach, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'coach.html'));
});

// ── Client login / logout ─────────────────────────────────────────────────────
app.get('/client/login', (req, res) => {
  if (req.session && req.session.clientId) return res.redirect('/client');
  res.sendFile(path.join(__dirname, 'public', 'client-login.html'));
});

app.post('/client/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.redirect('/client/login?error=1');
  const { clients } = readData();
  const client = clients.find(
    c => c.email && c.email.toLowerCase() === email.toLowerCase().trim()
  );
  if (!client || !client.passwordHash) return res.redirect('/client/login?error=1');
  const match = await bcrypt.compare(password, client.passwordHash);
  if (match) {
    req.session.clientId = client.id;
    return res.redirect('/client');
  }
  res.redirect('/client/login?error=1');
});

app.get('/client/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/client/login'));
});

// ── Client portal (protected) ─────────────────────────────────────────────────
app.get('/client', requireClient, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'client-portal.html'));
});

// ── Client API — returns only this client's own data ─────────────────────────
app.get('/api/client/me', requireClient, (req, res) => {
  const { clients } = readData();
  const client = clients.find(c => c.id === req.session.clientId);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  res.json(stripHash(client));
});

// ── Claude proxy (coach only) ─────────────────────────────────────────────────
app.post('/api/claude', requireCoach, async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured on server' });
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(502).json({ error: 'Failed to reach Anthropic API', detail: err.message });
  }
});

// ── Clients CRUD (coach only) ─────────────────────────────────────────────────
app.get('/api/clients', requireCoach, (req, res) => {
  const { clients } = readData();
  res.json(clients.map(stripHash));
});

app.post('/api/clients', requireCoach, (req, res) => {
  const data = readData();
  const client = {
    id:               crypto.randomUUID(),
    name:             req.body.name || 'New Client',
    email:            req.body.email || '',
    phone:            req.body.phone || '',
    programStartDate: req.body.programStartDate || new Date().toISOString().slice(0, 10),
    currentPhase:     1,
    generalNotes:     '',
    sections:         {},
    createdAt:        new Date().toISOString(),
    lastUpdated:      new Date().toISOString()
  };
  data.clients.push(client);
  writeData(data);
  res.status(201).json(stripHash(client));
});

app.get('/api/clients/:id', requireCoach, (req, res) => {
  const { clients } = readData();
  const client = clients.find(c => c.id === req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  res.json(stripHash(client));
});

app.put('/api/clients/:id', requireCoach, (req, res) => {
  const data = readData();
  const idx  = data.clients.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Client not found' });
  // Never allow overwriting the password hash via this generic endpoint
  const { passwordHash, ...patch } = req.body;
  data.clients[idx] = {
    ...data.clients[idx],
    ...patch,
    id:           data.clients[idx].id,
    passwordHash: data.clients[idx].passwordHash,   // preserve
    lastUpdated:  new Date().toISOString()
  };
  writeData(data);
  res.json(stripHash(data.clients[idx]));
});

app.delete('/api/clients/:id', requireCoach, (req, res) => {
  const data = readData();
  const idx  = data.clients.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Client not found' });
  data.clients.splice(idx, 1);
  writeData(data);
  res.json({ ok: true });
});

// ── Section update (coach only) ───────────────────────────────────────────────
app.put('/api/clients/:id/sections/:sectionKey', requireCoach, (req, res) => {
  const data = readData();
  const idx  = data.clients.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Client not found' });
  const key = req.params.sectionKey;
  data.clients[idx].sections           = data.clients[idx].sections || {};
  data.clients[idx].sections[key]      = {
    ...data.clients[idx].sections[key],
    ...req.body,
    lastUpdated: new Date().toISOString()
  };
  data.clients[idx].lastUpdated = new Date().toISOString();
  writeData(data);
  res.json(data.clients[idx].sections[key]);
});

// ── Set client portal password (coach only) ───────────────────────────────────
app.post('/api/clients/:id/set-password', requireCoach, async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }
  const data = readData();
  const idx  = data.clients.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Client not found' });
  if (!data.clients[idx].email) {
    return res.status(400).json({ error: 'Client must have an email address before a portal password can be set.' });
  }
  data.clients[idx].passwordHash = await bcrypt.hash(password, 10);
  data.clients[idx].lastUpdated  = new Date().toISOString();
  writeData(data);
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`InteGrit running on port ${PORT}`));
