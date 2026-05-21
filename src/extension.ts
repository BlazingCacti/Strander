import * as vscode from 'vscode';
import { parse } from 'graph-selector';

const VIEW_TYPE = 'strander.editor';
const LEGACY_DELIM = '=====';
const STRAND_LANG = 'strand';
const FILE_NESTING_DONE_KEY = 'strander.fileNestingApplied';

const diagnostics = vscode.languages.createDiagnosticCollection('strand');

const DEFAULT_STRAND = `// Welcome to Strander
// Each line creates a node. Indent to create children.
// Right-click nodes in the visual editor for actions.

Start
  Authenticate
    Valid credentials? .shape_diamond
      Yes .color_green
        Dashboard
      No .color_red
        Show error
`;

const DEFAULT_META = {
  themeEditor: {},
  cytoscapeStyle: '',
  nodePositions: {},
};

function parseIconfilePath(raw: string): string {
  let s = String(raw || '').trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }
  s = s.replace(/\\/g, '/');
  s = s.replace(/([^:/])\/{2,}/g, '$1/');
  return s;
}

function isAbsolutePath(p: string): boolean {
  return /^([a-zA-Z]:\/|\/)/.test(p);
}

async function resolveIconfileUri(documentUri: vscode.Uri, raw: string): Promise<vscode.Uri> {
  const path = parseIconfilePath(raw);
  if (!path) { throw new Error('Empty iconfile path'); }
  let resolved = path;
  if (resolved.startsWith('~/') || resolved === '~') {
    const home = (process.env.HOME || process.env.USERPROFILE || '').replace(/\\/g, '/');
    resolved = resolved.replace(/^~/, home);
  }
  const docDir = vscode.Uri.joinPath(documentUri, '..');
  const candidates: vscode.Uri[] = [];
  if (isAbsolutePath(resolved)) {
    candidates.push(vscode.Uri.file(resolved));
  } else {
    const parts = resolved.split('/');
    candidates.push(vscode.Uri.joinPath(docDir, ...parts));
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      candidates.push(vscode.Uri.joinPath(folder.uri, ...parts));
    }
  }
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      const stat = await vscode.workspace.fs.stat(candidate);
      if (stat.type & vscode.FileType.File) { return candidate; }
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(`iconfile not found: ${raw}${lastError ? ` (${(lastError as any)?.message ?? lastError})` : ''}`);
}

function sidecarUri(uri: vscode.Uri): vscode.Uri {
  return uri.with({ path: uri.path + '.meta' });
}

async function readSidecar(uri: vscode.Uri): Promise<any | null> {
  try {
    const bytes = await vscode.workspace.fs.readFile(sidecarUri(uri));
    const txt = new TextDecoder().decode(bytes);
    if (!txt.trim()) { return {}; }
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

async function writeSidecar(uri: vscode.Uri, meta: any): Promise<void> {
  const bytes = new TextEncoder().encode(JSON.stringify(meta ?? {}, null, 2) + '\n');
  await vscode.workspace.fs.writeFile(sidecarUri(uri), bytes);
}

// One-shot migration: if a file uses the legacy inline ===== meta, split it
// into chart-source + sidecar.
function splitLegacyInline(full: string): { text: string; meta: any } | null {
  const idx = full.indexOf('\n' + LEGACY_DELIM);
  if (idx === -1) { return null; }
  const after = full.slice(idx + 1);
  const parts = after.split(LEGACY_DELIM);
  const metaStr = (parts[1] ?? '').trim();
  let meta: any = {};
  if (metaStr) { try { meta = JSON.parse(metaStr); } catch { meta = {}; } }
  return { text: full.slice(0, idx).replace(/\s+$/, '') + '\n', meta };
}

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(diagnostics);
  context.subscriptions.push(FlowfunEditorProvider.register(context));

  // Ensure VS Code's built-in file nesting includes our pattern.
  void ensureFileNesting(context);

  // Diagnostics: parse open .strand documents and report syntax errors
  const refresh = (doc: vscode.TextDocument) => {
    if (doc.languageId !== STRAND_LANG && !doc.uri.path.endsWith('.strand')) { return; }
    refreshDiagnostics(doc);
  };
  vscode.workspace.textDocuments.forEach(refresh);
  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(refresh));
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((e) => refresh(e.document)));
  context.subscriptions.push(vscode.workspace.onDidCloseTextDocument((d) => diagnostics.delete(d.uri)));

  // Document formatter
  context.subscriptions.push(
    vscode.languages.registerDocumentFormattingEditProvider(STRAND_LANG, {
      provideDocumentFormattingEdits(doc) {
        const formatted = formatFlowfun(doc.getText(), doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n');
        if (formatted === doc.getText()) { return []; }
        return [vscode.TextEdit.replace(fullRangeOf(doc), formatted)];
      },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('strander.openTextEditor', async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) { vscode.window.showWarningMessage('No flowchart file is active.'); return; }
      await vscode.commands.executeCommand('vscode.openWith', target, 'default', vscode.ViewColumn.Active);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('strander.openVisualEditor', async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) { vscode.window.showWarningMessage('No flowchart file is active.'); return; }
      await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE, vscode.ViewColumn.Beside);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('strander.newFile', async () => {
      const folders = vscode.workspace.workspaceFolders;
      const defaultDir = folders && folders.length > 0 ? folders[0].uri : vscode.Uri.file(process.cwd());
      const target = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.joinPath(defaultDir, 'flowchart.strand'),
        filters: { 'Strander': ['strand'] },
        saveLabel: 'Create Flowchart',
      });
      if (!target) { return; }
      await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(DEFAULT_STRAND));
      await writeSidecar(target, DEFAULT_META);
      // Open in text editor first (user preference); user can open visual via title-bar button.
      const doc = await vscode.workspace.openTextDocument(target);
      await vscode.window.showTextDocument(doc);
      await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE, vscode.ViewColumn.Beside);
    })
  );
}

