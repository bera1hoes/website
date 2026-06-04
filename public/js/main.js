// ── Boot ───────────────────────────────────────────────────────────────────
// Must load last: this is the only file that runs side-effecting code at parse
// time (everything else just declares functions/state used at runtime).

if (IS_LOCAL) {
  document.getElementById('sheet-label').textContent = 'Loaded files';
  document.getElementById('sheet-select').innerHTML = '<option value="">Loading…</option>';
  const s1 = document.createElement('script');
  s1.src = './SampleData/GWLocalData.js';
  s1.onerror = function() {
    document.getElementById('loading').textContent = 'Could not load GWLocalData.js — serve via HTTP (e.g. VS Code Live Server)';
    document.getElementById('sheet-select').innerHTML = '<option value="">— no data —</option>';
  };
  s1.onload = function() {
    const s2 = document.createElement('script');
    s2.src = './SampleData/GBBLocalData.js';
    s2.onload = s2.onerror = function() {
      const s3 = document.createElement('script');
      s3.src = './SampleData/GlobalGBBLocalData.js';
      s3.onload = s3.onerror = function() {};
      document.head.appendChild(s3);
    };
    document.head.appendChild(s2);
  };
  document.head.appendChild(s1);
}
