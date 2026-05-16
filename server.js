const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'clients.json');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Data helpers ──────────────────────────────────────────────────────────────

function readData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return { clients: [] };
  }
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ── Claude proxy ──────────────────────────────────────────────────────────────

app.post('/api/claude', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured on server' });
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
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

// ── Clients CRUD ──────────────────────────────────────────────────────────────

app.get('/api/clients', (req, res) => {
  const { clients } = readData();
  res.json(clients);
});

app.post('/api/clients', (req, res) => {
  const data = readData();
  const client = {
    id: crypto.randomUUID(),
    name: req.body.name || 'New Client',
    email: req.body.email || '',
    phone: req.body.phone || '',
    programStartDate: req.body.programStartDate || new Date().toISOString().slice(0, 10),
    currentPhase: 1,
    generalNotes: '',
    sections: {},
    createdAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString()
  };
  data.clients.push(client);
  writeData(data);
  res.status(201).json(client);
});

app.get('/api/clients/:id', (req, res) => {
  const { clients } = readData();
  const client = clients.find(c => c.id === req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  res.json(client);
});

app.put('/api/clients/:id', (req, res) => {
  const data = readData();
  const idx = data.clients.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Client not found' });
  data.clients[idx] = {
    ...data.clients[idx],
    ...req.body,
    id: data.clients[idx].id,
    lastUpdated: new Date().toISOString()
  };
  writeData(data);
  res.json(data.clients[idx]);
});

app.delete('/api/clients/:id', (req, res) => {
  const data = readData();
  const idx = data.clients.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Client not found' });
  data.clients.splice(idx, 1);
  writeData(data);
  res.json({ ok: true });
});

// ── Section update ────────────────────────────────────────────────────────────

app.put('/api/clients/:id/sections/:sectionKey', (req, res) => {
  const data = readData();
  const idx = data.clients.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Client not found' });

  const key = req.params.sectionKey;
  data.clients[idx].sections = data.clients[idx].sections || {};
  data.clients[idx].sections[key] = {
    ...data.clients[idx].sections[key],
    ...req.body,
    lastUpdated: new Date().toISOString()
  };
  data.clients[idx].lastUpdated = new Date().toISOString();
  writeData(data);
  res.json(data.clients[idx].sections[key]);
});

app.listen(PORT, () => console.log(`InteGrit running on port ${PORT}`));
