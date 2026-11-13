/* Server stats counters on the logged-in dashboard. Unlike most settings pages this one acts on Discord:
   creating a counter creates a channel, deleting a counter deletes its channel. */
(() => {
  const API = '/dashboard/api/bot/server-stats';
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const TYPE_NAMES = { members: 'Anggota + bot', members_only: 'Anggota saja', bots: 'Bot saja' };
  const KIND_NAMES = { voice: 'Channel suara', text: 'Channel teks' };
  const typeName = (type) => TYPE_NAMES[type] || `Jenis tidak dikenal (${type})`;
  const clock = (ms) => new Date(ms).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });

  async function request(method = 'GET', path = '', body) {
    const session = await window.ZentixSession;
    const response = await fetch(API + path, {
      method,
      cache: 'no-store',
      headers: body ? { 'Content-Type': 'application/json', 'x-csrf-token': session.csrf } : {},
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await response.json();
    if (!response.ok) throw Error(data.error || 'Permintaan gagal.');
    return data;
  }

  function render() {
    return `<div id="serverStatsLive"><section class="f-panel"><div class="f-panel-head"><div><h2>Counter aktif</h2>`
      + `<p>Channel yang namanya mengikuti jumlah anggota. Paling banyak satu counter per jenis.</p></div><span>✳</span></div>`
      + `<div id="serverStatsList" aria-live="polite">Memuat…</div></section>`
      + `<section class="f-panel" style="margin-top:18px"><div class="f-panel-head"><div><h2>Buat counter</h2>`
      + `<p>Membuat channel baru di Discord, di kategori yang dipilih.</p></div><span>✳</span></div>`
      + `<div id="serverStatsCreate" aria-live="polite">Memuat…</div></section>`
      + `<div class="f-callout">ⓘ &nbsp; Discord membatasi seberapa sering nama channel boleh diganti, jadi angka pada nama channel dapat tertinggal beberapa menit dari jumlah sebenarnya. `
      + `Channel counter memakai izin kategorinya: kunci kategori bila anggota tidak boleh masuk atau menulis di sana.</div></div>`;
  }

  /** What the page says about one counter, from the fields of the API. */
  function statusText(counter) {
    if (!counter.known) return 'Jenis tidak dikenal; tidak diperbarui';
    if (counter.channelName === null) return 'Channel tidak terlihat oleh bot; mungkin sudah dihapus di Discord';
    if (!counter.enabled) return 'Nonaktif';
    if (counter.botCanManage === false) return 'Bot tidak dapat mengganti nama channel ini (perlu View Channel dan Manage Channels)';
    if (counter.count === null) return 'Daftar anggota belum dapat dibaca';
    if (counter.current) return 'Sesuai jumlah saat ini';
    if (counter.nextRenameAt) return `Menunggu batas ganti nama Discord, sekitar pukul ${clock(counter.nextRenameAt)}`;
    return 'Nama akan diperbarui pada penyegaran berikutnya';
  }

  function refreshText(refresh) {
    switch (refresh?.status) {
      case 'renamed': case 'current': return 'Nama channel sudah mengikuti.';
      case 'deferred': return `Nama channel menyusul setelah batas ganti nama Discord${refresh.retryAt ? `, sekitar pukul ${clock(refresh.retryAt)}` : ''}.`;
      case 'pending': case 'slow': return 'Discord menahan pergantian nama; nama channel menyusul.';
      case 'no_permission': return 'Bot tidak dapat mengganti nama channel itu (perlu View Channel dan Manage Channels).';
      case 'count_unknown': return 'Daftar anggota belum dapat dibaca; nama channel belum diganti.';
      case 'missing': return 'Channel itu sudah tidak ada di Discord.';
      default: return 'Nama channel belum dapat diganti; akan dicoba lagi pada penyegaran berikutnya.';
    }
  }

  function counterForm(counter, index, data) {
    const free = data.types.filter((type) => !type.taken || type.id === counter.type);
    const options = (counter.known ? [] : [`<option value="${esc(counter.type)}" selected>${esc(typeName(counter.type))}</option>`])
      .concat(free.map((type) => `<option value="${esc(type.id)}"${type.id === counter.type ? ' selected' : ''}>${esc(typeName(type.id))}</option>`)).join('');
    const name = counter.channelName === null ? 'Channel tidak terlihat' : counter.channelName;
    return `<form class="f-form" data-counter="${index}"><h3>${esc(name)}</h3>`
      + `<p class="f-muted">${esc(KIND_NAMES[counter.channelType] || 'Jenis channel tidak diketahui')} · ID counter ${esc(counter.id)} · ID channel ${esc(counter.channelId)}</p>`
      + `<p><b>Jumlah saat ini:</b> ${counter.count === null ? 'tidak diketahui' : esc(counter.count)} &nbsp;·&nbsp; <b>Status:</b> ${esc(statusText(counter))}</p>`
      + `<label class="f-field"><span><b>Jenis hitungan</b><small>Jenis yang sudah dipakai counter lain tidak ditawarkan.</small></span><select name="type">${options}</select></label>`
      + `<div class="f-form-actions"><button type="button" class="f-outline" data-delete="${index}">HAPUS COUNTER & CHANNEL</button>`
      + `<button type="submit" class="f-primary">UBAH JENIS ↗</button></div></form>`;
  }

  function createForm(data) {
    const free = data.types.filter((type) => !type.taken);
    if (!free.length) return '<p class="f-muted">Semua jenis counter sudah dipakai. Hapus salah satu untuk membuat yang baru.</p>';
    if (!data.categories.length) return '<p class="f-muted">Bot tidak melihat kategori di server ini. Buat kategori di Discord terlebih dahulu.</p>';
    const categories = data.categories.map((category) => `<option value="${esc(category.id)}"${category.usable ? '' : ' disabled'}>`
      + `${esc(category.name)}${category.usable ? '' : ' (izin bot kurang)'}</option>`).join('');
    return `<form class="f-form" id="serverStatsCreateForm">`
      + `<label class="f-field"><span><b>Jenis hitungan</b><small>Apa yang dihitung pada nama channel.</small></span>`
      + `<select name="type">${free.map((type) => `<option value="${esc(type.id)}">${esc(typeName(type.id))}</option>`).join('')}</select></label>`
      + `<label class="f-field"><span><b>Jenis channel</b><small>Channel suara disarankan: namanya tampil apa adanya.</small></span>`
      + `<select name="channelType"><option value="voice">${KIND_NAMES.voice}</option><option value="text">${KIND_NAMES.text}</option></select></label>`
      + `<label class="f-field"><span><b>Kategori</b><small>Bot memerlukan View Channel dan Manage Channels di kategori itu.${data.categoriesTruncated ? ' Daftar dipotong; gunakan /serverstats create bila kategori tidak tampil.' : ''}</small></span>`
      + `<select name="categoryId"><option value="">Pilih kategori</option>${categories}</select></label>`
      + `<div class="f-form-actions"><span>MEMBUAT CHANNEL DI DISCORD</span><button type="submit" class="f-primary">BUAT COUNTER ↗</button></div></form>`;
  }

  function bind(root) {
    const list = root.querySelector('#serverStatsList');
    const create = root.querySelector('#serverStatsCreate');
    if (!list || !create) return;
    const say = (text) => {
      const toast = document.getElementById('toast');
      if (!toast) return;
      toast.textContent = text;
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), 2600);
    };

    async function load(message = '') {
      list.textContent = 'Memuat…';
      create.textContent = 'Memuat…';
      let data;
      try {
        data = await request();
      } catch (error) {
        if (!list.isConnected) return;
        list.innerHTML = `<p role="alert">${esc(error.message)}</p><button type="button" class="f-outline" id="serverStatsRetry">COBA LAGI ↻</button>`;
        list.querySelector('#serverStatsRetry').onclick = () => load();
        create.innerHTML = '<p class="f-muted">Tidak tersedia sampai daftar counter dapat dibaca.</p>';
        return;
      }
      if (!list.isConnected) return;

      const note = `<p id="serverStatsStatus" class="f-muted" role="status">${esc(message)}</p>`;
      const rejected = data.rejected > 0 ? `<p role="alert">${esc(data.rejected)} entri tersimpan tidak dapat dibaca dan tidak ditampilkan.</p>` : '';
      list.innerHTML = note + rejected + (data.counters.length
        ? data.counters.map((counter, index) => counterForm(counter, index, data)).join('')
        : '<p class="f-muted">Belum ada counter.</p>')
        + '<div class="f-form-actions"><button type="button" class="f-outline" id="serverStatsReload">MUAT ULANG ↻</button></div>';
      create.innerHTML = '<p id="serverStatsCreateStatus" class="f-muted" role="status"></p>' + createForm(data);
      list.querySelector('#serverStatsReload').onclick = () => load();
      const status = list.querySelector('#serverStatsStatus');
      const createStatus = create.querySelector('#serverStatsCreateStatus');

      /** Runs one change with every control locked; reloads after success, reports a failure in place. */
      async function change(where, run, done) {
        const controls = [...root.querySelectorAll('#serverStatsLive button, #serverStatsLive select')];
        controls.forEach((control) => { control.disabled = true; });
        where.textContent = 'Memproses…';
        let result;
        try {
          result = await run();
        } catch (error) {
          if (!list.isConnected) return;
          controls.forEach((control) => { control.disabled = false; });
          where.textContent = `${error.message} Bila hasilnya tidak jelas, muat ulang dan periksa sebelum mengulang.`;
          return;
        }
        if (!list.isConnected) return;
        const text = done(result);
        say(text);
        load(text);
      }

      list.querySelectorAll('form[data-counter]').forEach((form) => {
        const counter = data.counters[Number(form.dataset.counter)];
        form.onsubmit = (event) => {
          event.preventDefault();
          const type = form.elements.type.value;
          if (type === counter.type) { status.textContent = 'Jenis tidak berubah.'; return; }
          if (!confirm(`Ubah counter ${counter.channelName ?? counter.id} menjadi "${typeName(type)}"? Nama channel di Discord akan ikut berubah.`)) return;
          change(status, () => request('PATCH', '/counters/' + encodeURIComponent(counter.id), { confirmed: true, revision: data.revision, type }),
            (result) => `Jenis counter diubah. ${refreshText(result.refresh)}`);
        };
        form.querySelector('[data-delete]').onclick = () => {
          const target = counter.channelName === null ? 'Channel-nya tidak terlihat oleh bot; hanya catatan counter yang dihapus bila channel memang sudah tidak ada.'
            : `Channel "${counter.channelName}" DIHAPUS dari Discord dan tidak dapat dikembalikan.`;
          if (!confirm(`Hapus counter ${counter.id}? ${target}`)) return;
          change(status, () => request('DELETE', '/counters/' + encodeURIComponent(counter.id), { confirmed: true, revision: data.revision }),
            (result) => (result.channelDeleted ? 'Counter dan channel-nya dihapus.' : result.channelKept
              ? 'Counter dihapus. Channel-nya bukan channel suara atau teks, jadi tidak dihapus.' : 'Counter dihapus. Channel-nya sudah tidak ada.'));
        };
      });

      const form = create.querySelector('#serverStatsCreateForm');
      if (form) {
        form.onsubmit = (event) => {
          event.preventDefault();
          const body = { confirmed: true, type: form.elements.type.value, channelType: form.elements.channelType.value, categoryId: form.elements.categoryId.value };
          if (!body.categoryId) { createStatus.textContent = 'Pilih kategori terlebih dahulu.'; return; }
          const category = data.categories.find((entry) => entry.id === body.categoryId);
          if (!confirm(`Buat ${KIND_NAMES[body.channelType].toLowerCase()} baru di kategori "${category?.name ?? body.categoryId}" untuk counter "${typeName(body.type)}"?`)) return;
          change(createStatus, () => request('POST', '/counters', body),
            (result) => `Counter dibuat: channel "${result.channelName}".${result.count === null ? ' Angkanya ditambahkan setelah daftar anggota terbaca.' : ''}`);
        };
      }
    }

    load();
  }

  window.ZentixServerStats = { render, bind };
})();
