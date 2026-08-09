(async function() {
  const scriptTag = document.currentScript;
  const token = scriptTag ? scriptTag.getAttribute('data-widget-token') : null;
  const container = document.getElementById('aen-widget');

  if (!container) return;

  if (!token) {
    console.error("AEN Widget Error: Missing data-widget-token attribute.");
    return;
  }

  try {
    const res = await fetch('https://aen-backend-production-a6b2.up.railway.app/v1/recommendation', { 
      headers: { 'x-widget-token': token } 
    });
    const data = await res.json();
    
    container.innerHTML = '';
    
    if (!data.recommendation) {
      container.innerHTML = '<div style="border:1px dashed #334155;padding:12px;border-radius:8px;color:#94a3b8;font-size:0.85rem;text-align:center;">Network recommendation slot active.</div>';
      return;
    }

    const c = data.recommendation;
    container.style.cssText = "border:1px solid #38bdf8;padding:16px;border-radius:8px;background:#1e293b;color:#fff;font-family:sans-serif;max-width:300px;";
    
    const tag = document.createElement('small'); 
    tag.style.cssText = "color:#38bdf8;font-weight:bold;display:block;margin-bottom:4px;"; 
    tag.textContent = "RECOMMENDED";
    
    const title = document.createElement('h3'); 
    title.style.cssText = "margin:0 0 8px 0;font-size:1.1rem;"; 
    title.textContent = c.title;
    
    const desc = document.createElement('p'); 
    desc.style.cssText = "margin:0 0 12px 0;color:#94a3b8;font-size:0.9rem;line-height:1.4;"; 
    desc.textContent = c.description;
    
    const btn = document.createElement('button'); 
    btn.style.cssText = "background:#38bdf8;border:none;padding:8px 16px;border-radius:4px;cursor:pointer;font-weight:bold;color:#0f172a;width:100%;"; 
    btn.textContent = c.ctaText || 'Visit →';
    
    btn.onclick = async () => {
      fetch('https://aen-backend-production-a6b2.up.railway.app/v1/event', { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ clickToken: c.clickToken }) 
      });
      window.open(c.targetUrl, '_blank');
    };

    container.append(tag, title, desc, btn);
  } catch (e) { 
    console.error("AEN Widget Error:", e); 
  }
})();
