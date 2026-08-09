const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const crypto = require('crypto');

const app = express();

// -------------------- Environment Configuration --------------------
const {
  PORT = 3000,
  DATABASE_URL,
  FREE_CREDITS = 20,
  TOKEN_TTL_MINUTES = 10,
  RATE_LIMIT_REC_PER_NODE = 60,
  RATE_LIMIT_CLICK_PER_NODE = 10,
  CORS_ORIGIN = '*'
} = process.env;

if (!DATABASE_URL) {
  console.error('FATAL: DATABASE_URL environment variable is missing.');
  process.exit(1);
}

app.set('trust proxy', 1);

app.use(express.json({ limit: '10kb' }));

app.use(cors({
  origin: CORS_ORIGIN,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'x-api-key',
    'x-aen-key',
    'Authorization'
  ]
}));

// -------------------- Database Setup --------------------
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false }
});

// -------------------- Helpers --------------------

const isValidDomain = (domain) => {
  const domainRegex =
    /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;

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

// Normalize a domain so example.com and www.example.com
// are treated consistently.
function normalizeDomain(domain) {
  return String(domain)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '')
    .replace(/\.$/, '')
    .slice(0, 255);
}

// Generate a short public key for the embed widget.
// This key is safe to expose in website HTML.
// It is NOT the private API key.
function generateEmbedKey(length = 10) {
  const alphabet =
    'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

  let result = '';

  while (result.length < length) {
    const bytes = crypto.randomBytes(length);

    for (const byte of bytes) {
      if (byte < 248) {
        result += alphabet[byte % alphabet.length];

        if (result.length === length) {
          break;
        }
      }
    }
  }

  return result;
}

// Check whether a request originated from the node's registered domain.
function isAllowedNodeOrigin(req, registeredDomain) {
  const normalizedRegisteredDomain = normalizeDomain(registeredDomain);

  const origin = req.headers.origin;
  const referer = req.headers.referer;

  // Local development.
  if (
    origin === 'http://localhost' ||
    origin === 'https://localhost' ||
    origin?.startsWith('http://localhost:') ||
    origin?.startsWith('https://localhost:') ||
    origin?.startsWith('http://127.0.0.1:') ||
    origin?.startsWith('https://127.0.0.1:')
  ) {
    return true;
  }

  // Prefer Origin because it gives us the site's origin.
  if (origin) {
    try {
      const originUrl = new URL(origin);
      const hostname = normalizeDomain(originUrl.hostname);

      return (
        hostname === normalizedRegisteredDomain ||
        hostname === `www.${normalizedRegisteredDomain}`
      );
    } catch (_) {
      return false;
    }
  }

  // Some environments may send Referer but no Origin.
  if (referer) {
    try {
      const refererUrl = new URL(referer);
      const hostname = normalizeDomain(refererUrl.hostname);

      return (
        hostname === normalizedRegisteredDomain ||
        hostname === `www.${normalizedRegisteredDomain}`
      );
    } catch (_) {
      return false;
    }
  }

  // No trustworthy origin information.
  return false;
}

// -------------------- Database Initialisation --------------------

async function initDb() {
  const client = await pool.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS nodes (
        id SERIAL PRIMARY KEY,
        app_name VARCHAR(60) NOT NULL,
        domain VARCHAR(255) UNIQUE NOT NULL,
        category VARCHAR(50) NOT NULL,
        api_key VARCHAR(64) UNIQUE NOT NULL,
        embed_key VARCHAR(32) UNIQUE,
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

      CREATE INDEX IF NOT EXISTS idx_nodes_embed_key
      ON nodes(embed_key);
    `);

    // Existing installations created before embed_key existed
    // need the new column.
    await client.query(`
      ALTER TABLE nodes
      ADD COLUMN IF NOT EXISTS embed_key VARCHAR(32) UNIQUE
    `);

    // Give existing nodes their own embed key.
    const existingNodes = await client.query(`
      SELECT id
      FROM nodes
      WHERE embed_key IS NULL
    `);

    for (const node of existingNodes.rows) {
      let embedKey;
      let inserted = false;

      while (!inserted) {
        embedKey = generateEmbedKey();

        try {
          await client.query(
            `UPDATE nodes SET embed_key = $1 WHERE id = $2`,
            [embedKey, node.id]
          );

          inserted = true;
        } catch (err) {
          if (err.code !== '23505') {
            throw err;
          }
        }
      }
    }

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_nodes_embed_key_unique
      ON nodes(embed_key)
    `);

    console.log(
      'Database tables verified successfully. AEN is ready for real nodes.'
    );
  } catch (err) {
    console.error('Database init error:', err);
    process.exit(1);
  } finally {
    client.release();
  }
}