async function ensureFileNesting(context: vscode.ExtensionContext) {
  if (context.globalState.get(FILE_NESTING_DONE_KEY)) { return; }
  try {
    const cfg = vscode.workspace.getConfiguration('explorer');
    const existing = cfg.get<Record<string, string>>('fileNesting.patterns') ?? {};
    if (existing['*.strand'] !== '${capture}.strand.meta') {
      const merged = { ...existing, '*.strand': '${capture}.strand.meta' };
      await cfg.update('fileNesting.patterns', merged, vscode.ConfigurationTarget.Global);
    }
    const enabled = cfg.get<boolean>('fileNesting.enabled');
    if (!enabled) {
      await cfg.update('fileNesting.enabled', true, vscode.ConfigurationTarget.Global);
    }
    await context.globalState.update(FILE_NESTING_DONE_KEY, true);
  } catch {
    /* ignore — user may not have writable user settings */
  }
}

function refreshDiagnostics(doc: vscode.TextDocument) {
  if (!doc.uri.path.endsWith('.strand')) { return; }
  const text = doc.getText();
  const diags: vscode.Diagnostic[] = [];
  try {
    parse(text);
  } catch (e: any) {
    const msg = String(e?.message ?? e ?? 'Parse error');
    const lineMatch = /line[\s:]+(\d+)/i.exec(msg);
    const line = lineMatch ? Math.max(0, Number(lineMatch[1]) - 1) : 0;
    const lineText = line < doc.lineCount ? doc.lineAt(line).text : '';
    const range = new vscode.Range(line, 0, line, Math.max(1, lineText.length));
    diags.push(new vscode.Diagnostic(range, msg, vscode.DiagnosticSeverity.Error));
  }
  // Quick structural checks: unmatched braces
  let depth = 0;
  for (let i = 0; i < doc.lineCount; i++) {
    const t = doc.lineAt(i).text;
    if (/^\s*\}\s*$/.test(t)) {
      depth--;
      if (depth < 0) {
        diags.push(new vscode.Diagnostic(
          new vscode.Range(i, 0, i, t.length),
          'Unmatched closing brace "}"',
          vscode.DiagnosticSeverity.Error,
        ));
        depth = 0;
      }
    } else if (/\{\s*$/.test(t)) {
      depth++;
    }
  }
  if (depth > 0) {
    const last = doc.lineCount - 1;
    diags.push(new vscode.Diagnostic(
      new vscode.Range(last, 0, last, doc.lineAt(last).text.length),
      `Unclosed container — ${depth} "{" never closed`,
      vscode.DiagnosticSeverity.Error,
    ));
  }
  diagnostics.set(doc.uri, diags);
}

