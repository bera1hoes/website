// ── Guild War Points data (rank → points) ─────────────────────────────────
// Two schedules: the 09-03-2026 patch raised 1st–29th place and left 30th and
// beyond alone. Ranks in THESE TABLES are 0-indexed (rank 0 = 1st place), which
// is how the game numbers places. The rest of the app is 1-based — read points
// through `gwPointsAt(sheet, rank)` at the bottom of this file, which does the
// conversion; never index a table directly, or old sheets get scored under
// today's rules and every place lands one off.

const GW_POINTS_DATA = `Rank	Guild War Points
0	1,000,000
1	900,000
2	800,000
3	730,000
4	660,000
5	610,000
6	560,000
7	510,000
8	460,000
9	410,000
10	380,000
11	350,000
12	320,000
13	290,000
14	260,000
15	250,000
16	240,000
17	230,000
18	220,000
19	210,000
20	205,000
21	200,000
22	195,000
23	190,000
24	185,000
25	180,000
26	175,000
27	170,000
28	165,000
29	160,000
30	157,000
31	154,000
32	151,000
33	148,000
34	145,000
35	142,000
36	139,000
37	136,000
38	133,000
39	130,000
40	128,000
41	126,000
42	124,000
43	122,000
44	120,000
45	118,000
46	116,000
47	114,000
48	112,000
49	110,000
50	109,000
51	108,000
52	107,000
53	106,000
54	105,000
55	104,000
56	103,000
57	102,000
58	101,000
59	100,000
60	99,000
61	98,000
62	97,000
63	96,000
64	95,000
65	94,000
66	93,000
67	92,000
68	91,000
69	90,000
70	89,000
71	88,000
72	87,000
73	86,000
74	85,000
75	84,000
76	83,000
77	82,000
78	81,000
79	80,000
80	79,000
81	78,000
82	77,000
83	76,000
84	75,000
85	74,000
86	73,000
87	72,000
88	71,000
89	70,000
90	69,000
91	68,000
92	67,000
93	66,000
94	65,000
95	64,000
96	63,000
97	62,000
98	61,000
99	60,300
100	59,600
101	58,900
102	58,200
103	57,500
104	56,800
105	56,100
106	55,400
107	54,700
108	54,000
109	53,300
110	52,600
111	51,900
112	51,200
113	50,500
114	49,800
115	49,100
116	48,400
117	47,700
118	47,000
119	46,300
120	45,600
121	44,900
122	44,200
123	43,500
124	42,800
125	42,100
126	41,400
127	40,700
128	40,000
129	39,300
130	38,600
131	37,900
132	37,200
133	36,500
134	35,800
135	35,100
136	34,400
137	33,700
138	33,000
139	32,300
140	31,600
141	30,900
142	30,200
143	29,500
144	28,800
145	28,100
146	27,400
147	26,700
148	26,000
149	25,300
150	24,600`;

// The 09-03-2026 table. Only 1st–29th (ranks 0–28) moved, so the tail is spliced
// off the old table rather than restating 120 identical rows — the two can't
// drift apart. Line 0 of GW_POINTS_DATA is the header and lines 1–29 are ranks
// 0–28, so the shared tail starts at line 30 (rank 29 = 30th place).
const GW_POINTS_DATA_V2 = `Rank	Guild War Points
0	1,500,000
1	1,200,000
2	950,000
3	850,000
4	780,000
5	720,000
6	670,000
7	630,000
8	590,000
9	560,000
10	530,000
11	500,000
12	470,000
13	440,000
14	410,000
15	380,000
16	350,000
17	320,000
18	290,000
19	260,000
20	250,000
21	240,000
22	230,000
23	220,000
24	210,000
25	200,000
26	190,000
27	180,000
28	170,000
` + GW_POINTS_DATA.split('\n').slice(30).join('\n');

// First Guild War scored under the new table, as a sortable YYYY-MM-DD key.
const GW_POINTS_V2_FROM = '2026-09-03';

// Which table a sheet is scored under. Sheet labels are "MM-DD-YYYY" remotely
// and "MM_DD_YYYY" in the local sample data; both flip to a lexically
// comparable "YYYY-MM-DD" (same trick as weekKey in prediction.js). Anything
// unrecognized falls through to the current table.
function gwPointsDataFor(sheet) {
  const m = /^(\d{2})[-_](\d{2})[-_](\d{4})$/.exec(String(sheet || ''));
  if (!m) return GW_POINTS_DATA_V2;
  const key = m[3] + '-' + m[1] + '-' + m[2];
  return key >= GW_POINTS_V2_FROM ? GW_POINTS_DATA_V2 : GW_POINTS_DATA;
}

// Parsed rank → points map for a sheet's schedule, memoized per table (there
// are only two, so keying the cache by the text itself is enough).
const _gwPointsMaps = new Map();
function gwPointsMap(sheet) {
  const text = gwPointsDataFor(sheet);
  if (!_gwPointsMaps.has(text)) _gwPointsMaps.set(text, parseGWPoints(text));
  return _gwPointsMaps.get(text);
}

// ── The one place the 0-indexed tables meet 1-based app ranks ───────────────
// Everything the app shows or reasons about is 1-based (rank 1 = 1st place, as
// assigned by `assignRanks` in chart.js). The tables above stay 0-indexed
// because that is how the game numbers places and how they were transcribed —
// re-keying 300 rows would be a silent, diff-heavy way to introduce an
// off-by-one. So ALL lookups come through here and subtract exactly once.
// Returns undefined past the end of the table (only ~151 places score points).
function gwPointsAt(sheet, rank) {
  return gwPointsMap(sheet).get(String(rank - 1));
}