initDb();

// -------------------- Background Cleanup --------------------

setInterval(async () => {
  try {
    const res = await pool.query(
      `DELETE FROM click_tokens
       WHERE (is_used = true AND created_at < NOW() - INTERVAL '24 hours')
          OR (is_used = false AND created_at < NOW() - INTERVAL '${parseInt(TOKEN_TTL_MINUTES)} minutes')`
    );

    if (res.rowCount > 0) {
      console.log(
        `Cleaned up ${res.rowCount} expired/old click tokens.`
      );
    }
  } catch (err) {
    console.error('Token cleanup error:', err);
  }
}, 5 * 60 * 1000);

// -------------------- Rate Limiters --------------------

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: {
    error: 'Too many requests, please try again later.'
  }
});

app.use(globalLimiter);

// Per-node in-memory limiter.
const nodeRateLimitStore = {};

function nodeRateLimiter(windowMs, max, message) {
  return (req, res, next) => {
    const nodeId =
      req.node?.id ||
      req.publisherNodeId;

    if (!nodeId) {
      return next();
    }

    const key = `node:${nodeId}:${windowMs}`;
    const now = Date.now();

    if (!nodeRateLimitStore[key]) {
      nodeRateLimitStore[key] = {
        count: 0,
        resetTime: now + windowMs
      };
    }

    const record = nodeRateLimitStore[key];

    if (now > record.resetTime) {
      record.count = 0;
      record.resetTime = now + windowMs;
    }

    record.count++;

    if (record.count > max) {
      return res.status(429).json({
        error: message || 'Node rate limit exceeded.'
      });
    }

    next();
  };
}

// -------------------- Private API Key Authentication --------------------

async function authenticateApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'];

  if (!apiKey) {
    return res.status(401).json({
      error: 'Missing x-api-key header'
    });
  }

  try {
    const result = await pool.query(
      'SELECT * FROM nodes WHERE api_key = $1',
      [apiKey]
    );

    if (result.rows.length === 0) {
      return res.status(403).json({
        error: 'Invalid API Key'
      });
    }

    req.node = result.rows[0];

    next();
  } catch (err) {
    console.error('Auth Middleware Error:', err);

    res.status(500).json({
      error: 'Internal Server Error'
    });
  }
}

// -------------------- Public Embed-Key Authentication --------------------

async function authenticateEmbedKey(req, res, next) {
  const embedKey =
    req.headers['x-aen-key'] ||
    req.query.embedKey;

  if (!embedKey) {
    return res.status(401).json({
      error: 'Missing AEN embed key'
    });
  }

  if (!/^[A-Za-z0-9]{10}$/.test(embedKey)) {
    return res.status(401).json({
      error: 'Invalid AEN embed key format'
    });
  }

  try {
    const result = await pool.query(
      `SELECT id, domain, embed_key
       FROM nodes
       WHERE embed_key = $1`,
      [embedKey]
    );

    if (result.rows.length === 0) {
      return res.status(403).json({
        error: 'Invalid AEN embed key'
      });
    }

    const node = result.rows[0];

    if (!isAllowedNodeOrigin(req, node.domain)) {
      return res.status(403).json({
        error:
          'Domain origin mismatch. This AEN widget is restricted to its registered domain.'
      });
    }

    req.publisherNodeId = node.id;
    req.nodeDomain = node.domain;

    next();
  } catch (err) {
    console.error('Embed Authentication Error:', err);

    res.status(500).json({
      error: 'Internal Server Error'
    });
  }
}

// -------------------- API Endpoints --------------------

// 1. Register Node

