// ── Color palettes ─────────────────────────────────────────────────────────

const GUILD_PALETTE = [
  '#4ecdc4', '#a78bfa', '#f87171', '#fb923c',
  '#38bdf8', '#4ade80', '#facc15', '#e879f9',
  '#f97316', '#34d399',
];

const GUILD_COLORS = { 'hoes': '#ff69b4', 'default': '#94a3b8' };

function assignGuildColors(data) {
  const guilds = [...new Set(data.map(d => d.guild))].filter(g => g !== 'hoes');
  guilds.sort();
  guilds.forEach((g, i) => {
    GUILD_COLORS[g] = GUILD_PALETTE[i % GUILD_PALETTE.length];
  });
}

const CLASS_COLORS = {
  'Marksman':    '#38bdf8',
  'Shadower':    '#a78bfa',
  'Dark Knight': '#f87171',
  'Bishop':      '#4ade80',
  'Night Lord':  '#fb923c',
  'Hero':        '#facc15',
  'ILM':         '#e879f9',
  'FPM':         '#2dd4bf',
  'Bowmaster':   '#f0a500',
  'Paladin':     '#60a5fa',
  'Buccaneer':   '#60a5fa',
  'Corsair':     '#60a5fa',
  'default':     '#94a3b8'
};

function getColor(d, mode) {
  if (mode === 'guild') {
    return GUILD_COLORS[d.guild] || GUILD_COLORS['default'];
  } else {
    return CLASS_COLORS[d.cls] || CLASS_COLORS['default'];
  }
}
