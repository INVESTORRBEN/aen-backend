const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const app = express();

// -------------------- Environment Configuration --------------------
const {
  PORT = 3000,
  DATABASE_URL,
  JWT_SECRET,
  FREE_CREDITS = 20,
  TOKEN_TTL_MINUTES = 10,
  WIDGET_JWT_EXPIRY = '7d',
  RATE_LIMIT_REC_PER_NODE = 60,     // requests per minute
  RATE_LIMIT_CLICK_PER_NODE = 10,   // requests per 15 minutes
  CORS_ORIGIN = '*'
} = process.env;

if (!DATABASE_URL) {
  console.error('FATAL: DATABASE_URL environment variable is missing.');
  process.exit(1);
}
if (!JWT_SECRET || JWT_SECRET === 'fallback-dev-secret-change-in-production') {
  console.warn('WARNING: JWT_SECRET is not set or using default. Use a strong secret in production.');
}

app.set('trust proxy', 1);
app.use(express.json({ limit: '10kb' }));
app.use(cors({
  origin: CORS_ORIGIN,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-api-key', 'x-widget-token', 'Authorization']
}));

// -------------------- Database Setup --------------------
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
});

// Input validators
const isValidDomain = (domain) => {
  const domainRegex = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
  return domainRegex.test(domain);
};

const isValidUrl = (string) => {
  try {
    const url = new URL(string);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (_) {
    return false;
  }
};

// Database Initialisation & Seeding
async function initDb() {
  const client = await pool.connect();

  try {
    // Reset database tables during initial development setup
    // Remove these DROP statements after the first successful deployment if data persistence is needed
    await client.query(`
      DROP TABLE IF EXISTS click_tokens CASCADE;
      DROP TABLE IF EXISTS campaigns CASCADE;
      DROP TABLE IF EXISTS nodes CASCADE;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS nodes (
        id SERIAL PRIMARY KEY,
        app_name VARCHAR(60) NOT NULL,
        domain VARCHAR(255) UNIQUE NOT NULL,
        category VARCHAR(50) NOT NULL,
        api_key VARCHAR(64) UNIQUE NOT NULL,
        credits INT NOT NULL DEFAULT ${parseInt(FREE_CREDITS)},
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS campaigns (
        id SERIAL PRIMARY KEY,
        node_id INT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        title VARCHAR(100) NOT NULL,
        description VARCHAR(280) NOT NULL,
        target_url TEXT NOT NULL,
        cta_text VARCHAR(30) DEFAULT 'Visit →',
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS click_tokens (
        token VARCHAR(64) PRIMARY KEY,
        publisher_node_id INT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        campaign_id INT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        is_used BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_click_tokens_created_at
      ON click_tokens(created_at);

      CREATE INDEX IF NOT EXISTS idx_campaigns_node_id
      ON campaigns(node_id);
    `);

    console.log('Database tables verified successfully.');

    // Seed mock nodes & campaigns automatically for bootstrapping
    const checkNodes = await client.query('SELECT COUNT(*) FROM nodes');
    if (parseInt(checkNodes.rows[0].count) === 0) {
      console.log('Seeding initial network nodes and campaigns...');
      const seedNodes = [
        { name: "DevPulse", domain: "devpulse.io", category: "Developer Tools", credits: 450 },
        { name: "TaskFlow", domain: "taskflow.app", category: "Productivity", credits: 1200 },
        { name: "SaaSTracker", domain: "saastracker.co", category: "SaaS", credits: 310 },
        { name: "CodeSnippet", domain: "codesnippet.dev", category: "Developer Tools", credits: 890 },
        { name: "FocusRoom", domain: "focusroom.xyz", category: "Productivity", credits: 670 },
        { name: "InvoiceFast", domain: "invoicefast.io", category: "SaaS", credits: 1540 },
        { name: "PixelCraft", domain: "pixelcraft.design", category: "General", credits: 230 },
        { name: "DataSync", domain: "datasync.tech", category: "Developer Tools", credits: 910 },
        { name: "NoteWave", domain: "notewave.app", category: "Productivity", credits: 410 },
        { name: "GrowthMetrics", domain: "growthmetrics.co", category: "SaaS", credits: 780 },
        { name: "CloudShelf", domain: "cloudshelf.cloud", category: "Developer Tools", credits: 1120 },
        { name: "SketchBoard", domain: "sketchboard.site", category: "General", credits: 540 }
      ];

      for (const node of seedNodes) {
        const apiKey = 'aen_seed_' + crypto.randomBytes(16).toString('hex');
        const nodeRes = await client.query(
          `INSERT INTO nodes (app_name, domain, category, api_key, credits)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [node.name, node.domain, node.category, apiKey, node.credits]
        );
        const nodeId = nodeRes.rows[0].id;

        // Create a default campaign for each seeded node so the network recommendation engine works right away
        await client.query(
          `INSERT INTO campaigns (node_id, title, description, target_url, cta_text)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            nodeId,
            `Discover ${node.name}`,
            `Supercharge your workflow with ${node.name}. Built for modern teams and creators.`,
            `https://${node.domain}`,
            'Explore Now →'
          ]
        );
      }
      console.log('Successfully seeded 12 initial active network nodes and campaigns.');
    }

  } catch (err) {
    console.error('Database init error:', err);
    process.exit(1);

  } finally {
    client.release();
  }
}
initDb();

