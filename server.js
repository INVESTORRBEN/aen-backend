const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');

const app = express();

app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());

// Initialize PostgreSQL Connection Pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Auto-create database schema on startup
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS nodes (
      node_id TEXT PRIMARY KEY,
      api_key TEXT UNIQUE NOT NULL,
      app_name TEXT NOT NULL,
      domain TEXT NOT NULL,
      category TEXT NOT NULL,
      credits INT NOT NULL DEFAULT 20,
      registered_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS campaigns (
      campaign_id TEXT PRIMARY KEY,
      node_id TEXT REFERENCES nodes(node_id),
      title TEXT NOT NULL,
      description TEXT,
      target_url TEXT NOT NULL,
      cta_text TEXT DEFAULT 'Learn More',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS events (
      event_id TEXT PRIMARY KEY,
      publisher_node_id TEXT REFERENCES nodes(node_id),
      advertiser_node_id TEXT REFERENCES nodes(node_id),
      campaign_id TEXT REFERENCES campaigns(campaign_id),
      timestamp TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log("PostgreSQL Database tables verified & ready.");
}

initDb().catch(err => console.error("Database initialization error:", err));

// Rate Limiter: Max 5 click events per real IP every 15 minutes
const clickRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: "Too many clicks from this IP. Credit settlement throttled."
  }
});

// 1. Health check endpoint
app.get('/', async (req, res) => {
  try {
    const nodesCount = await pool.query('SELECT COUNT(*) FROM nodes');
    const campaignsCount = await pool.query('SELECT COUNT(*) FROM campaigns');
    res.json({ 
      status: "AEN Backend Operational (PostgreSQL Persistent Storage)", 
      nodesCount: parseInt(nodesCount.rows[0].count), 
      activeCampaigns: parseInt(campaignsCount.rows[0].count) 
    });
  } catch (err) {
    res.status(500).json({ error: "Health check error" });
  }
});

// 2. Node registration endpoint
app.post('/v1/node/register', async (req, res) => {
  const { appName, domain, category } = req.body || {};
  if (!appName || !domain) {
    return res.status(400).json({ error: "Missing required fields: appName, domain" });
  }

  const nodeId = 'node_' + Math.random().toString(36).substr(2, 9);
  const apiKey = 'key_' + Math.random().toString(36).substr(2, 16) + Math.random().toString(36).substr(2, 8);

  try {
    await pool.query(
      `INSERT INTO nodes (node_id, api_key, app_name, domain, category, credits) VALUES ($1, $2, $3, $4, $5, $6)`,
      [nodeId, apiKey, appName.trim(), domain.trim(), category || 'General', 20]
    );

    return res.status(201).json({ success: true, nodeId, apiKey, credits: 20 });
  } catch (err) {
    console.error("Register Error:", err);
    return res.status(500).json({ error: "Database error registering node" });
  }
});

// 3. Launch campaign endpoint
app.post('/v1/campaign/create', async (req, res) => {
  const { apiKey, title, description, targetUrl, ctaText } = req.body || {};
  
  if (!apiKey || !title || !targetUrl) {
    return res.status(400).json({ error: "Missing required campaign fields" });
  }

  try {
    const nodeRes = await pool.query(`SELECT * FROM nodes WHERE api_key = $1`, [apiKey]);
    if (nodeRes.rows.length === 0) {
      return res.status(401).json({ error: "Invalid API key" });
    }
    const node = nodeRes.rows[0];

    if (node.credits < 1) {
      return res.status(403).json({ error: "Insufficient credits to launch campaign" });
    }

    let formattedUrl = targetUrl.trim();
    if (!formattedUrl.startsWith('http://') && !formattedUrl.startsWith('https://')) {
      formattedUrl = 'https://' + formattedUrl;
    }

    const campaignId = 'camp_' + Math.random().toString(36).substr(2, 9);
    await pool.query(
      `INSERT INTO campaigns (campaign_id, node_id, title, description, target_url, cta_text) VALUES ($1, $2, $3, $4, $5, $6)`,
      [campaignId, node.node_id, title.trim(), (description || '').trim(), formattedUrl, (ctaText || "Learn More").trim()]
    );

    return res.status(201).json({
      success: true,
      campaign: { campaignId, nodeId: node.node_id, title, description, targetUrl: formattedUrl, ctaText }
    });
  } catch (err) {
    console.error("Campaign Create Error:", err);
    return res.status(500).json({ error: "Database error launching campaign" });
  }
});

