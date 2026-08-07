(function () {
  const API_BASE = 'https://aen-backend-production-a6b2.up.railway.app';

  class AenWidget extends HTMLElement {
    connectedCallback() {
      const apiKey = this.getAttribute('api-key');
      if (!apiKey) return;

      this.attachShadow({ mode: 'open' });
      this.fetchAndRender(apiKey);
    }

    async fetchAndRender(apiKey) {
      try {
        const res = await fetch(`${API_BASE}/v1/recommendation?apiKey=${apiKey}`);
        if (!res.ok) return;
        const data = await res.json();

        let dwellSeconds = 0;
        let timer = setInterval(() => { dwellSeconds++; }, 1000);

        this.shadowRoot.innerHTML = `
          <style>
            .aen-card {
              border: 1px solid #e2e8f0;
              border-radius: 12px;
              padding: 16px;
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
              background: #ffffff;
              max-width: 320px;
              box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
            }
            .aen-tag { font-size: 10px; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px; }
            .aen-title { font-size: 16px; font-weight: 600; color: #0f172a; margin: 6px 0; }
            .aen-desc { font-size: 13px; color: #475569; line-height: 1.4; margin-bottom: 12px; }
            .aen-btn {
              display: inline-block;
              background: #2563eb;
              color: #ffffff;
              padding: 8px 14px;
              border-radius: 6px;
              text-decoration: none;
              font-size: 12px;
              font-weight: 600;
            }
          </style>
          <div class="aen-card">
            <div class="aen-tag">Recommended by Partner</div>
            <div class="aen-title">${data.title}</div>
            <div class="aen-desc">${data.description}</div>
            <a class="aen-btn" href="${data.targetUrl}" target="_blank" id="cta-link">${data.ctaText}</a>
          </div>
        `;

        const sendEvent = () => {
          clearInterval(timer);
          navigator.sendBeacon(`${API_BASE}/v1/event`, JSON.stringify({
            apiKey,
            recommendationId: data.recommendationId,
            advertiserNodeId: data.advertiserNodeId,
            dwellSeconds
          }));
        };

        this.shadowRoot.querySelector('#cta-link').addEventListener('click', sendEvent);
        window.addEventListener('beforeunload', sendEvent);

      } catch (err) {
        console.error('AEN Widget failed to load:', err);
      }
    }
  }

  customElements.define('aen-widget', AenWidget);
})();