// Background cleanup of old click tokens (preserves used tokens for 24 hours for dashboard audit)
setInterval(async () => {
  try {
    const res = await pool.query(
      `DELETE FROM click_tokens
       WHERE (is_used = true AND created_at < NOW() - INTERVAL '24 hours')
          OR (is_used = false AND created_at < NOW() - INTERVAL '${TOKEN_TTL_MINUTES} minutes')`
    );
    if (res.rowCount > 0) console.log(`Cleaned up ${res.rowCount} expired/old tokens.`);
  } catch (err) {
    console.error('Token cleanup error:', err);
  }
}, 5 * 60 * 1000); // every 5 minutes

// -------------------- Rate Limiters --------------------
// Global limiter
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later.' }
});
app.use(globalLimiter);

// Per‑node rate limiting (in‑memory store)
const nodeRateLimitStore = {};
function nodeRateLimiter(windowMs, max, message) {
  return (req, res, next) => {
    const nodeId = req.node?.id || req.publisherNodeId;
    if (!nodeId) return next();
    const key = `node:${nodeId}:${windowMs}`;
    const now = Date.now();
    if (!nodeRateLimitStore[key]) {
      nodeRateLimitStore[key] = { count: 0, resetTime: now + windowMs };
    }
    const record = nodeRateLimitStore[key];
    if (now > record.resetTime) {
      record.count = 0;
      record.resetTime = now + windowMs;
    }
    record.count++;
    if (record.count > max) {
      return res.status(429).json({ error: message || 'Node rate limit exceeded.' });
    }
    next();
  };
}

