/**
 * The pages a person sees before the dashboard itself opens: the login form, a login that failed,
 * "not configured yet", "too many attempts". They are sent by the server as one self-contained
 * document (no script, no request for another file) and follow the dashboard's design system:
 * the same colours, type and square, ink-outlined panels as dashboard-preview/style.css.
 */
export const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// The tokens are those of dashboard-preview/style.css (:root); keep the two in step.
const CSS = `
:root{--ground:#a9a9a9;--ink:#11120e;--line:rgba(18,19,15,.42);--softline:rgba(18,19,15,.2);--panel:#c3c3bd;--lime:#c4f82a;--mono:'Courier New',Courier,monospace;--sans:Arial,Helvetica,sans-serif}
*{box-sizing:border-box}
body{background:var(--ground);color:var(--ink);margin:0;font-family:var(--sans);-webkit-font-smoothing:antialiased}
a{color:inherit}
a:focus-visible,button:focus-visible{outline:3px solid #5b7911;outline-offset:4px}
.shell{max-width:1120px;min-height:100vh;margin:auto;padding:0 4.2vw 28px;display:flex;flex-direction:column}
.strip{height:31px;display:flex;align-items:center;gap:9px;border-bottom:1px solid var(--ink);font:700 9px var(--mono);letter-spacing:.08em}
.dot{width:7px;height:7px;border-radius:50%;background:var(--lime);box-shadow:0 0 0 2px #1c1c1a}
.sep{color:#555}
.head{height:96px;border-bottom:1px solid var(--ink);display:flex;align-items:center;justify-content:space-between;gap:16px}
.wordmark{display:flex;gap:12px;align-items:center;text-decoration:none}
.mark{font-size:39px;line-height:1}
.name{font-weight:900;font-size:23px;letter-spacing:-1.8px;line-height:1}
.reg{font:700 8px var(--mono);vertical-align:top;margin-left:3px;letter-spacing:0}
.name small{display:block;font:700 8px var(--mono);letter-spacing:.09em;margin-top:7px}
.head-note{font:9px/1.55 var(--mono);text-align:right;letter-spacing:.08em}
.head-note b{font-size:10px}
.stage{flex:1;display:grid;grid-template-columns:minmax(0,1fr) minmax(320px,430px);gap:56px;align-items:end;padding:64px 0 56px}
.kicker{display:flex;gap:10px;align-items:center;font:700 10px var(--mono);letter-spacing:.11em}
.kicker i{display:block;background:var(--ink);width:29px;height:1px}
.pill{border:1px solid var(--ink);border-radius:20px;padding:5px 8px;font-size:9px}
h1{font-weight:800;letter-spacing:-.065em;line-height:.89;font-size:clamp(54px,6.6vw,92px);margin:28px 0 22px;overflow-wrap:break-word}
h1 em{font-style:normal;font-weight:500}h1 span{color:var(--lime)}
.copy{font:13px/1.7 var(--mono);max-width:440px;margin:0;color:#30312d;overflow-wrap:anywhere}
.panel{border:1px solid var(--ink);padding:20px}
.panel-head{display:flex;justify-content:space-between;gap:10px;padding-bottom:16px;border-bottom:1px solid var(--ink)}
.panel-head h2{font-size:22px;letter-spacing:-.04em;margin:0 0 6px}
.panel-head p{font:10px/1.55 var(--mono);margin:0;color:#484a41}
.panel-head>span{font-size:23px;line-height:1}
form{padding-top:18px}
label{display:block;font:700 9px var(--mono);letter-spacing:.11em;text-transform:uppercase;margin-bottom:9px}
input{display:block;width:100%;border:1px solid var(--ink);background:#c4c4bd;color:#111;padding:13px 12px;outline:none;border-radius:0;font:16px var(--mono);-webkit-appearance:none;appearance:none}
input:focus{outline:2px solid #536f12;outline-offset:1px}
.primary,.alt a{display:block;width:100%;border:1px solid var(--ink);border-radius:0;padding:14px 13px;font:700 10px var(--mono);letter-spacing:.06em;text-transform:uppercase;text-align:left;text-decoration:none;cursor:pointer}
.primary{background:var(--lime);color:var(--ink);margin-top:14px}
.alt a{background:transparent;color:var(--ink)}
.primary:hover,.alt a:hover{background:var(--ink);color:var(--lime)}
.primary::after,.alt a::after{content:'↗';float:right}
.help{font:10px/1.6 var(--mono);margin:14px 0 0;color:#484a41}
.help code{font:700 10px var(--mono);background:var(--panel);border:1px solid var(--softline);padding:1px 4px}
.error{background:#1b1c18;color:#e7e9da;border-left:6px solid var(--lime);margin:0 0 16px;padding:13px 14px;font:700 11px/1.6 var(--mono);letter-spacing:.01em;overflow-wrap:anywhere}
.error::before{content:'GAGAL — ';color:var(--lime);letter-spacing:.08em}
.alt{margin:16px 0 0}
.alt span{display:block;font:700 9px var(--mono);letter-spacing:.11em;margin-bottom:9px}
.note{font:13px/1.7 var(--mono);margin:0 0 18px;color:#1d1e19;overflow-wrap:anywhere}
.foot{display:flex;justify-content:space-between;gap:15px;border-top:1px solid var(--ink);padding-top:15px;font:700 9px var(--mono);letter-spacing:.04em}
.foot b{background:var(--lime);padding:2px 3px}
@media(max-width:980px){
.shell{padding:0 20px 22px}
.head{height:78px}
.mark{font-size:33px}
.name{font-size:20px}
.stage{grid-template-columns:minmax(0,1fr);gap:30px;align-items:start;align-content:start;padding:34px 0 40px}
h1{font-size:clamp(46px,14vw,92px);margin:24px 0 18px}
.copy{font-size:12px}
.panel{padding:15px}
.panel-head h2{font-size:19px}
.foot{font-size:8px}
}
`.replace(/\n/g, '');

