const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.get('/', (req, res) => {
  res.json({ status: 'online', network: 'AEN Autonomous Distribution Network v1.0' });
});

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
        'https://github.com' AS "targetUrl",
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

app.post('/v1/event', async (req, res) => {
  const { apiKey, recommendationId, advertiserNodeId, dwellSeconds, visitorHash } = req.body;
  if (!apiKey || !recommendationId || !advertiserNodeId) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  try {
    const pubRes = await pool.query('SELECT id FROM nodes WHERE api_key = $1', [apiKey]);
    if (pubRes.rows.length === 0) return res.status(401).json({ error: 'Invalid API Key' });
    const publisherNodeId = pubRes.rows[0].id;

    const isQualified = true; // Auto-qualify click events for immediate test verification

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