// -------------------- Authentication Middleware --------------------
// For API key
async function authenticateApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) {
    return res.status(401).json({ error: 'Missing x-api-key header' });
  }
  try {
    const result = await pool.query('SELECT * FROM nodes WHERE api_key = $1', [apiKey]);
    if (result.rows.length === 0) {
      return res.status(403).json({ error: 'Invalid API Key' });
    }
    req.node = result.rows[0];
    next();
  } catch (err) {
    console.error('Auth Middleware Error:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
}

// For JWT widget token
function authenticateWidgetToken(req, res, next) {
  const widgetToken = req.headers['x-widget-token'] || req.headers['authorization']?.replace('Bearer ', '');
  if (!widgetToken) {
    return res.status(401).json({ error: 'Missing x-widget-token header' });
  }
  try {
    const decoded = jwt.verify(widgetToken, JWT_SECRET);
    req.publisherNodeId = decoded.nodeId;
    req.nodeDomain = decoded.domain;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired widget token' });
  }
}

// -------------------- API Endpoints --------------------

// 1. Register Node
app.post('/v1/node/register', async (req, res) => {
  let { appName, domain, category } = req.body;
  if (!appName || !domain || !category) {
    return res.status(400).json({ error: 'appName, domain, and category are required' });
  }

  appName = String(appName).trim().slice(0, 60);
  let cleanDomain = String(domain).trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/\/.*$/, '').slice(0, 255);
  category = String(category).trim().slice(0, 50);

  if (!isValidDomain(cleanDomain)) {
    return res.status(400).json({ error: 'Invalid domain format. Example: myapp.com' });
  }

  const apiKey = 'aen_live_' + crypto.randomBytes(16).toString('hex');

  try {
    const result = await pool.query(
      `INSERT INTO nodes (app_name, domain, category, api_key, credits)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, app_name AS "appName", domain, category, api_key AS "apiKey", credits`,
      [appName, cleanDomain, category, apiKey, parseInt(FREE_CREDITS)]
    );
    res.status(201).json({
      message: 'Node registered successfully',
      ...result.rows[0]
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Domain is already registered in the network' });
    }
    console.error('Register Node Error:', err);
    res.status(500).json({ error: 'Failed to register node' });
  }
});

// 2. Issue Widget Token (uses API key)
app.post('/v1/widget/token', async (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey) {
    return res.status(400).json({ error: 'apiKey is required' });
  }
  try {
    const result = await pool.query('SELECT id, domain FROM nodes WHERE api_key = $1', [apiKey]);
    if (result.rows.length === 0) {
      return res.status(403).json({ error: 'Invalid API Key' });
    }
    const node = result.rows[0];
    const token = jwt.sign(
      { nodeId: node.id, domain: node.domain },
      JWT_SECRET,
      { expiresIn: WIDGET_JWT_EXPIRY }
    );
    res.json({ token });
  } catch (err) {
    console.error('Widget Token Error:', err);
    res.status(500).json({ error: 'Failed to issue widget token' });
  }
});