app.post('/v1/node/register', async (req, res) => {
  let {
    appName,
    domain,
    category
  } = req.body;

  if (!appName || !domain || !category) {
    return res.status(400).json({
      error: 'appName, domain, and category are required'
    });
  }

  appName = String(appName)
    .trim()
    .slice(0, 60);

  const cleanDomain = normalizeDomain(domain);

  category = String(category)
    .trim()
    .slice(0, 50);

  if (!isValidDomain(cleanDomain)) {
    return res.status(400).json({
      error:
        'Invalid domain format. Example: myapp.com'
    });
  }

  const apiKey =
    'aen_live_' +
    crypto.randomBytes(16).toString('hex');

  const embedKey = generateEmbedKey();

  try {
    const result = await pool.query(
      `INSERT INTO nodes
       (
         app_name,
         domain,
         category,
         api_key,
         embed_key,
         credits
       )
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING
         id,
         app_name AS "appName",
         domain,
         category,
         api_key AS "apiKey",
         embed_key AS "embedKey",
         credits`,
      [
        appName,
        cleanDomain,
        category,
        apiKey,
        embedKey,
        parseInt(FREE_CREDITS)
      ]
    );

    res.status(201).json({
      message: 'Node registered successfully',
      ...result.rows[0]
    });
  } catch (err) {
    if (err.code === '23505') {
      if (err.constraint?.includes('domain')) {
        return res.status(400).json({
          error:
            'Domain is already registered in the network'
        });
      }

      return res.status(400).json({
        error:
          'Unable to generate a unique embed key. Please try again.'
      });
    }

    console.error('Register Node Error:', err);

    res.status(500).json({
      error: 'Failed to register node'
    });
  }
});

// 2. Get Widget Information

// This endpoint uses the PRIVATE API key.
// It is only used by the developer portal.
// The public website never needs this endpoint.

app.post(
  '/v1/widget/info',
  authenticateApiKey,
  async (req, res) => {
    try {
      res.json({
        embedKey: req.node.embed_key,
        domain: req.node.domain,
        nodeId: req.node.id
      });
    } catch (err) {
      console.error('Widget Info Error:', err);

      res.status(500).json({
        error: 'Failed to retrieve widget information'
      });
    }
  }
);

// 3. Launch Campaign

app.post(
  '/v1/campaign/create',
  authenticateApiKey,
  async (req, res) => {
    let {
      title,
      description,
      targetUrl,
      ctaText
    } = req.body;

    if (!title || !description || !targetUrl) {
      return res.status(400).json({
        error:
          'title, description, and targetUrl are required'
      });
    }

    if (!isValidUrl(targetUrl)) {
      return res.status(400).json({
        error:
          'Invalid targetUrl format. Must start with http:// or https://'
      });
    }

    title = String(title)
      .trim()
      .slice(0, 100);

    description = String(description)
      .trim()
      .slice(0, 280);

    ctaText = String(ctaText || 'Visit →')
      .trim()
      .slice(0, 30);

    const node = req.node;

    if (node.credits < 1) {
      return res.status(403).json({
        error:
          'Insufficient credits to launch campaign (need 1 credit).'
      });
    }

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const updateRes = await client.query(
        `UPDATE nodes
         SET credits = credits - 1
         WHERE id = $1
           AND credits > 0
         RETURNING credits`,
        [node.id]
      );

      if (updateRes.rows.length === 0) {
        await client.query('ROLLBACK');

        return res.status(400).json({
          error:
            'Failed to deduct credit. Insufficient balance.'
        });
      }

      const campaignResult = await client.query(
        `INSERT INTO campaigns
         (
           node_id,
           title,
           description,
           target_url,
           cta_text
         )
         VALUES ($1, $2, $3, $4, $5)
         RETURNING
           id,
           title,
           description,
           target_url AS "targetUrl",
           cta_text AS "ctaText"`,
        [
          node.id,
          title,
          description,
          targetUrl,
          ctaText
        ]
      );

      await client.query('COMMIT');

      res.status(201).json({
        message:
          'Campaign launched successfully (1 credit deducted)',
        campaign: campaignResult.rows[0],
        remainingCredits:
          updateRes.rows[0].credits
      });
    } catch (err) {
      await client.query('ROLLBACK');

      console.error(
        'Create Campaign Error:',
        err
      );

      res.status(500).json({
        error: 'Failed to create campaign'
      });
    } finally {
      client.release();
    }
  }
);

// 4. Recommendation Engine

app.get(
  '/v1/recommendation',
  authenticateEmbedKey,
  nodeRateLimiter(
    60 * 1000,
    parseInt(RATE_LIMIT_REC_PER_NODE),
    'Too many recommendation requests.'
  ),
  async (req, res) => {
    const publisherNodeId =
      req.publisherNodeId;

    try {
      const result = await pool.query(
        `SELECT
           c.id,
           c.title,
           c.description,
           c.target_url,
           c.cta_text,
           c.node_id
         FROM campaigns c
         JOIN nodes n
           ON c.node_id = n.id
         WHERE c.is_active = true
           AND c.node_id != $1
           AND n.credits > 0
         ORDER BY RANDOM()
         LIMIT 1`,
        [publisherNodeId]
      );

      if (result.rows.length === 0) {
        return res.json({
          recommendation: null
        });
      }

      const campaign = result.rows[0];

      const clickToken =
        crypto.randomBytes(32).toString('hex');

      await pool.query(
        `INSERT INTO click_tokens
         (
           token,
           publisher_node_id,
           campaign_id
         )
         VALUES ($1, $2, $3)`,
        [
          clickToken,
          publisherNodeId,
          campaign.id
        ]
      );

      res.json({
        recommendation: {
          title: campaign.title,
          description: campaign.description,
          targetUrl: campaign.target_url,
          ctaText: campaign.cta_text,
          clickToken
        }
      });
    } catch (err) {
      console.error(
        'Recommendation Error:',
        err
      );

      res.status(500).json({
        error:
          'Failed to fetch recommendation'
      });
    }
  }
);

