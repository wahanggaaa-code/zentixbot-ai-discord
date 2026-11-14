// AI Studio → Server Builder, connected to the bot. Three tabs:
//   design  – draft a plan from a ready-made theme or with the AI, review it, edit it, apply it;
//   history – what the builder created, and taking the newest build down again;
//   manual  – rename, re-permission or delete one existing object.
// Names in a plan come from an AI or from whoever edited it, so everything is put on the page as text
// (textContent), never as markup.
(() => {
 const API = '/dashboard/api/ai/builder/';
 async function req(path, body) {
  const s = await window.ZentixSession;
  const r = await fetch(API + path, { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json', 'x-csrf-token': s.csrf }, body: JSON.stringify(body) });
  const b = await r.json();
  if (!r.ok) { const e = Error(b.error || 'Permintaan gagal'); e.created = b.created; e.recorded = b.recorded; throw e; }
  return b;
 }
 async function read(path) {
  const r = await fetch(API + path, { cache: 'no-store' });
  const b = await r.json();
  if (!r.ok) throw Error(b.error || 'Data tidak dapat dimuat');
  return b;
 }
 /** Builds an element: el('li', {className:'x'}, 'text', childNode, …). Strings become text nodes. */
 function el(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) node[key] = value;
  for (const child of children) if (child !== null && child !== undefined && child !== '') node.append(child);
  return node;
 }
 const TYPE_LABELS = { category: 'KATEGORI', text: 'TEKS', voice: 'SUARA', forum: 'FORUM', news: 'PENGUMUMAN', stage: 'PANGGUNG', role: 'ROLE' };
 const SOURCE_LABELS = { ai: 'AI', theme: 'TEMA', fallback: 'TEMA CADANGAN' };
 const list = (value) => (Array.isArray(value) ? value : []);
 const countsOf = (plan) => ({ categories: list(plan?.categories).length, channels: list(plan?.categories).reduce((n, c) => n + list(c?.channels).length, 0), roles: list(plan?.roles).length });
 const countsText = (c) => `${c.categories} kategori · ${c.channels} channel · ${c.roles} role`;
 function itemCounts(items) {
  const c = { categories: 0, channels: 0, roles: 0 };
  for (const item of list(items)) c[item.type === 'category' ? 'categories' : item.type === 'role' ? 'roles' : 'channels']++;
  return c;
 }
 const when = (at) => { try { return new Date(at).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }); } catch { return '-'; } };

 /** The plan as a readable list: each category with its channels, then the roles. */
 function drawPlan(box, plan) {
  box.replaceChildren();
  box.append(el('div', { className: 'b-counts' }, countsText(countsOf(plan)).toUpperCase()));
  for (const category of list(plan?.categories)) {
   const rows = list(category?.channels).map((channel) => el('li', null,
    el('span', { className: 'b-tag' }, TYPE_LABELS[channel?.type] || 'CHANNEL'),
    el('span', { className: 'b-name' }, String(channel?.name ?? '')),
    channel?.topic ? el('small', null, String(channel.topic)) : null));
   box.append(el('div', { className: 'b-group' },
    el('div', { className: 'b-group-name' }, String(category?.name ?? '')),
    rows.length ? el('ul', null, ...rows) : el('p', { className: 'f-muted' }, 'Kategori kosong.')));
  }
  const roles = list(plan?.roles).map((role) => {
   const name = typeof role === 'string' ? role : String(role?.name ?? '');
   const color = typeof role?.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(role.color) ? role.color : null;
   const swatch = el('span', { className: 'b-swatch' });
   if (color) swatch.style.background = color;
   return el('li', null, swatch, el('span', { className: 'b-name' }, name), el('small', null, color || 'tanpa warna'));
  });
  if (roles.length) box.append(el('div', { className: 'b-group' }, el('div', { className: 'b-group-name' }, 'Role · tanpa izin khusus'), el('ul', null, ...roles)));
 }
 /** Created, removed or kept objects as one list. */
 function drawItems(box, title, items) {
  const rows = list(items).map((item) => el('li', null,
   el('span', { className: 'b-tag' }, TYPE_LABELS[item.type] || 'OBJEK'),
   el('span', { className: 'b-name' }, String(item.name ?? '')),
   item.reason ? el('small', null, String(item.reason)) : null));
  if (rows.length) box.append(el('div', { className: 'b-group' }, el('div', { className: 'b-group-name' }, title), el('ul', null, ...rows)));
 }

 const aside = (title, lead, note, callout) => `<aside><section class="f-panel"><div class="f-panel-head"><div><h2>${title}</h2><p>${lead}</p></div><span>◇</span></div><div class="f-feature-note"><p>${note}</p></div><div class="f-callout">⚠ &nbsp; ${callout}</div></section></aside>`;

 function designMarkup() {
  return `<div class="f-layout"><div>
<section class="f-panel"><div class="f-panel-head"><div><h2>Server Builder</h2><p>Pilih tema atau jelaskan servernya, tinjau, lalu terapkan dengan konfirmasi terpisah.</p></div><span>⌗</span></div>
<form id="aiBuilderThemeForm" class="f-form b-form"><label class="f-field"><span><b>Tema siap pakai</b><small>Tanpa AI, tidak memakai kuota. Hasilnya tetap bisa disunting.</small></span><select name="themeId" required><option value="">Memuat tema…</option></select></label><div class="f-form-actions"><span>✳ SUSUNAN SIAP PAKAI · TANPA KUOTA AI</span><button class="f-outline" type="submit">PAKAI TEMA ↗</button></div></form>
<form id="aiBuilderForm" class="f-form b-form"><label class="f-field"><span><b>Atau jelaskan servernya</b><small>Dikirim ke provider AI. Jangan masukkan data sensitif. Besar rancangan AI mengikuti batas output di Provider &amp; fallback; bila AI gagal, dipakai tema terdekat.</small></span><textarea name="description" maxlength="1000" rows="5" required></textarea></label><div class="f-form-actions"><span id="aiBuilderLimits">✳ MAKS. 8 KATEGORI, 40 CHANNEL, 12 ROLE</span><button class="f-primary" type="submit">RANCANG DENGAN AI ↗</button></div></form>
</section>
<section class="f-panel"><div class="f-panel-head"><div><h2>Rancangan untuk ditinjau</h2><p>Belum ada yang dibuat di Discord sampai Anda menekan Terapkan.</p></div><span>◉</span></div>
<p class="f-callout" id="aiBuilderNote" hidden></p>
<div class="b-tree" id="aiBuilderPreview"><p class="f-muted">Belum ada rancangan.</p></div>
<details class="b-details"><summary>SUNTING RANCANGAN (JSON)</summary><p class="f-muted">Ubah nama, tipe (text, voice, forum, news, stage), topic atau warna role, lalu validasi sebelum menerapkan. Ini tidak mengubah objek Discord yang sudah ada.</p><textarea class="b-code" id="aiBuilderPlan" rows="14" maxlength="20000" spellcheck="false" aria-label="JSON rancangan server" disabled></textarea><div class="b-actions"><button type="button" class="f-outline" id="aiBuilderSave" disabled>VALIDASI RANCANGAN ↗</button></div></details>
<div class="b-actions"><button type="button" class="f-primary" id="aiBuilderApply" disabled>TERAPKAN KE SERVER ↗</button><button type="button" class="f-outline" id="aiBuilderCancel" disabled>BATALKAN RANCANGAN</button></div>
<p id="aiBuilderStatus" aria-live="polite" class="f-muted b-status"></p>
<div class="b-tree" id="aiBuilderResult"></div>
</section></div>${aside('Sebelum menerapkan', 'Hanya owner bot yang dapat menjalankan.', 'Penerapan membuat kategori, channel dan role baru. Role baru tidak mendapat izin khusus, tidak dapat di-mention dan tidak ditampilkan terpisah. Channel mengikuti izin default kategori/server dan mungkin terlihat oleh anggota lain. Nama yang sudah ada di server ditolak. Tipe forum, news dan stage memerlukan fitur Komunitas Discord.', 'Rancangan berlaku 5 menit dan hanya sekali pakai. Semua yang dibuat tercatat di tab Riwayat & bongkar dan dapat dihapus lagi dari sana, juga bila penerapan berhenti di tengah jalan.')}</div>`;
 }

 function historyMarkup() {
  return `<div class="f-layout"><div>
<section class="f-panel"><div class="f-panel-head"><div><h2>Riwayat pembangunan</h2><p>Yang dibuat Server Builder di server ini, terbaru di atas.</p></div><span>◆</span></div>
<div class="b-builds" id="aiBuilderHistory"><p class="f-muted">Memuat…</p></div>
</section>
<section class="f-panel"><div class="f-panel-head"><div><h2>Bongkar bangunan terakhir</h2><p>Menghapus persis objek yang tercatat pada bangunan terakhir. Tinjau dulu, lalu ketik konfirmasinya.</p></div><span>⌫</span></div>
<div class="b-actions"><button type="button" class="f-outline" id="aiUndoPrepare" disabled>TINJAU BONGKAR ↗</button></div>
<div class="b-tree" id="aiUndoPreview"><p class="f-muted">Belum ada yang ditinjau.</p></div>
<label class="f-field"><span><b>Konfirmasi bongkar</b><small id="aiUndoHint">Tinjau dulu; kalimat yang harus diketik muncul di sini.</small></span><input id="aiUndoConfirmation" autocomplete="off" autocapitalize="characters" spellcheck="false"></label>
<div class="b-actions"><button type="button" class="f-outline b-danger" id="aiUndoApply" disabled>BONGKAR SEKARANG ↗</button><button type="button" class="f-outline" id="aiUndoForget" disabled>LEPAS DARI RIWAYAT</button></div>
<p class="f-muted b-status" id="aiUndoStatus" aria-live="polite"></p>
</section></div>${aside('Cara kerja bongkar', 'Hanya owner bot yang dapat menjalankan.', 'Setiap penerapan dicatat beserta ID objek yang benar-benar dibuat. Bongkar menghapus ID itu saja: channel dulu, lalu kategori, lalu role. Hanya bangunan terakhir yang dapat dibongkar; setelah habis, bangunan sebelumnya menjadi yang terakhir. Objek yang gagal dihapus tetap tercatat untuk dicoba lagi. Kategori yang masih berisi channel lain dan channel sistem server tidak dihapus.', 'Channel dihapus beserta seluruh pesannya dan role dilepas dari semua anggota. Bot tidak dapat memulihkannya. "Lepas dari riwayat" hanya menghapus catatan: objeknya tetap ada di Discord dan tidak bisa lagi dibongkar otomatis.')}</div>`;
 }

 function manualMarkup() {
  const names = ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'AddReactions', 'EmbedLinks', 'AttachFiles', 'Connect', 'Speak', 'Stream', 'UseVAD'];
  return `<div class="f-layout"><div><section class="f-panel"><div class="f-panel-head"><div><h2>Ubah objek yang ada</h2><p>Manual, satu target per tindakan · tidak dijalankan AI.</p></div><span>◇</span></div>
<form id="aiManualForm" class="f-form b-form"><label class="f-field"><span><b>Jenis target</b><small>Channel teks/suara/kategori atau role biasa.</small></span><select name="kind"><option value="channel">Channel atau kategori</option><option value="role">Role</option></select></label><label class="f-field"><span><b>ID target Discord</b><small>Salin ID di Discord, lalu tinjau sebelum mengubah.</small></span><input name="targetId" inputmode="numeric" pattern="[0-9]{17,20}" required></label><label class="f-field"><span><b>Tindakan</b><small>Hapus permanen; rollback hanya untuk nama dan izin role.</small></span><select name="action"><option value="rename">Ganti nama</option><option value="permissions">Atur izin dasar role</option><option value="delete">Hapus permanen</option></select></label><label class="f-field"><span><b>Nama baru</b><small>Hanya untuk ganti nama; channel teks/suara huruf kecil ASCII, angka, - atau _.</small></span><input name="newName" maxlength="40"></label>
<fieldset class="b-perms"><legend>Izin dasar role (hanya tindakan atur izin)</legend><p class="f-muted">Daftar lengkap izin dasar baru: centang yang diinginkan. Tidak mengubah permission overwrite channel.</p><div class="b-perm-grid">${names.map((n) => `<label><input type="checkbox" name="permission" value="${n}"><span>${n}</span></label>`).join('')}</div></fieldset>
<div class="b-actions"><button class="f-outline" type="submit">TINJAU TINDAKAN ↗</button></div></form>
<pre class="b-pre" id="aiManualPreview">Belum ada tindakan ditinjau.</pre>
<label class="f-field"><span><b>Konfirmasi target</b><small>Untuk rename/izin ketik ID. Untuk hapus ketik HAPUS diikuti spasi dan ID. Hapus tidak bisa di-rollback.</small></span><input id="aiManualConfirmation" autocomplete="off"></label>
<div class="b-actions"><button type="button" class="f-outline" id="aiManualApply" disabled>JALANKAN TINDAKAN ↗</button><button type="button" class="f-outline" id="aiManualUndo" disabled>ROLLBACK PERUBAHAN TERAKHIR ↗</button></div>
<p class="f-muted b-status" id="aiManualStatus" aria-live="polite"></p>
</section></div>${aside('Sebelum mengubah', 'Hanya owner bot yang dapat menjalankan.', 'Untuk objek yang sudah ada di server, apa pun asalnya. Setiap tindakan ditinjau dulu dan dikonfirmasi dengan mengetik ID target. Permission overwrite channel tidak dapat diubah dari sini.', 'Hapus channel dapat menghapus pesan; hapus role menghilangkan penetapan role. Bot tidak dapat memulihkan data tersebut. Tinjauan dan rollback hanya disimpan 5 menit di memori dan hilang saat restart. Perubahan lain dapat membuat rollback ditolak.')}</div>`;
 }

 function render(tab) { return tab === 'history' ? historyMarkup() : tab === 'manual' ? manualMarkup() : designMarkup(); }

 function bindDesign(root) {
  const form = root.querySelector('#aiBuilderForm'), themeForm = root.querySelector('#aiBuilderThemeForm');
  if (!form) return;
  const out = root.querySelector('#aiBuilderPlan'), status = root.querySelector('#aiBuilderStatus'), apply = root.querySelector('#aiBuilderApply'), save = root.querySelector('#aiBuilderSave');
  const cancel = root.querySelector('#aiBuilderCancel'), preview = root.querySelector('#aiBuilderPreview'), note = root.querySelector('#aiBuilderNote'), result = root.querySelector('#aiBuilderResult');
  let planId = null, revision = 0, dirty = false, busy = false;

  const idle = (text) => preview.replaceChildren(el('p', { className: 'f-muted' }, text));
  function reset(text) {
   planId = null; dirty = false; revision++;
   apply.disabled = true; save.disabled = true; cancel.disabled = true; out.disabled = true; out.value = '';
   if (note) { note.hidden = true; note.textContent = ''; }
   idle(text);
  }
  function show(draft, message) {
   planId = draft.id; dirty = false; revision++;
   drawPlan(preview, draft.plan);
   out.value = JSON.stringify(draft.plan, null, 2);
   out.disabled = false; save.disabled = false; apply.disabled = false; cancel.disabled = false;
   const source = SOURCE_LABELS[draft.source] ? `SUMBER: ${SOURCE_LABELS[draft.source]}${draft.theme?.label ? ' · ' + draft.theme.label : ''}` : '';
   if (note) { const text = [source, draft.note].filter(Boolean).join(' — '); note.textContent = text; note.hidden = !text; }
   result.replaceChildren();
   status.textContent = message;
  }
  async function draft(button, pending, run) {
   if (busy) return;
   busy = true; button.disabled = true;
   reset('Menyusun rancangan…'); status.textContent = pending;
   try { show(await run(), 'Tinjau rancangan. Berlaku 5 menit dan sekali pakai.'); }
   catch (err) { idle('Belum ada rancangan.'); status.textContent = err.message; }
   finally { busy = false; button.disabled = false; }
  }

  out.oninput = () => { revision++; dirty = true; apply.disabled = true; status.textContent = 'Rancangan berubah. Validasi sebelum menerapkan.'; };
  if (themeForm) themeForm.onsubmit = (e) => {
   e.preventDefault();
   const themeId = themeForm.elements.themeId.value;
   if (!themeId) { status.textContent = 'Pilih tema lebih dulu.'; return; }
   draft(themeForm.querySelector('button'), 'Menyiapkan tema…', () => req('theme', { themeId }));
  };
  form.onsubmit = (e) => {
   e.preventDefault();
   if (!confirm('Kirim deskripsi ke provider AI? Ini dapat memakai kuota dan berbiaya. Belum ada perubahan Discord.')) return;
   draft(form.querySelector('button'), 'Menyusun rancangan dengan AI…', () => req('draft', { description: form.elements.description.value, confirmed: true }));
  };
  save.onclick = async () => {
   if (!planId) return;
   let plan;
   try { plan = JSON.parse(out.value); } catch { status.textContent = 'JSON tidak valid.'; return; }
   const current = revision;
   save.disabled = true; apply.disabled = true; status.textContent = 'Memvalidasi rancangan…';
   try {
    const r = await req('edit', { id: planId, plan });
    if (revision !== current) { dirty = true; status.textContent = 'Rancangan berubah lagi. Validasi ulang sebelum menerapkan.'; return; }
    out.value = JSON.stringify(r.plan, null, 2);
    drawPlan(preview, r.plan);
    dirty = false; apply.disabled = false;
    status.textContent = `Rancangan valid. Sisa waktu sekitar ${r.expiresInSeconds} detik.`;
   } catch (err) { dirty = true; status.textContent = err.message; }
   finally { save.disabled = !planId; }
  };
  apply.onclick = async () => {
   if (!planId || dirty || !confirm('Terapkan rancangan yang ditampilkan ke server Discord? Kategori, channel dan role akan dibuat. Hasilnya tercatat dan dapat dibongkar dari tab Riwayat & bongkar.')) return;
   const id = planId;
   planId = null; apply.disabled = true; save.disabled = true; cancel.disabled = true; out.disabled = true;
   status.textContent = 'Menerapkan… pada rancangan besar ini bisa memakan waktu sekitar satu menit.';
   result.replaceChildren();
   try {
    const r = await req('apply', { id, confirmed: true });
    status.textContent = `Selesai: ${countsText(r.counts || itemCounts(r.created))} dibuat. ${r.recorded === false ? 'Riwayat tidak dapat disimpan, jadi bangunan ini tidak bisa dibongkar otomatis.' : 'Tercatat di tab Riwayat & bongkar.'}`;
    drawItems(result, 'Yang dibuat', r.created);
   } catch (err) {
    status.textContent = err.message;
    drawItems(result, 'Sudah dibuat sebelum berhenti', err.created);
   }
  };
  cancel.onclick = async () => {
   if (!planId) return;
   const id = planId;
   reset('Belum ada rancangan.'); status.textContent = 'Rancangan dibatalkan. Tidak ada yang dibuat.';
   try { await req('cancel', { id }); } catch { /* an expired plan is gone already */ }
  };

  // The theme list and limits come from the bot, so the page cannot drift from what the bot accepts.
  read('themes').then((r) => {
   const select = themeForm?.elements.themeId;
   if (!select) return;
   select.replaceChildren(...list(r.themes).map((t) => el('option', { value: t.id }, `${t.emoji || ''} ${t.label} · ${t.categories} kategori, ${t.channels} channel, ${t.roles} role`.trim())));
   if (!select.options.length) select.append(el('option', { value: '' }, 'Tidak ada tema'));
   const limits = root.querySelector('#aiBuilderLimits');
   if (limits && r.limits) limits.textContent = `✳ MAKS. ${r.limits.categories} KATEGORI, ${r.limits.channels} CHANNEL, ${r.limits.roles} ROLE`;
  }).catch((err) => { const select = themeForm?.elements.themeId; if (select) select.replaceChildren(el('option', { value: '' }, 'Tema tidak dapat dimuat')); status.textContent = err.message; });
  // A plan drafted a moment ago (here or on another tab) is still waiting on the bot.
  read('pending').then((r) => { if (r.pending?.id && !planId && !busy) show(r.pending, `Rancangan yang masih menunggu dimuat kembali. Sisa waktu sekitar ${r.pending.expiresInSeconds} detik.`); }).catch(() => {});
 }

 function bindHistory(root) {
  const box = root.querySelector('#aiBuilderHistory');
  if (!box) return;
  const prepare = root.querySelector('#aiUndoPrepare'), preview = root.querySelector('#aiUndoPreview'), input = root.querySelector('#aiUndoConfirmation'), hint = root.querySelector('#aiUndoHint');
  const apply = root.querySelector('#aiUndoApply'), forget = root.querySelector('#aiUndoForget'), status = root.querySelector('#aiUndoStatus');
  let latest = null, review = null;

  const idle = (text) => { review = null; apply.disabled = true; input.value = ''; hint.textContent = 'Tinjau dulu; kalimat yang harus diketik muncul di sini.'; preview.replaceChildren(el('p', { className: 'f-muted' }, text)); };
  function drawBuilds(builds) {
   box.replaceChildren();
   latest = builds[0] || null;
   prepare.disabled = !latest; forget.disabled = !latest;
   if (!builds.length) { box.append(el('p', { className: 'f-muted' }, 'Belum ada bangunan yang tercatat. Terapkan sebuah rancangan di tab Rancang.')); return; }
   builds.forEach((build, index) => {
    const flags = [index === 0 ? 'TERAKHIR' : null, SOURCE_LABELS[build.source] || null, build.edited ? 'DISUNTING' : null, build.partial ? 'BERHENTI DI TENGAH' : null].filter(Boolean);
    const rows = list(build.items).map((item) => el('li', null, el('span', { className: 'b-tag' }, TYPE_LABELS[item.type] || 'OBJEK'), el('span', { className: 'b-name' }, String(item.name ?? ''))));
    box.append(el('details', { className: 'b-build' },
     el('summary', null,
      el('span', { className: 'b-build-title' }, String(build.label || 'Tanpa nama')),
      el('span', { className: 'b-build-meta' }, `${when(build.at)} · ${countsText(build.counts || itemCounts(build.items))}`),
      el('span', { className: 'b-build-flags' }, ...flags.map((flag) => el('span', { className: 'b-tag' }, flag)))),
     el('ul', null, ...rows)));
   });
  }
  async function load() {
   try { drawBuilds(list((await read('history')).builds)); }
   catch (err) { box.replaceChildren(el('p', { className: 'f-muted' }, err.message)); prepare.disabled = true; forget.disabled = true; }
  }

  prepare.onclick = async () => {
   prepare.disabled = true; idle('Memeriksa keadaan di Discord…'); status.textContent = '';
   try {
    const r = await req('undo/prepare', { confirmed: true });
    review = { id: r.id, confirmation: r.confirmation };
    const marks = { delete: 'DIHAPUS', gone: 'SUDAH TIDAK ADA', blocked: 'DILEWATI' };
    preview.replaceChildren(el('div', { className: 'b-counts' }, `${r.counts.delete} DIHAPUS · ${r.counts.gone} SUDAH TIDAK ADA · ${r.counts.blocked} DILEWATI`),
     el('div', { className: 'b-group' }, el('div', { className: 'b-group-name' }, `${String(r.build?.label || 'Bangunan')} · ${when(r.build?.at)}`),
      el('ul', null, ...list(r.items).map((item) => el('li', { className: `b-state-${item.state}` },
       el('span', { className: 'b-tag' }, marks[item.state] || 'OBJEK'),
       el('span', { className: 'b-name' }, `${TYPE_LABELS[item.type] || ''} ${String(item.name ?? '')}`.trim()),
       list(item.notes).length ? el('small', null, list(item.notes).join('; ')) : null)))),
     el('p', { className: 'f-callout' }, `⚠ ${r.warning}`));
    hint.textContent = `Ketik persis: ${r.confirmation}`;
    input.value = ''; apply.disabled = false;
    status.textContent = 'Tinjau daftar di atas. Berlaku 5 menit.';
   } catch (err) { idle('Belum ada yang ditinjau.'); status.textContent = err.message; }
   finally { prepare.disabled = !latest; }
  };
  apply.onclick = async () => {
   if (!review) return;
   if (input.value.trim() !== review.confirmation) { status.textContent = `Konfirmasi tidak cocok. Ketik persis: ${review.confirmation}`; return; }
   if (!confirm('Bongkar bangunan terakhir? Channel dihapus beserta pesannya dan role dilepas dari semua anggota. Ini tidak dapat dipulihkan.')) return;
   const current = review;
   review = null; apply.disabled = true; status.textContent = 'Membongkar…';
   try {
    const r = await req('undo/apply', { id: current.id, confirmation: current.confirmation });
    idle('Belum ada yang ditinjau.');
    preview.replaceChildren();
    drawItems(preview, 'Dihapus', r.removed);
    drawItems(preview, 'Tidak terhapus · tetap tercatat', r.kept);
    if (!preview.children.length) preview.append(el('p', { className: 'f-muted' }, 'Tidak ada yang perlu dihapus; catatan ditutup.'));
    status.textContent = `Dibongkar: ${countsText(r.counts || itemCounts(r.removed))} dihapus.${list(r.kept).length ? ' Sebagian tidak terhapus; bereskan penyebabnya lalu tinjau lagi.' : ''}${r.recorded === false ? ' Riwayat tidak dapat diperbarui; muat ulang halaman.' : ''}`;
   } catch (err) { idle('Belum ada yang ditinjau.'); status.textContent = `${err.message} Tinjau lagi sebelum mencoba.`; }
   await load();
  };
  forget.onclick = async () => {
   if (!latest || !confirm('Lepas bangunan terakhir dari riwayat? Tidak ada yang dihapus di Discord, tetapi bangunan itu tidak bisa lagi dibongkar otomatis.')) return;
   forget.disabled = true; idle('Belum ada yang ditinjau.');
   try { await req('undo/forget', { buildId: latest.id, confirmed: true }); status.textContent = 'Catatan dilepas. Objeknya tetap ada di Discord.'; }
   catch (err) { status.textContent = err.message; }
   await load();
  };
  load();
 }

 function bindManual(root) {
  const manual = root.querySelector('#aiManualForm');
  if (!manual) return;
  const preview = root.querySelector('#aiManualPreview'), manualStatus = root.querySelector('#aiManualStatus'), confirmInput = root.querySelector('#aiManualConfirmation'), manualApply = root.querySelector('#aiManualApply'), undo = root.querySelector('#aiManualUndo');
  let ticket = null, undoTicket = null, version = 0;
  const changed = () => { version++; ticket = null; manualApply.disabled = true; preview.textContent = 'Input berubah; tinjau lagi sebelum menjalankan.'; };
  manual.addEventListener('input', changed); manual.addEventListener('change', changed);
  manual.onsubmit = async (e) => {
   e.preventDefault(); ticket = null; manualApply.disabled = true;
   const x = manual.elements, action = x.action.value, kind = x.kind.value, value = action === 'delete' ? null : action === 'rename' ? x.newName.value : [...manual.querySelectorAll('input[name=permission]:checked')].map((box) => box.value), current = version, button = manual.querySelector('button');
   button.disabled = true; manualStatus.textContent = 'Mengambil keadaan target…';
   try {
    const r = await req('manual/prepare', { kind, action, targetId: x.targetId.value, value });
    if (current !== version) { manualStatus.textContent = 'Input berubah; tinjau ulang.'; return; }
    ticket = { id: r.id, action, targetId: r.before.id };
    preview.textContent = JSON.stringify({ tindakan: r.action, sebelum: r.before, sesudah: r.after, izinSebelum: r.permissionsBefore, izinSesudah: r.permissionsAfter, peringatan: r.warning }, null, 2);
    confirmInput.value = ''; manualApply.disabled = false; manualStatus.textContent = 'Tinjau detail. Berlaku 5 menit.';
   } catch (err) { manualStatus.textContent = err.message; }
   finally { button.disabled = false; }
  };
  manualApply.onclick = async () => {
   if (!ticket) return;
   if (confirmInput.value !== (ticket.action === 'delete' ? `HAPUS ${ticket.targetId}` : ticket.targetId)) { manualStatus.textContent = 'Konfirmasi target tidak cocok.'; return; }
   if (!confirm(ticket.action === 'delete' ? 'Hapus target secara permanen? Pesan atau penetapan role dapat hilang dan tidak dapat dipulihkan.' : 'Jalankan perubahan pada target Discord yang ditinjau?')) return;
   const current = ticket; ticket = null; manualApply.disabled = true; manualStatus.textContent = 'Menjalankan…';
   try {
    const r = await req('manual/apply', { id: current.id, confirmation: confirmInput.value });
    undoTicket = r.undoId ? { id: r.undoId, targetId: r.targetId } : null; undo.disabled = !undoTicket; confirmInput.value = '';
    manualStatus.textContent = r.undoId ? 'Perubahan diterapkan. Rollback terbatas tersedia 5 menit dengan mengetik ID target.' : 'Tindakan selesai. Rollback tidak tersedia; periksa Discord.';
   } catch (err) { manualStatus.textContent = err.message + ' Tinjau ulang sebelum mencoba.'; }
  };
  undo.onclick = async () => {
   if (!undoTicket) return;
   if (confirmInput.value !== undoTicket.targetId) { manualStatus.textContent = 'Untuk rollback, ketik ID target.'; return; }
   if (!confirm('Kembalikan nama atau izin role yang terakhir diubah? Perubahan hanya diterapkan jika target belum berubah sejak itu.')) return;
   const u = undoTicket; undoTicket = null; undo.disabled = true; manualStatus.textContent = 'Memproses rollback…';
   try { await req('manual/undo', { id: u.id, confirmation: confirmInput.value }); confirmInput.value = ''; manualStatus.textContent = 'Rollback selesai.'; }
   catch (err) { manualStatus.textContent = err.message + ' Periksa Discord sebelum tindakan lain.'; }
  };
 }

 function bind(root) { bindDesign(root); bindHistory(root); bindManual(root); }
 window.ZentixAIBuilder = { render, bind };
})();