// 3. Launch Campaign (deducts 1 credit upfront)
app.post('/v1/campaign/create', authenticateApiKey, async (req, res) => {
  let { title, description, targetUrl, ctaText } = req.body;
  if (!title || !description || !targetUrl) {
    return res.status(400).json({ error: 'title, description, and targetUrl are required' });
  }
  if (!isValidUrl(targetUrl)) {
    return res.status(400).json({ error: 'Invalid targetUrl format. Must start with http:// or https://' });
  }

  title = String(title).trim().slice(0, 100);
  description = String(description).trim().slice(0, 280);
  ctaText = String(ctaText || 'Visit →').trim().slice(0, 30);

  const node = req.node;
  if (node.credits < 1) {
    return res.status(403).json({ error: 'Insufficient credits to launch campaign (need 1 credit).' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const updateRes = await client.query(
      'UPDATE nodes SET credits = credits - 1 WHERE id = $1 AND credits > 0 RETURNING credits',
      [node.id]
    );
    if (updateRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Failed to deduct credit. Insufficient balance.' });
    }

    const campaignResult = await client.query(
      `INSERT INTO campaigns (node_id, title, description, target_url, cta_text)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, title, description, target_url AS "targetUrl", cta_text AS "ctaText"`,
      [node.id, title, description, targetUrl, ctaText]
    );

    await client.query('COMMIT');
    res.status(201).json({
      message: 'Campaign launched successfully (1 credit deducted)',
      campaign: campaignResult.rows[0],
      remainingCredits: updateRes.rows[0].credits
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Create Campaign Error:', err);
    res.status(500).json({ error: 'Failed to create campaign' });
  } finally {
    client.release();
  }
});

// 4. Recommendation Engine
app.get('/v1/recommendation',
  authenticateWidgetToken,
  nodeRateLimiter(60 * 1000, parseInt(RATE_LIMIT_REC_PER_NODE), 'Too many recommendation requests.'),
  async (req, res) => {
    const publisherNodeId = req.publisherNodeId;
    const nodeDomain = req.nodeDomain;

    const reqOrigin = req.headers['origin'] || req.headers['referer'] || '';
    if (reqOrigin && !reqOrigin.includes('localhost') && !reqOrigin.includes('127.0.0.1')) {
      if (!reqOrigin.includes(nodeDomain)) {
        return res.status(403).json({ error: 'Domain origin mismatch. Widget token restricted to registered domain.' });
      }
    }

    try {
      const result = await pool.query(
        `SELECT c.id, c.title, c.description, c.target_url, c.cta_text, c.node_id
         FROM campaigns c
         JOIN nodes n ON c.node_id = n.id
         WHERE c.is_active = true
           AND c.node_id != $1
           AND n.credits > 0
         ORDER BY RANDOM()
         LIMIT 1`,
        [publisherNodeId]
      );

      if (result.rows.length === 0) {
        return res.json({ recommendation: null });
      }

      const campaign = result.rows[0];
      const clickToken = crypto.randomBytes(32).toString('hex');
      await pool.query(
        'INSERT INTO click_tokens (token, publisher_node_id, campaign_id) VALUES ($1, $2, $3)',
        [clickToken, publisherNodeId, campaign.id]
      );

      res.json({
        recommendation: {
          title: campaign.title,
          description: campaign.description,
          targetUrl: campaign.target_url,
          ctaText: campaign.cta_text,
          clickToken: clickToken
        }
      });
    } catch (err) {
      console.error('Recommendation Error:', err);
      res.status(500).json({ error: 'Failed to fetch recommendation' });
    }
  }
);

// 5. Atomic Credit Settlement
app.post('/v1/event',
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: parseInt(RATE_LIMIT_CLICK_PER_NODE) || 10,
    message: { error: 'Too many click events from this IP.' }
  }),
  async (req, res) => {
    const { clickToken } = req.body;
    if (!clickToken) {
      return res.status(400).json({ error: 'clickToken is required' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Consume token: must be unused and within TTL
      const tokenResult = await client.query(
        `UPDATE click_tokens
         SET is_used = true
         WHERE token = $1
           AND is_used = false
           AND created_at >= NOW() - INTERVAL '${TOKEN_TTL_MINUTES} minutes'
         RETURNING publisher_node_id, campaign_id`,
        [clickToken]
      );

      if (tokenResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Invalid, used, or expired click token' });
      }

      const { publisher_node_id, campaign_id } = tokenResult.rows[0];

      // Find advertiser node
      const campaignRes = await client.query(
        'SELECT node_id FROM campaigns WHERE id = $1',
        [campaign_id]
      );
      if (campaignRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Campaign not found' });
      }
      const advertiserNodeId = campaignRes.rows[0].node_id;

      // Deduct 1 credit from advertiser
      const deductRes = await client.query(
        'UPDATE nodes SET credits = credits - 1 WHERE id = $1 AND credits > 0 RETURNING credits',
        [advertiserNodeId]
      );
      if (deductRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Advertiser has insufficient credits' });
      }

      // Add 1 credit to publisher
      await client.query(
        'UPDATE nodes SET credits = credits + 1 WHERE id = $1',
        [publisher_node_id]
      );

      await client.query('COMMIT');
      res.json({ message: 'Click settled successfully' });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Event Settlement Error:', err);
      res.status(500).json({ error: 'Failed to process event' });
    } finally {
      client.release();
    }
  }
);

// 6. Node Balance
app.get('/v1/node/balance', authenticateApiKey, async (req, res) => {
  res.json({ credits: req.node.credits, nodeId: req.node.id });
});

// 7. Dashboard Data
app.get('/v1/dashboard', async (req, res) => {
  try {
    const nodes = await pool.query(
      `SELECT id, app_name AS "appName", domain, category, credits
       FROM nodes ORDER BY created_at DESC`
    );
    const campaigns = await pool.query(
      `SELECT id, title, description, target_url AS "targetUrl", cta_text AS "ctaText", is_active AS "isActive"
       FROM campaigns ORDER BY created_at DESC LIMIT 50`
    );
    const events = await pool.query(
      `SELECT token, publisher_node_id AS "publisherNodeId", campaign_id AS "campaignId", created_at AS "timestamp"
       FROM click_tokens
       WHERE is_used = true
       ORDER BY created_at DESC
       LIMIT 50`
    );

    res.json({
      nodes: nodes.rows,
      campaigns: campaigns.rows,
      recentEvents: events.rows
    });
  } catch (err) {
    console.error('Dashboard Error:', err);
    res.status(500).json({ error: 'Failed to fetch dashboard data' });
  }
});

// 8. Health Check
app.get('/', (req, res) => {
  res.json({ status: 'AEN Backend Operational', timestamp: new Date().toISOString() });
});

// Start Server
app.listen(PORT, () => {
  console.log(`AEN Secure Server running on port ${PORT}`);
});