// 5. Atomic Credit Settlement

app.post(
  '/v1/event',
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max:
      parseInt(RATE_LIMIT_CLICK_PER_NODE) ||
      10,
    message: {
      error:
        'Too many click events from this IP.'
    }
  }),
  async (req, res) => {
    const { clickToken } = req.body;

    if (!clickToken) {
      return res.status(400).json({
        error: 'clickToken is required'
      });
    }

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const tokenResult = await client.query(
        `UPDATE click_tokens
         SET is_used = true
         WHERE token = $1
           AND is_used = false
           AND created_at >= NOW()
             - INTERVAL '${parseInt(TOKEN_TTL_MINUTES)} minutes'
         RETURNING
           publisher_node_id,
           campaign_id`,
        [clickToken]
      );

      if (tokenResult.rows.length === 0) {
        await client.query('ROLLBACK');

        return res.status(400).json({
          error:
            'Invalid, used, or expired click token'
        });
      }

      const {
        publisher_node_id,
        campaign_id
      } = tokenResult.rows[0];

      const campaignRes = await client.query(
        `SELECT node_id
         FROM campaigns
         WHERE id = $1`,
        [campaign_id]
      );

      if (campaignRes.rows.length === 0) {
        await client.query('ROLLBACK');

        return res.status(404).json({
          error: 'Campaign not found'
        });
      }

      const advertiserNodeId =
        campaignRes.rows[0].node_id;

      const deductRes = await client.query(
        `UPDATE nodes
         SET credits = credits - 1
         WHERE id = $1
           AND credits > 0
         RETURNING credits`,
        [advertiserNodeId]
      );

      if (deductRes.rows.length === 0) {
        await client.query('ROLLBACK');

        return res.status(400).json({
          error:
            'Advertiser has insufficient credits'
        });
      }

      await client.query(
        `UPDATE nodes
         SET credits = credits + 1
         WHERE id = $1`,
        [publisher_node_id]
      );

      await client.query('COMMIT');

      res.json({
        message:
          'Click settled successfully'
      });
    } catch (err) {
      await client.query('ROLLBACK');

      console.error(
        'Event Settlement Error:',
        err
      );

      res.status(500).json({
        error:
          'Failed to process event'
      });
    } finally {
      client.release();
    }
  }
);

// 6. Node Balance

app.get(
  '/v1/node/balance',
  authenticateApiKey,
  async (req, res) => {
    res.json({
      credits: req.node.credits,
      nodeId: req.node.id
    });
  }
);

// 7. Dashboard Data

app.get(
  '/v1/dashboard',
  async (req, res) => {
    try {
      const nodes = await pool.query(
        `SELECT
           id,
           app_name AS "appName",
           domain,
           category,
           credits
         FROM nodes
         ORDER BY created_at DESC`
      );

      const campaigns = await pool.query(
        `SELECT
           id,
           title,
           description,
           target_url AS "targetUrl",
           cta_text AS "ctaText",
           is_active AS "isActive"
         FROM campaigns
         ORDER BY created_at DESC
         LIMIT 50`
      );

      const events = await pool.query(
        `SELECT
           token,
           publisher_node_id AS "publisherNodeId",
           campaign_id AS "campaignId",
           created_at AS "timestamp"
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
      console.error(
        'Dashboard Error:',
        err
      );

      res.status(500).json({
        error:
          'Failed to fetch dashboard data'
      });
    }
  }
);

// 8. Health Check

app.get('/', (req, res) => {
  res.json({
    status: 'AEN Backend Operational',
    timestamp: new Date().toISOString()
  });
});

// -------------------- Start Server --------------------

app.listen(PORT, () => {
  console.log(
    `AEN Secure Server running on port ${PORT}`
  );
});