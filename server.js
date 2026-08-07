const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
app.use(cors());
app.use(express.json());

// In-memory database storage
const nodes = {};
const campaigns = [];
const events = [];

// Rate Limiter: Max 5 click events per IP every 15 minutes
const clickRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: "Too many clicks from this IP. Credit settlement throttled to prevent spam."
  }
});

// 1. Health check endpoint
app.get('/', (req, res) => {
  res.json({ status: "AEN Backend Operational", nodesCount: Object.keys(nodes).length, activeCampaigns: campaigns.length });
});

// 2. Node registration endpoint
app.post('/v1/node/register', (req, res) => {
  const { appName, domain, category } = req.body;
  if (!appName || !domain) {
    return res.status(400).json({ error: "Missing required fields: appName, domain" });
  }

  const nodeId = 'node_' + Math.random().toString(36).substr(2, 9);
  const apiKey = 'key_' + Math.random().toString(36).substr(2, 16) + Math.random().toString(36).substr(2, 8);

  nodes[nodeId] = {
    nodeId,
    apiKey,
    appName,
    domain,
    category: category || 'General',
    credits: 20, // 20 free initial credits
    registeredAt: new Date().toISOString()
  };

  return res.status(201).json({
    success: true,
    nodeId,
    apiKey,
    credits: 20
  });
});

// 3. Launch campaign endpoint
app.post('/v1/campaign/create', (req, res) => {
  const { apiKey, title, description, targetUrl, ctaText } = req.body;
  
  const node = Object.values(nodes).find(n => n.apiKey === apiKey);
  if (!node) {
    return res.status(401).json({ error: "Invalid API key" });
  }

  if (node.credits < 1) {
    return res.status(403).json({ error: "Insufficient credits to launch campaign" });
  }

  const campaignId = 'camp_' + Math.random().toString(36).substr(2, 9);
  const newCampaign = {
    campaignId,
    nodeId: node.nodeId,
    title,
    description,
    targetUrl,
    ctaText: ctaText || "Learn More",
    createdAt: new Date().toISOString()
  };

  campaigns.push(newCampaign);
  return res.status(201).json({ success: true, campaign: newCampaign });
});

// 4. Recommendation ad fetch endpoint (Unthrottled for high speed)
app.get('/v1/recommendation', (req, res) => {
  const apiKey = req.headers['x-api-key'] || req.query.apiKey;
  const publisherNode = Object.values(nodes).find(n => n.apiKey === apiKey);

  if (!publisherNode) {
    return res.status(401).json({ error: "Invalid API key" });
  }

  // Filter out advertiser campaigns from the publisher's own node
  const availableCampaigns = campaigns.filter(c => {
    const advertiser = nodes[c.nodeId];
    return c.nodeId !== publisherNode.nodeId && advertiser && advertiser.credits >= 1;
  });

  if (availableCampaigns.length === 0) {
    return res.status(200).json({ recommendation: null, message: "No active third-party campaigns available." });
  }

  // Serve a random matching campaign
  const selected = availableCampaigns[Math.floor(Math.random() * availableCampaigns.length)];
  return res.status(200).json({ recommendation: selected });
});

// 5. Click conversion endpoint (Protected by Click Rate Limiter)
app.post('/v1/event', clickRateLimiter, (req, res) => {
  const { apiKey, campaignId } = req.body;

  const publisherNode = Object.values(nodes).find(n => n.apiKey === apiKey);
  if (!publisherNode) {
    return res.status(401).json({ error: "Invalid API key" });
  }

  const campaign = campaigns.find(c => c.campaignId === campaignId);
  if (!campaign) {
    return res.status(404).json({ error: "Campaign not found" });
  }

  const advertiserNode = nodes[campaign.nodeId];
  if (!advertiserNode || advertiserNode.credits < 1) {
    return res.status(400).json({ error: "Advertiser balance exhausted" });
  }

  // Settle credit transfer between nodes
  advertiserNode.credits -= 1;
  publisherNode.credits += 1;

  events.push({
    eventId: 'evt_' + Math.random().toString(36).substr(2, 9),
    publisherNodeId: publisherNode.nodeId,
    advertiserNodeId: advertiserNode.nodeId,
    campaignId,
    timestamp: new Date().toISOString()
  });

  return res.status(200).json({
    success: true,
    message: "Credit transfer settled",
    publisherCredits: publisherNode.credits
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`AEN Backend running on port ${PORT}`);
});
