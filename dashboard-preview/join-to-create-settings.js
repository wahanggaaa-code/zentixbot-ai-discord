/* Join to Create settings. Changes are stored by the bot's transaction protocol; nothing here touches Discord. */
(() => {
  const API = '/dashboard/api/bot/join-to-create/settings';
  const DEFAULTS = { nameTemplate: "{username}'s Room", userLimit: 0, bitrate: 64000 };
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
    return `<section class="f-panel"><div class="f-panel-head"><div><h2>Pengaturan trigger</h2>`
      + `<p>Berlaku untuk channel sementara yang dibuat setelah disimpan. Channel yang sudah ada tidak diubah.</p></div><span>✳</span></div>`
      + `<div id="jtcSettings" aria-live="polite">Memuat…</div></section>`;
  }

  function fields(values, data) {
    const guildKbps = data.limits.guildBitrate ? Math.floor(data.limits.guildBitrate / 1000) : null;
    return `<label class="f-field"><span><b>Template nama</b><small>Placeholder: ${esc(data.placeholders.join(' '))}</small></span>`
      + `<input name="nameTemplate" type="text" maxlength="${esc(data.limits.nameTemplate)}" value="${esc(values.nameTemplate)}"></label>`
      + `<label class="f-field"><span><b>Batas user</b><small>0 = tanpa batas, paling banyak 99.</small></span>`
      + `<input name="userLimit" type="number" min="0" max="99" step="1" value="${esc(values.userLimit)}"></label>`
      + `<label class="f-field"><span><b>Bitrate (kbps)</b><small>8 sampai 384.${guildKbps ? ` Server ini saat ini mengizinkan sampai ${esc(guildKbps)}; nilai lebih tinggi diturunkan saat channel dibuat.` : ''}</small></span>`
      + `<input name="bitrateKbps" type="number" min="8" max="384" step="any" value="${esc(values.bitrate / 1000)}"></label>`;
  }

  function triggerForm(trigger, index, data) {
    const name = trigger.channelName === null
      ? 'Channel tidak ada di cache bot; mungkin sudah dihapus di Discord'
      : trigger.channelName;
    const permission = trigger.botCanManage === false
      ? '<p role="alert">Bot tidak memiliki izin Manage Channels, Move Members atau Connect pada channel ini; channel sementara tidak akan dibuat.</p>'
      : '';
    return `<form class="f-form" data-trigger="${index}"><h3>${esc(name)}</h3><p class="f-muted">ID ${esc(trigger.channelId)}</p>${permission}`
      + fields(trigger, data)
      + `<div class="f-form-actions"><button type="button" class="f-outline" data-remove="${index}">LEPAS TRIGGER</button><button type="submit" class="f-primary">SIMPAN ↗</button></div></form>`;
  }

  function setupForm(data) {
    if (!data.voiceChannels.length) {
      return '<p class="f-muted">Bot tidak melihat channel suara di server ini. Buat channel suara di Discord, atau jalankan /jointocreate setup.</p>';
    }
    const options = data.voiceChannels.map((channel, index) => `<option value="${index}"${channel.usable ? '' : ' disabled'}>`
      + `${esc(channel.category ? channel.category + ' / ' : '')}${esc(channel.name)}${channel.usable ? '' : ' (izin bot kurang)'}</option>`).join('');
    return `<form class="f-form" data-setup><p class="f-muted">Join to Create belum memiliki trigger. Pilih channel suara yang sudah ada; anggota yang masuk ke channel itu mendapat channel sementara di kategori yang sama.</p>`
      + `<label class="f-field"><span><b>Channel trigger</b><small>Bot memerlukan Manage Channels, Move Members dan Connect.${data.voiceChannelsTruncated ? ' Daftar dipotong; gunakan /jointocreate setup bila channel tidak tampil.' : ''}</small></span>`
      + `<select name="channel"><option value="">Pilih channel suara</option>${options}</select></label>`
      + fields(DEFAULTS, data)
      + `<div class="f-form-actions"><span>PERUBAHAN TERSIMPAN DI DATABASE BOT</span><button type="submit" class="f-primary">AKTIFKAN JOIN TO CREATE ↗</button></div></form>`;
  }

  /** Reads the three inputs. Returns { values } or { error }. */
  function readFields(form) {
    const nameTemplate = form.elements.nameTemplate.value.trim();
    const limitText = form.elements.userLimit.value.trim();
    const kbpsText = form.elements.bitrateKbps.value.trim();
    if (!nameTemplate) return { error: 'Template nama tidak boleh kosong.' };
    if (!/^\d{1,2}$/.test(limitText)) return { error: 'Batas user harus bilangan bulat 0 sampai 99.' };
    const bitrate = Math.round(Number(kbpsText) * 1000);
    if (!/^\d{1,3}(\.\d{1,3})?$/.test(kbpsText) || bitrate < 8000 || bitrate > 384000) return { error: 'Bitrate harus 8 sampai 384 kbps.' };
    return { values: { nameTemplate, userLimit: Number(limitText), bitrate } };
  }

  function bind(root, onChanged) {
    const slot = root.querySelector('#jtcSettings');
    if (!slot) return;

    async function load(notice = '') {
      slot.textContent = 'Memuat…';
      let data;
      try {
        data = await request();
      } catch (error) {
        if (!slot.isConnected) return;
        slot.textContent = error.message;
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'f-outline';
        retry.textContent = 'COBA LAGI';
        retry.onclick = () => load();
        slot.append(retry);
        return;
      }
      if (!slot.isConnected) return;

      const busy = data.busy ? '<p role="alert">Bot sedang membuat channel sementara. Perubahan ditolak sampai selesai; coba lagi beberapa detik lagi.</p>' : '';
      slot.innerHTML = `<p id="jtcSettingsStatus" class="f-muted" role="status">${esc(notice)}</p>${busy}`
        + (data.triggers.length ? data.triggers.map((trigger, index) => triggerForm(trigger, index, data)).join('') : setupForm(data))
        + `<p><button type="button" class="f-outline" id="jtcSettingsReload">MUAT ULANG ↻</button></p>`;
      const status = slot.querySelector('#jtcSettingsStatus');
      slot.querySelector('#jtcSettingsReload').onclick = () => load();

      const lock = (locked) => slot.querySelectorAll('button,input,select').forEach((element) => { element.disabled = locked; });
      async function send(method, path, body, done) {
        lock(true);
        status.textContent = 'Menyimpan…';
        try {
          await request(method, path, body);
        } catch (error) {
          // Keep what was typed; the administrator decides whether to reload.
          lock(false);
          status.textContent = `${error.message} Bila hasilnya tidak jelas, muat ulang sebelum mencoba lagi.`;
          return;
        }
        if (onChanged) onChanged();
        await load(done);
      }

      slot.querySelectorAll('form[data-trigger]').forEach((form) => {
        const trigger = data.triggers[Number(form.dataset.trigger)];
        form.onsubmit = (event) => {
          event.preventDefault();
          const { values, error } = readFields(form);
          if (error) { status.textContent = error; return; }
          // Send only what changed, so untouched settings are never rewritten.
          const patch = {};
          for (const key of ['nameTemplate', 'userLimit', 'bitrate']) if (values[key] !== trigger[key]) patch[key] = values[key];
          if (!Object.keys(patch).length) { status.textContent = 'Tidak ada perubahan.'; return; }
          if (!confirm('Simpan pengaturan trigger ini? Berlaku untuk channel sementara berikutnya.')) return;
          send('PATCH', `/triggers/${trigger.channelId}`, { ...patch, revision: data.configRevision, confirmed: true }, 'Pengaturan disimpan.');
        };
        form.querySelector('[data-remove]').onclick = () => {
          const message = 'Lepas trigger ini? Join to Create berhenti membuat channel baru. '
            + 'Channel di Discord tidak dihapus, dan channel sementara yang masih ada tetap dihapus saat kosong.';
          if (!confirm(message)) return;
          send('DELETE', `/triggers/${trigger.channelId}`, { revision: data.configRevision, confirmed: true }, 'Trigger dilepas. Channel di Discord tidak dihapus.');
        };
      });

      const setup = slot.querySelector('form[data-setup]');
      if (setup) {
        setup.onsubmit = (event) => {
          event.preventDefault();
          const channel = data.voiceChannels[Number(setup.elements.channel.value)];
          if (setup.elements.channel.value === '' || !channel || !channel.usable) { status.textContent = 'Pilih channel suara yang dapat dikelola bot.'; return; }
          const { values, error } = readFields(setup);
          if (error) { status.textContent = error; return; }
          if (!confirm(`Jadikan "${channel.name}" trigger Join to Create?`)) return;
          send('POST', '/triggers', { ...values, channelId: channel.id, confirmed: true }, 'Join to Create diaktifkan.');
        };
      }
    }
    load();
  }

  window.ZentixJoinToCreateSettings = { render, bind };
})();
