// The HTML/CSS/JS for the sidebar chat webview.
//
// We embed it as a single string exported from this module. esbuild will
// bundle it into dist/extension.js, and SidebarProvider hands it to the
// webview's `html` property.
//
// IMPORTANT: this file is a TypeScript module, but the body of the webview
// `<script>` is plain JavaScript text. We deliberately avoid backtick
// characters in that text — backticks inside a template literal would
// terminate it prematurely. (We use `String.fromCharCode(96)` in the rare
// places where we need a backtick inside the webview JS.)

export const WEBVIEW_HTML = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src __CSP__ 'unsafe-inline'; script-src __CSP__ 'unsafe-inline'; img-src __CSP__ data:;" />
<style>
:root {
  color-scheme: light dark;
  --cp-fg: var(--vscode-foreground);
  --cp-bg: var(--vscode-sideBar-background);
  --cp-bg-elev: var(--vscode-editor-background);
  --cp-border: var(--vscode-panel-border);
  --cp-muted: var(--vscode-descriptionForeground);
  --cp-link: var(--vscode-textLink-foreground);
  --cp-link-active: var(--vscode-textLink-activeForeground);
  --cp-error: var(--vscode-errorForeground);
  --cp-warn: var(--vscode-editorWarning-foreground);
  --cp-ok: var(--vscode-terminal-ansiGreen);
  --cp-accent: var(--vscode-button-background);
  --cp-accent-fg: var(--vscode-button-foreground);
  --cp-accent-hover: var(--vscode-button-hoverBackground);
  --cp-input-bg: var(--vscode-input-background);
  --cp-input-fg: var(--vscode-input-foreground);
  --cp-input-border: var(--vscode-input-border);
  --cp-code-bg: var(--vscode-textCodeBlock-background);
  --cp-tool-bg: var(--vscode-editorWidget-background);
}
* { box-sizing: border-box; }
html, body {
  margin: 0; padding: 0;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  background: var(--cp-bg);
  color: var(--cp-fg);
  height: 100%;
}
body { display: flex; flex-direction: column; min-height: 100vh; }
header.cp-header {
  padding: 6px 10px;
  display: flex; align-items: center; gap: 8px;
  border-bottom: 1px solid var(--cp-border);
  font-size: 12px; color: var(--cp-muted);
}
header .dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--cp-muted);
}
header .dot.ready   { background: var(--cp-ok); }
header .dot.busy    { background: var(--vscode-progressBar-background, #4a90e2); animation: pulse 1.4s ease-in-out infinite; }
header .dot.error   { background: var(--cp-error); }
header .dot.connecting { background: var(--vscode-progressBar-background, #4a90e2); animation: pulse 1.4s ease-in-out infinite; }
@keyframes pulse { 0%,100% { opacity: 0.4 } 50% { opacity: 1 } }
header .spacer { flex: 1; }
header button {
  background: transparent;
  border: 1px solid var(--cp-border);
  color: var(--cp-fg);
  padding: 2px 8px; border-radius: 3px; cursor: pointer;
  font-size: 11px;
}
header button:hover { background: var(--cp-accent-hover); color: var(--cp-accent-fg); }

main.cp-messages {
  flex: 1; overflow-y: auto;
  padding: 10px 12px;
  display: flex; flex-direction: column; gap: 10px;
}
.msg {
  border-radius: 6px;
  padding: 8px 10px;
  background: var(--cp-bg-elev);
  border: 1px solid var(--cp-border);
  word-wrap: break-word;
  line-height: 1.45;
}
.msg .role {
  font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em;
  color: var(--cp-muted); margin-bottom: 4px; font-weight: 600;
}
.msg.user { border-left: 3px solid var(--cp-link); }
.msg.assistant { border-left: 3px solid var(--cp-accent); }
.msg.system { border-left: 3px solid var(--cp-warn); background: transparent; }
.msg.tool { background: var(--cp-tool-bg); border-left: 3px solid var(--vscode-symbolIcon-functionColor, #b180d7); }
.msg pre {
  background: var(--cp-code-bg);
  border-radius: 4px;
  padding: 6px 8px;
  overflow-x: auto;
  font-family: var(--vscode-editor-font-family);
  font-size: 0.92em;
}
.msg code { font-family: var(--vscode-editor-font-family); background: var(--cp-code-bg); padding: 0 3px; border-radius: 3px; }
.msg blockquote { margin: 4px 0; padding: 4px 8px; border-left: 2px solid var(--cp-border); color: var(--cp-muted); }
.msg a { color: var(--cp-link); text-decoration: none; }
.msg a:hover { color: var(--cp-link-active); text-decoration: underline; }
.msg ul, .msg ol { margin: 4px 0; padding-left: 20px; }
.msg .context-list { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px; }
.msg .ctx-chip {
  font-size: 10px; padding: 2px 6px; border-radius: 9px;
  background: var(--cp-tool-bg); color: var(--cp-muted);
  border: 1px solid var(--cp-border);
}

.tool-call { font-size: 12px; }
.tool-call .head {
  display: flex; align-items: center; gap: 6px;
  cursor: pointer; user-select: none;
}
.tool-call .head .chev { transition: transform 0.15s; display: inline-block; }
.tool-call.collapsed .head .chev { transform: rotate(-90deg); }
.tool-call .head .name { font-weight: 600; color: var(--vscode-symbolIcon-functionColor, #b180d7); }
.tool-call .head .badge { font-size: 10px; padding: 1px 5px; border-radius: 7px; background: var(--cp-border); color: var(--cp-fg); }
.tool-call .head .badge.error { background: var(--cp-error); color: var(--cp-bg); }
.tool-call .body { margin-top: 6px; padding-left: 10px; border-left: 2px solid var(--cp-border); }
.tool-call.collapsed .body { display: none; }
.tool-call .body pre { max-height: 240px; }

.plan-step { display: flex; align-items: flex-start; gap: 6px; padding: 2px 0; }
.plan-step .marker { width: 14px; flex: 0 0 14px; text-align: center; }
.plan-step.completed .marker { color: var(--cp-ok); }
.plan-step.in_progress .marker { color: var(--vscode-progressBar-background, #4a90e2); }
.plan-step.pending .marker { color: var(--cp-muted); }
.plan-step.blocked .marker { color: var(--cp-error); }
.plan-step .title { flex: 1; }
.plan-step.completed .title { color: var(--cp-muted); text-decoration: line-through; }

footer.cp-footer {
  border-top: 1px solid var(--cp-border);
  padding: 8px 10px;
  background: var(--cp-bg);
  display: flex; flex-direction: column; gap: 6px;
}
.modes {
  display: flex; align-items: center; gap: 0;
  font-size: 11px;
  user-select: none;
}
.modes .label {
  color: var(--cp-muted);
  margin-right: 6px;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.modes .seg {
  display: inline-flex;
  border: 1px solid var(--cp-border);
  border-radius: 3px;
  overflow: hidden;
}
.modes .seg button {
  background: transparent;
  color: var(--cp-fg);
  border: none;
  padding: 2px 9px;
  font-size: 11px;
  cursor: pointer;
  border-right: 1px solid var(--cp-border);
}
.modes .seg button:last-child { border-right: none; }
.modes .seg button:hover { background: var(--cp-accent-hover); color: var(--cp-accent-fg); }
.modes .seg button.active {
  background: var(--cp-accent);
  color: var(--cp-accent-fg);
  font-weight: 600;
}
.modes .seg button:disabled { opacity: 0.5; cursor: not-allowed; }
footer textarea {
  width: 100%;
  resize: none;
  min-height: 56px; max-height: 240px;
  background: var(--cp-input-bg);
  color: var(--cp-input-fg);
  border: 1px solid var(--cp-input-border);
  border-radius: 4px;
  padding: 6px 8px;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
}
footer textarea:focus { outline: none; border-color: var(--cp-accent); }
footer .row { display: flex; gap: 6px; align-items: center; }
footer button {
  background: var(--cp-accent);
  color: var(--cp-accent-fg);
  border: none;
  padding: 4px 12px; border-radius: 3px; cursor: pointer;
}
footer button:hover { background: var(--cp-accent-hover); }
footer button.secondary {
  background: transparent; color: var(--cp-fg);
  border: 1px solid var(--cp-border);
}
footer button:disabled { opacity: 0.5; cursor: not-allowed; }
footer .usage {
  font-size: 11px; color: var(--cp-muted);
  margin-left: auto;
}
.empty {
  padding: 30px 16px; text-align: center; color: var(--cp-muted);
  font-size: 12px;
}
.empty h3 { color: var(--cp-fg); margin: 0 0 6px; font-size: 14px; }
</style>
</head>
<body>
<header class="cp-header">
  <span class="dot" id="dot"></span>
  <span id="conn-label">connecting…</span>
  <span class="spacer"></span>
  <button id="btn-new" title="Start a new session">New</button>
</header>
<main class="cp-messages" id="messages">
  <div class="empty" id="empty">
    <h3>CodePilot</h3>
    <div>Ask anything. Mention files with <code>@path</code>.</div>
  </div>
</main>
<footer class="cp-footer">
  <div class="modes" id="modes">
    <span class="label">Mode</span>
    <div class="seg" role="group" aria-label="Collaboration mode">
      <button data-mode="chat" title="Read-only Q&A">Ask</button>
      <button data-mode="plan" title="Read-only exploration + planning">Plan</button>
      <button data-mode="agent" title="Full autonomous execution">Agent</button>
    </div>
  </div>
  <textarea id="input" placeholder="Ask CodePilot…   (Shift+Enter for newline)" rows="3"></textarea>
  <div class="row">
    <button id="btn-send">Send</button>
    <button id="btn-cancel" class="secondary" disabled>Cancel</button>
    <span class="usage" id="usage">0 tok</span>
  </div>
</footer>
<script>
(function () {
  var vscode = acquireVsCodeApi();
  var state = { busy: false, messages: [], usage: {}, connection: 'connecting', mode: null };

  var $dot = document.getElementById('dot');
  var $conn = document.getElementById('conn-label');
  var $messages = document.getElementById('messages');
  var $input = document.getElementById('input');
  var $send = document.getElementById('btn-send');
  var $cancel = document.getElementById('btn-cancel');
  var $new = document.getElementById('btn-new');
  var $usage = document.getElementById('usage');
  var $empty = document.getElementById('empty');
  var $modes = document.getElementById('modes');
  var $modeButtons = $modes.querySelectorAll('button[data-mode]');

  function post(msg) { vscode.postMessage(msg); }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c];
    });
  }
  function escapeAttr(s) { return String(s).replace(/"/g, '&quot;'); }

  // Render a small subset of Markdown: paragraphs, fenced code, inline code,
  // bold/italic, links, lists, blockquotes. All user input is HTML-escaped
  // first, so we only emit a known-safe set of tags.
  function renderMarkdown(src) {
    var lines = String(src || '').split(/\r?\n/);
    var out = '';
    var inCode = false, codeBuf = '';
    var listBuf = null;
    function flushList() {
      if (!listBuf) return;
      out += (listBuf === 'ul' ? '</ul>' : '</ol>');
      listBuf = null;
    }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var fence = line.match(/^(\s*)(\x60\x60\x60|~~~)/);
      if (fence) {
        flushList();
        if (!inCode) { inCode = true; codeBuf = ''; }
        else { out += '<pre><code>' + escapeHtml(codeBuf.replace(/\n$/, '')) + '</code></pre>'; inCode = false; }
        continue;
      }
      if (inCode) { codeBuf += line + '\n'; continue; }

      if (/^\s*[-*]\s+/.test(line)) {
        if (listBuf !== 'ul') { flushList(); out += '<ul>'; listBuf = 'ul'; }
        out += '<li>' + inline(line.replace(/^\s*[-*]\s+/, '')) + '</li>';
        continue;
      }
      if (/^\s*\d+\.\s+/.test(line)) {
        if (listBuf !== 'ol') { flushList(); out += '<ol>'; listBuf = 'ol'; }
        out += '<li>' + inline(line.replace(/^\s*\d+\.\s+/, '')) + '</li>';
        continue;
      }
      if (/^\s*>\s?/.test(line)) {
        flushList();
        out += '<blockquote>' + inline(line.replace(/^\s*>\s?/, '')) + '</blockquote>';
        continue;
      }
      flushList();
      if (line.trim() === '') continue;
      out += '<p>' + inline(line) + '</p>';
    }
    flushList();
    if (inCode) out += '<pre><code>' + escapeHtml(codeBuf) + '</code></pre>';
    return out;
  }
  function inline(s) {
    var t = escapeHtml(s);
    // inline code: use \x60 for backtick so it doesn't terminate this template
    t = t.replace(/\x60([^\x60]+)\x60/g, function (_, c) { return '<code>' + c + '</code>'; });
    // bold
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // italic
    t = t.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
    // links [text](url)
    t = t.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    return t;
  }

  function render() {
    var conn = state.connection;
    $dot.className = 'dot ' + (conn === 'ready' ? 'ready' : conn === 'busy' ? 'busy' : conn === 'error' ? 'error' : 'connecting');
    $conn.textContent = conn === 'ready' ? 'ready' : conn === 'error' ? 'error: ' + (state.detail || '') : conn === 'connecting' ? 'connecting…' : 'disconnected';

    $send.disabled = state.busy || !$input.value.trim();
    $cancel.disabled = !state.busy;

    for (var mi = 0; mi < $modeButtons.length; mi++) {
      var btn = $modeButtons[mi];
      var active = state.mode && btn.getAttribute('data-mode') === state.mode;
      btn.classList.toggle('active', !!active);
      btn.disabled = !state.mode;
    }

    var totalTok = (state.usage.input || 0) + (state.usage.output || 0);
    $usage.textContent = totalTok ? formatNum(totalTok) + ' tok' + (state.usage.costUSD ? ' · $' + state.usage.costUSD.toFixed(3) : '') : '0 tok';

    if (!state.messages.length) {
      $empty.style.display = '';
      $messages.querySelectorAll('.msg').forEach(function (n) { n.remove(); });
      return;
    }
    $empty.style.display = 'none';

    var wantIds = new Set(state.messages.map(function (m) { return m.id; }));
    $messages.querySelectorAll('.msg[data-id]').forEach(function (n) {
      if (!wantIds.has(n.dataset.id)) n.remove();
    });
    for (var i = 0; i < state.messages.length; i++) {
      var m = state.messages[i];
      var node = $messages.querySelector('.msg[data-id="' + m.id + '"]');
      if (!node) {
        node = document.createElement('div');
        node.dataset.id = m.id;
        $messages.appendChild(node);
      }
      renderMessage(node, m);
    }
    $messages.scrollTop = $messages.scrollHeight;
  }

  function renderMessage(node, m) {
    node.className = 'msg ' + m.role;
    var html = '<div class="role">' + m.role + '</div>';
    if (m.context && m.context.length) {
      html += '<div class="context-list">' + m.context.map(function (c) {
        return '<span class="ctx-chip" title="' + escapeAttr(c.label) + '">' + escapeHtml(c.kind) + ': ' + escapeHtml(c.label) + '</span>';
      }).join('') + '</div>';
    }
    if (m.role === 'tool' && m.tool) {
      html += renderToolCall(m.tool);
    } else if (m.role === 'system' && m.plan) {
      html += renderPlan(m.plan);
    } else {
      html += renderMarkdown(m.text || '');
    }
    node.innerHTML = html;
    if (m.role === 'tool' && m.tool) {
      var head = node.querySelector('.tool-call .head');
      if (head) {
        head.addEventListener('click', function () {
          m.tool.collapsed = !m.tool.collapsed;
          var parent = head.parentElement;
          parent.classList.toggle('collapsed', m.tool.collapsed);
          parent.querySelector('.body').style.display = m.tool.collapsed ? 'none' : '';
        });
      }
    }
  }

  function renderToolCall(t) {
    var badge = t.isError
      ? '<span class="badge error">error</span>'
      : (t.result !== undefined ? '<span class="badge">done</span>' : '<span class="badge">running…</span>');
    var input = t.input !== undefined ? '<pre>' + escapeHtml(safeStringify(t.input)) + '</pre>' : '';
    var result = t.result !== undefined ? '<pre>' + escapeHtml(t.result) + '</pre>' : '';
    return '<div class="tool-call' + (t.collapsed ? ' collapsed' : '') + '">' +
      '<div class="head"><span class="chev">▾</span><span class="name">' + escapeHtml(t.name) + '</span>' + badge + '</div>' +
      '<div class="body">' + (input ? '<div>' + input + '</div>' : '') + (result ? '<div>' + result + '</div>' : '') + '</div>' +
      '</div>';
  }

  function renderPlan(steps) {
    return steps.map(function (s) {
      var m = s.status === 'completed' ? '✓' : s.status === 'in_progress' ? '◐' : s.status === 'blocked' ? '✗' : '·';
      return '<div class="plan-step ' + s.status + '"><span class="marker">' + m + '</span><span class="title">' + escapeHtml(s.title) + '</span></div>';
    }).join('');
  }

  function safeStringify(v) {
    try {
      var seen = new WeakSet();
      return JSON.stringify(v, function (k, val) {
        if (typeof val === 'object' && val !== null) {
          if (seen.has(val)) return '[Circular]';
          seen.add(val);
        }
        if (typeof val === 'string' && val.length > 4000) return val.slice(0, 4000) + '…';
        return val;
      }, 2);
    } catch (e) { return String(v); }
  }
  function formatNum(n) {
    if (n < 1000) return String(n);
    if (n < 1e6) return (n / 1000).toFixed(n < 1e4 ? 1 : 0) + 'k';
    return (n / 1e6).toFixed(1) + 'M';
  }

  function autosize() {
    $input.style.height = 'auto';
    $input.style.height = Math.min(240, $input.scrollHeight) + 'px';
  }
  $input.addEventListener('input', autosize);
  $input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });
  $send.addEventListener('click', submit);
  $cancel.addEventListener('click', function () { post({ type: 'cancel' }); });
  $new.addEventListener('click', function () { post({ type: 'new' }); });
  for (var mi2 = 0; mi2 < $modeButtons.length; mi2++) {
    (function (btn) {
      btn.addEventListener('click', function () {
        var m = btn.getAttribute('data-mode');
        if (!m || m === state.mode) return;
        // optimistic UI flip; the server's 'mode' event will confirm.
        state.mode = m;
        render();
        post({ type: 'setMode', mode: m });
      });
    })($modeButtons[mi2]);
  }
  function submit() {
    var text = $input.value;
    if (!text.trim() || state.busy) return;
    post({ type: 'send', text: text });
    $input.value = '';
    autosize();
  }

  window.addEventListener('message', function (e) {
    var m = e.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'state') {
      state = m.state;
      render();
    }
  });

  post({ type: 'ready' });
  render();
})();
</script>
</body>
</html>`;

/** Substitute the VSCode webview CSP source placeholder. */
export function renderWebviewHtml(cspSource: string): string {
  return WEBVIEW_HTML.replace(/__CSP__/g, cspSource);
}