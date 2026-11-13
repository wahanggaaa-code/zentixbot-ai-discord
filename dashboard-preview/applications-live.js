/* Role applications on the logged-in dashboard: server-wide settings and the application forms. Saving here changes
   stored settings only. Submitted applications hold members' answers; they are read and decided in Discord. */
(() => {
  const API = '/dashboard/api/bot/applications';
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
    return `<div id="applicationsLive"><section class="f-panel"><div class="f-panel-head"><div><h2>Lamaran role</h2>`
      + `<p>Anggota mengisi formulir dengan <code>/apply submit</code>; pengelola menyetujui atau menolak di Discord. Lamaran yang disetujui memberi role formulirnya.</p></div><span>✳</span></div>`
      + `<div id="applicationsState" aria-live="polite">Memuat…</div></section>`
      + `<section class="f-panel" style="margin-top:18px"><div class="f-panel-head"><div><h2>Pengaturan</h2>`
      + `<p>Berlaku untuk semua formulir di server ini.</p></div><span>✳</span></div>`
      + `<div id="applicationsSettings" aria-live="polite">Memuat…</div></section>`
      + `<section class="f-panel" style="margin-top:18px"><div class="f-panel-head"><div><h2>Formulir</h2>`
      + `<p>Satu formulir untuk satu role. Menghapus formulir ikut menghapus lamaran yang masuk lewat formulir itu.</p></div><span>✳</span></div>`
      + `<div id="applicationsForms" aria-live="polite">Memuat…</div></section>`
      + `<div class="f-callout">ⓘ &nbsp; Isi lamaran (jawaban anggota) tidak ditampilkan di halaman ini. Lamaran dibaca dan diputuskan di Discord: `
      + `lewat tombol Review pada entri di channel log lamaran, atau <code>/app-admin review</code>.</div></div>`;
  }

  function stateView(data) {
    const { settings, counts, logging } = data;
    let log;
    if (!logging.channelId) log = 'Belum diatur. Lamaran baru tidak diumumkan di channel mana pun, dan role pengelola tidak mendapat tombol Review.';
    else if (logging.channelName === null) log = `Channel (ID ${logging.channelId}) tidak terlihat oleh bot; mungkin sudah dihapus.`;
    else if (!logging.channelUsable) log = `#${logging.channelName} bukan channel teks; entri log tidak dapat dikirim ke sana.`;
    else if (!logging.enabled) log = `#${logging.channelName}, tetapi logging server sedang dimatikan sehingga tidak ada yang dikirim.`;
    else if (!logging.applicationEvents) log = `#${logging.channelName}, tetapi jenis log lamaran dimatikan di pengaturan Logging sehingga tidak ada yang dikirim.`;
    else log = `#${logging.channelName}`;
    const warn = !settings.enabled || !logging.channelId || logging.channelName === null || !logging.channelUsable || !logging.enabled || !logging.applicationEvents;
    return `<p${warn ? ' role="alert"' : ''}><b>Status:</b> ${settings.enabled ? 'Aktif.' : 'Nonaktif. Anggota tidak dapat melamar.'}</p>`
      + `<p><b>Lamaran tersimpan:</b> ${esc(counts.pending)} menunggu &nbsp;·&nbsp; ${esc(counts.approved)} diterima &nbsp;·&nbsp; ${esc(counts.denied)} ditolak</p>`
      + `<p><b>Channel log lamaran:</b> ${esc(log)} Diatur di <a href="#features/logging">Logging</a> ("Channel applications").</p>`
      + `<p class="f-muted">Angka di atas adalah keadaan saat halaman dimuat.</p>`;
  }

  function settingsForm(data) {
    const { settings, limits } = data;
    const known = new Set(data.roles.map((role) => role.id));
    const roles = data.roles.map((role) => `<option value="${esc(role.id)}"${settings.managerRoles.includes(role.id) ? ' selected' : ''}>@${esc(role.name)}</option>`).join('')
      + settings.managerRoles.filter((id) => !known.has(id)).map((id) => `<option value="${esc(id)}" selected>Role tidak dikenal (ID ${esc(id)})</option>`).join('');
    return `<form class="f-form" id="applicationsSettingsForm">`
      + `<label class="f-field"><span><b>Aktifkan lamaran</b><small>Bila mati, <code>/apply submit</code> dan <code>/apply list</code> menolak; lamaran lama tetap dapat dilihat dan diputuskan.</small></span>`
      + `<input type="checkbox" name="enabled"${settings.enabled ? ' checked' : ''}></label>`
      + `<label class="f-field"><span><b>Role pengelola</b><small>Pemegang role ini dapat membaca dan memutuskan semua lamaran lewat tombol Review di channel log. `
      + `Paling banyak ${esc(limits.managerRoles)}. Tahan Ctrl atau Cmd untuk memilih lebih dari satu; kosongkan agar hanya pemilik izin Manage Server yang dapat meninjau.`
      + `${data.rolesTruncated ? ' Daftar role dipotong.' : ''}</small></span>`
      + `<select name="managerRoles" multiple size="6">${roles}</select></label>`
      + `<label class="f-field"><span><b>Masa simpan lamaran menunggu (hari)</b><small>${esc(limits.retentionMin)} sampai ${esc(limits.retentionMax)}. Lamaran yang lebih lama dari ini dihapus.</small></span>`
      + `<input type="number" name="pendingDays" min="${esc(limits.retentionMin)}" max="${esc(limits.retentionMax)}" step="1" value="${esc(settings.pendingDays)}" required></label>`
      + `<label class="f-field"><span><b>Masa simpan lamaran yang sudah diputuskan (hari)</b><small>Dihitung sejak diputuskan.</small></span>`
      + `<input type="number" name="reviewedDays" min="${esc(limits.retentionMin)}" max="${esc(limits.retentionMax)}" step="1" value="${esc(settings.reviewedDays)}" required></label>`
      + `<div class="f-form-actions"><span>MENYIMPAN PENGATURAN</span><button type="submit" class="f-primary">SIMPAN ↗</button></div></form>`;
  }

  const questionInputs = (limits, questions, firstRequired = true) => Array.from({ length: limits.questions }, (unused, index) =>
    `<label class="f-field"><span><b>Pertanyaan ${index + 1}</b><small>${index === 0 ? 'Wajib.' : 'Opsional.'} Paling banyak ${esc(limits.question)} karakter.</small></span>`
    + `<input type="text" name="q${index}" maxlength="${esc(limits.question)}" value="${esc(questions[index] ?? '')}"${index === 0 && firstRequired ? ' required' : ''}></label>`).join('');

  function formCard(data, form) {
    const role = form.roleName === null ? `Role sudah tidak ada (ID ${form.roleId})` : `@${form.roleName}`;
    const problem = form.usable ? '' : `<p role="alert"><b>Persetujuan akan ditolak:</b> ${esc(form.problem)}</p>`;
    return `<form class="f-form" data-app-form="${esc(form.roleId)}"><h3>${esc(form.name)}</h3>`
      + `<p class="f-muted">Role: ${esc(role)} &nbsp;·&nbsp; ${esc(form.pending)} menunggu, ${esc(form.stored)} tersimpan</p>${problem}`
      + `<label class="f-field"><span><b>Nama formulir</b><small>Nama yang dipilih anggota di <code>/apply submit</code>. Paling banyak ${esc(data.limits.formName)} karakter.</small></span>`
      + `<input type="text" name="name" maxlength="${esc(data.limits.formName)}" value="${esc(form.name)}" required></label>`
      + `<label class="f-field"><span><b>Dibuka</b><small>Formulir yang ditutup tidak tampil di <code>/apply list</code> dan tidak dapat diisi.</small></span>`
      + `<input type="checkbox" name="enabled"${form.enabled ? ' checked' : ''}></label>`
      + questionInputs(data.limits, form.questions)
      + `<div class="f-form-actions"><button type="button" class="f-outline" data-app-delete="${esc(form.roleId)}">HAPUS FORMULIR</button>`
      + `<button type="submit" class="f-primary">SIMPAN ↗</button></div></form>`;
  }

  function newForm(data) {
    if (data.forms.length >= data.limits.forms) return `<p class="f-muted">Batas ${esc(data.limits.forms)} formulir sudah tercapai.</p>`;
    const taken = new Set(data.forms.map((form) => form.roleId));
    const roles = data.roles.filter((role) => !taken.has(role.id)).map((role) =>
      `<option value="${esc(role.id)}"${role.offerable ? '' : ' disabled'}>@${esc(role.name)}${role.offerable ? '' : ` (${esc(role.reason)})`}</option>`).join('');
    return `<form class="f-form" id="applicationsNewForm"><h3>Formulir baru</h3>`
      + `<label class="f-field"><span><b>Role yang dilamar</b><small>Role ini diberikan saat lamaran disetujui. Hanya role yang dapat Anda berikan sendiri di Discord `
      + `(izin Manage Roles dan posisi di bawah role tertinggi Anda) dan dapat diberikan bot.${data.rolesTruncated ? ' Daftar role dipotong; gunakan /app-admin setup bila role tidak tampil.' : ''}</small></span>`
      + `<select name="roleId"><option value="" selected>Pilih role</option>${roles}</select></label>`
      + `<label class="f-field"><span><b>Nama formulir</b><small>Misalnya Moderator atau Helper.</small></span>`
      + `<input type="text" name="name" maxlength="${esc(data.limits.formName)}" required></label>`
      + questionInputs(data.limits, [])
      + `<div class="f-form-actions"><span>MEMBUAT FORMULIR</span><button type="submit" class="f-primary">BUAT ↗</button></div></form>`;
  }

  function bind(root) {
    const stateBox = root.querySelector('#applicationsState');
    const settingsBox = root.querySelector('#applicationsSettings');
    const formsBox = root.querySelector('#applicationsForms');
    if (!stateBox || !settingsBox || !formsBox) return;
    const say = (text) => {
      const toast = document.getElementById('toast');
      if (!toast) return;
      toast.textContent = text;
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), 2600);
    };

    async function load(message = '') {
      stateBox.textContent = 'Memuat…';
      settingsBox.textContent = 'Memuat…';
      formsBox.textContent = 'Memuat…';
      let data;
      try {
        data = await request();
      } catch (error) {
        if (!stateBox.isConnected) return;
        stateBox.innerHTML = `<p role="alert">${esc(error.message)}</p><button type="button" class="f-outline" id="applicationsRetry">COBA LAGI ↻</button>`;
        stateBox.querySelector('#applicationsRetry').onclick = () => load();
        settingsBox.innerHTML = '<p class="f-muted">Tidak tersedia sampai pengaturan lamaran dapat dibaca.</p>';
        formsBox.innerHTML = '<p class="f-muted">Tidak tersedia sampai pengaturan lamaran dapat dibaca.</p>';
        return;
      }
      if (!stateBox.isConnected) return;

      stateBox.innerHTML = `<p id="applicationsStatus" class="f-muted" role="status">${esc(message)}</p>` + stateView(data)
        + '<div class="f-form-actions"><button type="button" class="f-outline" id="applicationsReload">MUAT ULANG ↻</button></div>';
      settingsBox.innerHTML = '<p id="applicationsSettingsStatus" class="f-muted" role="status"></p>' + settingsForm(data);
      formsBox.innerHTML = '<p id="applicationsFormsStatus" class="f-muted" role="status"></p>'
        + (data.forms.length ? data.forms.map((form) => formCard(data, form)).join('') : '<p class="f-muted">Belum ada formulir.</p>')
        + newForm(data);
      stateBox.querySelector('#applicationsReload').onclick = () => load();

      /** Runs one change with every control locked; reloads after success, reports a failure in place. */
      async function change(status, run, done) {
        const controls = [...root.querySelectorAll('#applicationsLive button, #applicationsLive select, #applicationsLive input')];
        const locked = controls.filter((control) => !control.disabled);
        locked.forEach((control) => { control.disabled = true; });
        status.textContent = 'Memproses…';
        let result;
        try {
          result = await run();
        } catch (error) {
          if (!stateBox.isConnected) return;
          locked.forEach((control) => { control.disabled = false; });
          status.textContent = `${error.message} Bila hasilnya tidak jelas, muat ulang dan periksa sebelum mengulang.`;
          return;
        }
        if (!stateBox.isConnected) return;
        const text = done(result);
        say(text);
        load(text);
      }
      const questionsOf = (form) => Array.from({ length: data.limits.questions }, (unused, index) => form.elements[`q${index}`].value.trim()).filter(Boolean);
      const days = (value) => (/^\d{1,4}$/.test(value.trim()) ? Number(value.trim()) : NaN);

      const settingsStatus = settingsBox.querySelector('#applicationsSettingsStatus');
      const settingsFormEl = settingsBox.querySelector('#applicationsSettingsForm');
      settingsFormEl.onsubmit = (event) => {
        event.preventDefault();
        const managerRoles = [...settingsFormEl.elements.managerRoles.selectedOptions].map((option) => option.value);
        const pendingDays = days(settingsFormEl.elements.pendingDays.value);
        const reviewedDays = days(settingsFormEl.elements.reviewedDays.value);
        const inRange = (value) => Number.isInteger(value) && value >= data.limits.retentionMin && value <= data.limits.retentionMax;
        if (!inRange(pendingDays) || !inRange(reviewedDays)) { settingsStatus.textContent = `Masa simpan harus bilangan bulat ${data.limits.retentionMin} sampai ${data.limits.retentionMax} hari.`; return; }
        if (managerRoles.length > data.limits.managerRoles) { settingsStatus.textContent = `Role pengelola paling banyak ${data.limits.managerRoles}.`; return; }
        const enabled = settingsFormEl.elements.enabled.checked;
        const shorter = pendingDays < data.settings.pendingDays || reviewedDays < data.settings.reviewedDays
          ? ' Masa simpan diperpendek: lamaran yang lebih lama dari masa baru tidak lagi ditampilkan dan akan dihapus.' : '';
        if (!confirm(`Simpan pengaturan lamaran? Lamaran ${enabled ? 'AKTIF' : 'NONAKTIF'}; ${managerRoles.length} role pengelola.${shorter}`)) return;
        change(settingsStatus, () => request('PUT', '/settings', { confirmed: true, revision: data.revision, enabled, managerRoles, pendingDays, reviewedDays }),
          () => 'Pengaturan lamaran disimpan.');
      };

      const formsStatus = formsBox.querySelector('#applicationsFormsStatus');
      formsBox.querySelectorAll('[data-app-form]').forEach((formEl) => {
        const stored = data.forms.find((form) => form.roleId === formEl.dataset.appForm);
        formEl.onsubmit = (event) => {
          event.preventDefault();
          const questions = questionsOf(formEl);
          const name = formEl.elements.name.value.trim();
          if (!name) { formsStatus.textContent = 'Formulir perlu nama.'; return; }
          if (!questions.length) { formsStatus.textContent = 'Formulir perlu sedikitnya satu pertanyaan.'; return; }
          if (!confirm(`Simpan formulir "${name}"? Anggota yang sedang mengisi formulir ini harus mengulang bila pertanyaannya berubah.`)) return;
          change(formsStatus, () => request('PUT', `/forms/${stored.roleId}`, { confirmed: true, revision: data.revision, name, enabled: formEl.elements.enabled.checked, questions }),
            () => `Formulir "${name}" disimpan.`);
        };
        formEl.querySelector('[data-app-delete]').onclick = () => {
          if (!confirm(`Hapus formulir "${stored.name}"? Pertanyaan, pengaturan, dan ${stored.stored} lamaran yang masuk lewat formulir ini DIHAPUS dan tidak dapat dikembalikan. `
            + 'Role yang sudah diberikan tidak dicabut.')) return;
          change(formsStatus, () => request('POST', `/forms/${stored.roleId}/delete`, { confirmed: true, revision: data.revision }),
            (result) => `Formulir "${result.deleted.name}" dihapus bersama ${result.deleted.applications} lamaran.`);
        };
      });

      const created = formsBox.querySelector('#applicationsNewForm');
      if (created) {
        created.onsubmit = (event) => {
          event.preventDefault();
          const roleId = created.elements.roleId.value;
          const name = created.elements.name.value.trim();
          const questions = questionsOf(created);
          if (!roleId) { formsStatus.textContent = 'Pilih role terlebih dahulu.'; return; }
          if (!name) { formsStatus.textContent = 'Formulir perlu nama.'; return; }
          if (!questions.length) { formsStatus.textContent = 'Formulir perlu sedikitnya satu pertanyaan.'; return; }
          const role = data.roles.find((entry) => entry.id === roleId);
          const first = data.forms.length === 0 && !data.settings.enabled ? ' Ini formulir pertama, jadi lamaran sekaligus diaktifkan.' : '';
          if (!confirm(`Buat formulir "${name}" untuk role @${role?.name ?? roleId}? Setiap lamaran yang disetujui memberi role itu kepada pelamar.${first}`)) return;
          change(formsStatus, () => request('POST', '/forms', { confirmed: true, revision: data.revision, roleId, name, questions }),
            (result) => `Formulir "${result.form.name}" dibuat.`);
        };
      }
    }

    load();
  }

  window.ZentixApplications = { render, bind };
})();
