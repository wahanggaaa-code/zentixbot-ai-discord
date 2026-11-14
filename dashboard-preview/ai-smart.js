/* "Fitur pintar" room of AI Studio: FAQ and reply cache, message menu, morning digest, greeting extras,
   automatic translation and the usage report. Owner only. Every feature has its own switch and its own
   save button; features that work in channels let the owner tick several channels. */
(() => {
 const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
 async function req(path, opts = {}) {
  const s = await window.ZentixSession;
  const r = await fetch('/dashboard/api/ai/' + path, { cache: 'no-store', ...opts, headers: opts.body ? { 'Content-Type': 'application/json', 'x-csrf-token': s.csrf } : {} });
  const b = await r.json();
  if (!r.ok) throw Error(b.error || 'Permintaan gagal');
  return b;
 }
 const row = (title, help, control) => `<label class="f-field"><span><b>${esc(title)}</b><small>${esc(help)}</small></span>${control}</label>`;
 const toggle = (name, title, help, value) => row(title, help, `<span class="f-check"><input name="${name}" type="checkbox" ${value ? 'checked' : ''}><span class="fake-switch"></span></span>`);
 const number = (name, title, help, value, min, max) => row(title, `${help} (${min}–${max})`, `<input name="${name}" type="number" min="${min}" max="${max}" value="${esc(value)}" required>`);
 const options = (map, chosen) => Object.entries(map).map(([value, label]) => `<option value="${esc(value)}" ${value === chosen ? 'selected' : ''}>${esc(label)}</option>`).join('');
 // Tick boxes instead of a multi-select: the same on a phone and on a desktop.
 const channelPicker = (name, title, help, channels, chosen, max) => {
  const known = new Set(channels.map((c) => c.id));
  const items = [...channels.map((c) => [c.id, '# ' + c.name]), ...chosen.filter((id) => !known.has(id)).map((id) => [id, 'ID tersimpan — tidak tersedia'])];
  return `<fieldset class="f-field" data-picker="${name}" data-max="${max}"><span><b>${esc(title)}</b><small>${esc(help)} Boleh lebih dari satu, paling banyak ${max}.</small></span><div class="f-picker">${items.length ? items.map(([id, label]) => `<label><input type="checkbox" name="${name}" value="${esc(id)}" ${chosen.includes(id) ? 'checked' : ''}> ${esc(label)}</label>`).join('') : '<small>Tidak ada channel teks.</small>'}</div></fieldset>`;
 };
 const actions = (note, extra = '') => `<div class="f-form-actions"><span>✳ ${esc(note)}</span><span class="f-inline">${extra}<button class="f-primary" type="submit">SIMPAN ↗</button></span></div>`;
 const panel = (title, sub, id) => `<section class="f-panel"><div class="f-panel-head"><div><h2>${esc(title)}</h2><p>${esc(sub)}</p></div><span>✦</span></div><div id="${id}">Memuat…</div></section>`;
 const side = (title, sub, text) => `<section class="f-panel"><div class="f-panel-head"><div><h2>${esc(title)}</h2><p>${esc(sub)}</p></div><span>◇</span></div><p class="f-muted">${esc(text)}</p></section>`;

 const PAGES = {
  faq: { title: 'FAQ & cache jawaban', sub: 'Menjawab tanpa permintaan AI · khusus owner bot.', aside: ['Hemat kuota', 'Dua cara menjawab tanpa AI.', 'FAQ dicocokkan di mesin bot sendiri: tidak ada yang dikirim ke provider dan tidak ada kuota yang terpakai. Saat bot dipanggil (AI interaktif aktif), FAQ diperiksa lebih dulu. Dengan "Jawab otomatis", bot juga menjawab pertanyaan yang cocok di channel pilihan tanpa dipanggil; di sana kecocokan harus lebih ketat dan entri yang sama tidak diulang dalam 2 menit. Cache hanya berlaku untuk balasan AI interaktif pada pertanyaan yang sama persis (minimal 3 kata, tanpa gambar, bukan balasan lanjutan) dan hilang saat bot restart.'] },
  menu: { title: 'Menu pesan', sub: 'Tekan-tahan pesan → Apps · khusus owner bot.', aside: ['Cara kerja', 'Baca sebelum mengaktifkan.', 'Anggota menekan-tahan sebuah pesan (di komputer: klik kanan) lalu memilih Apps. Jawaban hanya terlihat oleh anggota itu dan memakai kuota hariannya. Teks pesan yang dipilih, yang bisa saja ditulis anggota lain, dikirim ke provider AI. Entri yang dimatikan tidak didaftarkan ke Discord. Discord mengizinkan 5 menu pesan per server, terpisah dari 100 slash command. Menu baru bisa perlu beberapa saat atau memuat ulang Discord sampai terlihat.'] },
  digest: { title: 'Koran pagi', sub: 'Berita dan fakta harian · khusus owner bot.', aside: ['Kuota & sumber', 'Baca sebelum mengaktifkan.', 'Satu edisi per hari: satu pencarian web dan satu permintaan AI, memakai kuota harian bot. Berita memerlukan kunci pencarian web (Brave atau Tavily); tanpa kunci hanya fakta yang dikirim. Berita ditulis dari cuplikan hasil pencarian, bukan dari artikel lengkap, dan fakta ditulis AI: keduanya bisa keliru. Bila bot sedang mati pada jam kirim, edisi tetap dikirim sampai 60 menit setelahnya. Isi yang panjang memerlukan batas output AI minimal 512 token (Provider & fallback).'] },
  greeting: { title: 'Sapaan multibahasa', sub: 'Tambahan untuk AI Welcome dan AI Goodbye · khusus owner bot.', aside: ['Dari mana katanya', 'Tidak dibuat oleh AI.', 'Kata sapaan, cara bacanya dan artinya diambil dari daftar di dalam bot (46 sapaan selamat datang, 25 kata perpisahan), dipilih acak, lalu ditaruh di atas pesan. Tidak ada permintaan AI tambahan. Berlaku hanya bila AI Welcome atau AI Goodbye aktif di ruang Welcome & goodbye; gaya bicaranya tetap diatur di sana.'] },
  translate: { title: 'Terjemahan otomatis', sub: 'Per channel · khusus owner bot.', aside: ['Privasi & kuota', 'Baca sebelum mengaktifkan.', 'Pesan anggota di channel yang dipilih dikirim ke provider AI tanpa persetujuan per pesan; beri tahu anggota. Pesan yang terlihat sudah dalam bahasa tujuan, pesan pendek, link, emoji dan perintah bot dilewati tanpa permintaan AI. Teks yang sama tidak diterjemahkan dua kali dalam 24 jam. Setiap terjemahan memakai kuota harian anggota yang menulis pesan. Bot memerlukan izin melihat channel dan mengirim pesan.'] },
  usage: { title: 'Laporan pemakaian AI', sub: 'Per hari, per jenis, per anggota · khusus owner bot.', aside: ['Yang dicatat', 'Hanya angka.', 'Saat aktif, bot mencatat jumlah permintaan AI yang dijawab provider: per hari (UTC, sama dengan reset kuota), per jenis fitur dan per anggota (ID). Isi pesan tidak dicatat. Catatan disimpan 45 hari. Pencarian web dan permintaan yang gagal tidak dihitung, jadi angkanya bisa sedikit di bawah kuota yang terpakai. Token hanya terisi bila provider melaporkannya.'] },
 };
 const KINDS = { reply: 'Balasan saat dipanggil', join: 'Nimbrung', gallery: 'Komentar galeri', idle: 'Sapaan saat sepi', link: 'Rangkum link', search: 'Cari berita', recap: 'Rangkum obrolan', 'menu-translate': 'Menu: terjemahkan', 'menu-explain': 'Menu: jelaskan', 'menu-fact': 'Menu: cek fakta', digest: 'Koran pagi', 'auto-translate': 'Terjemahan otomatis', aichat: '/aichat', icebreaker: 'Icebreaker harian', welcome: 'AI Welcome', goodbye: 'AI Goodbye', activity: 'Activities', builder: 'Server builder', knowledge: 'Pengetahuan', tools: 'AI tools', research: 'Riset web', ocr: 'Baca teks gambar', test: 'Uji koneksi', other: 'Lainnya' };
 const ZONES = { WIB: 'WIB', WITA: 'WITA', WIT: 'WIT' };

 function render(tab) {
  const page = PAGES[tab] || PAGES.faq;
  return `<div class="f-layout"><div>${panel(page.title, page.sub, 'aiSmart')}</div><aside>${side(...page.aside)}</aside></div>`;
 }

 /** Deterministic id for a new FAQ entry: the same question added at the same position gets the same id. */
 function entryId(question, taken) {
  let h = 2166136261;
  for (const c of question + '|' + taken.size) h = Math.imul(h ^ c.codePointAt(0), 16777619) >>> 0;
  let id = 'q' + h.toString(36).padStart(7, '0');
  while (taken.has(id)) id += '0';
  return id;
 }

 function bind(root, tab, notify) {
  const slot = root.querySelector('#aiSmart');
  if (!slot) return;
  const name = PAGES[tab] ? tab : 'faq';
  req('smart').then((data) => { if (slot.isConnected) views[name](slot, data, notify); }).catch((e) => { if (slot.isConnected) slot.textContent = e.message; });
 }

 /** Wires a form: checks the pickers, sends `body()` as PATCH smart/<section>, reports the outcome. */
 function wire(form, section, body, notify, done) {
  const picked = (name) => [...form.querySelectorAll(`input[name="${name}"]:checked`)].map((x) => x.value);
  form.onsubmit = async (e) => {
   e.preventDefault();
   for (const set of form.querySelectorAll('[data-picker]')) {
    if (picked(set.dataset.picker).length > Number(set.dataset.max)) { notify(`${set.querySelector('b').textContent}: paling banyak ${set.dataset.max} channel.`); return; }
   }
   const btn = form.querySelector('button[type=submit]');
   btn.disabled = true;
   try { const out = await req('smart/' + section, { method: 'PATCH', body: JSON.stringify(body(form.elements, picked)) }); done(out); }
   catch (err) { notify(err.message); }
   finally { btn.disabled = false; }
  };
 }

 const views = {
  faq(slot, data, notify) {
   let { faq, cache } = data.settings;
   const max = data.limits.faqEntries;
   const draw = () => {
    slot.innerHTML = `<form id="aiFaqForm" class="f-form">${toggle('enabled', 'Aktifkan FAQ', 'Saat bot dipanggil, pertanyaan yang cocok dijawab dari daftar di bawah, tanpa AI.', faq.enabled)}${toggle('autoAnswer', 'Jawab otomatis tanpa dipanggil', 'Di channel pilihan, bot menjawab pertanyaan yang cocok dengan FAQ walau tidak dipanggil.', faq.autoAnswer)}${channelPicker('channelIds', 'Channel jawab otomatis', 'Tempat bot menjawab FAQ tanpa dipanggil.', data.channels, faq.channelIds, data.limits.channels)}${actions('BERLAKU PADA PESAN BERIKUTNYA')}</form>
     <h3 class="s-head">Daftar FAQ <small>${faq.entries.length} dari ${max}</small></h3>
     <div class="s-list">${faq.entries.length ? faq.entries.map((entry) => `<div class="s-item"><div><b>${esc(entry.question)}</b><p>${esc(entry.answer)}</p></div><button type="button" class="f-outline" data-faq-remove="${esc(entry.id)}">HAPUS</button></div>`).join('') : '<p class="f-muted">Belum ada entri. Tambahkan pertanyaan yang sering muncul di server Anda.</p>'}</div>
     <form id="aiFaqAddForm" class="f-form">${row('Pertanyaan', 'Tulis seperti anggota bertanya, 3–150 karakter. Kata-kata pentingnya yang dicocokkan.', '<input name="question" type="text" minlength="3" maxlength="150" required placeholder="mis. Bagaimana cara dapat role member?">')}${row('Jawaban', 'Dikirim apa adanya, 1–800 karakter. Mention di dalamnya tidak memanggil siapa pun.', '<textarea name="answer" rows="3" maxlength="800" required></textarea>')}<div class="f-form-actions"><span>✳ LANGSUNG TERSIMPAN</span><button class="f-primary" type="submit" ${faq.entries.length >= max ? 'disabled' : ''}>TAMBAH ENTRI ↗</button></div></form>
     <h3 class="s-head">Cache jawaban</h3>
     <form id="aiCacheForm" class="f-form">${toggle('enabled', 'Aktifkan cache jawaban', 'Pertanyaan yang sama kepada AI interaktif dalam rentang waktu ini memakai jawaban sebelumnya, tanpa kuota.', cache.enabled)}${number('minutes', 'Lama cache (menit)', 'Sejak jawaban dibuat', cache.minutes, 1, 120)}${actions('BERLAKU PADA PESAN BERIKUTNYA')}</form>`;
    const saveFaq = async (next, message) => {
     try { faq = (await req('smart/faq', { method: 'PATCH', body: JSON.stringify(next) })).settings.faq; notify(message); draw(); }
     catch (err) { notify(err.message); }
    };
    wire(slot.querySelector('#aiFaqForm'), 'faq', (x, picked) => ({ enabled: x.enabled.checked, autoAnswer: x.autoAnswer.checked, channelIds: picked('channelIds'), entries: faq.entries }), notify, (out) => { faq = out.settings.faq; notify('Pengaturan FAQ disimpan.'); });
    slot.querySelector('#aiFaqAddForm').onsubmit = (e) => {
     e.preventDefault();
     const x = e.target.elements, question = x.question.value.trim(), answer = x.answer.value.trim();
     if (question.length < 3 || !answer) { notify('Isi pertanyaan (minimal 3 karakter) dan jawabannya.'); return; }
     if (faq.entries.length >= max) { notify(`FAQ paling banyak ${max} entri.`); return; }
     saveFaq({ ...faq, entries: [...faq.entries, { id: entryId(question, new Set(faq.entries.map((entry) => entry.id))), question, answer }] }, 'Entri FAQ ditambahkan.');
    };
    slot.querySelectorAll('[data-faq-remove]').forEach((button) => button.addEventListener('click', () => saveFaq({ ...faq, entries: faq.entries.filter((entry) => entry.id !== button.dataset.faqRemove) }, 'Entri FAQ dihapus.')));
    wire(slot.querySelector('#aiCacheForm'), 'cache', (x) => ({ enabled: x.enabled.checked, minutes: Number(x.minutes.value) }), notify, (out) => { cache = out.settings.cache; notify('Pengaturan cache disimpan.'); });
   };
   draw();
  },

  menu(slot, data, notify) {
   const s = data.settings.menu;
   const help = { translate: 'Menerjemahkan pesan yang dipilih ke bahasa tujuan di bawah.', explain: 'Menjelaskan maksud pesan, istilah dan bahasa gaulnya.', factCheck: data.search.configured ? 'Membandingkan klaim dengan cuplikan pencarian web dan menyebut sumbernya. Memakai 2 kuota.' : 'Kunci pencarian web belum terpasang: AI hanya meninjau klaim tanpa sumber dan mengatakannya.', recap: 'Merangkum sampai 150 pesan yang ditulis setelah pesan yang dipilih. Perlu izin membaca riwayat pesan.' };
   slot.innerHTML = `<form id="aiMenuForm" class="f-form">${data.menus.map((menu) => toggle(menu.key, `Menu "${menu.name}"`, help[menu.key], s[menu.key])).join('')}${row('Bahasa tujuan terjemahan', 'Dipakai oleh menu "Terjemahkan".', `<select name="language">${options(data.languages, s.language)}</select>`)}${actions('DIDAFTARKAN KE DISCORD SAAT DISIMPAN')}</form>`;
   wire(slot.querySelector('form'), 'menu', (x) => ({ translate: x.translate.checked, explain: x.explain.checked, factCheck: x.factCheck.checked, recap: x.recap.checked, language: x.language.value }), notify,
    (out) => notify(out.menuSync === false ? 'Tersimpan, tetapi menu belum bisa didaftarkan ke Discord. Restart bot untuk mendaftarkannya.' : out.menuSync === true ? 'Tersimpan dan menu didaftarkan ke Discord.' : 'Pengaturan menu pesan disimpan.'));
  },

  digest(slot, data, notify) {
   const s = data.settings.digest;
   slot.innerHTML = `<form id="aiDigestForm" class="f-form">${toggle('enabled', 'Aktifkan koran pagi', 'Satu kiriman per hari pada jam di bawah.', s.enabled)}${channelPicker('channelIds', 'Channel koran pagi', 'Edisi yang sama dikirim ke setiap channel yang dicentang.', data.channels, s.channelIds, data.limits.channels)}${row('Jam kirim', 'Waktu setempat sesuai zona.', `<span class="f-inline"><input name="time" type="time" value="${esc(s.time)}" required> <select name="zone">${options(ZONES, s.zone)}</select></span>`)}${toggle('news', 'Berita', data.search.configured ? 'Tiga sampai empat butir dari hasil pencarian web, dengan sumbernya.' : 'Kunci pencarian web (Brave atau Tavily) belum terpasang: berita dilewati sampai kunci dipasang.', s.news)}${toggle('fact', 'Fakta hari ini', 'Satu fakta menarik yang ditulis AI.', s.fact)}${row('Topik', 'Opsional, paling banyak 120 karakter. Kosong = berita utama Indonesia.', `<input name="topics" type="text" maxlength="120" value="${esc(s.topics)}" placeholder="mis. teknologi, game, anime">`)}${actions('BERLAKU PADA JAM KIRIM BERIKUTNYA', '<button class="f-outline" type="button" id="aiDigestTest">KIRIM TES SEKARANG</button> ')}</form>`;
   const form = slot.querySelector('form');
   wire(form, 'digest', (x, picked) => ({ enabled: x.enabled.checked, channelIds: picked('channelIds'), time: x.time.value, zone: x.zone.value, news: x.news.checked, fact: x.fact.checked, topics: x.topics.value }), notify, () => notify('Pengaturan koran pagi disimpan.'));
   const test = slot.querySelector('#aiDigestTest');
   test.addEventListener('click', async () => {
    if (!window.confirm('Kirim satu edisi sekarang ke channel yang TERSIMPAN? Ini memakai kuota AI bot.')) return;
    test.disabled = true;
    try { const out = await req('smart/digest/test', { method: 'POST', body: JSON.stringify({ confirmed: true }) }); notify(`Terkirim ke ${out.sent} channel${out.failed ? `, gagal di ${out.failed} channel (periksa izin bot)` : ''}.${out.note ? ' Catatan: ' + out.note : ''}`); }
    catch (err) { notify(err.message); }
    finally { test.disabled = false; }
   });
  },

  greeting(slot, data, notify) {
   const s = data.settings.greeting;
   slot.innerHTML = `<form id="aiGreetingForm" class="f-form">${toggle('multilingual', 'Sapaan dari berbagai bahasa', 'Satu kata sapaan acak di atas pesan AI Welcome dan AI Goodbye, lengkap dengan cara baca dan artinya. Contoh: Yōkoso! (ようこそ · bahasa Jepang, artinya “selamat datang”).', s.multilingual)}${toggle('tenure', 'Lama bergabung pada pesan perpisahan', 'Menambahkan satu baris pada AI Goodbye, misalnya "Bersama kami selama 3 bulan." Dilewati bila Discord tidak memberi tanggal bergabung.', s.tenure)}${actions('BERLAKU PADA ANGGOTA BERIKUTNYA')}</form>`;
   wire(slot.querySelector('form'), 'greeting', (x) => ({ multilingual: x.multilingual.checked, tenure: x.tenure.checked }), notify, () => notify('Pengaturan sapaan disimpan.'));
  },

  translate(slot, data, notify) {
   const s = data.settings.translate;
   slot.innerHTML = `<form id="aiTranslateForm" class="f-form">${toggle('enabled', 'Aktifkan terjemahan otomatis', 'Pesan berbahasa lain di channel pilihan dibalas dengan terjemahannya.', s.enabled)}${channelPicker('channelIds', 'Channel terjemahan', 'Tempat bot menerjemahkan pesan anggota.', data.channels, s.channelIds, data.limits.channels)}${row('Bahasa tujuan', 'Pesan yang sudah dalam bahasa ini dilewati.', `<select name="target">${options(data.languages, s.target)}</select>`)}${number('hourlyLimit', 'Batas terjemahan per jam', 'Per channel', s.hourlyLimit, 1, 120)}${actions('BERLAKU PADA PESAN BERIKUTNYA')}</form>`;
   wire(slot.querySelector('form'), 'translate', (x, picked) => ({ enabled: x.enabled.checked, channelIds: picked('channelIds'), target: x.target.value, hourlyLimit: Number(x.hourlyLimit.value) }), notify, () => notify('Pengaturan terjemahan otomatis disimpan.'));
  },

  usage(slot, data, notify) {
   let enabled = data.settings.usage.enabled;
   slot.innerHTML = `<form id="aiUsageForm" class="f-form">${toggle('enabled', 'Catat pemakaian AI', 'Mati = tidak ada yang dicatat; catatan lama tetap ada sampai kedaluwarsa (45 hari).', enabled)}${actions('BERLAKU PADA PERMINTAAN BERIKUTNYA')}</form><div class="s-report-bar"><h3 class="s-head">Laporan</h3><span class="f-inline"><button type="button" class="f-outline" data-days="7">7 HARI</button><button type="button" class="f-outline" data-days="14">14 HARI</button><button type="button" class="f-outline" data-days="30">30 HARI</button></span></div><div id="aiUsageReport" class="s-report">Memuat…</div>`;
   const report = slot.querySelector('#aiUsageReport');
   const n = (value) => Number(value || 0).toLocaleString('id-ID');
   const load = async (days) => {
    try {
     const r = await req('smart/usage?days=' + days);
     if (!report.isConnected) return;
     const peak = Math.max(1, ...r.days.map((d) => d.calls));
     const saved = r.total.cacheHits + r.total.faqHits;
     report.innerHTML = `${r.enabled ? '' : '<p class="f-muted">Pencatatan sedang mati. Angka di bawah berasal dari catatan sebelumnya, bila ada.</p>'}
      <div class="s-stats"><div><b>${n(r.total.calls)}</b><span>permintaan AI · ${days} hari</span></div><div><b>${n(saved)}</b><span>dijawab tanpa AI (FAQ ${n(r.total.faqHits)} · cache ${n(r.total.cacheHits)})</span></div><div><b>${n(r.total.tokens)}</b><span>token dilaporkan provider</span></div><div><b>${n(r.limits.guildDaily)}</b><span>batas server per hari · ${n(r.limits.perUserDaily)} per anggota</span></div></div>
      <h4>Per hari (UTC)</h4><div class="s-bars">${r.days.map((d) => `<div class="s-bar" title="${esc(d.day)}"><span>${esc(d.day.slice(5))}</span><i><em style="width:${Math.round(d.calls / peak * 100)}%"></em></i><b>${n(d.calls)}</b></div>`).join('')}</div>
      <h4>Per jenis</h4>${r.kinds.length ? `<div class="s-bars s-long">${r.kinds.map((k) => `<div class="s-bar"><span>${esc(KINDS[k.kind] || k.kind)}</span><i><em style="width:${Math.round(k.calls / Math.max(1, r.kinds[0].calls) * 100)}%"></em></i><b>${n(k.calls)}</b></div>`).join('')}</div>` : '<p class="f-muted">Belum ada catatan pada rentang ini.</p>'}
      <h4>Lima anggota teratas</h4>${r.members.length ? `<div class="s-bars s-long">${r.members.map((m) => `<div class="s-bar" title="ID ${esc(m.userId)}"><span>${esc(m.name || 'ID ' + m.userId)}</span><i><em style="width:${Math.round(m.calls / Math.max(1, r.members[0].calls) * 100)}%"></em></i><b>${n(m.calls)}</b></div>`).join('')}</div>` : '<p class="f-muted">Belum ada catatan pada rentang ini.</p>'}`;
     slot.querySelectorAll('[data-days]').forEach((button) => button.classList.toggle('active', Number(button.dataset.days) === days));
    } catch (err) { if (report.isConnected) report.textContent = err.message; }
   };
   slot.querySelectorAll('[data-days]').forEach((button) => button.addEventListener('click', () => load(Number(button.dataset.days))));
   wire(slot.querySelector('form'), 'usage', (x) => ({ enabled: x.enabled.checked }), notify, (out) => { enabled = out.settings.usage.enabled; notify(enabled ? 'Pencatatan pemakaian diaktifkan.' : 'Pencatatan pemakaian dimatikan.'); load(7); });
   load(7);
  },
 };

 window.ZentixAISmart = { render, bind };
})();
