/** The inspector's neutral desktop chrome and conversation surfaces. */
export const CSS = `
:root {
  --bg: #efebe6;
  --panel: #fffcf8;
  --rail: #f4efea;
  --bright: #292124;
  --dim: #3c3234;
  --muted: #554749;
  --faint: #665657;
  --hairline: #cdc0ba;
  --shade: #f2eae4;
  --shade-hover: #eae0d9;
  --selected: #f1e1e6;
  --accent: #762741;
  --gold: #926522;
  --gold-text: #ffdb8a;
  --focus: #855813;
  --accent-transparent: #76274130;
  --scrim: #26171d80;
  --label: #fff8f4;
  --action: #73253e;
  --action-hover: #8b3050;
  --chrome: #f7f1eb;
  --raised: 0 1px 1px #2a15191a;
  --shadow: #24141926;
  --red: #9b302c;
  --warning: #795318;
  --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
  --metadata: .75rem/1rem var(--mono);
  --inset: 12px;
  --overlay-layer: 30;
  --nav-layer: 41;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --bg: #1c181a;
    --panel: #241f21;
    --rail: #292326;
    --bright: #fff5ee;
    --dim: #ebddda;
    --muted: #d9c8c6;
    --faint: #c3b0ae;
    --hairline: #665457;
    --shade: #332a2e;
    --shade-hover: #42363a;
    --selected: #482936;
    --accent: #f4aec6;
    --gold: #d9ac5d;
    --focus: #f3c975;
    --accent-transparent: #f4aec638;
    --scrim: #120c10b3;
    --chrome: #30262b;
    --raised: 0 1px 1px #0005;
    --shadow: #0006;
    --red: #ffaaa2;
    --warning: #f5cc80;
  }
}
* { box-sizing: border-box; }
html { scroll-behavior: auto; -webkit-tap-highlight-color: var(--accent-transparent); }
body {
  margin: 0;
  overflow: hidden;
  background: var(--bg);
  color: var(--dim);
  font: .875rem/1.25rem system-ui, sans-serif;
  font-variant-numeric: tabular-nums;
  cursor: default;
}
a { color: inherit; text-decoration: none; cursor: default; }
button { cursor: default; font: inherit; color: inherit; background: none; border: 0; padding: 0; letter-spacing: inherit; }
input, textarea { font: inherit; color: var(--bright); letter-spacing: inherit; cursor: text; }
::selection { background: var(--accent-transparent); }
:is(a, button, input, textarea, select, [tabindex]):focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.shell [data-view-title]:focus { outline: 2px solid var(--focus); outline-offset: 2px; }
:where(code, pre, .avatar) { font-family: var(--mono); }

.boot { display: grid; place-items: center; height: 100dvh; color: var(--faint); }
.boot.error, .error { color: var(--red); }
.name-gate { display: grid; gap: 10px; width: min(320px, 90vw); color: var(--bright); }
.name-gate p { margin: 0; color: var(--faint); }
.name-gate input { width: 100%; height: 36px; padding: 0 10px; border: 0; outline: 1px solid var(--muted); background: var(--shade); font-size: 16px; }
.name-gate .send { justify-self: end; }
.empty, .error { padding: 20px; margin: 0; color: var(--faint); }
.faint { color: var(--faint); }
.grow { flex: 1; min-width: 0; }
.hint { color: var(--faint); font-size: 11px; }

.shell { display: flex; height: 100dvh; overflow: hidden; }
@media (min-width: 64rem) {
  .shell { margin: 12px; height: calc(100dvh - 24px); border: 1px solid var(--hairline); border-radius: 7px; box-shadow: 0 2px 3px var(--shadow); }
}

/* --- sidebar: an opaque navigation rail --- */
.sidebar { position: relative; flex-shrink: 0; display: none; background: var(--rail); border-right: 1px solid var(--hairline); }
.sidebar-col { flex: 1; min-width: 0; display: flex; flex-direction: column; }
/* What's said on the board scrolls; its settings and who you are stay put under it. */
.sidebar-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 8px 8px 12px; }
.sidebar-foot { flex-shrink: 0; padding: 4px 8px 12px; }
.brand {
  height: 46px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 var(--inset);
  border-bottom: 1px solid var(--hairline);
  background: var(--chrome);
  color: var(--bright);
  font-weight: 600;
  gap: 8px;
}
/* Which board this is: its name, and where it is under it. */
.brand .which { display: grid; min-width: 0; line-height: 1.3; }
.home-emblem { flex: none; width: 44px; height: 44px; display: grid; place-items: center; border-radius: 4px; }
.home-emblem img { display: block; object-fit: contain; }
.home-emblem:hover { background: var(--shade-hover); }
.home-emblem:focus-visible { outline-offset: -2px; }
.brand .name, .brand .at { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.brand .at { color: var(--faint); font-size: 11px; font-weight: 400; }
.sidebar h2 { display: flex; align-items: center; justify-content: space-between; height: 18px; margin: 16px 8px 4px; font-size: 11px; font-weight: 500; color: var(--faint); }
.sidebar h2 .tool { min-width: 20px; height: 20px; margin-right: -6px; padding: 0; color: var(--faint); }
.sidebar .item.settings { gap: 8px; color: var(--faint); font-size: 12px; }
.sidebar .item.settings:hover, .sidebar .item.settings[aria-current='page'] { color: var(--bright); }
.new-channel { display: flex; align-items: center; gap: 2px; margin: 2px 0 4px; }
.new-channel input { flex: 1; min-width: 0; height: 28px; padding: 0 8px; border: 0; outline: 1px solid var(--muted); background: var(--shade); font-size: 12px; }
.sidebar .item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  min-height: 30px;
  color: var(--muted);
  font-size: .875rem;
  border: 1px solid transparent;
  border-radius: 4px;
}
.sidebar .item:hover { background: var(--shade-hover); color: var(--bright); }
.sidebar .item[aria-current='page'] { background: var(--selected); border-color: var(--hairline); border-inline-start-color: var(--gold); color: var(--accent); font-weight: 700; }
.sidebar .item .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sidebar .item.unread { color: var(--bright); font-weight: 600; }
.sidebar .count { color: var(--faint); font-size: 11px; font-weight: 400; }
.sidebar .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); }
.whoami-wrap { padding-top: 2px; }
.whoami { width: 100%; display: flex; align-items: center; gap: 6px; padding: 6px 8px; color: var(--muted); font-size: 11px; text-align: left; }
.whoami:hover, .whoami[data-popup-open] { background: var(--shade); color: var(--bright); }
.whoami .as { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.whoami.naming { flex-direction: column; align-items: stretch; }
.whoami.naming .send { align-self: flex-end; }
.whoami.naming input { width: 100%; height: 28px; padding: 0 8px; border: 0; outline: 1px solid var(--muted); background: var(--shade); font-size: 12px; }
.choice { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.choice svg { color: var(--accent); }

/* --- resize handles: a hairline that lights up --- */
.resize { position: absolute; top: 0; bottom: 0; width: 7px; z-index: 5; display: flex; justify-content: center; outline: none; }
.resize.right { right: -3px; }
.resize.left { left: -3px; }
.resize i { width: 2px; height: 100%; }
.resize:hover i { background: var(--muted); }
.resize.dragging i, .resize:focus-visible i { background: var(--accent); }

/* --- main and the thread pane --- */
.main, .pane { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.main { flex: 1; background: var(--panel); }
.pane { position: fixed; inset: 0; width: auto !important; background: var(--bg); z-index: var(--overlay-layer); }
.resize { display: none; }
@media (min-width: 64rem) {
  .sidebar:not([hidden]) { display: flex; }
  .pane { position: relative; flex-shrink: 0; width: var(--pane-width) !important; max-width: max(320px, calc(100% - var(--sidebar-width) - 20rem)); border-left: 1px solid var(--hairline); }
  .resize { display: flex; }
}

.header {
  height: 46px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 var(--inset);
  border-bottom: 1px solid var(--hairline);
  white-space: nowrap;
}
.header { background: var(--chrome); }
.header > .tool, .brand > .tool { border: 1px solid var(--hairline); border-radius: 4px; background: var(--chrome); box-shadow: var(--raised); }
.header > .tool:hover, .brand > .tool:hover { background: var(--shade); }
.header .title {
  margin: 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--bright);
  font: 700 1.125rem/1.375rem 'Avenir Next Condensed', 'Arial Narrow', 'Liberation Sans Narrow', sans-serif;
  font-stretch: condensed;
  letter-spacing: .04em;
  text-transform: uppercase;
}
.header .meta { color: var(--faint); font-size: 11px; overflow: hidden; text-overflow: ellipsis; }
.header .spacer { flex: 1; }
.header.flat { border-bottom: 0; }

/* --- tabs: plain text, the current one underlined. Under a flat header they carry its hairline. --- */
.tabs { flex-shrink: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 0 18px; min-height: 34px; padding: 0 20px; border-bottom: 1px solid var(--hairline); }
.tabs.plain { border-bottom: 0; padding-top: 4px; }
.tab { padding: 7px 0; margin-bottom: -1px; border-bottom: 1px solid transparent; color: var(--muted); white-space: nowrap; cursor: default; }
.tab:hover { color: var(--bright); }
.tab[aria-current='page'] { border-bottom: 2px solid var(--accent); color: var(--accent); font-weight: 600; }
.tab-actions { display: flex; align-items: center; gap: 14px; margin-left: auto; }
.tab-actions .act { height: 24px; }
.text-link { color: var(--accent); text-decoration: underline; text-decoration-color: var(--faint); text-underline-offset: 3px; white-space: nowrap; cursor: default; }
.text-link:hover { text-decoration-color: currentColor; }
.scrim { display: none; }

.live { display: flex; align-items: center; gap: 6px; color: var(--faint); font-size: 11px; }
.live i { width: 6px; height: 6px; border-radius: 50%; background: var(--faint); }
.live:not(.connecting, .reconnecting) i { background: var(--accent); }

/* --- the feed: no row borders; a short conversation sits on the composer --- */
.feed-wrap { position: relative; flex: 1; min-height: 0; display: flex; }
.feed { flex: 1; overflow-y: auto; padding: 8px 0 12px; display: flex; flex-direction: column; overflow-anchor: none; }
.feed > div { margin-top: auto; }
.jump {
  position: absolute;
  bottom: 12px;
  left: 50%;
  transform: translateX(-50%);
  padding: 3px 10px;
  border: 1px solid var(--accent);
  background: var(--bg);
  color: var(--accent);
  font-size: 11px;
}
.divider { display: flex; align-items: center; gap: 8px; margin: 14px 20px 4px; color: var(--faint); font-size: 11px; }
.divider::after { content: ''; flex: 1; height: 1px; background: var(--hairline); }

.message { position: relative; display: grid; grid-template-columns: 40px minmax(0, 1fr); gap: 8px; padding: 4px var(--inset) 4px 8px; }
.message.continued { padding-block: 0; }
@media (hover: hover) { .message:not(.active):hover { background: var(--shade); } }
.message.active { background: var(--selected); box-shadow: inset 2px 0 var(--gold); }
.pane .feed-wrap { background: var(--panel); }
.pane .task-card, .pane .thread-facts { background: var(--rail); }
.message.pending { opacity: 0.5; }
.message.failed { opacity: 1; }
.gutter { display: flex; justify-content: center; align-items: flex-start; }
.gutter-time { visibility: hidden; color: var(--faint); font-size: 10px; line-height: 21px; }
.message.active .gutter-time, .gutter-time.shown { visibility: visible; }
.avatar {
  flex-shrink: 0;
  display: inline-grid;
  place-items: center;
  border-radius: 50%;
  background: var(--selected);
  color: var(--accent);
  box-shadow: inset 0 0 0 1px var(--hairline);
  font-weight: 600;
  overflow: hidden;
}
.avatar img { width: 100%; height: 100%; object-fit: cover; }
.body { min-width: 0; }
.meta-line { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; }
.author { color: var(--bright); font-weight: 600; }
.where { color: var(--faint); font-size: 12px; }
.where a { color: var(--accent); cursor: default; }
.where a:hover { text-decoration: underline; }
.time, .id { color: var(--faint); font-size: 11px; }
/* Message text is markdown. Blocks stay compact; a short message reads as one line. */
.text { max-inline-size: 65ch; overflow-wrap: anywhere; color: var(--dim); font-size: .875rem; line-height: 1.25rem; cursor: text; }
.text > :first-child { margin-top: 0; }
.text > :last-child { margin-bottom: 0; }
.text > p:last-child, .text > p:has(+ .edited) { display: inline; }
.text p { margin: 0 0 6px; }
.text a { color: var(--accent); text-decoration: underline; text-decoration-color: var(--faint); text-underline-offset: 3px; overflow-wrap: anywhere; }
.text a:hover { text-decoration-color: currentColor; }
.text strong { color: var(--bright); font-weight: 600; }
.text h1, .text h2, .text h3, .text h4 { margin: 8px 0 4px; color: var(--bright); font-size: 14px; font-weight: 600; }
.text ul, .text ol { margin: 2px 0 6px; padding-left: 20px; }
.text li + li { margin-top: 1px; }
.text blockquote { margin: 4px 0; padding-left: 10px; border-left: 2px solid var(--hairline); color: var(--muted); }
.text code { padding: 1px 4px; border-radius: 3px; background: var(--shade); color: var(--bright); font-size: 0.92em; }
.message.active .text code { background: var(--shade-hover); }
.text pre { margin: 4px 0 6px; padding: 10px; overflow-x: auto; border: 1px solid var(--hairline); border-radius: 4px; background: var(--shade); line-height: 1.5; }
.text pre code, .message.active .text pre code { padding: 0; border-radius: 0; background: none; font-size: 13px; }
.text table { margin: 4px 0 6px; border-collapse: collapse; font-size: 12px; display: block; overflow-x: auto; max-width: 100%; }
.text th, .text td { padding: 3px 10px; border: 1px solid var(--hairline); text-align: left; white-space: nowrap; }
.text th { color: var(--bright); font-weight: 600; background: var(--shade); }
.text img { max-width: 100%; max-height: 260px; vertical-align: middle; }
.text hr { border: 0; height: 1px; margin: 8px 0; background: var(--hairline); }
.text input[type='checkbox'] { margin: 0 6px 0 0; vertical-align: middle; }
.text ul.contains-task-list { list-style: none; padding-left: 2px; }
.avatar-wrap { position: relative; display: inline-flex; }
.source {
  position: absolute;
  right: -5px;
  bottom: -5px;
  width: 16px;
  height: 16px;
  padding: 2px;
  border-radius: 4px;
  background: var(--bg);
  color: var(--bright);
}
.source svg { display: block; width: 100%; height: 100%; }
.source.text { display: grid; place-items: center; font-size: 9px; font-weight: 600; }
.mention { color: var(--accent); font-weight: 600; }
.removed { color: var(--faint); font-style: italic; }
.edited { color: var(--faint); font-size: 11px; }
.undelivered { margin-top: 4px; font-size: 11px; color: var(--red); }
.undelivered button { text-decoration: underline; }

.chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
.badge, .label, .chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 7px;
  border: 1px solid var(--hairline);
  background: var(--shade);
  color: var(--muted);
  font-size: 11px;
  line-height: 16px;
}
.badge.slack, .badge.github { border-color: var(--accent-transparent); background: none; color: var(--accent); }
.label:hover, .chip:hover { color: var(--bright); background: var(--shade-hover); }
.label button { color: var(--faint); display: inline-flex; }
.label button:hover { color: var(--bright); }
/* Your own reaction: a little brighter, not louder. */
.chip.mine { border-color: var(--muted); background: var(--shade-hover); color: var(--bright); }
/* Attachments: media in a fixed frame, so loading never moves the page; files as chips. */
.links { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
.link-embed { padding: 2px 0 2px 10px; border-left: 2px solid var(--hairline); }
.link-meta { display: flex; gap: 8px; align-items: baseline; font-size: 12px; color: var(--muted); }
.link-meta .author { font-size: 13px; }
.link-meta a, .link-file a { color: var(--accent); text-decoration: underline; text-decoration-color: var(--faint); text-underline-offset: 3px; overflow-wrap: anywhere; }
.link-meta a:hover, .link-file a:hover { text-decoration-color: currentColor; }
.link-file { display: flex; gap: 4px; align-items: center; margin-top: 2px; font-size: 12px; color: var(--muted); }
.attachments { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.attachment-media { display: block; width: 320px; max-width: 100%; height: 200px; border: 1px solid var(--hairline); background: var(--shade); overflow: hidden; }
.attachment-media img, .attachment-media video { display: block; width: 100%; height: 100%; object-fit: contain; }
.file { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; padding: 4px 8px; border: 1px solid var(--hairline); background: var(--shade); color: var(--dim); font-size: 12px; }
button.file:hover { background: var(--shade-hover); color: var(--bright); }
.file-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file button { color: var(--faint); display: inline-flex; }
.file button:hover { color: var(--bright); }
.composer-files { margin: 0 12px 4px; }
.replies { display: inline-flex; align-items: center; gap: 6px; margin: 4px 0 0 -4px; padding: 2px 6px 2px 4px; color: var(--dim); font-size: 12px; font-weight: 600; }
.replies:hover { background: var(--shade-hover); color: var(--bright); }
.replies .time { font-weight: 400; }
.replies .faces { display: inline-flex; }
.replies .faces .avatar + .avatar { margin-left: -4px; }

.editor { display: grid; gap: 2px; margin: 2px 0; }
.editor textarea {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--hairline);
  background: var(--bg);
  resize: none;
  outline: none;
  font-size: 14px;
}
.editor textarea:focus { border-color: var(--muted); }

/* --- hover actions: one hairline box at the row's corner --- */
.actions { position: absolute; top: -12px; right: 20px; z-index: 5; display: flex; border: 1px solid var(--hairline); border-radius: 4px; background: var(--chrome); box-shadow: var(--raised); }
.tool {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-width: 28px;
  height: 26px;
  padding: 0 6px;
  color: var(--muted);
  font-size: 13px;
}
.tool:hover, .tool[data-popup-open] { background: var(--shade); color: var(--bright); }
.tool.on { color: var(--accent); }
.tool .count, .tool .tool-label { font-size: 11px; }

/* --- menus and popovers --- */
.positioner { z-index: 50; outline: none; }
.frame { position: relative; isolation: isolate; }
.dots {
  position: absolute;
  inset: 0;
  border-radius: 6px;
  z-index: -1;
  box-shadow: 0 4px 12px var(--shadow);
  pointer-events: none;
}
.menu { min-width: 172px; padding: 6px; border: 1px solid var(--hairline); border-radius: 6px; background: var(--panel); outline: none; }
.menu.list { max-height: 260px; overflow-y: auto; }
.item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  color: var(--muted);
  outline: none;
  cursor: default;
  white-space: nowrap;
}
.item[data-highlighted] { background: var(--shade); color: var(--bright); }
.item.danger, .item.danger[data-highlighted] { color: var(--red); }
/* A hint (a message's ID) gives way first: a long one ends in an ellipsis, not a wide menu. */
.item .hint { margin-left: 12px; min-width: 0; max-width: 22ch; overflow: hidden; text-overflow: ellipsis; }
.separator { height: 1px; margin: 4px 0; background: var(--hairline); }
.empty-item { padding: 6px 8px; color: var(--faint); }
.emoji-row { display: grid; grid-template-columns: repeat(6, 1fr); }
.item.emoji { justify-content: center; padding: 6px 0; font-size: 15px; }
.emoji-grid { display: grid; grid-template-columns: repeat(12, 30px); padding: 6px; }
.emoji-grid .emoji { height: 30px; font-size: 16px; }
.emoji-grid .emoji:hover { background: var(--shade); }
.popover { width: min(380px, calc(100vw - 32px)); padding: 12px; }
.popover-title { margin: 0 0 8px; color: var(--bright); font-size: 12px; font-weight: 600; }

.labels-editor { display: grid; gap: 10px; }
.labels-editor > .hint { margin: 0; }
.label-rows { display: grid; }
.label-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr) auto; align-items: center; gap: 8px; padding: 2px 0 2px 8px; }
.label-row:hover { background: var(--shade); }
.label-key { color: var(--bright); overflow: hidden; text-overflow: ellipsis; }
.label-value { color: var(--muted); overflow: hidden; text-overflow: ellipsis; }
.label-add { display: flex; align-items: center; gap: 6px; }
.suggest { display: flex; align-items: center; min-width: 0; padding: 0 8px; background: var(--shade); }
.suggest input { width: 100%; min-width: 0; height: 28px; border: 0; outline: none; background: none; }
.suggest:focus-within { outline: 1px solid var(--muted); }
.suggest .prefix { color: var(--faint); }
.suggest input::placeholder { color: var(--faint); }
.label-add > .suggest { width: 38%; }

/* --- filters --- */
.filter-bar { flex-shrink: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 8px 20px 0; }
.clear { color: var(--faint); font-size: 11px; }
.clear:hover { color: var(--bright); }
.filter-form { display: grid; gap: 12px; }
.filter-form > .clear { justify-self: start; }
.filter-row { display: grid; grid-template-columns: 52px minmax(0, 1fr); align-items: start; gap: 10px; }
.filter-name { color: var(--faint); font-size: 11px; line-height: 28px; }
.filter-row .grow { display: grid; gap: 6px; }
.segments { display: flex; flex-wrap: wrap; gap: 2px; }
.segment { height: 28px; padding: 0 10px; background: var(--shade); color: var(--muted); }
.segment:hover { color: var(--bright); }
.segment.on { background: var(--bright); color: var(--bg); }

/* --- composer: recessed input on a separate toolbar surface --- */
.composer { flex-shrink: 0; padding: 8px; border-top: 1px solid var(--hairline); background: var(--rail); }
.composer-box {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.composer-box textarea {
  width: 100%;
  min-height: 38px;
  max-height: clamp(38px, 24dvh, 160px);
  padding: 8px;
  border: 1px solid var(--hairline);
  border-radius: 6px;
  background: var(--panel);
  box-shadow: inset 0 1px 3px var(--shadow);
  color: var(--dim);
  font-size: 14px;
  line-height: 1.5;
  resize: none;
  overflow-y: auto;
}
.composer-box textarea::placeholder { color: var(--faint); }
.composer-channel { margin: 8px 8px 0; align-self: flex-start; width: min(320px, calc(100% - 16px)); }
.composer-labels { margin: 8px 12px 0; }
.composer-footer { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; min-height: 30px; }
.composer-footer .tool { border: 1px solid var(--hairline); border-radius: 4px; background: var(--chrome); box-shadow: var(--raised); }
.composer-footer .hint { margin-left: auto; margin-right: 8px; }
.pane .composer-footer .hint { display: none; }
.pane .composer-footer .send { margin-left: auto; }
.send { height: 30px; padding: 0 12px; background: var(--action); color: var(--label); border: 1px solid var(--gold); border-radius: 4px; font-weight: 600; white-space: nowrap; }
.send:not(:disabled):hover { background: var(--action-hover); }
@media (hover: hover) {
  button:not(:disabled, [aria-disabled="true"]):hover { filter: brightness(1.07); }
}
button:not(:disabled, [aria-disabled="true"]):active {
  filter: brightness(.94);
  box-shadow: inset 1px 2px 3px var(--shadow), inset -1px -1px var(--gold);
}
/* Instant feedback, with no movement or transitions. */
.button-sounds { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; white-space: nowrap; }
.button-sounds input { accent-color: var(--action); }
.send.small { height: 28px; padding: 0 10px; }
.send:disabled { opacity: 0.5; }

/* --- a view that isn't a feed: rows under a header --- */
.page { flex: 1; min-height: 0; overflow-y: auto; padding: 8px 0 16px; }
.home-view { padding: clamp(16px, 4vw, 40px); }
.home-view > * { max-width: 52rem; margin-inline: auto; }
.handoffs-view { padding-block: 8px 12px; }
.handoffs-view > * + * { margin-block-start: 8px; }
.home-view p { margin: 0 0 6px; color: var(--muted); }
.handoffs-view p { margin: 0; }
.home-view a { color: var(--accent); text-decoration: underline; text-underline-offset: 3px; }
.home-intro a { display: inline-flex; min-height: 32px; align-items: center; }
.home-view a:focus-visible, .home-view button:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.home-queue h2 { margin: 0; padding-bottom: 2px; border-bottom: 1px solid var(--hairline); font-size: 1rem; color: var(--bright); }
.handoff-list, .handoff-needs ul { list-style: none; margin: 0; padding: 0; }
.handoff { padding: 4px 0; overflow-wrap: anywhere; }
.handoff-line { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 8px; margin-bottom: 2px; }
.handoff-title { font-weight: 600; }
.handoff small { color: var(--muted); }
.handoff-result { white-space: pre-wrap; }
.handoff-needs { margin-top: 3px; padding-inline-start: 8px; border-inline-start: 2px solid var(--hairline); }
.handoff-needs li { margin-top: 1px; }
.more { display: block; margin: 8px 20px; }
/* A few facts, each a quiet name and what it is. */
.facts { display: grid; grid-template-columns: 44px minmax(0, 1fr); gap: 3px 10px; margin: 0; }
.facts dt { color: var(--faint); font-size: 11px; line-height: 18px; }
.facts dd { margin: 0; color: var(--dim); overflow-wrap: anywhere; }
.segment.small { height: 22px; padding: 0 8px; font-size: 11px; }

/* --- buttons that act, and the small forms that ask first --- */
.acts { display: flex; flex-wrap: wrap; gap: 4px; }
.acts .act[aria-haspopup] { padding: 0 7px; }
.act { display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 9px; background: var(--chrome); border: 1px solid var(--hairline); border-radius: 4px; box-shadow: var(--raised); color: var(--dim); font-size: 12px; white-space: nowrap; }
.act:hover, .act[data-popup-open] { background: var(--shade-hover); color: var(--bright); }
.act.primary, .act.primary:hover { background: var(--action); color: var(--label); }
.act.danger { color: var(--red); }
/* A row's own control: there when you're on the row, and it says what it is only when you reach for it. */
.act.quiet { visibility: hidden; background: none; color: var(--muted); }
:hover > .act.quiet, :focus-within > .act.quiet { visibility: visible; }
.act.quiet:hover, .act.quiet:focus-visible { background: var(--shade-hover); color: var(--red); }
.act:disabled { opacity: 0.5; }
.ask { display: grid; gap: 8px; }
.ask textarea { width: 100%; min-height: 64px; padding: 6px 8px; border: 0; outline: none; background: var(--shade); font-size: 13px; line-height: 1.5; resize: vertical; }
.ask textarea:focus { outline: 1px solid var(--muted); }
.ask .hint { margin: 0; }
.ask .suggest .prefix { margin-right: 8px; font-size: 11px; white-space: nowrap; }
.ask .send { justify-self: end; }

/* --- tasks: a thread with a state, so one more line on its root --- */
.task-state { display: inline-flex; align-items: center; gap: 5px; color: var(--muted); font-size: 12px; white-space: nowrap; }
.task-state svg { flex-shrink: 0; }
.task-state.ready, .task-state.claimed { color: var(--accent); }
.task-state.blocked { color: var(--warning); }
.task-state.completed { color: var(--dim); }
.task-state.failed { color: var(--red); }
.task-state.waiting, .task-state.canceled { color: var(--faint); }
.task-line, .task-head { display: flex; flex-wrap: wrap; align-items: center; margin-left: -15px; clip-path: inset(0 0 0 15px); }
/* Each item carries its own separator, and the row clips the ones at its left edge: none starts a line. */
.task-line > *, .task-head > * { position: relative; padding-left: 15px; }
.task-line > *::before, .task-head > *::before { content: '\\00b7'; position: absolute; left: 4px; color: var(--faint); font-weight: 400; }
.task-line { margin-top: 3px; color: var(--muted); font-size: 12px; }
.task-note { color: var(--dim); overflow-wrap: anywhere; }
.lease { font-variant-numeric: tabular-nums; }
.needs { display: inline-flex; flex-wrap: wrap; gap: 0 8px; }
.need { color: var(--accent); cursor: default; }
.need:hover { text-decoration: underline; }
.need-state { margin-left: 4px; color: var(--faint); }
.need-state.completed { color: var(--muted); }
.need-state.failed { color: var(--red); }

/* The task in full, under the thread's header: it's part of the header, so the hairline goes under it. */
.task-card { flex-shrink: 0; display: grid; gap: 10px; padding: 12px 20px; border-bottom: 1px solid var(--hairline); font-size: 12px; }
.task-head { color: var(--dim); }
.task-head .task-state { font-size: 13px; font-weight: 600; }
.task-card .hint { margin: 0; }

.task-rows { display: grid; container-type: inline-size; }
.task-row { display: grid; grid-template-columns: 80px minmax(0, 1fr) 32px; align-items: center; gap: 0 8px; min-height: 32px; padding: 4px var(--inset); }
.task-row:hover { background: var(--shade); }
.task-row[aria-current] { background: var(--selected); box-shadow: inset 3px 0 var(--accent); }
.task-row:focus-visible { outline-offset: -2px; }
.task-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dim); }
.task-title .label { margin-left: 6px; vertical-align: 1px; }
.task-now { max-width: 36ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: 12px; }
.task-now .needs { display: inline; }
.task-now .need + .need { margin-left: 8px; }
.task-where { color: var(--faint); font-size: 12px; white-space: nowrap; }
.task-row .time { text-align: right; }
.task-places { display: grid; padding: 0 12px; }
.task-place { display: flex; align-items: center; gap: 12px; padding: 5px 8px; color: var(--dim); }
.task-place:hover { background: var(--shade); color: var(--bright); }
.task-place .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.task-place .count { color: var(--faint); font-size: 12px; white-space: nowrap; }
.task-where { display: none; }
.task-now { grid-column: 2 / -1; grid-row: 2; max-width: none; }
.task-now:empty { display: none; }

.composer-task { display: flex; gap: 6px; margin: 8px 8px 0; }
.composer-task .suggest { flex: 1; }
.composer-task .prefix { margin-right: 8px; font-size: 11px; white-space: nowrap; }

/* --- blocks: the data a message carries, as a card where its fence was --- */
.block { max-width: 640px; margin: 6px 0; border: 1px solid var(--hairline); font-size: 12px; }
.block-head { display: flex; align-items: center; gap: 10px; height: 26px; padding: 0 0 0 10px; background: var(--shade); }
.block-head .spacer { flex: 1; }
.block-head .tool { height: 26px; }
.message.active .block-head { background: var(--shade-hover); }
.block-schema { color: var(--bright); font-weight: 600; cursor: default; }
.block-schema:hover { text-decoration: underline; }
.block-schema .faint { font-weight: 400; }
.block-fields { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 2px 14px; margin: 0; padding: 7px 10px; cursor: text; }
.block-field { display: contents; }
.block-field dt { color: var(--faint); }
.block-field dd { margin: 0; color: var(--dim); overflow-wrap: anywhere; }
.block-field a { color: var(--accent); text-decoration: underline; text-decoration-color: var(--faint); text-underline-offset: 3px; }
.block-raw { margin: 0; padding: 7px 10px; color: var(--dim); font-family: inherit; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; cursor: text; }

/* --- schemas --- */
.schema-row { display: grid; grid-template-columns: minmax(120px, 200px) auto minmax(0, 1fr) auto; align-items: center; gap: 14px; padding: 6px 20px; }
.schema-row:hover { background: var(--shade); }
.schema-name { color: var(--bright); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.schema-versions { display: flex; gap: 10px; }
.schema-versions .tab { padding: 0; margin: 0; }
.schema-about { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: 12px; }
.small { font-size: 11px; }
.schema-detail { display: grid; gap: 10px; padding: 4px 20px 16px; max-width: 860px; }
.schema-detail .hint { margin: 0; font-size: 12px; }
.schema-detail code { color: var(--dim); }
.schema-fields { display: grid; grid-template-columns: max-content max-content minmax(0, 1fr); gap: 3px 16px; font-size: 12px; cursor: text; }
.schema-field { display: contents; }
.field-name { color: var(--bright); }
.schema-json { position: relative; }
.schema-json pre { margin: 0; padding: 10px 12px; max-height: 360px; overflow: auto; border: 1px solid var(--hairline); background: var(--shade); color: var(--dim); font-family: inherit; font-size: 12px; line-height: 1.5; cursor: text; }
.schema-json .act { position: absolute; top: 6px; right: 6px; background: var(--bg); }
.ask textarea.code { min-height: 180px; font-size: 12px; white-space: pre; }
.suggest.version { width: 64px; flex-shrink: 0; }
.error-text { color: var(--red); }
@media (max-width: 700px) {
  .schema-row { grid-template-columns: minmax(0, 1fr) auto; row-gap: 0; }
  .schema-about { grid-column: 1 / -1; grid-row: 2; }
  .schema-row > .small { display: none; }
}

/* --- access: grants, and the board's answer to who decides a channel --- */
.page h3 { margin: 16px 20px 4px; color: var(--faint); font-size: 11px; font-weight: 500; }
.page h3 b { color: var(--dim); font-weight: 600; }
.page > h3:first-child, .page > section:first-child h3 { margin-top: 6px; }
.grant-row { display: grid; grid-template-columns: 30px minmax(120px, 340px) minmax(0, 1fr) auto auto; align-items: center; gap: 12px; min-height: 30px; padding: 3px 20px; }
.grant-row:hover { background: var(--shade); }
.grant-who { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--bright); }
.grant-who .badge { margin-left: 8px; }
.grant-can { display: flex; flex-wrap: wrap; gap: 4px; min-width: 0; }
.grant-can b { color: var(--bright); font-weight: 600; }
.grant-row .act { height: 22px; }
.explain { display: grid; gap: 8px; padding: 2px 20px 6px; }
.explain-ask { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.explain-ask > .suggest { width: 200px; }
.who-fields { display: flex; flex-wrap: wrap; gap: 6px; }
.who-fields .suggest { width: 190px; }
.ask .who-fields .suggest { flex: 1; width: auto; min-width: 150px; }
.ask textarea.code.can { min-height: 64px; }
.explained { display: grid; gap: 6px; max-width: 900px; padding: 10px 12px; background: var(--shade); cursor: text; }
.explained p { margin: 0; color: var(--dim); font-size: 14px; }
.explained b { color: var(--bright); font-weight: 600; }
.explained .facts { grid-template-columns: 56px minmax(0, 1fr); font-size: 12px; }
.explained .grant-row { margin: 0 -12px; padding: 3px 12px; }
.explained .grant-row:hover { background: var(--shade-hover); }
@media (max-width: 700px) {
  .grant-row { grid-template-columns: 30px minmax(0, 1fr) auto; row-gap: 2px; padding: 5px 20px; }
  .grant-can { grid-column: 2 / -1; grid-row: 2; }
  .grant-row > .small { display: none; }
}

/* --- schedules, watchers, and a thread's copies --- */
.sched-row { display: grid; grid-template-columns: 64px minmax(110px, 200px) minmax(0, 1fr) auto auto 52px; align-items: center; gap: 14px; min-height: 30px; padding: 3px 20px; }
.sched-row:hover { background: var(--shade); }
.sched-when { color: var(--bright); white-space: nowrap; }
.sched-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dim); }
.sched-row .act { height: 22px; justify-self: end; }
.watch-row { display: grid; grid-template-columns: minmax(90px, 180px) minmax(0, 1fr); gap: 14px; padding: 4px 20px; }
.watch-row:hover { background: var(--shade); }
.watch-id { color: var(--bright); }
.watch-row code { color: var(--dim); overflow-wrap: anywhere; }
.thread-facts { flex-shrink: 0; padding: 10px 20px; border-bottom: 1px solid var(--hairline); font-size: 12px; }
.thread-facts .fact { display: contents; }
.copies { display: flex; flex-wrap: wrap; gap: 2px 12px; }
.label-add.end { justify-content: flex-end; gap: 12px; }
.suggest input:disabled { opacity: 0.4; }
@media (max-width: 700px) {
  .sched-row { grid-template-columns: 64px minmax(0, 1fr) auto; row-gap: 0; padding: 5px 20px; }
  .sched-row > .faint { display: none; }
  .sched-text { grid-column: 1 / -1; grid-row: 2; }
}

.inbox-row { display: grid; grid-template-columns: 70px 90px 1fr; gap: 12px; padding: 6px 20px; }
.inbox-row:hover { background: var(--shade); }
.inbox-row pre { margin: 4px 0 0; color: var(--faint); font-size: 11px; white-space: pre-wrap; overflow-wrap: anywhere; }

/* --- a narrow page: the sidebar comes over it when it's asked for --- */
.shell.nav .sidebar { display: flex; position: fixed; inset: 0 auto 0 0; z-index: var(--nav-layer); width: min(280px, 84vw) !important; opacity: 1 !important; }
.shell.nav .scrim { display: block; position: fixed; inset: 0; z-index: calc(var(--nav-layer) - 1); background: var(--scrim); }
:is(.brand .at, .sidebar h2, .sidebar .count, .whoami, .header .meta, .live, .time, .id, .divider, .where, .edited, .undelivered, .hint, .task-state, .task-now, .task-where) { font: var(--metadata); }
:is(.chip, .label button, .file button, .sidebar h2 .tool, .replies, .clear) { min-height: 24px; }
.emoji-grid { grid-template-columns: repeat(12, minmax(0, 1fr)); width: min(372px, calc(100vw - 24px)); }
@media (max-width: 700px) {
  .composer-footer .hint { display: none; }
  .composer-footer .send { margin-left: auto; }
}

/* --- operator console --- */
.operator-filters { display: flex; align-items: end; flex-wrap: wrap; gap: 8px 12px; padding: 10px 16px; }
:is(.operator-filters, .operator-history) label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--faint); }
:is(.operator-filters, .operator-history) :is(input, select) { max-width: 12rem; padding: 4px 6px; border: 0; border-radius: 4px; color: var(--dim); background: var(--bg); font: inherit; }
.operator-filters input { cursor: text; }
.operator-filters .hint { padding-bottom: 4px; }
.operator-scroller { flex: 1; min-height: 0; overflow: auto; padding: 8px 16px 16px; }
.operator-lanes { display: grid; grid-auto-columns: minmax(8rem, 1fr); grid-auto-flow: column; gap: 8px; }
.operator-lane { min-height: 6rem; padding: 7px; background: var(--bg); border-radius: 6px; }
.operator-lane h2 { display: flex; justify-content: space-between; align-items: baseline; gap: 4px; margin: 0; padding: 0 0 6px; border-bottom: 1px solid var(--hairline); font-size: 12px; }
.operator-lane ul { list-style: none; margin: 8px 0 0; padding: 0; display: grid; gap: 6px; }
.operator-card { display: grid; gap: 4px; width: 100%; padding: 7px; border-radius: 4px; background: var(--panel); text-align: left; overflow-wrap: anywhere; }
.operator-card strong { font-size: 12px; font-weight: 600; }
.operator-card:is(:hover, [aria-pressed=true]) { color: var(--accent); }
.operator-card[aria-pressed=true] { box-shadow: inset 0 0 0 1px var(--accent); }
.operator-scroller > .act { margin-top: 10px; }
.operator-details { max-height: 42dvh; overflow: auto; padding: 12px 16px; background: var(--bg); font-size: 12px; overflow-wrap: anywhere; }
.operator-detail-head, .operator-history-actions { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; }
.operator-detail-head { padding-bottom: 6px; border-bottom: 1px solid var(--hairline); }
.operator-detail-head h2, .operator-details h3 { margin: 0; font-size: 13px; }
.operator-details h3 { margin-top: 10px; }
.operator-details :is(ol, ul) { padding-inline-start: 1.5rem; }
.operator-history label { display: inline-flex; margin-top: 6px; }
.operator-history li { margin-block: 4px; }

.toasts { position: fixed; right: 16px; bottom: 16px; display: grid; gap: 8px; z-index: 60; }
.toast { max-width: 420px; padding: 8px 12px; border: 1px solid var(--dim); background: var(--bg); color: var(--bright); }

/* --- a touch device: iOS zooms in on a focused field whose text is under
   16px, so every field gets 16px there; important so it beats each field's
   own size, whatever its selector. A desktop keeps the sizes above. --- */
@media (pointer: coarse) {
  input, textarea, select { font-size: 16px !important; }
  :is(.header .tool, .sidebar .item, .brand .tool, .whoami, .send, .composer-footer .tool, .task-row) { min-height: 44px; }
  :is(.header .tool, .brand .tool, .composer-footer .tool) { min-width: 44px; }
}

@container (min-width: 42rem) {
  .task-row { grid-template-columns: 80px minmax(0, 1fr) auto auto 36px; }
  .task-where, .task-now:empty { display: block; }
  .task-now { grid-column: auto; grid-row: auto; max-width: 24ch; }
  .task-where { max-width: 16ch; overflow: hidden; text-overflow: ellipsis; }
}
`
