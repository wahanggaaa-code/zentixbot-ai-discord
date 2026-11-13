/* Reaction role panels on the logged-in dashboard. This page acts on Discord: creating or reposting a panel
   sends a message, changing it edits that message, deleting it deletes the message. */
(() => {
  const API = '/dashboard/api/bot/reaction-roles';
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const STATUS = {
    ok: 'Aktif di Discord',
    message_missing: 'Pesan panel sudah dihapus di Discord — pasang ulang untuk memakainya lagi',
    channel_missing: 'Channel panel sudah tidak ada — hapus panel ini lalu buat panel baru',
    unknown: 'Belum dapat diperiksa di Discord saat ini',
  };
  /** What happened to the posted message after a stored change, from the `message` field of the API. */
  const REDRAW = {
    updated: 'Pesan panel di Discord sudah mengikuti.',
    missing: 'Tersimpan, tetapi pesan panelnya sudah tidak ada di Discord. Pasang ulang panel.',
    channel_missing: 'Tersimpan, tetapi channel panelnya sudah tidak ada.',
    no_roles: 'Tersimpan, tetapi tidak ada lagi role panel yang masih ada di server, jadi pesannya tidak diubah.',
  };
  const redrawText = (state) => REDRAW[state] || 'Tersimpan, tetapi pesan panel belum dapat diperbarui. Tekan SEGARKAN PESAN untuk mencoba lagi.';
  /** Only a Discord message link is turned into a link. */
  const messageLink = (url) => (typeof url === 'string' && /^https:\/\/discord\.com\/channels\/\d+\/\d+\/\d+$/.test(url)
    ? ` · <a href="${esc(url)}" target="_blank" rel="noopener noreferrer">buka pesan ↗</a>` : '');

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
    return `<div id="reactRolesLive"><section class="f-panel"><div class="f-panel-head"><div><h2>Panel tersimpan</h2>`
      + `<p>Pesan berisi menu pilihan; anggota memilih sendiri role-nya di sana.</p></div><span>✳</span></div>`
      + `<div id="reactRolesList" aria-live="polite">Memuat…</div></section>`
      + `<section class="f-panel" style="margin-top:18px"><div class="f-panel-head"><div><h2>Buat panel</h2>`
      + `<p>Mengirim pesan baru ke channel yang dipilih.</p></div><span>✳</span></div>`
      + `<div id="reactRolesCreate" aria-live="polite">Memuat…</div></section>`
      + `<div class="f-callout">ⓘ &nbsp; Setiap kali anggota mengirim pilihan di menu, role panel yang tidak dipilih dilepas dari anggota itu. `
      + `Role dengan izin pengelolaan server, moderasi, atau mention @everyone, role milik bot/integrasi, dan role yang tidak berada di bawah role tertinggi bot tidak dapat ditawarkan.</div></div>`;
  }

  const roleName = (role) => (role.name === null ? `Role terhapus (${role.id})` : role.name);

  function panelBlock(panel, index, data) {
    const onPanel = new Set(panel.roles.map((role) => role.id));
    const free = data.roles.filter((role) => role.usable && !onPanel.has(role.id));
    const place = panel.channelName === null ? 'Channel tidak terlihat oleh bot' : `#${panel.channelName}`;
    const roles = panel.roles.map((role) => `<li style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:6px 0">`
      + `<span><b>${esc(roleName(role))}</b>${role.ok ? '' : ` <small role="note">⚠ Tidak dapat diberikan: ${esc(role.reason)}</small>`}</span>`
      + `<button type="button" class="f-outline" data-remove="${esc(role.id)}"${panel.roles.length < 2 ? ' disabled title="Role terakhir tidak dapat dilepas; hapus panelnya."' : ''}>LEPAS</button></li>`).join('');
    const add = panel.roles.length >= data.limits.roles ? `<p class="f-muted">Panel sudah memuat ${esc(data.limits.roles)} role (batas maksimum).</p>`
      : free.length ? `<form class="f-form" data-add="${index}"><label class="f-field"><span><b>Tambah role</b><small>Hanya role yang boleh ditawarkan dan belum ada di panel ini.</small></span>`
        + `<select name="roleId"><option value="">Pilih role</option>${free.map((role) => `<option value="${esc(role.id)}">${esc(role.name)}</option>`).join('')}</select></label>`
        + `<div class="f-form-actions"><span>MENGUBAH PESAN DI DISCORD</span><button type="submit" class="f-primary">TAMBAH ROLE ↗</button></div></form>`
        : '<p class="f-muted">Tidak ada role lain yang boleh ditawarkan.</p>';
    return `<div data-panel="${index}" style="padding:18px 0;border-bottom:1px solid var(--softline)"><h3>${esc(panel.title ?? 'Panel tanpa judul')}</h3>`
      + `<p class="f-muted">${esc(place)} · ID pesan ${esc(panel.messageId)}${messageLink(panel.url)}</p>`
      + `<p><b>Status:</b> ${esc(STATUS[panel.status] || STATUS.unknown)}</p>`
      + `<form class="f-form" data-text="${index}">`
      + `<label class="f-field"><span><b>Judul</b><small>Paling banyak ${esc(data.limits.title)} karakter.</small></span><input name="title" maxlength="${esc(data.limits.title)}" value="${esc(panel.title ?? '')}"></label>`
      + `<label class="f-field"><span><b>Deskripsi</b><small>Paling banyak ${esc(data.limits.description)} karakter.</small></span><textarea name="description" maxlength="${esc(data.limits.description)}">${esc(panel.description ?? '')}</textarea></label>`
      + `<div class="f-form-actions"><span>MENGUBAH PESAN DI DISCORD</span><button type="submit" class="f-primary">SIMPAN TEKS ↗</button></div></form>`
      + `<p><b>Role di panel (${esc(panel.roles.length)} / ${esc(data.limits.roles)})</b></p><ul style="list-style:none;margin:0;padding:0">${roles}</ul>${add}`
      + `<div class="f-form-actions"><span></span><span>`
      + (panel.status === 'message_missing' ? `<button type="button" class="f-outline" data-repost="${index}">PASANG ULANG ↗</button> ` : '')
      + (panel.status === 'ok' ? `<button type="button" class="f-outline" data-refresh="${index}">SEGARKAN PESAN ↻</button> ` : '')
      + `<button type="button" class="f-outline" data-delete="${index}">HAPUS PANEL</button></span></div></div>`;
  }

  function createForm(data) {
    if (data.panels.length >= data.limits.panels) return `<p class="f-muted">Server ini sudah memiliki ${esc(data.limits.panels)} panel (batas maksimum). Hapus satu panel untuk membuat yang baru.</p>`;
    if (!data.channels.length) return '<p class="f-muted">Bot tidak melihat channel teks di server ini.</p>';
    const usable = data.roles.filter((role) => role.usable);
    if (!usable.length) return '<p class="f-muted">Belum ada role yang boleh ditawarkan. Buat role biasa di Discord dan letakkan di bawah role bot.</p>';
    const channels = data.channels.map((channel) => `<option value="${esc(channel.id)}"${channel.usable ? '' : ' disabled'}>#${esc(channel.name)}${channel.usable ? '' : ' (izin bot kurang)'}</option>`).join('');
    const boxes = data.roles.map((role) => `<label style="display:block;padding:4px 0"><input type="checkbox" name="roleIds" value="${esc(role.id)}"${role.usable ? '' : ' disabled'}> `
      + `${esc(role.name)}${role.usable ? '' : ` <small>— ${esc(role.reason)}</small>`}</label>`).join('');
    return `<form class="f-form" id="reactRolesCreateForm">`
      + `<label class="f-field"><span><b>Channel</b><small>Bot memerlukan View Channel, Send Messages, dan Embed Links di sana.${data.channelsTruncated ? ' Daftar dipotong; gunakan /reactroles setup bila channel tidak tampil.' : ''}</small></span>`
      + `<select name="channelId"><option value="">Pilih channel</option>${channels}</select></label>`
      + `<label class="f-field"><span><b>Judul</b><small>Paling banyak ${esc(data.limits.title)} karakter.</small></span><input name="title" maxlength="${esc(data.limits.title)}"></label>`
      + `<label class="f-field"><span><b>Deskripsi</b><small>Paling banyak ${esc(data.limits.description)} karakter.</small></span><textarea name="description" maxlength="${esc(data.limits.description)}"></textarea></label>`
      + `<div class="f-field"><span><b>Role yang ditawarkan</b><small>Pilih 1 sampai ${esc(data.limits.roles)} role.${data.rolesTruncated ? ' Daftar role dipotong.' : ''}</small></span>`
      + `<div style="max-height:260px;overflow:auto">${boxes}</div></div>`
      + `<div class="f-form-actions"><span>MENGIRIM PESAN KE DISCORD</span><button type="submit" class="f-primary">BUAT PANEL ↗</button></div></form>`;
  }

  function bind(root) {
    const list = root.querySelector('#reactRolesList');
    const create = root.querySelector('#reactRolesCreate');
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
        list.innerHTML = `<p role="alert">${esc(error.message)}</p><button type="button" class="f-outline" id="reactRolesRetry">COBA LAGI ↻</button>`;
        list.querySelector('#reactRolesRetry').onclick = () => load();
        create.innerHTML = '<p class="f-muted">Tidak tersedia sampai daftar panel dapat dibaca.</p>';
        return;
      }
      if (!list.isConnected) return;

      const note = `<p id="reactRolesStatus" class="f-muted" role="status">${esc(message)}</p>`;
      const rejected = data.rejected > 0 ? `<p role="alert">${esc(data.rejected)} catatan panel tersimpan tidak dapat dibaca dan tidak ditampilkan.</p>` : '';
      list.innerHTML = note + rejected + (data.panels.length
        ? data.panels.map((panel, index) => panelBlock(panel, index, data)).join('')
        : '<p class="f-muted">Belum ada panel.</p>')
        + '<div class="f-form-actions"><button type="button" class="f-outline" id="reactRolesReload">MUAT ULANG ↻</button></div>';
      create.innerHTML = '<p id="reactRolesCreateStatus" class="f-muted" role="status"></p>' + createForm(data);
      list.querySelector('#reactRolesReload').onclick = () => load();
      const status = list.querySelector('#reactRolesStatus');
      const createStatus = create.querySelector('#reactRolesCreateStatus');

      /** Runs one change with every control locked; reloads after success, reports a failure in place. */
      async function change(where, run, done) {
        const controls = [...root.querySelectorAll('#reactRolesLive button, #reactRolesLive select, #reactRolesLive input, #reactRolesLive textarea')].filter((control) => !control.disabled);
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

      list.querySelectorAll('[data-panel]').forEach((block) => {
        const panel = data.panels[Number(block.dataset.panel)];
        const path = '/panels/' + encodeURIComponent(panel.messageId);
        const label = panel.title ?? panel.messageId;

        const text = block.querySelector('form[data-text]');
        text.onsubmit = (event) => {
          event.preventDefault();
          const title = text.elements.title.value.trim();
          const description = text.elements.description.value.trim();
          if (!title || !description) { status.textContent = 'Judul dan deskripsi wajib diisi.'; return; }
          if (title === (panel.title ?? '') && description === (panel.description ?? '')) { status.textContent = 'Teks tidak berubah.'; return; }
          if (!confirm(`Ubah judul dan deskripsi panel "${label}"? Pesannya di Discord ikut diubah.`)) return;
          change(status, () => request('PATCH', path, { confirmed: true, revision: panel.revision, title, description }),
            (result) => `Teks panel disimpan. ${redrawText(result.message)}`);
        };

        const add = block.querySelector('form[data-add]');
        if (add) {
          add.onsubmit = (event) => {
            event.preventDefault();
            const roleId = add.elements.roleId.value;
            if (!roleId) { status.textContent = 'Pilih role terlebih dahulu.'; return; }
            const role = data.roles.find((entry) => entry.id === roleId);
            if (!confirm(`Tambahkan role "${role?.name ?? roleId}" ke panel "${label}"? Semua anggota yang melihat panel dapat mengambil role itu sendiri.`)) return;
            change(status, () => request('POST', path + '/roles', { confirmed: true, revision: panel.revision, roleId }),
              (result) => `Role ditambahkan. ${redrawText(result.message)}`);
          };
        }

        block.querySelectorAll('[data-remove]').forEach((button) => {
          button.onclick = () => {
            const role = panel.roles.find((entry) => entry.id === button.dataset.remove);
            if (!confirm(`Lepas role "${roleName(role)}" dari panel "${label}"? Anggota yang sudah memilikinya tetap memilikinya.`)) return;
            change(status, () => request('DELETE', path + '/roles/' + encodeURIComponent(role.id), { confirmed: true, revision: panel.revision }),
              (result) => `Role dilepas dari panel. ${redrawText(result.message)}`);
          };
        });

        const repost = block.querySelector('[data-repost]');
        if (repost) {
          repost.onclick = () => {
            if (!confirm(`Pasang ulang panel "${label}"? Pesan baru dikirim ke ${panel.channelName === null ? 'channel panel' : '#' + panel.channelName}.`)) return;
            change(status, () => request('POST', path + '/repost', { confirmed: true }), () => 'Panel dipasang ulang sebagai pesan baru.');
          };
        }
        const refresh = block.querySelector('[data-refresh]');
        if (refresh) {
          refresh.onclick = () => {
            if (!confirm(`Gambar ulang pesan panel "${label}" di Discord dari data tersimpan?`)) return;
            change(status, () => request('POST', path + '/refresh', { confirmed: true }),
              (result) => (result.message === 'updated' ? 'Pesan panel digambar ulang.' : redrawText(result.message)));
          };
        }
        block.querySelector('[data-delete]').onclick = () => {
          const target = panel.status === 'ok' ? 'Pesannya DIHAPUS dari Discord dan tidak dapat dikembalikan.'
            : 'Pesannya tidak ditemukan; hanya catatan panel yang dihapus bila pesan memang sudah tidak ada.';
          if (!confirm(`Hapus panel "${label}"? ${target} Role yang sudah dimiliki anggota tidak dicabut.`)) return;
          change(status, () => request('DELETE', path, { confirmed: true, revision: panel.revision }),
            (result) => (result.messageDeleted ? 'Panel dan pesannya dihapus.' : 'Panel dihapus. Pesannya sudah tidak ada.'));
        };
      });

      const form = create.querySelector('#reactRolesCreateForm');
      if (form) {
        form.onsubmit = (event) => {
          event.preventDefault();
          const body = {
            confirmed: true,
            channelId: form.elements.channelId.value,
            title: form.elements.title.value.trim(),
            description: form.elements.description.value.trim(),
            roleIds: [...form.querySelectorAll('input[name="roleIds"]:checked')].map((box) => box.value),
          };
          if (!body.channelId) { createStatus.textContent = 'Pilih channel terlebih dahulu.'; return; }
          if (!body.title || !body.description) { createStatus.textContent = 'Judul dan deskripsi wajib diisi.'; return; }
          if (!body.roleIds.length) { createStatus.textContent = 'Pilih minimal satu role.'; return; }
          if (body.roleIds.length > data.limits.roles) { createStatus.textContent = `Paling banyak ${data.limits.roles} role.`; return; }
          const channel = data.channels.find((entry) => entry.id === body.channelId);
          const names = body.roleIds.map((id) => data.roles.find((entry) => entry.id === id)?.name ?? id).join(', ');
          if (!confirm(`Kirim panel "${body.title}" ke #${channel?.name ?? body.channelId}? Semua anggota yang melihatnya dapat mengambil sendiri role: ${names}.`)) return;
          change(createStatus, () => request('POST', '/panels', body), () => 'Panel dibuat dan dikirim ke Discord.');
        };
      }
    }

    load();
  }

  window.ZentixReactRoles = { render, bind };
})();
