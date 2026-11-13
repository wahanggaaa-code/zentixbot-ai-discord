/* The counting game on the logged-in dashboard. Saving here changes stored settings only; the bot acts on Discord
   later, when members write in the counting channel (it deletes a wrong count and announces the reset). */
(() => {
  const API = '/dashboard/api/bot/counting';
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const PERMISSIONS = { ViewChannel: 'View Channel', SendMessages: 'Send Messages', ManageMessages: 'Manage Messages' };
  const permissionList = (missing) => missing.map((flag) => PERMISSIONS[flag] || flag).join(', ');

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
    return `<div id="countingLive"><section class="f-panel"><div class="f-panel-head"><div><h2>Permainan hitung</h2>`
      + `<p>Anggota menulis angka berikutnya secara bergantian di satu channel. Angka yang salah dihapus dan urutan kembali ke 1.</p></div><span>✳</span></div>`
      + `<div id="countingState" aria-live="polite">Memuat…</div></section>`
      + `<section class="f-panel" style="margin-top:18px"><div class="f-panel-head"><div><h2>Pengaturan</h2>`
      + `<p>Channel dan cara menulis angka. Papan skor dan rekor tidak berubah saat pengaturan disimpan.</p></div><span>✳</span></div>`
      + `<div id="countingSetup" aria-live="polite">Memuat…</div></section>`
      + `<section class="f-panel" style="margin-top:18px"><div class="f-panel-head"><div><h2>Papan skor</h2>`
      + `<p>Sepuluh anggota dengan hitungan benar terbanyak.</p></div><span>✳</span></div>`
      + `<div id="countingBoard" aria-live="polite">Memuat…</div></section>`
      + `<div class="f-callout">ⓘ &nbsp; Setiap pesan anggota di channel hitung dinilai, termasuk obrolan biasa: pesan yang bukan angka berikutnya memutus urutan. `
      + `Anggota yang sama tidak boleh menghitung dua kali berturut-turut. Pesan sistem Discord (anggota bergabung, pin, boost) tidak dinilai.</div></div>`;
  }

  /** What the page says about the game, from the fields of the API. */
  function healthText(data) {
    const { health, game } = data;
    switch (health.state) {
      case 'none': return 'Belum pernah diatur.';
      case 'off': return 'Nonaktif. Pesan di channel tidak dinilai.';
      case 'channel_missing': return `Aktif, tetapi channel (ID ${game.channelId}) tidak terlihat oleh bot; mungkin sudah dihapus. Nonaktifkan lalu atur ulang.`;
      case 'permissions': return `Aktif, tetapi bot kekurangan izin di channel itu: ${permissionList(health.missing)}.`;
      default: return 'Aktif.';
    }
  }

  function stateView(data) {
    const { game } = data;
    const channel = game.channelId ? (game.channelName === null ? `Channel tidak terlihat (ID ${game.channelId})` : `#${game.channelName}`) : 'Belum dipilih';
    const system = data.systems.find((entry) => entry.value === game.system);
    const last = game.lastUserId ? (game.lastUserName === null ? `ID ${game.lastUserId}` : game.lastUserName) : 'Belum ada';
    const warn = ['channel_missing', 'permissions'].includes(data.health.state);
    return `<p${warn ? ' role="alert"' : ''}><b>Status:</b> ${esc(healthText(data))}</p>`
      + `<p><b>Channel:</b> ${esc(channel)} &nbsp;·&nbsp; <b>Sistem:</b> ${esc(system ? system.label : game.system)}</p>`
      + `<p><b>Angka berikutnya:</b> ${esc(game.expected)} &nbsp;·&nbsp; <b>Urutan saat ini:</b> ${esc(game.currentStreak)} &nbsp;·&nbsp; <b>Rekor:</b> ${esc(game.bestStreak)}</p>`
      + `<p><b>Penghitung terakhir:</b> ${esc(last)}</p>`
      + `<p class="f-muted">Angka di atas adalah keadaan saat halaman dimuat; permainan terus berjalan di Discord.</p>`;
  }

  function setupForm(data) {
    const { game } = data;
    if (!data.channels.length) return '<p class="f-muted">Bot tidak melihat channel teks di server ini.</p>';
    const known = data.channels.some((channel) => channel.id === game.channelId);
    const channels = data.channels.map((channel) => `<option value="${esc(channel.id)}"${channel.id === game.channelId ? ' selected' : ''}${channel.usable ? '' : ' disabled'}>`
      + `#${esc(channel.name)}${channel.usable ? '' : ` (izin bot kurang: ${esc(permissionList(channel.missing))})`}</option>`).join('');
    const systems = data.systems.map((system) => `<option value="${esc(system.value)}"${system.value === game.system ? ' selected' : ''}>${esc(system.label)}</option>`).join('');
    const moving = game.enabled ? ' Permainan sedang aktif: untuk pindah channel, nonaktifkan dulu.' : '';
    return `<form class="f-form" id="countingSetupForm">`
      + `<label class="f-field"><span><b>Channel hitung</b><small>Bot memerlukan View Channel, Send Messages, dan Manage Messages di sana.${moving}`
      + `${data.channelsTruncated ? ' Daftar dipotong; gunakan /count setup bila channel tidak tampil.' : ''}</small></span>`
      + `<select name="channelId"><option value=""${known ? '' : ' selected'}>Pilih channel</option>${channels}</select></label>`
      + `<label class="f-field"><span><b>Sistem hitung</b><small>Mengganti sistem memulai urutan dari 1 lagi.</small></span>`
      + `<select name="system">${systems}</select></label>`
      + `<p class="f-muted" id="countingSystemHint"></p>`
      + `<div class="f-form-actions"><span>MENYIMPAN PENGATURAN</span><button type="submit" class="f-primary">${game.enabled ? 'SIMPAN ↗' : 'AKTIFKAN ↗'}</button></div></form>`;
  }

  function resetForm(data) {
    return `<form class="f-form" id="countingResetForm"><h3>Mulai ulang urutan</h3>`
      + `<label class="f-field"><span><b>Mulai dari angka</b><small>1 sampai ${esc(data.limits.maxStart)}.</small></span>`
      + `<input type="number" name="start" min="1" max="${esc(data.limits.maxStart)}" step="1" value="1" required></label>`
      + `<label class="f-field"><span><b>Kosongkan papan skor</b><small>Menghapus papan skor dan rekor. Tidak dapat dikembalikan.</small></span>`
      + `<input type="checkbox" name="clearScores"></label>`
      + `<div class="f-form-actions"><button type="button" class="f-outline" id="countingDisable">NONAKTIFKAN</button>`
      + `<button type="submit" class="f-primary">MULAI ULANG ↗</button></div></form>`;
  }

  function board(data) {
    if (!data.leaderboard.length) return '<p class="f-muted">Belum ada hitungan yang tercatat.</p>';
    const rows = data.leaderboard.map((entry, index) => `<tr><td>${index + 1}</td><td>${entry.name === null ? `ID ${esc(entry.userId)}` : esc(entry.name)}</td><td>${esc(entry.counts)}</td></tr>`).join('');
    return `<div class="f-table-wrap"><table class="f-table"><thead><tr><th>#</th><th>ANGGOTA</th><th>HITUNGAN BENAR</th></tr></thead><tbody>${rows}</tbody></table></div>`
      + `<p class="f-muted">${esc(data.players)} anggota pernah menghitung dengan benar. Nama diambil dari anggota yang sedang dikenal bot; selain itu ditampilkan ID-nya.</p>`;
  }

  function bind(root) {
    const stateBox = root.querySelector('#countingState');
    const setup = root.querySelector('#countingSetup');
    const boardBox = root.querySelector('#countingBoard');
    if (!stateBox || !setup || !boardBox) return;
    const say = (text) => {
      const toast = document.getElementById('toast');
      if (!toast) return;
      toast.textContent = text;
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), 2600);
    };

    async function load(message = '') {
      stateBox.textContent = 'Memuat…';
      setup.textContent = 'Memuat…';
      boardBox.textContent = 'Memuat…';
      let data;
      try {
        data = await request();
      } catch (error) {
        if (!stateBox.isConnected) return;
        stateBox.innerHTML = `<p role="alert">${esc(error.message)}</p><button type="button" class="f-outline" id="countingRetry">COBA LAGI ↻</button>`;
        stateBox.querySelector('#countingRetry').onclick = () => load();
        setup.innerHTML = '<p class="f-muted">Tidak tersedia sampai permainan hitung dapat dibaca.</p>';
        boardBox.innerHTML = '<p class="f-muted">Tidak tersedia sampai permainan hitung dapat dibaca.</p>';
        return;
      }
      if (!stateBox.isConnected) return;

      stateBox.innerHTML = `<p id="countingStatus" class="f-muted" role="status">${esc(message)}</p>` + stateView(data)
        + '<div class="f-form-actions"><button type="button" class="f-outline" id="countingReload">MUAT ULANG ↻</button></div>';
      setup.innerHTML = '<p id="countingSetupStatus" class="f-muted" role="status"></p>' + setupForm(data) + (data.game.enabled ? resetForm(data) : '');
      boardBox.innerHTML = board(data);
      stateBox.querySelector('#countingReload').onclick = () => load();
      const setupStatus = setup.querySelector('#countingSetupStatus');

      /** Runs one change with every control locked; reloads after success, reports a failure in place. */
      async function change(run, done) {
        const controls = [...root.querySelectorAll('#countingLive button, #countingLive select, #countingLive input')];
        const locked = controls.filter((control) => !control.disabled);
        locked.forEach((control) => { control.disabled = true; });
        setupStatus.textContent = 'Memproses…';
        let result;
        try {
          result = await run();
        } catch (error) {
          if (!stateBox.isConnected) return;
          locked.forEach((control) => { control.disabled = false; });
          setupStatus.textContent = `${error.message} Bila hasilnya tidak jelas, muat ulang dan periksa sebelum mengulang.`;
          return;
        }
        if (!stateBox.isConnected) return;
        const text = done(result);
        say(text);
        load(text);
      }

      const form = setup.querySelector('#countingSetupForm');
      if (form) {
        const hint = form.querySelector('#countingSystemHint');
        const showHint = () => {
          const system = data.systems.find((entry) => entry.value === form.elements.system.value);
          hint.textContent = system ? system.description : '';
        };
        form.elements.system.onchange = showHint;
        showHint();
        form.onsubmit = (event) => {
          event.preventDefault();
          const body = { confirmed: true, revision: data.revision, channelId: form.elements.channelId.value, system: form.elements.system.value };
          if (!body.channelId) { setupStatus.textContent = 'Pilih channel terlebih dahulu.'; return; }
          const channel = data.channels.find((entry) => entry.id === body.channelId);
          const system = data.systems.find((entry) => entry.value === body.system);
          const restart = data.game.enabled && data.game.channelId === body.channelId && data.game.system === body.system ? '' : ' Urutan dimulai dari 1; papan skor dan rekor tetap.';
          if (!confirm(`Jalankan permainan hitung di #${channel?.name ?? body.channelId} dengan sistem "${system?.label ?? body.system}"?${restart} `
            + 'Setiap pesan anggota di channel itu akan dinilai, dan pesan yang salah dihapus.')) return;
          change(() => request('PUT', '', body), (result) => (result.changed ? 'Permainan hitung disimpan dan aktif.' : 'Tidak ada yang berubah; pengaturan sudah seperti itu.'));
        };
      }

      const reset = setup.querySelector('#countingResetForm');
      if (reset) {
        reset.onsubmit = (event) => {
          event.preventDefault();
          const start = Number(reset.elements.start.value);
          const clearScores = reset.elements.clearScores.checked;
          if (!Number.isInteger(start) || start < 1 || start > data.limits.maxStart) { setupStatus.textContent = `Angka awal harus antara 1 dan ${data.limits.maxStart}.`; return; }
          if (!confirm(`Mulai ulang urutan dari ${start}? Urutan yang sedang berjalan hilang.`
            + (clearScores ? ' Papan skor dan rekor DIHAPUS dan tidak dapat dikembalikan.' : ' Papan skor dan rekor tetap.'))) return;
          change(() => request('POST', '/reset', { confirmed: true, revision: data.revision, start, clearScores }),
            () => `Urutan dimulai dari ${start}.${clearScores ? ' Papan skor dan rekor dikosongkan.' : ''}`);
        };
        reset.querySelector('#countingDisable').onclick = () => {
          if (!confirm('Nonaktifkan permainan hitung? Pesan di channel itu tidak lagi dinilai. Channel, sistem, papan skor, dan rekor tetap tersimpan.')) return;
          change(() => request('POST', '/disable', { confirmed: true, revision: data.revision }),
            (result) => (result.changed ? 'Permainan hitung dinonaktifkan.' : 'Permainan hitung sudah nonaktif.'));
        };
      }
    }

    load();
  }

  window.ZentixCounting = { render, bind };
})();
