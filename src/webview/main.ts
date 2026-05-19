/// <reference lib="dom" />
// Flowchart.fun-compatible renderer for VS Code (Strander).
// Original implementation; uses public npm libraries (cytoscape, graph-selector,
// dagre, klay, elk, fcose, cose-bilkent). No source from flowchart-fun is copied;
// only the data-format and theme-field interfaces are matched.

import cytoscape from 'cytoscape';
// @ts-ignore
import dagre from 'cytoscape-dagre';
// @ts-ignore
import klay from 'cytoscape-klay';
// @ts-ignore
import elk from 'cytoscape-elk';
// @ts-ignore
import fcose from 'cytoscape-fcose';
// @ts-ignore
import coseBilkent from 'cytoscape-cose-bilkent';
import { parse, operate } from 'graph-selector';

cytoscape.use(dagre);
cytoscape.use(klay);
cytoscape.use(elk);
cytoscape.use(fcose);
cytoscape.use(coseBilkent);

declare function acquireVsCodeApi(): { postMessage: (m: any) => void };
const vscode = acquireVsCodeApi();

// =====================================================================
// FFTheme — fields match flowchart-fun's theme interface for data compat
// Default values reproduce flowchart-fun's default chart theme.
// =====================================================================
interface FFTheme {
  layoutName: string;
  direction: 'UP' | 'DOWN' | 'LEFT' | 'RIGHT';
  spacingFactor: number;
  background: string;
  color: string;            // global text color
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  textTransform: 'none' | 'uppercase' | 'lowercase' | 'capitalize';
  nodeBackground: string;
  borderColor: string;
  borderWidth: number;
  borderStyle: 'solid' | 'dashed' | 'dotted' | 'double';
  cornerRadius: number;
  padding: number;
  shape: string;
  edgeColor: string;
  edgeWidth: number;
  edgeStyle: 'solid' | 'dashed' | 'dotted';
  edgeCurve: 'bezier' | 'straight' | 'taxi' | 'unbundled-bezier' | 'segments' | 'round-taxi' | 'round-segments';
  edgeTextSize: number;
  edgeTextColor: string;
  edgeTextBackground: string;
  rotateEdgeLabel: boolean;
  arrowScale: number;
  sourceDistanceFromNode: number;
  targetDistanceFromNode: number;
  textMarginY: number;
  wheelSensitivity: number;
  sourceArrowShape: 'none' | 'triangle' | 'vee' | 'triangle-backcurve' | 'circle';
  targetArrowShape: 'none' | 'triangle' | 'vee' | 'triangle-backcurve' | 'circle';
  iconWidth: number;
  iconHeight: number;
  iconPlacement: 'before' | 'after' | 'above' | 'below';
  iconSpacing: number;
}

const DEFAULT_THEME: FFTheme = {
  layoutName: 'dagre',
  direction: 'DOWN',
  spacingFactor: 1.1,
  background: '#ffffff',
  color: '#000000',
  fontFamily: 'IBM Plex Sans',
  fontSize: 16,
  fontWeight: 400,
  textTransform: 'none',
  nodeBackground: '#e6e6e6',
  borderColor: '#000000',
  borderWidth: 0,
  borderStyle: 'solid',
  cornerRadius: 4,
  padding: 16,
  shape: 'round-rectangle',
  edgeColor: '#606ef6',
  edgeWidth: 2,
  edgeStyle: 'solid',
  edgeCurve: 'bezier',
  edgeTextSize: 0.875,
  edgeTextColor: '#000000',
  edgeTextBackground: '#ffffff',
  rotateEdgeLabel: false,
  arrowScale: 1,
  sourceDistanceFromNode: 5,
  targetDistanceFromNode: 5,
  textMarginY: 0,
  wheelSensitivity: 1.0,
  sourceArrowShape: 'none',
  targetArrowShape: 'triangle',
  iconWidth: 24,
  iconHeight: 24,
  iconPlacement: 'before',
  iconSpacing: 4,
};

const ARROW_SHAPES = ['none', 'triangle', 'vee', 'triangle-backcurve', 'circle', 'square', 'diamond', 'tee', 'chevron'];
const ICON_PLACEMENTS = ['before', 'after', 'above', 'below'];

const FF_FONTS = [
  'IBM Plex Sans', 'IBM Plex Mono', 'IBM Plex Serif',
  'Inter', 'Roboto', 'Open Sans', 'Lato', 'Montserrat',
  'Source Code Pro', 'Fira Code', 'JetBrains Mono',
  'Merriweather', 'Playfair Display', 'Lora',
  'Comic Neue', 'Indie Flower', 'Caveat',
  'Arial', 'Helvetica', 'Georgia', 'Times New Roman', 'Courier New',
];

const LAYOUT_NAMES = [
  'dagre', 'klay', 'breadthfirst', 'cose', 'concentric', 'circle',
  'random', 'grid', 'preset',
  'elk-box', 'elk-force', 'elk-layered', 'elk-mrtree', 'elk-stress',
];

const SHAPE_OPTIONS = [
  'round-rectangle', 'rectangle', 'ellipse', 'triangle',
  'diamond', 'pentagon', 'hexagon', 'octagon', 'star',
  'tag', 'rhomboid', 'vee', 'cut-rectangle', 'barrel',
];

// =====================================================================
// State
// =====================================================================
let cy: cytoscape.Core | null = null;
let currentText = '';
let currentMeta: any = { themeEditor: {}, cytoscapeStyle: '', nodePositions: {}, autoLayout: true };
let autoLayout = true;
let isApplyingDoc = false;
let metaWriteTimer: any = null;
let importedFontUrls = new Set<string>();
let lastWheelSensitivity: number | null = null;

function getTheme(): FFTheme {
  return { ...DEFAULT_THEME, ...(currentMeta?.themeEditor ?? {}) };
}

function postMeta() {
  if (metaWriteTimer) { clearTimeout(metaWriteTimer); }
  metaWriteTimer = setTimeout(() => {
    metaWriteTimer = null;
    vscode.postMessage({ type: 'writeMeta', meta: currentMeta });
  }, 200);
}

function postText(text: string) {
  if (text === currentText) { return; }
  vscode.postMessage({ type: 'writeText', text });
  applyUpdate(text, currentMeta, { forceRelayout: autoLayout });
}

// =====================================================================
// graph-selector parse → cytoscape elements
// =====================================================================
let lastParseError: { message: string; line?: number } | null = null;

// Re-extract id/classes/data from the source line directly, because
// graph-selector@0.13.0 has a stateful global-regex bug that silently
// drops id or classes when both appear on one line after enough parses.
function reparseLineFeatures(rawLine: string): { id?: string; classes: string[]; data: Record<string, any> } {
  let line = rawLine;
  line = line.replace(/^\s+/, '');
  if (line.endsWith('{')) { line = line.slice(0, -1).replace(/\s+$/, ''); }
  line = line.replace(/^\}\s*/, '');
  // Strip edge label prefix "name: "
  const colonMatch = /([^\\])(: |：)/.exec(line);
  if (colonMatch && colonMatch.index < 80) {
    line = line.slice(colonMatch.index + colonMatch[1].length + colonMatch[2].length);
  }
  // Strip non-escaped pointers (...)
  line = line.replace(/(^|[^\\])[(（][^)）]*[)）]/g, '$1');
  // Find feature start: (^|\s)(#|.|[)
  const featStart = /(^|\s)(#|\.|\[)/.exec(line);
  if (!featStart) { return { classes: [], data: {} }; }
  let i = featStart.index;
  if (featStart[1]) { i += featStart[1].length; }
  const feats = line.slice(i);
  const classes: string[] = [];
  let id: string | undefined;
  const data: Record<string, any> = {};
  let p = 0;
  while (p < feats.length) {
    const c = feats[p];
    if (c === ' ' || c === '\t') { p++; continue; }
    if (c === '#') {
      const m = /^#([\w-]+)/.exec(feats.slice(p));
      if (m) { if (!id) { id = m[1]; } p += m[0].length; continue; }
    }
    if (c === '.') {
      const m = /^\.([a-zA-Z][\w-]*)/.exec(feats.slice(p));
      if (m) { classes.push(m[1]); p += m[0].length; continue; }
    }
    if (c === '[') {
      const m = /^\[([^\]=]+)(?:=("[^"]*"|'[^']*'|[^\]]*))?\]/.exec(feats.slice(p));
      if (m) {
        const key = m[1].trim();
        let val: any = true;
        if (m[2] !== undefined) {
          let v = m[2];
          if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
            v = v.slice(1, -1);
          } else if (v !== '' && !isNaN(Number(v))) {
            val = Number(v);
            data[key] = val;
            p += m[0].length;
            continue;
          }
          val = v;
        }
        data[key] = val;
        p += m[0].length;
        continue;
      }
    }
    break;
  }
  return { id, classes, data };
}

// Convert unescaped `|` into newlines (literal `\n`). `\|` stays a literal pipe.
function pipesToNewlines(s: string): string {
  // Replace unescaped | with newline, then unescape \|
  return String(s)
    .replace(/(^|[^\\])\|/g, (_m, p1: string) => `${p1}\n`)
    .replace(/\\\|/g, '|');
}