function formatFlowfun(text: string, eol: string): string {
  const rawLines = text.split(/\r?\n/);
  // First pass: compute brace depth per line and the column count of leading whitespace.
  type Info = { raw: string; trimmed: string; depthBefore: number; leadingCols: number; };
  const infos: Info[] = [];
  let depth = 0;
  for (const raw of rawLines) {
    const trimmed = raw.replace(/\s+$/, '').replace(/^[ \t]+/, '');
    const leadingMatch = /^([ \t]*)/.exec(raw)!;
    const leadingCols = countColumns(leadingMatch[1]);
    let depthBefore = depth;
    if (/^\}\s*$/.test(trimmed)) {
      depthBefore = Math.max(0, depth - 1);
      depth = depthBefore;
    } else if (/\{\s*$/.test(trimmed)) {
      // depthBefore stays at current depth; depth increases for following lines.
      depth = depth + 1;
    }
    infos.push({ raw, trimmed, depthBefore, leadingCols });
  }

  // Second pass: per brace-scope, find min leadingCols among non-empty, non-close lines,
  // then re-base so the min equals 0 within the scope and indentation is in 2-space units.
  // Identify scopes by depthBefore; for each scope group find min cols.
  const scopeMin = new Map<number, Map<number, number>>(); // depth -> (scopeId -> minCols)
  // Build scopeIds: every time depth changes, a new scope begins for that depth.
  const scopeIds: number[] = new Array(infos.length).fill(0);
  const counters = new Map<number, number>();
  let lastDepth = -1;
  for (let i = 0; i < infos.length; i++) {
    const d = infos[i].depthBefore;
    if (d !== lastDepth) {
      counters.set(d, (counters.get(d) ?? -1) + 1);
      lastDepth = d;
    }
    scopeIds[i] = counters.get(d) ?? 0;
    if (infos[i].trimmed === '' || /^\}\s*$/.test(infos[i].trimmed)) { continue; }
    let perDepth = scopeMin.get(d);
    if (!perDepth) { perDepth = new Map(); scopeMin.set(d, perDepth); }
    const sid = scopeIds[i];
    const cur = perDepth.get(sid);
    if (cur === undefined || infos[i].leadingCols < cur) { perDepth.set(sid, infos[i].leadingCols); }
  }

  const out: string[] = [];
  for (let i = 0; i < infos.length; i++) {
    const info = infos[i];
    if (info.trimmed === '') { out.push(''); continue; }
    if (/^\}\s*$/.test(info.trimmed)) {
      out.push('  '.repeat(info.depthBefore) + '}');
      continue;
    }
    const min = scopeMin.get(info.depthBefore)?.get(scopeIds[i]) ?? 0;
    const rel = Math.max(0, info.leadingCols - min);
    const units = Math.round(rel / 2);
    out.push('  '.repeat(info.depthBefore + units) + info.trimmed);
  }
  return out.join(eol);
}

function countColumns(s: string): number {
  let cols = 0;
  for (const ch of s) { cols += ch === '\t' ? 2 : 1; }
  return cols;
}

function countIndent(s: string): number {
  let units = 0;
  let i = 0;
  while (i < s.length) {
    if (s[i] === '\t') { units++; i++; }
    else {
      let spaces = 0;
      while (i < s.length && s[i] === ' ') { spaces++; i++; }
      units += Math.floor(spaces / 2);
    }
  }
  return units;
}

export function deactivate() { /* no-op */ }

interface PanelState {
  document: vscode.TextDocument;
  panel: vscode.WebviewPanel;
  meta: any;
  pendingMetaWrite?: NodeJS.Timeout;
  // Suppress the immediate echo of our own text writes
  lastWrittenText?: string;
  watcher: vscode.FileSystemWatcher;
  subs: vscode.Disposable[];
}

