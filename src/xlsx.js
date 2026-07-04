// Minimal .xlsx reader (zip + XML, no libraries). Reads the "Endustrie trACKER"
// workbook layout: Project Status, Featured Artist, POC's, Social Media, Marketing.
const td = new TextDecoder();

export async function unzip(buf) {
  const dv = new DataView(buf), u8 = new Uint8Array(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65558); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const entries = {};
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const method = dv.getUint16(off + 10, true);
    const csize = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    const localOff = dv.getUint32(off + 42, true);
    const name = td.decode(u8.subarray(off + 46, off + 46 + nameLen));
    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    entries[name] = {method, data: u8.subarray(dataStart, dataStart + csize)};
    off += 46 + nameLen + extraLen + commentLen;
  }
  const out = {};
  for (const [name, f] of Object.entries(entries)) {
    if (f.method === 0) { out[name] = f.data; continue; }
    const src = new ReadableStream({start(c) { c.enqueue(f.data); c.close(); }});
    out[name] = new Uint8Array(await new Response(
      src.pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
  }
  return out;
}

export function colToIdx(ref) {
  let c = 0;
  for (const ch of ref) {
    if (ch >= 'A' && ch <= 'Z') c = c * 26 + ch.charCodeAt(0) - 64; else break;
  }
  return c - 1;
}
const XL_EPOCH = Date.UTC(1899, 11, 30);
export const serialToISO = n => new Date(XL_EPOCH + Math.round(n) * 86400000).toISOString().slice(0, 10);
export function serialToLen(n) {
  const mins = Math.round((n % 1) * 1440);
  return Math.floor(mins / 60) + ':' + String(mins % 60).padStart(2, '0');
}
export const clean = v => v == null ? null : String(v).replace(/\s*\n\s*/g, ' ').trim() || null;

/* Which pipeline stage does a spreadsheet row imply? */
export function deriveStage(s) {
  if (/Music Video Completed/i.test(s.notes || '')) return 'video';
  if (s._mastered16 === 'Yes') return 'mastered';
  if (s._exported6db === 'Yes') return 'exported';
  if (/no vocals/i.test(s.notes || '')) return 'writing';
  if (!s.producer && !s.key && !s.bpm) return 'writing';
  return 'mixing';
}

export function parseSheetXml(doc, shared) {
  const rows = [];
  doc.querySelectorAll('row').forEach(row => {
    const r = [];
    row.querySelectorAll('c').forEach(c => {
      const ref = c.getAttribute('r') || '';
      const t = c.getAttribute('t');
      const v = c.querySelector('v')?.textContent;
      const isEl = c.querySelector('is');
      let val = null;
      if (t === 's' && v != null) val = shared[+v];
      else if (t === 'inlineStr' && isEl) val = isEl.textContent;
      else if (v != null) val = Number(v);
      r[colToIdx(ref)] = val;
    });
    rows.push(r);
  });
  return rows;
}

export async function readWorkbook(buf, DOMParserImpl = DOMParser) {
  const files = await unzip(buf);
  const parse = name => new DOMParserImpl().parseFromString(td.decode(files[name]), 'application/xml');
  const wb = parse('xl/workbook.xml');
  const rels = parse('xl/_rels/workbook.xml.rels');
  const relMap = {};
  rels.querySelectorAll('Relationship').forEach(r => relMap[r.getAttribute('Id')] = r.getAttribute('Target').replace(/^\//, ''));
  const shared = [];
  if (files['xl/sharedStrings.xml']) {
    parse('xl/sharedStrings.xml').querySelectorAll('si').forEach(si => {
      shared.push([...si.querySelectorAll('t')].map(t => t.textContent).join(''));
    });
  }
  const sheets = {};
  wb.querySelectorAll('sheet').forEach(sh => {
    const rid = sh.getAttribute('r:id') ||
      sh.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
    let target = relMap[rid];
    if (!target) return;
    if (!target.startsWith('xl/')) target = 'xl/' + target;
    if (files[target]) sheets[sh.getAttribute('name')] = parseSheetXml(parse(target), shared);
  });
  return sheets;
}

const findSheet = (sheets, re) => sheets[Object.keys(sheets).find(n => re.test(n)) || ''];
const findHeader = (rows, col, text) =>
  rows.findIndex(r => r && String(r[col] || '').includes(text));

export function mapSongs(rows) {
  const hdr = findHeader(rows, 0, 'Song Working Title');
  if (hdr < 0) return [];
  const songs = [];
  for (const r of rows.slice(hdr + 1)) {
    if (!r || r[0] == null || String(r[0]).trim() === '') continue;
    const s = {
      title: clean(r[0]), finished: clean(r[2]), producer: clean(r[4]), key: clean(r[6]),
      instruments: clean(r[7]),
      bpm: typeof r[8] === 'number' ? r[8] : (r[8] ? Number(r[8]) || null : null),
      featured: typeof r[9] === 'number' ? null : clean(r[9]),
      stems: (v => v && /^n\/?a\.?$/i.test(v) ? null : v)(clean(r[11])),
      exportDate: typeof r[14] === 'number' ? serialToISO(r[14]) : clean(r[14]),
      _exported6db: clean(r[16]), _mastered16: clean(r[17]),
      length: typeof r[19] === 'number' ? serialToLen(r[19]) : null,
      notes: clean(r[21]),
    };
    s.stage = deriveStage(s);
    delete s._exported6db; delete s._mastered16;
    songs.push(s);
  }
  return songs;
}
export function mapArtists(rows) {
  const hdr = findHeader(rows, 0, 'Full Legal Name');
  if (hdr < 0) return [];
  return rows.slice(hdr + 1)
    .filter(r => r && (r[0] || r[2] || r[6]))
    .map(r => ({legal: clean(r[0]), stage: clean(r[2]), phone: clean(r[4]), email: clean(r[6]),
                spotify: clean(r[8]), apple: clean(r[10]) != null ? String(clean(r[10])) : null,
                publishing: clean(r[12]), links: clean(r[14])}));
}
export function mapPocs(rows) {
  return rows.filter(r => r && r[4] != null && clean(r[4]) !== 'POC')
    .map(r => ({company: clean(r[0]), employees: clean(r[2]) != null ? String(clean(r[2])) : null,
                poc: clean(r[4]), phone: clean(r[6]), email: clean(r[8]),
                services: clean(r[10]), status: clean(r[12])}));
}
export function mapSocial(rows) {
  const hdr = rows.findIndex(r => r && /Platform/.test(String(r[0] || '')));
  if (hdr < 0) return [];
  return rows.slice(hdr + 1)
    .filter(r => r && r[0])
    .map(r => ({platform: clean(r[0]), email: clean(r[2]), user: clean(r[3]),
                linktree: clean(r[7]), pfp: clean(r[8]), header: clean(r[10]),
                updated: typeof r[12] === 'number' ? serialToISO(r[12]) : clean(r[12]),
                info: clean(r[14])})); // deliberately skips the Password column
}
export function mapMarketing(rows) {
  const hdr = findHeader(rows, 0, 'Campaign type');
  if (hdr < 0) return [];
  return rows.slice(hdr + 1)
    .filter(r => r && r[0])
    .map(r => ({type: clean(r[0]), company: clean(r[2]), website: clean(r[3]),
                services: clean(r[7]),
                kickoff: typeof r[9] === 'number' ? serialToISO(r[9]) : clean(r[9]),
                duration: clean(r[10]), cost: typeof r[11] === 'number' ? r[11] : null,
                notes: clean(r[12])}));
}

export function mapAlbumTitle(rows) {
  for (const r of rows) {
    const m = /album title:\s*(.+)/i.exec(String(r?.[0] || ''));
    if (m) return m[1].replace(/\(.*$/, '').trim() || null;
  }
  return null;
}

export async function importWorkbook(buf, DOMParserImpl = DOMParser) {
  const sheets = await readWorkbook(buf, DOMParserImpl);
  return {
    albumTitle: mapAlbumTitle(findSheet(sheets, /project status/i) || []),
    songs: mapSongs(findSheet(sheets, /project status/i) || []),
    artists: mapArtists(findSheet(sheets, /featured artist/i) || []),
    pocs: mapPocs(findSheet(sheets, /poc/i) || []),
    social: mapSocial(findSheet(sheets, /social media/i) || []),
    marketing: mapMarketing(findSheet(sheets, /marketing/i) || []),
  };
}