function slugifyLabel(s: string): string {
  return String(s)
    .replace(/\\n/g, ' ')
    .replace(/[|\n]/g, ' ')
    .replace(/\\([:：\(\)\（\）{}\[\]#.\/|])/g, '$1')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

// Inject auto-IDs (#slug-from-label) into lines that declare a node without
// an explicit #id, so users can write `(#caddy)` references and have them
// resolve to a node whose label is "Caddy". The original document text is
// untouched; this only feeds graph-selector a normalized version.
function injectAutoIds(text: string): { text: string; injectedFor: Map<number, string> } {
  const lines = text.split(/\n/);
  const used = new Set<string>();
  // First pass: collect explicit IDs (anywhere) and skip nothing.
  for (const line of lines) {
    // Strip pointer references so #ids inside (...) don't reserve names.
    const stripped = line.replace(/[(（][^)）]*[)）]/g, '');
    const re = /(?:^|[^\\])#([\w-]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(stripped)) != null) { used.add(m[1]); }
  }
  const injected = new Map<number, string>();
  for (let i = 0; i < lines.length; i++) {
    const orig = lines[i];
    const trimmed = orig.trim();
    if (!trimmed) { continue; }
    // Closing brace only — skip.
    if (/^\}\s*$/.test(trimmed)) { continue; }
    // Pointer-only line at indent 0 (leading reference) — leave alone.
    if (trimmed[0] === '(') { continue; }
    // Line already contains an explicit #id (anywhere) — skip.
    if (/(?:^|[^\\])#[\w-]+/.test(orig)) { continue; }
    // Lines that contain pointers `(...)` are edge declarations, not node
    // declarations — leave alone.
    // Note: `\(` escaped paren is fine to leave alone; this regex matches
    // unescaped `(`.
    if (/(?:^|[^\\])[(（]/.test(orig)) { continue; }

    // Derive the label text: strip leading indent / closing brace / container
    // opening brace / edge label prefix / features section.
    let work = orig.replace(/^\s+/, '');
    if (work.endsWith('{')) { work = work.slice(0, -1).replace(/\s+$/, ''); }
    work = work.replace(/^\}\s*/, '');
    const colonMatch = /([^\\])(: |：)/.exec(work);
    if (colonMatch && colonMatch.index < 80) {
      work = work.slice(colonMatch.index + colonMatch[1].length + colonMatch[2].length);
    }
    const featStart = /(^|\s)(\.|\[)/.exec(work);
    if (featStart) {
      const idx = featStart[1] ? featStart.index + featStart[1].length : featStart.index;
      work = work.slice(0, idx);
    }
    work = work.trim();
    if (!work) { continue; }

    let slug = slugifyLabel(work);
    if (!slug) { continue; }
    if (used.has(slug)) {
      let n = 2;
      while (used.has(`${slug}-${n}`)) { n++; }
      slug = `${slug}-${n}`;
    }
    used.add(slug);

    // Inject `#slug` immediately before the container brace (if any), else
    // append to the end of the line preserving trailing whitespace newline.
    if (/\{\s*$/.test(orig)) {
      lines[i] = orig.replace(/\{\s*$/, `#${slug} {`);
    } else {
      lines[i] = orig.replace(/\s*$/, ` #${slug}`);
    }
    injected.set(i + 1, slug);
  }
  return { text: lines.join('\n'), injectedFor: injected };
}

function buildElements(text: string): cytoscape.ElementDefinition[] {
  // Pre-process: inject `#slug` IDs derived from labels for nodes that
  // don't have an explicit ID, so `(#slug)` references resolve to them.
  const { text: parseText, injectedFor: _autoIdMap } = injectAutoIds(text);
  void _autoIdMap;

  // Same pre-split as graph-selector: split first, then replace \n escape inside lines.
  const rawLines = parseText.split(/\n/g).map((l) => l.replace(/\\n/g, '\n'));

  let parsed: any;
  try {
    parsed = parse(parseText);
    lastParseError = null;
  } catch (e: any) {
    const msg = String(e?.message ?? e ?? 'Parse error');
    const lineMatch = /line[\s:]+(\d+)/i.exec(msg);
    lastParseError = { message: msg, line: lineMatch ? Number(lineMatch[1]) : undefined };
    vscode.postMessage({ type: 'parseError', message: msg, line: lastParseError.line });
    parsed = { nodes: [], edges: [] };
  }
  if (!lastParseError) {
    vscode.postMessage({ type: 'parseOk' });
  }

  // Build oldId → correctedId map by reparsing each node's source line.
  const idMap = new Map<string, string>();
  const corrected = new Map<string, { id: string; classes: string[]; data: Record<string, any> }>();
  for (const n of parsed.nodes ?? []) {
    const ln = Number(n.parser?.lineNumber ?? n.data?.lineNumber ?? 0);
    const src = ln > 0 && ln <= rawLines.length ? rawLines[ln - 1] : '';
    const r = reparseLineFeatures(src);
    const oldId = String(n.data?.id ?? '');
    const newId = r.id ?? oldId;
    if (oldId && newId !== oldId) { idMap.set(oldId, newId); }
    corrected.set(oldId, { id: newId, classes: r.classes, data: r.data });
  }

  const remap = (s: string) => idMap.get(s) ?? s;

  const els: cytoscape.ElementDefinition[] = [];
  const seenIds = new Set<string>();

  for (const n of parsed.nodes ?? []) {
    const oldId = String(n.data?.id ?? '');
    if (!oldId) { continue; }
    const fix = corrected.get(oldId) ?? { id: oldId, classes: [], data: {} };
    const id = fix.id;
    if (!id) { continue; }
    seenIds.add(id);

    const parserClasses: string[] = typeof n.data?.classes === 'string'
      ? n.data.classes.split(/[.\s]+/).filter(Boolean)
      : (Array.isArray(n.data?.classes) ? n.data.classes : []);
    // Merge: prefer our reparsed classes; fall back to parser's if reparse found none.
    const classes = fix.classes.length > 0 ? fix.classes : parserClasses;

    const data: any = {
      id,
      label: pipesToNewlines(n.data?.label ?? ''),
      lineNumber: Number(n.parser?.lineNumber ?? n.data?.lineNumber ?? 0),
    };
    if (n.data?.parent) { data.parent = remap(String(n.data.parent)); }
    if (n.data?.isParent) { data.isParent = true; }
    // Merge parser data (minus structural keys) + our reparsed attribute data.
    for (const k of Object.keys(n.data ?? {})) {
      if (['id', 'label', 'classes', 'lineNumber', 'parent', 'isParent'].includes(k)) { continue; }
      data[k] = n.data[k];
    }
    for (const k of Object.keys(fix.data)) {
      data[k] = fix.data[k];
    }
    els.push({ group: 'nodes', data, classes });
  }

  let eAuto = 0;
  for (const e of parsed.edges ?? []) {
    const source = remap(String(e.source));
    const target = remap(String(e.target));
    if (!seenIds.has(source) || !seenIds.has(target)) { continue; }
    const id = String(e.data?.id ?? `e_${++eAuto}_${source}_${target}`);
    const classes: string[] = typeof e.data?.classes === 'string'
      ? e.data.classes.split(/[.\s]+/).filter(Boolean)
      : (Array.isArray(e.data?.classes) ? e.data.classes : []);
    const data: any = {
      id,
      source,
      target,
      label: pipesToNewlines(e.data?.label ?? ''),
      lineNumber: Number(e.parser?.lineNumber ?? e.data?.lineNumber ?? 0),
    };
    els.push({ group: 'edges', data, classes });
  }
  return els;
}

// =====================================================================
// Layout
// =====================================================================
function dirCardinal(dir: FFTheme['direction']): 'TB' | 'BT' | 'LR' | 'RL' {
  return dir === 'UP' ? 'BT' : dir === 'LEFT' ? 'RL' : dir === 'RIGHT' ? 'LR' : 'TB';
}

function getCompoundDepth(): number {
  if (!cy) { return 0; }
  let max = 0;
  cy.nodes(':parent').forEach((p) => {
    let d = 1;
    let cur: any = p;
    while (cur.parent && cur.parent().length > 0) { d++; cur = cur.parent(); }
    if (d > max) { max = d; }
  });
  return max;
}

function buildLayout(theme: FFTheme, mode: 'all' | 'preset' = 'all'): any {
  if (mode === 'preset') {
    return { name: 'preset', fit: false, animate: false };
  }
  const sp = theme.spacingFactor;
  switch (theme.layoutName) {
    case 'dagre':
      return {
        name: 'dagre',
        rankDir: dirCardinal(theme.direction),
        spacingFactor: sp,
        animate: false,
        fit: true,
        padding: 24,
      };
    case 'klay':
      return {
        name: 'klay',
        klay: {
          direction: theme.direction === 'DOWN' ? 'DOWN'
            : theme.direction === 'UP' ? 'UP'
            : theme.direction === 'LEFT' ? 'LEFT' : 'RIGHT',
        },
        spacingFactor: sp,
        animate: false,
        fit: true,
        padding: 24,
      };
    case 'breadthfirst':
      return {
        name: 'breadthfirst',
        directed: true,
        spacingFactor: sp,
        animate: false,
        fit: true,
        padding: 24,
      };
    case 'cose':
      return {
        name: 'fcose',
        animate: true,
        animationDuration: 350,
        fit: true,
        padding: 24,
        spacingFactor: sp,
      };
    case 'concentric':
      return { name: 'concentric', animate: false, fit: true, padding: 24, spacingFactor: sp };
    case 'circle':
      return { name: 'circle', animate: false, fit: true, padding: 24, spacingFactor: sp };
    case 'grid':
      return { name: 'grid', animate: false, fit: true, padding: 24, spacingFactor: sp };
    case 'random':
      return { name: 'random', animate: false, fit: true, padding: 24 };
    case 'preset':
      return { name: 'preset', fit: false, animate: false };
    default:
      if (theme.layoutName?.startsWith('elk-')) {
        const algo = theme.layoutName.substring(4);
        return {
          name: 'elk',
          animate: false,
          fit: true,
          padding: 24,
          spacingFactor: sp,
          elk: {
            algorithm: algo,
            'elk.direction': theme.direction,
            'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
            ...(algo === 'layered' ? { 'elk.layered.nodePlacement.bk.fixedAlignment': 'BALANCED' } : {}),
          },
        };
      }
      return { name: 'dagre', rankDir: dirCardinal(theme.direction), spacingFactor: sp, animate: false, fit: true, padding: 24 };
  }
}

// =====================================================================
// Style — base + dynamic class rules from custom CSS + style.json
// =====================================================================
function buildStylesheet(theme: FFTheme, dynamicClasses: { node: string[]; edge: string[]; parent: string[] }) {
  const ts: cytoscape.Stylesheet[] = [
    {
      selector: 'node',
      style: {
        'background-color': theme.nodeBackground,
        'border-color': theme.borderColor,
        'border-width': theme.borderWidth,
        'border-style': theme.borderStyle as any,
        'shape': theme.shape as any,
        'color': theme.color,
        'label': 'data(label)',
        'text-valign': 'center',
        'text-halign': 'center',
        'text-wrap': 'wrap',
        'text-max-width': '320px',
        'font-family': theme.fontFamily,
        'font-size': theme.fontSize,
        'font-weight': theme.fontWeight,
        'text-transform': theme.textTransform as any,
        'text-margin-y': theme.textMarginY,
        'padding': theme.padding,
        'width': 'label',
        'height': 'label',
      } as any,
    },
    {
      selector: '$node > node',
      style: {
        // child node — kept default
      },
    },
    {
      selector: ':parent',
      style: {
        'background-color': theme.background,
        'background-opacity': 1 as any,
        'border-color': theme.borderColor,
        'border-width': Math.max(1, theme.borderWidth),
        'text-valign': 'top',
        'text-halign': 'center',
        'text-margin-y': -8 as any,
        'padding': 10,
        'color': theme.color,
        'font-weight': 600 as any,
        'shape': 'round-rectangle' as any,
      } as any,
    },
    {
      selector: 'edge',
      style: {
        'curve-style': (theme.edgeCurve || 'bezier') as any,
        'width': theme.edgeWidth,
        'line-color': theme.edgeColor,
        'line-style': theme.edgeStyle as any,
        'target-arrow-color': theme.edgeColor,
        'target-arrow-shape': (theme.targetArrowShape || 'triangle') as any,
        'source-arrow-color': theme.edgeColor,
        'source-arrow-shape': (theme.sourceArrowShape || 'none') as any,
        'source-endpoint': `outside-to-node-or-label`,
        'target-endpoint': `outside-to-node-or-label`,
        'source-distance-from-node': theme.sourceDistanceFromNode,
        'target-distance-from-node': theme.targetDistanceFromNode,
        'arrow-scale': theme.arrowScale,
        'label': 'data(label)',
        'font-size': Math.round(theme.fontSize * theme.edgeTextSize),
        'font-family': theme.fontFamily,
        'color': theme.edgeTextColor,
        'text-background-color': theme.edgeTextBackground,
        'text-background-opacity': 1 as any,
        'text-background-padding': '2px' as any,
        'text-background-shape': 'roundrectangle' as any,
        'edge-text-rotation': (theme.rotateEdgeLabel ? 'autorotate' : 'none') as any,
        'text-rotation': (theme.rotateEdgeLabel ? 'autorotate' : 'none') as any,
      } as any,
    },
    {
      selector: 'node:selected',
      style: {
        'overlay-color': '#3b82f6',
        'overlay-opacity': 0.18,
        'overlay-padding': 4,
      } as any,
    },
    {
      selector: 'edge:selected',
      style: {
        'overlay-color': '#3b82f6',
        'overlay-opacity': 0.18,
        'overlay-padding': 4,
      } as any,
    },
  ];

  // Reusable color classes (FF-compatible names)
  const palette: Record<string, string> = {
    red: '#ef4444', orange: '#f97316', yellow: '#eab308',
    green: '#22c55e', blue: '#3b82f6', purple: '#8b5cf6',
    grey: '#6b7280', pink: '#ec4899', teal: '#14b8a6',
    white: '#ffffff', black: '#0a0a0a',
  };
  for (const [name, color] of Object.entries(palette)) {
    ts.push({ selector: `node.color_${name}`, style: { 'background-color': color } as any });
    ts.push({ selector: `edge.color_${name}`, style: { 'line-color': color, 'target-arrow-color': color } as any });
  }
  for (const s of SHAPE_OPTIONS) {
    ts.push({ selector: `node.shape_${s.replace(/-/g, '_')}`, style: { shape: s as any } });
  }
  ts.push({ selector: 'edge.dashed', style: { 'line-style': 'dashed' } as any });
  ts.push({ selector: 'edge.dotted', style: { 'line-style': 'dotted' } as any });
  ts.push({ selector: 'edge.thick', style: { width: Math.max(theme.edgeWidth + 2, 4) } as any });

  return ts;
}

// =====================================================================
// Custom CSS preprocessing: $vars + @import font loading
// =====================================================================
function preprocessCustomCss(raw: string, theme: FFTheme): string {
  if (!raw) { return ''; }
  // Extract @import url(...) fonts
  const imports: string[] = [];
  raw = raw.replace(/@import\s+url\(([^)]+)\)\s*;?/g, (_m, url) => {
    imports.push(url.replace(/["']/g, '').trim());
    return '';
  });
  applyFontImports(imports);

  // Extract $var: value;
  const vars: Record<string, string> = {
    background: theme.background,
    color: theme.color,
    red: '#ef4444', orange: '#f97316', yellow: '#eab308',
    green: '#22c55e', blue: '#3b82f6', purple: '#8b5cf6', grey: '#6b7280',
  };
  raw = raw.replace(/^\s*\$([\w-]+)\s*:\s*([^;]+);/gm, (_m, name, val) => {
    vars[name] = String(val).trim();
    return '';
  });
  // Substitute $var occurrences
  raw = raw.replace(/\$([\w-]+)\b/g, (m, name) => vars[name] ?? m);
  return raw;
}

function applyFontImports(urls: string[]) {
  // Combine with already-imported set
  for (const url of urls) {
    if (importedFontUrls.has(url)) { continue; }
    importedFontUrls.add(url);
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = url;
    document.head.appendChild(link);
  }
}

// =====================================================================
// Parse custom CSS to find dynamic class names used in selectors
// =====================================================================
function extractDynamicClasses(css: string) {
  const out = { node: [] as string[], edge: [] as string[], parent: [] as string[] };
  if (!css) { return out; }
  // Match :childless.X, edge.X, :parent.X, node.X, or bare .X (treated as node).
  const re = /(?::childless|edge|:parent|node)?\.([A-Za-z_][\w-]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    const cls = m[1];
    const sel = m[0];
    if (sel.startsWith('edge')) { out.edge.push(cls); }
    else if (sel.startsWith(':parent')) { out.parent.push(cls); }
    else { out.node.push(cls); }
  }
  return out;
}

// =====================================================================
// Apply theme.background to canvas
// =====================================================================
function applyBackground(theme: FFTheme) {
  const cyEl = document.getElementById('cy');
  if (cyEl) {
    cyEl.style.background = theme.background;
  }
}

// =====================================================================
// Icons — Google Material Design Icons fetched as SVG, tinted with text
// color, cached as data URIs. flowchart-fun uses the same source URL.
// =====================================================================
const iconCache = new Map<string, string>();
const iconInflight = new Map<string, Promise<string>>();

async function getIconDataUri(icon: string, color: string): Promise<string> {
  const key = `${icon}|${color}`;
  if (iconCache.has(key)) { return iconCache.get(key)!; }
  if (iconInflight.has(key)) { return iconInflight.get(key)!; }
  const p = (async () => {
    // const url = `https://raw.githubusercontent.com/google/material-design-icons/master/src/${icon}/materialicons/24px.svg`;
    const url = `https://raw.githubusercontent.com/google/material-design-icons/master/symbols/web/${icon}/materialsymbolssharp/${icon}_gradN25_24px.svg`;
    try {
      const r = await fetch(url);
      if (!r.ok) { throw new Error(String(r.status)); }
      let svg = await r.text();
      // First strip fills from the body (everything after <svg ...>), but
      // PRESERVE fill="none" — material icons use a fill="none" rectangle
      // as a transparent overlay. Stripping it makes the icon a solid block.
      svg = svg.replace(/^(<svg[^>]*>)([\s\S]*)$/, (_m, head: string, body: string) => {
        const cleanedBody = body.replace(/\sfill="([^"]*)"/g, (m, v: string) => v === 'none' ? m : '');
        // Drop any existing root fill, then inject our color.
        const cleanedHead = head.replace(/\sfill="[^"]*"/g, '').replace(/<svg/, `<svg fill="${color}"`);
        return cleanedHead + cleanedBody;
      });
      const dataUri = 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
      iconCache.set(key, dataUri);
      return dataUri;
    } catch {
      iconCache.set(key, '');
      return '';
    } finally {
      iconInflight.delete(key);
    }
  })();
  iconInflight.set(key, p);
  return p;
}

function measureLabelMetrics(text: string, font: string, fontSize: number): { w: number; h: number } {
  const canvas = (measureLabelMetrics as any)._c
    ?? ((measureLabelMetrics as any)._c = document.createElement('canvas'));
  const ctx: CanvasRenderingContext2D = canvas.getContext('2d');
  ctx.font = font;
  const lines = String(text).split(/\r?\n/);
  let maxW = 0;
  for (const l of lines) {
    const w = ctx.measureText(l).width;
    if (w > maxW) { maxW = w; }
  }
  // Cytoscape's default line-height is 1; bumped slightly for descenders.
  const h = Math.max(1, lines.length) * fontSize * 1.1;
  return { w: maxW, h };
}

function applyIcons(theme: FFTheme) {
  if (!cy) { return; }
  const iw = Math.max(8, Number(theme.iconWidth) || 24);
  const ih = Math.max(8, Number(theme.iconHeight) || 24);
  const sp = Math.max(0, Number(theme.iconSpacing) || 0);
  const basePad = Math.max(Number(theme.padding) || 0, 4);
  const fontSize = Number(theme.fontSize) || 16;
  const font = `${theme.fontWeight || 400} ${fontSize}px "${theme.fontFamily}"`;
  cy.nodes('[icon]').forEach((ele) => {
    const icon = String(ele.data('icon') ?? '').trim();
    if (!icon) { return; }
    const isParent = ele.isParent();
    let placement = theme.iconPlacement || 'before';
    if (isParent) {
      if (placement === 'above') { placement = 'before'; }
      else if (placement === 'below') { placement = 'after'; }
    }
    const color = String(ele.style('color') || theme.color || '#000');
    getIconDataUri(icon, color).then((uri) => {
      if (!uri || !cy) { return; }
      const el = cy.getElementById(ele.id());
      if (el.empty()) { return; }
      const baseStyle: any = {
        'background-image': uri,
        'background-image-opacity': 1,
        'background-fit': 'none',
        'background-clip': 'none',
        'background-width': iw + 'px',
        'background-height': ih + 'px',
        'background-repeat': 'no-repeat',
      };

      const label = String(el.data('label') ?? el.data('id') ?? '');

      if (isParent) {
        // Parent group: label sits ABOVE the top border (text-valign: top,
        // text-margin-y: -8). Place the icon at label height beside the
        // centered label, computed using a canvas measurement of the label.
        const parentFont = `${theme.fontWeight || 600} ${fontSize}px "${theme.fontFamily}"`;
        const labelW = measureLabelMetrics(label, parentFont, fontSize).w;
        const ow = el.outerWidth();
        const labelCenterY = -8 - fontSize / 2;
        const iconY = labelCenterY - ih / 2;
        let iconX = 0;
        if (placement === 'before') {
          baseStyle['text-margin-x'] = (iw + sp) / 2;
          const labelCenterX = ow / 2 + (iw + sp) / 2;
          iconX = labelCenterX - labelW / 2 - sp - iw;
        } else {
          baseStyle['text-margin-x'] = -(iw + sp) / 2;
          const labelCenterX = ow / 2 - (iw + sp) / 2;
          iconX = labelCenterX + labelW / 2 + sp;
        }
        baseStyle['background-position-x'] = `${iconX}px`;
        baseStyle['background-position-y'] = `${iconY}px`;
        el.style(baseStyle);
        return;
      }

      // Leaf node: compute explicit box dimensions so the icon is GUARANTEED
      // to sit beside the label with `sp` spacing, regardless of how
      // Cytoscape's `width: 'label'` autosizer interacts with padding.
      const { w: labelW, h: labelH } = measureLabelMetrics(label, font, fontSize);
      let boxW = 0, boxH = 0;
      let marginX = 0, marginY = 0;
      let iconX = 0, iconY = 0;
      const labelBoxW = Math.max(0, labelW);
      const labelBoxH = Math.max(fontSize, labelH);
      switch (placement) {
        case 'before':
          boxW = basePad + iw + sp + labelBoxW + basePad;
          boxH = Math.max(ih, labelBoxH) + 2 * basePad;
          marginX = (iw + sp) / 2;
          marginY = 0;
          iconX = basePad;
          iconY = (boxH - ih) / 2;
          break;
        case 'after':
          boxW = basePad + labelBoxW + sp + iw + basePad;
          boxH = Math.max(ih, labelBoxH) + 2 * basePad;
          marginX = -(iw + sp) / 2;
          marginY = 0;
          iconX = boxW - basePad - iw;
          iconY = (boxH - ih) / 2;
          break;
        case 'above':
          boxW = Math.max(iw, labelBoxW) + 2 * basePad;
          boxH = basePad + ih + sp + labelBoxH + basePad;
          marginX = 0;
          marginY = (ih + sp) / 2;
          iconX = (boxW - iw) / 2;
          iconY = basePad;
          break;
        case 'below':
          boxW = Math.max(iw, labelBoxW) + 2 * basePad;
          boxH = basePad + labelBoxH + sp + ih + basePad;
          marginX = 0;
          marginY = -(ih + sp) / 2;
          iconX = (boxW - iw) / 2;
          iconY = boxH - basePad - ih;
          break;
      }
      el.style({
        ...baseStyle,
        'width': boxW,
        'height': boxH,
        'padding': 0,
        'padding-left': 0,
        'padding-right': 0,
        'padding-top': 0,
        'padding-bottom': 0,
        'text-margin-x': marginX,
        'text-margin-y': marginY,
        'background-position-x': `${iconX}px`,
        'background-position-y': `${iconY}px`,
      });
    });
  });
}

// =====================================================================
// Incremental render: diff current cy state vs new elements
// =====================================================================
function isSameClasses(eleClasses: string[], newClasses: string[]): boolean {
  if (eleClasses.length !== newClasses.length) { return false; }
  const a = [...eleClasses].sort();
  const b = [...newClasses].sort();
  for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) { return false; } }
  return true;
}

function renderIncremental(text: string, meta: any, opts: { themeChanged: boolean; textChanged: boolean; forceRelayout?: boolean }) {
  if (!cy) { return; }
  const theme = getTheme();
  // Preserve viewport across settings-only changes (theme changed but text didn't).
  const preserveViewport = opts.themeChanged && !opts.textChanged;
  const savedZoom = preserveViewport ? cy.zoom() : null;
  const savedPan = preserveViewport ? { ...cy.pan() } : null;
  const newEls = buildElements(text);
  const newById = new Map<string, cytoscape.ElementDefinition>();
  for (const e of newEls) { newById.set(String(e.data!.id), e); }

  const existing = cy.elements();
  const removed: cytoscape.Collection = cy.collection();
  existing.forEach((el) => {
    if (!newById.has(String(el.id()))) { removed.merge(el as any); }
  });
  if (removed.length) { cy.remove(removed); }

  const toAdd: cytoscape.ElementDefinition[] = [];
  const newNodeIdsAdded: string[] = [];

  for (const el of newEls) {
    const id = String(el.data!.id);
    const cur = cy.getElementById(id);
    if (cur.empty()) {
      toAdd.push(el);
      if (el.group === 'nodes') { newNodeIdsAdded.push(id); }
      continue;
    }
    // Update label and data
    const curData = cur.data() ?? {};
    const newData = el.data ?? {};
    let changed = false;
    for (const k of Object.keys(newData)) {
      if (k === 'id' || k === 'source' || k === 'target') { continue; }
      if (curData[k] !== (newData as any)[k]) {
        cur.data(k, (newData as any)[k]);
        changed = true;
      }
    }
    // Remove data keys that no longer exist
    for (const k of Object.keys(curData)) {
      if (['id', 'source', 'target'].includes(k)) { continue; }
      if (!(k in newData)) { cur.removeData(k); changed = true; }
    }
    // Sync classes
    const curClasses = (cur as any).classes() as string[];
    const newClasses: string[] = (el.classes as any) ?? [];
    if (!isSameClasses(curClasses, newClasses)) {
      for (const c of curClasses) { cur.removeClass(c); }
      for (const c of newClasses) { cur.addClass(c); }
      changed = true;
    }
    void changed;
  }

  if (toAdd.length) {
    cy.add(toAdd);
    // Apply saved positions on freshly-added nodes
    const positions = meta?.nodePositions ?? {};
    for (const id of newNodeIdsAdded) {
      const p = positions[id];
      if (p && typeof p.x === 'number' && typeof p.y === 'number') {
        cy.getElementById(id).position({ x: p.x, y: p.y });
      }
    }
  }

  // Layout policy
  const wasEmpty = existing.length === 0;
  const structural = toAdd.length > 0 || removed.length > 0;
  if (autoLayout) {
    if (wasEmpty || structural || opts.textChanged || opts.forceRelayout) {
      try { cy.layout(buildLayout(theme, 'all')).run(); } catch { /* ignore */ }
      persistAllPositions();
    }
  } else if (opts.forceRelayout) {
    try { cy.layout(buildLayout(theme, 'all')).run(); } catch { /* ignore */ }
    persistAllPositions();
  } else {
    // Preserve user positions; lay out only newly-introduced unpositioned nodes
    const positions = meta?.nodePositions ?? {};
    const unpositioned = newNodeIdsAdded.filter((id) => !positions[id]);
    if (unpositioned.length > 0) {
      const newNodes = cy.collection(unpositioned.map((id) => cy!.getElementById(id) as any));
      const sub = newNodes.union(newNodes.connectedEdges());
      try {
        sub.layout({ ...buildLayout(theme, 'all'), fit: false } as any).run();
      } catch { /* ignore */ }
      persistAllPositions();
    }
  }

  // Style refresh on theme change
  if (opts.themeChanged) {
    const dyn = extractDynamicClasses(meta?.cytoscapeStyle ?? '');
    const base = buildStylesheet(theme, dyn);
    cy.style().fromJson(base).update();
    applyExtraCss(meta?.cytoscapeStyle ?? '', theme);
    applyBackground(theme);
  }
  // Icons: always re-apply so newly-added nodes get their icon and so
  // tinting follows the current text color.
  applyIcons(theme);

  // Restore viewport on pure settings change so the camera doesn't snap-to-fit.
  if (preserveViewport && savedZoom != null && savedPan) {
    try {
      cy.viewport({ zoom: savedZoom, pan: savedPan });
    } catch { /* ignore */ }
  }
}

function applyExtraCss(rawCss: string, theme: FFTheme) {
  if (!cy) { return; }
  if (!rawCss?.trim()) { return; }
  const css = preprocessCustomCss(rawCss, theme);
  // graph-selector style.json compat: try to apply as a JSON list if user writes one.
  let json: any = null;
  try { json = JSON.parse(css); } catch { /* not JSON; ignore */ }
  if (Array.isArray(json)) {
    try {
      const current = (cy.style() as any).json() as any[];
      cy.style().fromJson([...(Array.isArray(current) ? current : []), ...json]).update();
    } catch { /* ignore */ }
    return;
  }
  // Parse simple `selector { prop: val; ... }` blocks.
  const rules: cytoscape.Stylesheet[] = [];
  const re = /([^{}]+)\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    let selector = m[1].trim();
    const body = m[2];
    if (!selector) { continue; }
    // Allow comma-separated selectors
    const selectors = selector.split(',').map((s) => s.trim()).filter(Boolean);
    for (let sel of selectors) {
      // Auto-prefix bare class selectors (e.g. ".custom-red") so they apply to nodes
      if (/^\.[A-Za-z_][\w-]*$/.test(sel)) { sel = 'node' + sel; }
      const styleObj: any = {};
      body.split(';').forEach((decl) => {
        const idx = decl.indexOf(':');
        if (idx < 0) { return; }
        const prop = decl.slice(0, idx).trim();
        const val = decl.slice(idx + 1).trim();
        if (!prop || !val) { return; }
        const mapped = mapCssPropToCytoscape(prop);
        if (Array.isArray(mapped)) {
          for (const p of mapped) { styleObj[p] = val; }
        } else {
          styleObj[mapped] = val;
        }
      });
      if (Object.keys(styleObj).length) {
        rules.push({ selector: sel, style: styleObj });
      }
    }
  }
  if (rules.length) {
    try {
      const current = (cy.style() as any).json() as any[];
      cy.style().fromJson([...(Array.isArray(current) ? current : []), ...rules]).update();
    } catch { /* ignore */ }
  }
}

// Map common CSS property names users might write to the equivalent cytoscape
// stylesheet properties. Cytoscape uses hyphenated names but is strict.
function mapCssPropToCytoscape(prop: string): string | string[] {
  const p = prop.toLowerCase();
  switch (p) {
    case 'background':
    case 'bg':
    case 'fill': return 'background-color';
    case 'color': return 'color';
    case 'foreground': return 'color';
    case 'text-color': return 'color';
    case 'border': return ['border-width', 'border-color', 'border-style'];
    case 'stroke': return 'line-color';
    case 'stroke-width': return 'width';
    case 'font': return 'font-family';
    default: return p;
  }
}

function persistAllPositions() {
  if (!cy) { return; }
  const positions: Record<string, { x: number; y: number }> = {};
  cy.nodes().forEach((n) => {
    const p = n.position();
    positions[String(n.id())] = { x: Math.round(p.x), y: Math.round(p.y) };
  });
  currentMeta = { ...currentMeta, nodePositions: positions };
  postMeta();
}

// =====================================================================
// Initial cytoscape setup
// =====================================================================
function initCy() {
  const theme = getTheme();
  const container = document.getElementById('cy') as HTMLDivElement;
  applyBackground(theme);
  cy = cytoscape({
    container,
    elements: [],
    style: buildStylesheet(theme, { node: [], edge: [], parent: [] }) as any,
    wheelSensitivity: theme.wheelSensitivity,
    boxSelectionEnabled: true,
    selectionType: 'additive',
    layout: { name: 'preset' } as any,
  });

  // Drag persistence: turn off Auto-Layout on first manual drag, then save positions
  cy.on('dragfree', 'node', () => {
    if (autoLayout) {
      autoLayout = false;
      currentMeta = { ...currentMeta, autoLayout: false };
      postMeta();
      updateAutoLayoutBtn();
    }
    persistAllPositions();
  });

  // Double-click → revealLine
  cy.on('dbltap', 'node, edge', (evt) => {
    const ln = Number((evt.target as any).data('lineNumber') ?? 0);
    if (ln > 0) { vscode.postMessage({ type: 'revealLine', line: ln }); }
  });

  // Right-click → context menu
  cy.on('cxttap', 'node', (evt) => showCtxMenu(evt as any, 'node'));
  cy.on('cxttap', 'edge', (evt) => showCtxMenu(evt as any, 'edge'));
  cy.on('cxttap', (evt) => {
    if ((evt.target as any) === cy) { showCtxMenu(evt as any, 'canvas'); }
  });

  // Click anywhere to close menus
  cy.on('tap', () => { hideCtxMenu(); });

  // ResizeObserver to keep canvas sized
  if ((window as any).ResizeObserver) {
    const ro = new (window as any).ResizeObserver(() => {
      if (cy) { cy.resize(); }
    });
    ro.observe(container);
  }
  window.addEventListener('resize', () => { if (cy) { cy.resize(); } });
}

// =====================================================================
// Update handler — text + meta from extension
// =====================================================================
function applyUpdate(text: string, meta: any, opts?: { forceRestyle?: boolean; forceRelayout?: boolean }) {
  if (isApplyingDoc) { return; }
  isApplyingDoc = true;
  try {
    const prevTheme = JSON.stringify(currentMeta?.themeEditor ?? {});
    const prevCss = String(currentMeta?.cytoscapeStyle ?? '');
    const prevText = currentText;
    currentText = text;
    currentMeta = meta ?? { themeEditor: {}, cytoscapeStyle: '', nodePositions: {}, autoLayout: true };
    if (typeof currentMeta.autoLayout === 'boolean') { autoLayout = currentMeta.autoLayout; }
    if (!cy) { initCy(); }

    const themeChanged = !!opts?.forceRestyle ||
      JSON.stringify(currentMeta?.themeEditor ?? {}) !== prevTheme ||
      String(currentMeta?.cytoscapeStyle ?? '') !== prevCss;
    const textChanged = text !== prevText;
    const forceRelayout = !!opts?.forceRelayout || themeChanged;

    renderIncremental(text, currentMeta, { themeChanged, textChanged, forceRelayout });
    updateAutoLayoutBtn();
  } finally {
    isApplyingDoc = false;
  }
}

// =====================================================================
// Context menu
// =====================================================================
const ctxMenu = () => document.getElementById('ctx-menu') as HTMLDivElement;

function hideCtxMenu() { ctxMenu().classList.add('hidden'); }

function showCtxMenu(evt: any, kind: 'node' | 'edge' | 'canvas') {
  const target = evt.target;
  const el = ctxMenu();
  const items: string[] = [];
  if (kind === 'node') {
    const id = String(target.id());
    items.push(item('Rename label…', `rename:${id}`));
    items.push(item('Add child', `add-child:${id}`));
    items.push(item('Add sibling', `add-sibling:${id}`));
    items.push(sub('Shape', SHAPE_OPTIONS.map((s) => item(s, `shape:${id}:${s}`)).join('')));
    items.push(sub('Color', colorItems('node', id)));
    items.push(sep());
    items.push(item('Jump to source line', `jump:${id}`));
    items.push(sep());
    items.push(item('Delete', `delete:${id}`, 'danger'));
  } else if (kind === 'edge') {
    const id = String(target.id());
    items.push(item('Rename label…', `edge-rename:${id}`));
    items.push(sub('Color', colorItems('edge', id)));
    items.push(sub('Style', ['solid', 'dashed', 'dotted'].map((s) => item(s, `edge-style:${id}:${s}`)).join('')));
    items.push(item('Thick toggle', `edge-thick:${id}`));
    items.push(sep());
    items.push(item('Jump to source line', `edge-jump:${id}`));
    items.push(sep());
    items.push(item('Delete edge', `edge-delete:${id}`, 'danger'));
  } else {
    items.push(item('Fit to view', `fit:`));
    items.push(item('Reset all positions', `reset-positions:`));
  }
  el.innerHTML = items.join('');
  el.classList.remove('hidden');
  const pt = evt.originalEvent
    ? { x: (evt.originalEvent as MouseEvent).clientX, y: (evt.originalEvent as MouseEvent).clientY }
    : { x: 100, y: 100 };
  const root = document.getElementById('app-root')!.getBoundingClientRect();
  el.style.left = Math.max(0, pt.x - root.left) + 'px';
  el.style.top = Math.max(0, pt.y - root.top) + 'px';
  el.querySelectorAll('.item').forEach((node) => {
    node.addEventListener('click', () => {
      const a = (node as HTMLElement).dataset.action!;
      hideCtxMenu();
      handleAction(a);
    });
  });
}

function item(label: string, action: string, cls?: string) {
  return `<div class="item ${cls ?? ''}" data-action="${escapeAttr(action)}">${escapeHtml(label)}</div>`;
}
function sep() { return `<div class="sep"></div>`; }
function sub(label: string, inner: string) {
  return `<div class="submenu"><div class="item">${escapeHtml(label)}</div><div class="submenu-panel">${inner}</div></div>`;
}
function colorItems(kind: 'node' | 'edge', id: string) {
  return ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'grey', 'pink', 'teal']
    .map((c) => item(c, `${kind === 'edge' ? 'edge-color' : 'color'}:${id}:${c}`))
    .concat(item('— remove color —', `${kind === 'edge' ? 'edge-color' : 'color'}:${id}:`))
    .join('');
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
function escapeAttr(s: string) { return escapeHtml(s); }

// =====================================================================
// Action handlers (use graph-selector.operate where possible)
// =====================================================================
function handleAction(action: string) {
  const [op, ...rest] = action.split(':');
  switch (op) {
    case 'rename': return renameNode(rest[0]);
    case 'add-child': return addChild(rest[0]);
    case 'add-sibling': return addSibling(rest[0]);
    case 'shape': return setNodeClassExclusive(rest[0], 'shape_', rest[1].replace(/-/g, '_'));
    case 'color': return setNodeClassExclusive(rest[0], 'color_', rest[1] ?? '');
    case 'delete': return deleteNode(rest[0]);
    case 'jump': return jumpToLine(cy?.getElementById(rest[0]).data('lineNumber'));
    case 'edge-rename': return renameEdge(rest[0]);
    case 'edge-color': return setEdgeClassExclusive(rest[0], 'color_', rest[1] ?? '');
    case 'edge-style': return setEdgeClassExclusive(rest[0], '', rest[1] === 'solid' ? '' : rest[1]);
    case 'edge-thick': return toggleEdgeClass(rest[0], 'thick');
    case 'edge-jump': return jumpToLine(cy?.getElementById(rest[0]).data('lineNumber'));
    case 'edge-delete': return deleteEdge(rest[0]);
    case 'fit': return cy?.fit(undefined, 24);
    case 'reset-positions': {
      currentMeta = { ...currentMeta, nodePositions: {} };
      postMeta();
      if (cy) {
        cy.layout(buildLayout(getTheme(), 'all')).run();
        persistAllPositions();
      }
      return;
    }
  }
}

// ---- Text-level mutations (line-aware) -----------------------------------
function findNodeLine(id: string): number | null {
  if (!cy) { return null; }
  const n = cy.getElementById(id);
  const ln = Number(n.data('lineNumber') ?? 0);
  return ln > 0 ? ln - 1 : null;
}

function getLines(): string[] { return currentText.split(/\r?\n/); }
function joinLines(lines: string[]): string { return lines.join('\n'); }

function indentOf(line: string): string {
  const m = /^(\s*)/.exec(line); return m ? m[1] : '';
}

async function renameNode(id: string) {
  const idx = findNodeLine(id); if (idx == null) { return; }
  const lines = getLines();
  const orig = lines[idx];
  const indent = indentOf(orig);
  const stripped = orig.slice(indent.length);
  const labelMatch = /^([^#.\[(\/]*?)(\s*(?:[#.\[(\/].*)?)$/.exec(stripped);
  const currentLabel = (labelMatch?.[1] ?? stripped).trim();
  const newLabel = await ffPrompt('New label:', currentLabel);
  if (newLabel == null) { return; }
  const suffix = labelMatch?.[2] ?? '';
  lines[idx] = indent + newLabel + suffix;
  postText(joinLines(lines));
}

async function renameEdge(id: string) {
  if (!cy) { return; }
  const edge = cy.getElementById(id);
  const ln = Number(edge.data('lineNumber') ?? 0);
  if (ln <= 0) { return; }
  const idx = ln - 1;
  const lines = getLines();
  const orig = lines[idx];
  const m = /^(\s+)([A-Za-z][\w-]*\s*):\s*(.*)$/.exec(orig);
  const cur = m?.[3] ?? '';
  const next = await ffPrompt('Edge label:', cur);
  if (next == null) { return; }
  if (m) {
    lines[idx] = `${m[1]}${m[2].trim()}: ${next}`;
  } else {
    lines[idx] = `${indentOf(orig)}label: ${next}`;
  }
  postText(joinLines(lines));
}

async function addChild(id: string) {
  const idx = findNodeLine(id); if (idx == null) { return; }
  const lines = getLines();
  const parentIndent = indentOf(lines[idx]);
  const childIndent = parentIndent + (parentIndent.includes('\t') ? '\t' : '  ');
  const label = await ffPrompt('Child label:', 'New child');
  if (label == null) { return; }
  lines.splice(idx + 1, 0, childIndent + label);
  postText(joinLines(lines));
}

async function addSibling(id: string) {
  const idx = findNodeLine(id); if (idx == null) { return; }
  const lines = getLines();
  const ind = indentOf(lines[idx]);
  const label = await ffPrompt('Sibling label:', 'New sibling');
  if (label == null) { return; }
  let end = idx + 1;
  while (end < lines.length && (lines[end].trim() === '' || indentOf(lines[end]).length > ind.length)) { end++; }
  lines.splice(end, 0, ind + label);
  postText(joinLines(lines));
}

function deleteNode(id: string) {
  try {
    const next = operate(currentText, { type: 'removeNode', nodeId: id } as any);
    if (typeof next === 'string') { postText(next); return; }
  } catch { /* fall through */ }
  // Fallback: line-based delete of the node line and its subtree
  const idx = findNodeLine(id); if (idx == null) { return; }
  const lines = getLines();
  const ind = indentOf(lines[idx]);
  let end = idx + 1;
  while (end < lines.length && (lines[end].trim() === '' || indentOf(lines[end]).length > ind.length)) { end++; }
  lines.splice(idx, end - idx);
  postText(joinLines(lines));
}

function deleteEdge(id: string) {
  if (!cy) { return; }
  const edge = cy.getElementById(id);
  const ln = Number(edge.data('lineNumber') ?? 0);
  if (ln <= 0) { return; }
  const lines = getLines();
  lines.splice(ln - 1, 1);
  postText(joinLines(lines));
}

function setNodeClassExclusive(id: string, prefix: string, value: string) {
  // graph-selector's `operate` has a different signature than what we want
  // here, so we drive class changes directly via line-rewriting which both
  // node and edge lines route through.
  textEditNodeClasses(id, prefix, value);
}

function setEdgeClassExclusive(id: string, prefix: string, value: string) {
  if (!cy) { return; }
  const edge = cy.getElementById(id);
  const ln = Number(edge.data('lineNumber') ?? 0);
  if (ln <= 0) { return; }
  textEditClassesOnLine(ln - 1, prefix, value);
}

function toggleEdgeClass(id: string, cls: string) {
  if (!cy) { return; }
  const edge = cy.getElementById(id);
  const ln = Number(edge.data('lineNumber') ?? 0);
  if (ln <= 0) { return; }
  const has = (edge as any).hasClass(cls);
  textEditClassesOnLine(ln - 1, '', has ? `__remove__${cls}` : cls);
}

function isEdgeLine(line: string): boolean {
  const trimmed = line.replace(/^\s+/, '');
  // Edge label syntax: `<label>: ...` where the colon is not escaped.
  // Use a non-stateful regex on the original (no-indent) line.
  const m = /([^\\])(: |：)/.exec(' ' + trimmed);
  return !!m;
}

function textEditNodeClasses(id: string, prefix: string, value: string) {
  const idx = findNodeLine(id); if (idx == null) { return; }
  textEditClassesOnLine(idx, prefix, value);
}

function textEditClassesOnLine(idx: number, prefix: string, value: string) {
  const lines = getLines();
  let line = lines[idx];
  if (!line) { return; }
  const indentMatch = /^(\s*)/.exec(line);
  const indent = indentMatch ? indentMatch[1] : '';
  let body = line.slice(indent.length);
  const edge = isEdgeLine(line);

  // Build the new class list. Existing classes for node lines live in a
  // contiguous `.foo.bar.baz` run preceded by whitespace; for edge lines
  // they MUST be prepended (graph-selector parses `routes: (#x) .foo` as
  // "node and pointer on same line").
  //
  // 1. Extract & remove all existing classes from the line first.
  const classRegex = /(?:^|(?<=\s))(\.[a-zA-Z][\w-]*(?:\.[a-zA-Z][\w-]*)*)/g;
  const existingClasses: string[] = [];
  body = body.replace(classRegex, (m, run: string) => {
    for (const c of run.split('.').filter(Boolean)) { existingClasses.push(c); }
    return '';
  }).replace(/\s+/g, ' ').trim();

  // 2. Compute the new class list.
  let newClasses = existingClasses.slice();
  if (prefix) {
    newClasses = newClasses.filter((c) => !c.startsWith(prefix));
    if (value) { newClasses.push(prefix + value); }
  } else if (value.startsWith('__remove__')) {
    const cls = value.slice('__remove__'.length);
    newClasses = newClasses.filter((c) => c !== cls);
  } else if (value) {
    if (!newClasses.includes(value)) { newClasses.push(value); }
  }
  const classRun = newClasses.length ? newClasses.map((c) => '.' + c).join('') : '';

  // 3. Reassemble. Edge lines: classes go at the START of body (before the
  // label and colon). Node lines: classes go at the END, separated by a
  // single space, so they don't disrupt the label/id.
  let newBody: string;
  if (edge) {
    newBody = classRun ? (classRun + ' ' + body).trim() : body;
  } else {
    newBody = classRun ? (body + (body ? ' ' : '') + classRun) : body;
  }
  lines[idx] = indent + newBody;
  postText(joinLines(lines));
}

function jumpToLine(line: number | undefined) {
  const ln = Number(line ?? 0);
  if (ln > 0) { vscode.postMessage({ type: 'revealLine', line: ln }); }
}

// =====================================================================
// Toolbar
// =====================================================================
function updateAutoLayoutBtn() {
  const btn = document.getElementById('btn-auto-layout');
  if (!btn) { return; }
  btn.classList.toggle('active', autoLayout);
  btn.textContent = autoLayout ? '↻ Auto-Layout: ON' : '↻ Auto-Layout: OFF';
}

function setAutoLayout(next: boolean) {
  if (autoLayout === next) { return; }
  autoLayout = next;
  currentMeta = { ...currentMeta, autoLayout: next };
  postMeta();
  updateAutoLayoutBtn();
  if (next && cy) {
    try { cy.layout(buildLayout(getTheme(), 'all')).run(); } catch { /* ignore */ }
    persistAllPositions();
  }
}

function wireToolbar() {
  document.getElementById('btn-auto-layout')?.addEventListener('click', () => setAutoLayout(!autoLayout));
  document.getElementById('btn-fit')?.addEventListener('click', () => cy?.fit(undefined, 24));
  document.getElementById('btn-zoom-in')?.addEventListener('click', () => {
    if (!cy) { return; }
    const c = { x: cy.width() / 2, y: cy.height() / 2 };
    cy.zoom({ level: cy.zoom() * 1.2, renderedPosition: c });
  });
  document.getElementById('btn-zoom-out')?.addEventListener('click', () => {
    if (!cy) { return; }
    const c = { x: cy.width() / 2, y: cy.height() / 2 };
    cy.zoom({ level: cy.zoom() / 1.2, renderedPosition: c });
  });
  document.getElementById('btn-zoom-100')?.addEventListener('click', () => {
    if (!cy) { return; }
    const c = { x: cy.width() / 2, y: cy.height() / 2 };
    cy.zoom({ level: 1, renderedPosition: c });
  });
  document.getElementById('btn-reset-positions')?.addEventListener('click', () => {
    const nextMeta = { ...currentMeta, nodePositions: {}, autoLayout: true };
    applyUpdate(currentText, nextMeta, { forceRestyle: false });
    postMeta();
  });
  document.querySelectorAll('#toolbar [data-export]').forEach((b) => {
    b.addEventListener('click', () => exportAs((b as HTMLElement).dataset.export as any));
  });
  document.getElementById('btn-settings')?.addEventListener('click', toggleSettings);
  updateAutoLayoutBtn();
}

function exportAs(format: 'png' | 'jpg' | 'svg') {
  if (!cy) { return; }
  if (format === 'svg') {
    try {
      const data = (cy as any).svg ? (cy as any).svg({ full: true, scale: 1 }) : null;
      if (!data) {
        vscode.postMessage({ type: 'showError', text: 'SVG export requires cytoscape-svg plugin (not installed). Use PNG/JPG.' });
        return;
      }
      vscode.postMessage({ type: 'export', format, data });
    } catch (e: any) {
      vscode.postMessage({ type: 'showError', text: 'SVG export failed: ' + (e?.message ?? e) });
    }
    return;
  }
  const data = format === 'png'
    ? cy.png({ full: true, scale: 2, bg: getTheme().background, output: 'base64uri' })
    : cy.jpg({ full: true, scale: 2, bg: getTheme().background, output: 'base64uri', quality: 0.92 });
  vscode.postMessage({ type: 'export', format, data });
}

// =====================================================================
// Settings panel
// =====================================================================
function toggleSettings() {
  const p = document.getElementById('settings-panel')!;
  if (p.classList.contains('hidden')) { openSettings(); }
  else { closeSettings(); }
}

function openSettings() {
  const p = document.getElementById('settings-panel')!;
  renderSettings();
  p.classList.remove('hidden');
  setTimeout(() => {
    document.addEventListener('mousedown', settingsOutsideClick, true);
    document.addEventListener('keydown', settingsKeydown, true);
  }, 0);
}

function closeSettings() {
  const p = document.getElementById('settings-panel')!;
  p.classList.add('hidden');
  document.removeEventListener('mousedown', settingsOutsideClick, true);
  document.removeEventListener('keydown', settingsKeydown, true);
}

function settingsOutsideClick(ev: MouseEvent) {
  const p = document.getElementById('settings-panel');
  const btn = document.getElementById('btn-settings');
  if (!p || p.classList.contains('hidden')) { return; }
  const t = ev.target as Node;
  if (p.contains(t) || (btn && btn.contains(t))) { return; }
  closeSettings();
}

function settingsKeydown(ev: KeyboardEvent) {
  if (ev.key === 'Escape') { closeSettings(); }
}

function renderSettings() {
  const p = document.getElementById('settings-panel')!;
  const t = getTheme();
  const e = currentMeta?.themeEditor ?? {};
  const customCss = String(currentMeta?.cytoscapeStyle ?? '');

  p.innerHTML = `
    <h3>Layout</h3>
    <label><span>Algorithm</span>${select('layoutName', t.layoutName, LAYOUT_NAMES)}</label>
    <label><span>Direction</span>${select('direction', t.direction, ['DOWN','UP','LEFT','RIGHT'])}</label>
    <label><span>Spacing Factor</span>${numInput('spacingFactor', t.spacingFactor, 0.1, 4, 0.05)}</label>
    <label><span>Wheel Sensitivity</span>${numInput('wheelSensitivity', t.wheelSensitivity, 0.1, 3, 0.1)}</label>

    <h4>Background &amp; Text</h4>
    <label><span>Background</span>${colorInput('background', t.background)}</label>
    <label><span>Text Color</span>${colorInput('color', t.color)}</label>
    <label><span>Font Family</span>${select('fontFamily', t.fontFamily, FF_FONTS, true)}</label>
    <label><span>Font Size</span>${numInput('fontSize', t.fontSize, 6, 64, 1)}</label>
    <label><span>Font Weight</span>${select('fontWeight', String(t.fontWeight), ['300','400','500','600','700'])}</label>
    <label><span>Text Transform</span>${select('textTransform', t.textTransform, ['none','uppercase','lowercase','capitalize'])}</label>
    <label><span>Text Margin Y</span>${numInput('textMarginY', t.textMarginY, -40, 40, 1)}</label>

    <h4>Nodes</h4>
    <label><span>Shape</span>${select('shape', t.shape, SHAPE_OPTIONS)}</label>
    <label><span>Node Background</span>${colorInput('nodeBackground', t.nodeBackground)}</label>
    <label><span>Border Color</span>${colorInput('borderColor', t.borderColor)}</label>
    <label><span>Border Width</span>${numInput('borderWidth', t.borderWidth, 0, 20, 1)}</label>
    <label><span>Border Style</span>${select('borderStyle', t.borderStyle, ['solid','dashed','dotted','double'])}</label>
    <label><span>Padding</span>${numInput('padding', t.padding, 0, 60, 1)}</label>
    <label><span>Corner Radius</span>${numInput('cornerRadius', t.cornerRadius, 0, 30, 1)}</label>

    <h4>Icons</h4>
    <label><span>Icon Width</span>${numInput('iconWidth', t.iconWidth, 8, 128, 1)}</label>
    <label><span>Icon Height</span>${numInput('iconHeight', t.iconHeight, 8, 128, 1)}</label>
    <label><span>Icon Spacing</span>${numInput('iconSpacing', t.iconSpacing, 0, 64, 1)}</label>
    <label><span>Icon Placement</span>${select('iconPlacement', t.iconPlacement, ICON_PLACEMENTS)}</label>

    <h4>Edges</h4>
    <label><span>Edge Color</span>${colorInput('edgeColor', t.edgeColor)}</label>
    <label><span>Edge Width</span>${numInput('edgeWidth', t.edgeWidth, 0.5, 10, 0.5)}</label>
    <label><span>Edge Style</span>${select('edgeStyle', t.edgeStyle, ['solid','dashed','dotted'])}</label>
    <label><span>Edge Curve</span>${select('edgeCurve', t.edgeCurve, ['bezier','straight','taxi','unbundled-bezier','segments','round-taxi','round-segments'])}</label>
    <label><span>Source Arrow</span>${select('sourceArrowShape', t.sourceArrowShape, ARROW_SHAPES)}</label>
    <label><span>Target Arrow</span>${select('targetArrowShape', t.targetArrowShape, ARROW_SHAPES)}</label>
    <label><span>Arrow Scale</span>${numInput('arrowScale', t.arrowScale, 0.5, 4, 0.25)}</label>
    <label><span>Edge Text Size</span>${numInput('edgeTextSize', t.edgeTextSize, 0.3, 3, 0.05)}</label>
    <label><span>Edge Text Color</span>${colorInput('edgeTextColor', t.edgeTextColor)}</label>
    <label><span>Edge Text BG</span>${colorInput('edgeTextBackground', t.edgeTextBackground)}</label>
    <label><span>Source Gap</span>${numInput('sourceDistanceFromNode', t.sourceDistanceFromNode, 0, 40, 1)}</label>
    <label><span>Target Gap</span>${numInput('targetDistanceFromNode', t.targetDistanceFromNode, 0, 40, 1)}</label>
    <label><span>Rotate Edge Label</span>${boolInput('rotateEdgeLabel', t.rotateEdgeLabel)}</label>

    <h4>Custom CSS</h4>
    <textarea id="set-css" placeholder="/* Use $background, $color, $red, … or @import url(…) for fonts. */">${escapeHtml(customCss)}</textarea>

    <div class="button-row">
      <button id="set-apply">Apply</button>
      <button id="set-reset">Reset Theme</button>
      <button id="set-close">Close</button>
    </div>
  `;

  p.querySelectorAll<HTMLElement>('[data-key]').forEach((el) => {
    el.addEventListener('change', () => commitSetting(el));
  });
  document.getElementById('set-apply')?.addEventListener('click', () => {
    const nextMeta = { ...currentMeta, cytoscapeStyle: (document.getElementById('set-css') as HTMLTextAreaElement).value };
    applyUpdate(currentText, nextMeta, { forceRestyle: true, forceRelayout: autoLayout });
    postMeta();
  });
  document.getElementById('set-reset')?.addEventListener('click', () => {
    const nextMeta = { ...currentMeta, themeEditor: {} };
    applyUpdate(currentText, nextMeta, { forceRestyle: true, forceRelayout: autoLayout });
    postMeta();
    renderSettings();
  });
  document.getElementById('set-close')?.addEventListener('click', () => closeSettings());
  void e;
}

function commitSetting(el: HTMLElement) {
  const key = el.dataset.key!;
  const t = (el as HTMLInputElement | HTMLSelectElement);
  let val: any = t.value;
  if ((t as HTMLInputElement).type === 'checkbox') { val = (t as HTMLInputElement).checked; }
  if ((t as HTMLInputElement).type === 'number') { val = Number(val); }
  if (['fontWeight'].includes(key)) { val = Number(val); }
  const themeEditor = { ...(currentMeta.themeEditor ?? {}) };
  themeEditor[key] = val;
  const nextMeta = { ...currentMeta, themeEditor };
  applyUpdate(currentText, nextMeta, { forceRestyle: true, forceRelayout: autoLayout });
  postMeta();
}

function select(key: string, val: string, opts: string[], freeText = false): string {
  const options = opts.map((o) => `<option ${o === val ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('');
  if (freeText) {
    return `<input type="text" data-key="${key}" value="${escapeAttr(String(val))}" list="ff-fonts-list" />
      <datalist id="ff-fonts-list">${opts.map((o) => `<option value="${escapeAttr(o)}">`).join('')}</datalist>`;
  }
  return `<select data-key="${key}">${options}</select>`;
}
function numInput(key: string, val: number, min: number, max: number, step: number) {
  return `<input type="number" data-key="${key}" value="${val}" min="${min}" max="${max}" step="${step}" />`;
}
function colorInput(key: string, val: string) {
  return `<input type="color" data-key="${key}" value="${escapeAttr(val)}" />`;
}
function boolInput(key: string, val: boolean) {
  return `<input type="checkbox" data-key="${key}" ${val ? 'checked' : ''} />`;
}

// =====================================================================
// Custom in-webview prompt dialog (window.prompt is blocked in webviews)
// =====================================================================
function ffPrompt(message: string, defaultValue = ''): Promise<string | null> {
  return new Promise((resolve) => {
    const root = document.getElementById('app-root')!;
    const overlay = document.createElement('div');
    overlay.className = 'ff-modal-overlay';
    overlay.innerHTML = `
      <div class="ff-modal">
        <div class="ff-modal-msg"></div>
        <input class="ff-modal-input" type="text" />
        <div class="ff-modal-buttons">
          <button class="ff-modal-cancel">Cancel</button>
          <button class="ff-modal-ok">OK</button>
        </div>
      </div>
    `;
    (overlay.querySelector('.ff-modal-msg') as HTMLDivElement).textContent = message;
    const input = overlay.querySelector('.ff-modal-input') as HTMLInputElement;
    input.value = defaultValue;
    root.appendChild(overlay);
    setTimeout(() => { input.focus(); input.select(); }, 0);
    const finish = (val: string | null) => {
      overlay.remove();
      resolve(val);
    };
    overlay.querySelector('.ff-modal-ok')!.addEventListener('click', () => finish(input.value));
    overlay.querySelector('.ff-modal-cancel')!.addEventListener('click', () => finish(null));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) { finish(null); } });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(input.value); }
      if (e.key === 'Escape') { e.preventDefault(); finish(null); }
    });
  });
}

function setStatus(text: string, isError = false) {
  const s = document.getElementById('status');
  if (!s) { return; }
  s.textContent = text;
  s.classList.toggle('error', isError);
}

function updateErrorBanner() {
  const root = document.getElementById('app-root');
  if (!root) { return; }
  let banner = document.getElementById('error-banner');
  if (lastParseError) {
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'error-banner';
      root.insertBefore(banner, document.getElementById('cy'));
    }
    const lineTxt = lastParseError.line ? ` (line ${lastParseError.line})` : '';
    banner.textContent = `⚠ Syntax error${lineTxt}: ${lastParseError.message}`;
    setStatus(`Parse error${lineTxt}`, true);
  } else {
    if (banner) { banner.remove(); }
    setStatus('OK');
  }
}

// =====================================================================
// Boot
// =====================================================================
window.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg?.type === 'update') {
    applyUpdate(String(msg.text ?? ''), msg.meta ?? {});
    updateErrorBanner();
  }
});

document.addEventListener('DOMContentLoaded', () => {
  wireToolbar();
  vscode.postMessage({ type: 'ready' });
});

// In webview, DOM may already be ready by the time this runs
if (document.readyState !== 'loading') {
  wireToolbar();
  vscode.postMessage({ type: 'ready' });
}