class FlowfunEditorProvider implements vscode.CustomTextEditorProvider {
  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new FlowfunEditorProvider(context);
    return vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    });
  }

  private panels = new Map<vscode.WebviewPanel, PanelState>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    // Initialize empty file with default content
    if (document.getText().length === 0) {
      const edit = new vscode.WorkspaceEdit();
      edit.insert(document.uri, new vscode.Position(0, 0), DEFAULT_STRAND);
      await vscode.workspace.applyEdit(edit);
    }

    // Migration: if main file still contains inline ===== meta, split it.
    {
      const full = document.getText();
      const legacy = splitLegacyInline(full);
      if (legacy) {
        // Write sidecar from legacy meta
        await writeSidecar(document.uri, legacy.meta);
        // Replace main file content with cleaned text
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, fullRangeOf(document), legacy.text);
        await vscode.workspace.applyEdit(edit);
        vscode.window.setStatusBarMessage(
          `Migrated inline metadata to ${sidecarUri(document.uri).path.split('/').pop()}`,
          5000
        );
      }
    }

    // Load sidecar meta (or create default)
    let meta = await readSidecar(document.uri);
    if (meta == null) {
      meta = { ...DEFAULT_META };
      await writeSidecar(document.uri, meta);
    }

    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };

    webviewPanel.webview.html = this.getHtml(webviewPanel.webview);

    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(
        vscode.Uri.joinPath(document.uri, '..'),
        document.uri.path.split('/').pop() + '.meta'
      )
    );

    const state: PanelState = {
      document,
      panel: webviewPanel,
      meta,
      watcher,
      subs: [],
    };
    this.panels.set(webviewPanel, state);

    const postUpdate = () => {
      webviewPanel.webview.postMessage({
        type: 'update',
        text: document.getText(),
        meta: state.meta,
        version: document.version,
      });
    };

    // Document change → push text to webview (unless it's our own echo)
    state.subs.push(vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) { return; }
      const cur = e.document.getText();
      if (state.lastWrittenText === cur) {
        state.lastWrittenText = undefined;
        return;
      }
      postUpdate();
    }));

    // Sidecar external change → reload meta + push to webview
    state.subs.push(watcher.onDidChange(async () => {
      const next = await readSidecar(document.uri);
      if (next) { state.meta = next; postUpdate(); }
    }));
    state.subs.push(watcher.onDidCreate(async () => {
      const next = await readSidecar(document.uri);
      if (next) { state.meta = next; postUpdate(); }
    }));

    webviewPanel.onDidDispose(() => {
      state.subs.forEach((d) => d.dispose());
      state.watcher.dispose();
      if (state.pendingMetaWrite) { clearTimeout(state.pendingMetaWrite); }
      this.panels.delete(webviewPanel);
    });

    webviewPanel.webview.onDidReceiveMessage(async (msg: any) => {
      const s = this.panels.get(webviewPanel);
      if (!s) { return; }
      switch (msg?.type) {
        case 'ready':
          postUpdate();
          break;
        case 'writeText':
          await this.replaceText(s, String(msg.text ?? ''));
          break;
        case 'writeMeta':
          s.meta = msg.meta ?? {};
          this.scheduleMetaWrite(s);
          break;
        case 'revealLine': {
          const line = Math.max(0, Number(msg.line ?? 0) - 1);
          const editors = vscode.window.visibleTextEditors.filter(
            (e) => e.document.uri.toString() === document.uri.toString()
          );
          let editor = editors[0];
          if (!editor) {
            editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.Beside, true);
          }
          const range = new vscode.Range(line, 0, line, editor.document.lineAt(Math.min(line, editor.document.lineCount - 1)).text.length);
          editor.selection = new vscode.Selection(range.start, range.end);
          editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
          break;
        }
        case 'export': {
          // msg.format = 'png' | 'jpg' | 'svg'
          // msg.data = base64 string for png/jpg, or raw svg string
          const format = String(msg.format ?? 'png');
          const folders = vscode.workspace.workspaceFolders;
          const dir = folders && folders.length > 0 ? folders[0].uri : vscode.Uri.joinPath(document.uri, '..');
          const baseName = (document.uri.path.split('/').pop() ?? 'flowchart').replace(/\.strand$/i, '');
          const target = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.joinPath(dir, `${baseName}.${format}`),
            filters: { [format.toUpperCase()]: [format] },
            saveLabel: `Export ${format.toUpperCase()}`,
          });
          if (!target) { return; }
          let bytes: Uint8Array;
          if (format === 'svg') {
            bytes = new TextEncoder().encode(String(msg.data ?? ''));
          } else {
            const b64 = String(msg.data ?? '').replace(/^data:[^,]+,/, '');
            bytes = Buffer.from(b64, 'base64');
          }
          await vscode.workspace.fs.writeFile(target, bytes);
          vscode.window.showInformationMessage(`Exported ${target.path.split('/').pop()}`);
          break;
        }
        case 'showInfo':
          vscode.window.showInformationMessage(String(msg.text ?? ''));
          break;
        case 'showError':
          vscode.window.showErrorMessage(String(msg.text ?? ''));
          break;
        case 'parseError': {
          const line = Math.max(0, Number(msg.line ?? 1) - 1);
          const lineText = line < document.lineCount ? document.lineAt(line).text : '';
          const range = new vscode.Range(line, 0, line, Math.max(1, lineText.length));
          diagnostics.set(document.uri, [new vscode.Diagnostic(
            range,
            String(msg.message ?? 'Parse error'),
            vscode.DiagnosticSeverity.Error,
          )]);
          break;
        }
        case 'parseOk':
          diagnostics.delete(document.uri);
          break;
        case 'loadIconFile': {
          const path = String(msg.path ?? '');
          const key = String(msg.key ?? path);
          try {
            const iconUri = await resolveIconfileUri(document.uri, path);
            const bytes = await vscode.workspace.fs.readFile(iconUri);
            const lowerPath = iconUri.path.toLowerCase();
            let mime = 'application/octet-stream';
            if (lowerPath.endsWith('.svg')) { mime = 'image/svg+xml'; }
            else if (lowerPath.endsWith('.png')) { mime = 'image/png'; }
            else if (lowerPath.endsWith('.jpg') || lowerPath.endsWith('.jpeg')) { mime = 'image/jpeg'; }
            else if (lowerPath.endsWith('.gif')) { mime = 'image/gif'; }
            else if (lowerPath.endsWith('.webp')) { mime = 'image/webp'; }
            const payload = mime === 'image/svg+xml'
              ? { type: 'iconFileLoaded', key, mime, svg: Buffer.from(bytes).toString('utf8') }
              : { type: 'iconFileLoaded', key, mime, base64: Buffer.from(bytes).toString('base64') };
            webviewPanel.webview.postMessage(payload);
          } catch (e: any) {
            webviewPanel.webview.postMessage({ type: 'iconFileLoaded', key, error: String(e?.message ?? e) });
          }
          break;
        }
      }
    });
  }

  private scheduleMetaWrite(s: PanelState) {
    if (s.pendingMetaWrite) { clearTimeout(s.pendingMetaWrite); }
    s.pendingMetaWrite = setTimeout(async () => {
      s.pendingMetaWrite = undefined;
      try {
        await writeSidecar(s.document.uri, s.meta);
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to save flowchart metadata: ${e?.message ?? e}`);
      }
    }, 200);
  }

  private async replaceText(s: PanelState, newText: string): Promise<void> {
    const doc = s.document;
    if (doc.getText() === newText) { return; }
    s.lastWrittenText = newText;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, fullRangeOf(doc), newText);
    await vscode.workspace.applyEdit(edit);
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'webview.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'webview.css')
    );
    const nonce = getNonce();

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: https:; style-src ${webview.cspSource} 'unsafe-inline' https:; script-src 'nonce-${nonce}' 'unsafe-eval'; font-src ${webview.cspSource} data: https:; connect-src https:;" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>Strander</title>
</head>
<body>
  <div id="app-root">
    <div id="toolbar">
      <button id="btn-auto-layout" title="Auto-Layout mode — when ON, the diagram re-lays-out on every text change. Dragging a node turns this off.">↻ Auto-Layout</button>
      <button id="btn-fit" title="Fit graph to view">Fit</button>
      <button id="btn-zoom-in" title="Zoom in">+</button>
      <button id="btn-zoom-out" title="Zoom out">−</button>
      <button id="btn-zoom-100" title="Zoom to 100%">100%</button>
      <button id="btn-reset-positions" title="Clear saved positions and re-run layout">Reset Positions</button>
      <div class="dropdown">
        <button id="btn-export">⤓ Export</button>
        <div class="dropdown-menu">
          <button data-export="png">PNG</button>
          <button data-export="jpg">JPG</button>
          <button data-export="svg">SVG</button>
        </div>
      </div>
      <button id="btn-settings" title="Open settings panel">⚙ Settings</button>
      <span id="status"></span>
    </div>
    <div id="cy"></div>
    <div id="ctx-menu" class="hidden"></div>
    <div id="settings-panel" class="hidden"></div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function fullRangeOf(doc: vscode.TextDocument): vscode.Range {
  return new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
