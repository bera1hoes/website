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
    const loadS4 = function() {
      const s4 = document.createElement('script');
      s4.src = './SampleData/GuildConquestLocalData.js';
      s4.onerror = function() {
        console.warn('Could not load GuildConquestLocalData.js — Guild Conquest data will be unavailable');
      };
      document.head.appendChild(s4);
    };
    const loadS3 = function() {
      const s3 = document.createElement('script');
      s3.src = './SampleData/GlobalGBBLocalData.js';
      s3.onload = loadS4;
      s3.onerror = function() {
        console.warn('Could not load GlobalGBBLocalData.js — Global GBB data will be unavailable');
        loadS4();
      };
      document.head.appendChild(s3);
    };
    s2.onload = loadS3;
    s2.onerror = function() {
      console.warn('Could not load GBBLocalData.js — GBB data will be unavailable');
      loadS3();
    };
    document.head.appendChild(s2);
  };
  document.head.appendChild(s1);
}
