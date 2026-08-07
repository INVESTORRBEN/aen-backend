const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// 1. Health check
app.get('/', (req, res) => {
  res.json({ status: 'online', network: 'AEN Autonomous Distribution Network v1.0' });
});

// 2. Register a new builder app node
app.post('/v1/nodes', async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Missing node/app name' });

  try {
    const nodeId = crypto.randomUUID(); // Generates a valid PostgreSQL UUID
    const apiKey = 'key_' + crypto.randomBytes(12).toString('hex');
    const starterCredits = 20.0000;

    const result = await pool.query(
      `INSERT INTO nodes (id, name, api_key, credit_balance) 
       VALUES ($1, $2, $3, $4) 
       RETURNING id, name, api_key AS "apiKey", credit_balance AS "creditBalance"`,
      [nodeId, name, apiKey, starterCredits]
    );

    res.status(201).json({
      message: 'App node successfully registered',
      node: result.rows[0]
    });
  } catch (err) {
    console.error('Registration Error:', err);
    res.status(500).json({ error: 'Failed to register app node', details: err.message });
  }
});


// 3. Publish a new recommendation campaign
app.post('/v1/recommendations', async (req, res) => {
  const { apiKey, title, description, targetUrl, ctaText } = req.body;
  if (!apiKey || !title || !description || !targetUrl) {
    return res.status(400).json({ error: 'Missing required parameters (apiKey, title, description, targetUrl)' });
  }

  try {
    const nodeRes = await pool.query('SELECT id FROM nodes WHERE api_key = $1', [apiKey]);
    if (nodeRes.rows.length === 0) return res.status(401).json({ error: 'Invalid API Key' });

    const nodeId = nodeRes.rows[0].id;
    const cta = ctaText || 'Learn More';

    const result = await pool.query(
      `INSERT INTO recommendations (node_id, title, description, target_url, cta_text, is_active)
       VALUES ($1, $2, $3, $4, $5, true)
       RETURNING id, title, description, target_url AS "targetUrl", cta_text AS "ctaText"`,
      [nodeId, title, description, targetUrl, cta]
    );

    res.status(201).json({
      message: 'Campaign published successfully',
      recommendation: result.rows[0]
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to publish recommendation' });
  }
});

// 4. Serve matching cross-promotion to widget
app.get('/v1/recommendation', async (req, res) => {
  const { apiKey } = req.query;
  if (!apiKey) return res.status(400).json({ error: 'Missing apiKey' });

  try {
    const publisherRes = await pool.query('SELECT id FROM nodes WHERE api_key = $1', [apiKey]);
    if (publisherRes.rows.length === 0) return res.status(401).json({ error: 'Invalid API Key' });
    const publisherId = publisherRes.rows[0].id;

    const recRes = await pool.query(`
      SELECT 
        r.id AS "recommendationId",
        r.node_id AS "advertiserNodeId",
        r.title,
        r.description,
        COALESCE(r.target_url, 'https://github.com') AS "targetUrl",
        r.cta_text AS "ctaText"
      FROM recommendations r
      JOIN nodes n ON r.node_id = n.id
      WHERE r.node_id != $1 AND r.is_active = true AND n.credit_balance > 0
      ORDER BY RANDOM()
      LIMIT 1
    `, [publisherId]);

    if (recRes.rows.length === 0) return res.status(404).json({ error: 'No active recommendations available' });

    res.json(recRes.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 5. Settle credit transfer on impression / click event
app.post('/v1/event', async (req, res) => {
  const { apiKey, recommendationId, advertiserNodeId, dwellSeconds, visitorHash } = req.body;
  if (!apiKey || !recommendationId || !advertiserNodeId) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  try {
    const pubRes = await pool.query('SELECT id FROM nodes WHERE api_key = $1', [apiKey]);
    if (pubRes.rows.length === 0) return res.status(401).json({ error: 'Invalid API Key' });
    const publisherNodeId = pubRes.rows[0].id;

    const isQualified = true;

    const eventRes = await pool.query(`
      INSERT INTO qau_events (publisher_node_id, advertiser_node_id, recommendation_id, visitor_hash, dwell_seconds, is_qualified)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id
    `, [publisherNodeId, advertiserNodeId, recommendationId, visitorHash || 'anon_visitor', dwellSeconds || 3, isQualified]);

    const qauAmount = 1.0000;
    await pool.query('UPDATE nodes SET credit_balance = credit_balance - $1 WHERE id = $2', [qauAmount, advertiserNodeId]);
    await pool.query('UPDATE nodes SET credit_balance = credit_balance + $1 WHERE id = $2', [qauAmount, publisherNodeId]);
    await pool.query(`
      INSERT INTO credit_ledger (from_node_id, to_node_id, qau_event_id, amount, transaction_type)
      VALUES ($1, $2, $3, $4, 'QAU_EARNED')
    `, [advertiserNodeId, publisherNodeId, eventRes.rows[0].id, qauAmount]);

    res.json({ success: true, qualified: isQualified });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to record event' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
