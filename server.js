const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();

app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

app.get('/v1/recommendation', async (req, res) => {
  try {
    const { apiKey } = req.query;

    const pubRes = await pool.query(
      'SELECT * FROM nodes WHERE api_key = $1',
      [apiKey]
    );

    if (pubRes.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid API Key' });
    }

    const publisher = pubRes.rows[0];

    const recQuery = `
      SELECT 
        r.id,
        r.title,
        r.description,
        r.target_url,
        r.cta_text,
        n.id AS advertiser_node_id
      FROM recommendations r
      JOIN nodes n ON r.node_id = n.id
      WHERE n.id != $1
        AND n.credit_balance > 0
        AND r.is_active = TRUE
      ORDER BY n.distribution_score DESC, RANDOM()
      LIMIT 1;
    `;

    const recRes = await pool.query(recQuery, [publisher.id]);

    if (recRes.rows.length === 0) {
      return res.status(404).json({
        error: 'No available recommendations'
      });
    }

    const rec = recRes.rows[0];

    res.json({
      recommendationId: rec.id,
      advertiserNodeId: rec.advertiser_node_id,
      title: rec.title,
      description: rec.description,
      targetUrl: rec.target_url,
      ctaText: rec.cta_text
    });

  } catch (err) {
    res.status(500).json({
      error: err.message
    });
  }
});


app.post('/v1/qau/verify', async (req, res) => {

  const client = await pool.connect();

  try {

    const {
      apiKey,
      recommendationId,
      advertiserNodeId,
      dwellTime,
      visitorIp,
      userAgent
    } = req.body;


    const pubRes = await client.query(
      'SELECT id FROM nodes WHERE api_key = $1',
      [apiKey]
    );


    if (pubRes.rows.length === 0) {
      return res.status(401).json({
        error: 'Unauthorized'
      });
    }


    const publisherId = pubRes.rows[0].id;


    if (dwellTime < 30) {
      return res.status(400).json({
        status: 'Ignored',
        reason: 'Dwell time under 30 seconds'
      });
    }


    const visitorHash = crypto
      .createHash('sha256')
      .update(`${visitorIp || 'unknown'}-${userAgent || 'unknown'}`)
      .digest('hex');


    await client.query('BEGIN');


    const qauRes = await client.query(
      `
      INSERT INTO qau_events
      (
        publisher_node_id,
        advertiser_node_id,
        recommendation_id,
        visitor_hash,
        dwell_seconds,
        is_qualified
      )

      VALUES ($1,$2,$3,$4,$5,TRUE)

      RETURNING id
      `,
      [
        publisherId,
        advertiserNodeId,
        recommendationId,
        visitorHash,
        dwellTime
      ]
    );


    const qauEventId = qauRes.rows[0].id;


    await client.query(
      `
      UPDATE nodes
      SET credit_balance = credit_balance - 1.0
      WHERE id = $1
      `,
      [advertiserNodeId]
    );


    await client.query(
      `
      UPDATE nodes
      SET credit_balance = credit_balance + 1.0
      WHERE id = $1
      `,
      [publisherId]
    );


    await client.query(
      `
      INSERT INTO credit_ledger
      (
        from_node_id,
        to_node_id,
        qau_event_id,
        amount,
        transaction_type
      )

      VALUES ($1,$2,$3,1.0,'QAU_EARNED')
      `,
      [
        advertiserNodeId,
        publisherId,
        qauEventId
      ]
    );


    await client.query('COMMIT');


    res.json({
      status: 'Success',
      message: 'Credit Transferred'
    });


  } catch (err) {

    await client.query('ROLLBACK');

    res.status(500).json({
      error: err.message
    });


  } finally {

    client.release();

  }

});


const PORT = process.env.PORT || 3000;


app.listen(PORT, () => {
  console.log(`Server live on port ${PORT}`);
});