// 4. Recommendation ad fetch endpoint
app.get('/v1/recommendation', async (req, res) => {
  const apiKey = req.headers['x-api-key'] || req.query.apiKey;

  try {
    const pubRes = await pool.query(`SELECT * FROM nodes WHERE api_key = $1`, [apiKey]);
    if (pubRes.rows.length === 0) {
      return res.status(401).json({ error: "Invalid API key" });
    }
    const publisherNode = pubRes.rows[0];

    // Fetch active third-party campaigns where advertiser has credits >= 1
    const campRes = await pool.query(`
      SELECT c.* 
      FROM campaigns c
      JOIN nodes n ON c.node_id = n.node_id
      WHERE c.node_id != $1 AND n.credits >= 1
    `, [publisherNode.node_id]);

    if (campRes.rows.length === 0) {
      return res.status(200).json({ recommendation: null, message: "No active third-party campaigns available." });
    }

    const selected = campRes.rows[Math.floor(Math.random() * campRes.rows.length)];
    return res.status(200).json({
      recommendation: {
        campaignId: selected.campaign_id,
        nodeId: selected.node_id,
        title: selected.title,
        description: selected.description,
        targetUrl: selected.target_url,
        ctaText: selected.cta_text
      }
    });
  } catch (err) {
    console.error("Recommendation Fetch Error:", err);
    return res.status(500).json({ error: "Database error fetching recommendation" });
  }
});

// 5. Click conversion endpoint (Atomic Transaction)
app.post('/v1/event', clickRateLimiter, async (req, res) => {
  const body = req.body || {};
  const apiKey = body.apiKey;
  const campaignId = body.campaignId || body.recommendationId;

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const pubRes = await client.query(`SELECT * FROM nodes WHERE api_key = $1 FOR UPDATE`, [apiKey]);
    if (pubRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(401).json({ error: "Invalid API key" });
    }
    const publisherNode = pubRes.rows[0];

    const campRes = await client.query(`SELECT * FROM campaigns WHERE campaign_id = $1`, [campaignId]);
    if (campRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: "Campaign not found" });
    }
    const campaign = campRes.rows[0];

    const advRes = await client.query(`SELECT * FROM nodes WHERE node_id = $1 FOR UPDATE`, [campaign.node_id]);
    if (advRes.rows.length === 0 || advRes.rows[0].credits < 1) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: "Advertiser balance exhausted" });
    }
    const advertiserNode = advRes.rows[0];

    // Atomically transfer 1 credit
    await client.query(`UPDATE nodes SET credits = credits - 1 WHERE node_id = $1`, [advertiserNode.node_id]);
    await client.query(`UPDATE nodes SET credits = credits + 1 WHERE node_id = $1`, [publisherNode.node_id]);

    const eventId = 'evt_' + Math.random().toString(36).substr(2, 9);
    await client.query(
      `INSERT INTO events (event_id, publisher_node_id, advertiser_node_id, campaign_id) VALUES ($1, $2, $3, $4)`,
      [eventId, publisherNode.node_id, advertiserNode.node_id, campaignId]
    );

    await client.query('COMMIT');

    return res.status(200).json({
      success: true,
      message: "Credit transfer settled",
      publisherCredits: publisherNode.credits + 1
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error("Event Settlement Error:", err);
    return res.status(500).json({ error: "Database transaction failed" });
  } finally {
    client.release();
  }
});

// 6. Live network dashboard endpoint
app.get('/v1/dashboard', async (req, res) => {
  try {
    const nodesRes = await pool.query(
      `SELECT node_id AS "nodeId", app_name AS "appName", domain, category, credits, registered_at AS "registeredAt" FROM nodes ORDER BY registered_at DESC`
    );
    const campRes = await pool.query(
      `SELECT campaign_id AS "campaignId", node_id AS "nodeId", title, description, target_url AS "targetUrl", cta_text AS "ctaText", created_at AS "createdAt" FROM campaigns ORDER BY created_at DESC`
    );
    const eventRes = await pool.query(
      `SELECT event_id AS "eventId", publisher_node_id AS "publisherNodeId", advertiser_node_id AS "advertiserNodeId", campaign_id AS "campaignId", timestamp FROM events ORDER BY timestamp DESC LIMIT 50`
    );

    return res.status(200).json({
      timestamp: new Date().toISOString(),
      summary: {
        totalNodes: nodesRes.rows.length,
        totalCampaigns: campRes.rows.length,
        totalTransactions: eventRes.rows.length
      },
      nodes: nodesRes.rows,
      campaigns: campRes.rows,
      recentEvents: eventRes.rows
    });
  } catch (err) {
    console.error("Dashboard Fetch Error:", err);
    return res.status(500).json({ error: "Database error fetching dashboard" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`AEN Backend running on port ${PORT}`);
});