/**
 * One document in the dashboard's look.
 *
 * @param {object} page
 * @param {string} page.title     the browser tab's title
 * @param {string} page.label     the word in the strip, the kicker and the footer, e.g. "MASUK"
 * @param {string} page.heading   the large heading, as HTML (the caller escapes what it puts in); <em> is the lighter weight
 * @param {string} [page.lead]    one sentence under the heading, as plain text
 * @param {string} page.body      the right-hand column, as HTML
 */
export function pageShell({ title, label, heading, lead = '', body }) {
    return '<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        // "same-origin", not "no-referrer": under "no-referrer" a browser posts the login form with
        // "Origin: null", and the server could not tell its own page from somebody else's.
        + '<meta name="referrer" content="same-origin"><meta name="color-scheme" content="light"><meta name="theme-color" content="#a9a9a9"><meta name="robots" content="noindex">'
        + `<title>${escapeHtml(title)}</title><style>${CSS}</style></head><body><div class="shell">`
        + `<div class="strip"><span class="dot"></span> ZENTIX <span class="sep">/</span> CONTROL ROOM · ${escapeHtml(label)}</div>`
        + '<header class="head"><a class="wordmark" href="/dashboard/" aria-label="Zentix, ke dashboard"><span class="mark">✳</span><span class="name">ZENTIX<span class="reg">®</span><small>DISCORD CONTROL SYSTEM</small></span></a>'
        + '<span class="head-note">COMMUNITY<br><b>CONTROL ROOM</b></span></header>'
        + `<main class="stage"><div class="lead"><div class="kicker"><i></i><span class="pill">01</span> ${escapeHtml(label)}</div><h1>${heading}</h1>`
        + (lead ? `<p class="copy">${escapeHtml(lead)}</p>` : '')
        + `</div><div class="side">${body}</div></main>`
        + `<footer class="foot"><span>© ZENTIXBOT <span class="sep">/</span> DESIGNED FOR YOUR COMMUNITY</span><span>${escapeHtml(label)} <b>01</b></span></footer>`
        + '</div></body></html>';
}

/**
 * A page that says one thing and offers one way on: used where the login cannot go ahead.
 *
 * @param {string} message         plain text
 * @param {object} [options]
 * @param {string} [options.title]    heading and tab title
 * @param {string} [options.label]    the word in the strip
 * @param {string | null} [options.href]  where the button leads; null for no button
 * @param {string} [options.action]   the button's text
 */
export function noticePage(message, { title = 'Belum bisa masuk', label = 'MASUK', href = '/dashboard/login', action = 'Buka halaman login' } = {}) {
    const words = escapeHtml(title).split(' ');
    // Like the dashboard's own headings: the first line heavy, the last word lighter on its own line.
    const heading = words.length > 1 ? `${words.slice(0, -1).join(' ')}<br><em>${words.at(-1)}</em><span>.</span>` : `${words[0]}<span>.</span>`;
    return pageShell({
        title: `${title} — Zentix`,
        label,
        heading,
        body: `<section class="panel"><p class="note" role="alert">${escapeHtml(message)}</p>${href ? `<p class="alt"><a href="${escapeHtml(href)}">${escapeHtml(action)}</a></p>` : ''}</section>`,
    });
}
