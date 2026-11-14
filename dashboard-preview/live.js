/* Dashboard mode switch, shared request helper, connected overview and welcome. Other pages have their own *-live.js module. */
(() => {
  const enabled=location.pathname.startsWith('/dashboard/');
  if (enabled) document.querySelector('.demo-strip').textContent = 'TAHAP 08 / INTEGRASI AI · PERIKSA LABEL TIAP MODUL';
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const notify=text=>{const t=document.getElementById('toast');t.textContent=text;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),4000)};
  async function request(path,opts={}) {
    const session=await window.ZentixSession;
    const res=await fetch('/dashboard/api/bot/'+path,{cache:'no-store',...opts,headers:{...(opts.body?{'Content-Type':'application/json','x-csrf-token':session.csrf}:{}),...opts.headers}});
    const data=await res.json(); if(!res.ok)throw Object.assign(Error(data.error || 'Permintaan gagal.'),{status:res.status}); return data;
  }

  // ---- Overview, "02 / PEMAKAIAN SISTEM": CPU, memory, network and disk of the bot's host, asked every 3 seconds.
  const USAGE_EVERY=3000, USAGE_FIRST=1000, USAGE_AFTER_ERROR=15000;
  const amount=(value,unit)=>[value>=100?String(Math.round(value)):value.toFixed(1).replace(/\.0$/,''),unit];
  const bytes=value=>value>=1073741824?amount(value/1073741824,' GB'):value>=1048576?amount(value/1048576,' MB'):value>=1024?amount(value/1024,' KB'):amount(value,' B');
  const plain=value=>value===null||value===undefined?'—':bytes(value).join('');
  const share=(part,whole)=>part===null||part===undefined||!(whole>0)?0:Math.max(0,Math.min(100,part/whole*100));
  function usage(root) {
    const box=root.querySelector('#systemUsage'); if(!box)return;
    clearTimeout(window.ZentixUsageTimer);document.removeEventListener('visibilitychange',window.ZentixUsageWake);
    const state=box.querySelector('.usage-state'), foot=box.querySelectorAll('.usage-foot span');
    const card=name=>box.querySelector(`[data-usage="${name}"]`);
    // Every value goes in as text: nothing from the server is read as HTML.
    const big=(name,pair)=>{const el=card(name)?.querySelector('.usage-value');if(!el)return;el.textContent=pair?pair[0]:'—';if(pair){const unit=document.createElement('span');unit.textContent=pair[1];el.append(unit)}};
    const sub=(name,text)=>{const el=card(name)?.querySelector('.usage-sub');if(el)el.textContent=text};
    const bar=(name,percent)=>{const el=card(name)?.querySelector('.progress i');if(el)el.style.width=`${percent}%`;card(name)?.classList.toggle('usage-high',percent>=90)};
    const flow=(index,value)=>{const row=card('network')?.querySelectorAll('.usage-net div')[index];if(!row)return;const pair=value===null?null:bytes(value);row.querySelector('b').textContent=pair?pair[0]:'—';row.querySelector('span').textContent=pair?`${pair[1]}/s`:''};
    const blank=(text,left,right)=>{for(const name of ['cpu','memory','disk']){big(name,null);sub(name,text);bar(name,0)}flow(0,null);flow(1,null);sub('network',text);foot[0].textContent=left;foot[1].textContent=right};
    const paint=d=>{
      const container=d.scope==='container';
      big('cpu',d.cpu.percent===null?null:amount(d.cpu.percent,'%'));
      sub('cpu',d.cpu.limitPercent===null?`${d.cpu.cores} INTI · TANPA BATAS`:`DARI ${d.cpu.limitPercent}%`);
      bar('cpu',share(d.cpu.percent,d.cpu.limitPercent??d.cpu.cores*100));
      big('memory',bytes(d.memory.usedBytes));
      sub('memory',`${d.memory.limited?'DARI':'RAM MESIN'} ${plain(d.memory.totalBytes)}`);
      bar('memory',share(d.memory.usedBytes,d.memory.totalBytes));
      flow(0,d.network.inBytesPerSecond);flow(1,d.network.outBytesPerSecond);
      sub('network',d.network.inBytes===null?'TIDAK TERBACA':`TOTAL ↓ ${plain(d.network.inBytes)} · ↑ ${plain(d.network.outBytes)}`);
      big('disk',d.disk.usedBytes===null?null:bytes(d.disk.usedBytes));
      sub('disk',d.disk.usedBytes===null?'MENGHITUNG…':`${d.disk.complete===false?'LEBIH DARI INI · ':''}${d.disk.limitBytes===null?'KUOTA BELUM DIISI':`DARI ${plain(d.disk.limitBytes)}`}`);
      bar('disk',share(d.disk.usedBytes,d.disk.limitBytes));
      state.textContent=d.panel?.state?`● LIVE · ${String(d.panel.state).toUpperCase()}`:'● LIVE';
      foot[0].textContent=container?'DIUKUR DI DALAM KONTAINER BOT':'DI LUAR KONTAINER: CPU & RAM MILIK PROSES BOT';
      foot[1].textContent=`REFRESH / ${USAGE_EVERY/1000} DETIK · DISK / ${d.disk.source==='panel'?'PANEL':'5 MENIT'}`;
    };
    const later=ms=>{window.ZentixUsageTimer=setTimeout(tick,ms)};
    async function tick() {
      if(!box.isConnected)return;   // another page is shown: stop asking
      if(document.hidden)return;    // nobody is looking: wait for the tab to come back (see `wake`)
      try {
        const d=await request('system-usage'); if(!box.isConnected)return;
        paint(d); later(d.cpu.percent===null?USAGE_FIRST:USAGE_EVERY);   // the first answer has no rates yet
      } catch(e) {
        if(!box.isConnected)return;
        const denied=e.status===403, gone=e.status===401;
        state.textContent=denied?'✳ KHUSUS OWNER BOT':'○ TIDAK TERSEDIA';
        blank(denied?'KHUSUS OWNER':'TIDAK TERSEDIA',e.message||'Pemakaian sistem tidak dapat dibaca.',denied||gone?'':'MENCOBA LAGI / 15 DETIK');
        if(!denied&&!gone)later(USAGE_AFTER_ERROR);
      }
    }
    const wake=window.ZentixUsageWake=()=>{if(!box.isConnected)return document.removeEventListener('visibilitychange',wake);if(!document.hidden){clearTimeout(window.ZentixUsageTimer);tick()}};
    document.addEventListener('visibilitychange',wake);
    state.textContent='✳ MEMUAT';blank('MEMUAT…','MENGAMBIL DATA DARI BOT…','');
    tick();
  }
  function welcome() {return `<div class="f-layout"><div><section class="f-panel"><div class="f-panel-head"><div><h2>Welcome terhubung</h2><p>Memuat pengaturan yang tersimpan di bot…</p></div><span>✳</span></div><div id="liveWelcome">Memuat…</div></section><div class="f-callout">ⓘ &nbsp; Autorole tidak dapat diaktifkan bersamaan dengan verification atau auto-verify.</div></div><aside><section class="f-panel"><div class="f-panel-head"><div><h2>Preview Discord</h2><p>Perkiraan tampilan dari pengaturan di formulir.</p></div><span>✳</span></div><div class="discord-demo"><div class="discord-avatar">✳</div><div class="discord-copy"><div><strong>ZentixBot</strong> <span class="discord-bot">BOT</span></div><div class="discord-embed"><b id="livePreviewTitle">🎉 Welcome!</b><p id="livePreviewMessage"></p><small id="livePreviewFooter"></small><img id="livePreviewImage" alt="Preview gambar welcome" style="display:block;max-width:100%;max-height:180px;margin-top:12px" hidden></div></div></div><div class="f-preview-action"><button type="button" id="liveTest" class="f-outline" disabled>KIRIM TES ↗</button></div><p class="f-muted">Tes menggunakan pengaturan yang sudah disimpan dan tidak melakukan ping.</p></section></aside></div>`;}
  const field=(label,help,control)=>`<label class="f-field"><span><b>${label}</b><small>${help}</small></span>${control}</label>`;
  function bindWelcome(root) {
    const slot=root.querySelector('#liveWelcome'); if(!slot)return;
    request('welcome').then(({welcome:w,channels,roles,verificationActive})=>{
      if(!slot.isConnected)return;
      if (w.roleIds?.length > 1) { slot.textContent = 'Konfigurasi memiliki lebih dari satu autorole; kelola lewat bot terlebih dahulu agar data tidak tertimpa.'; return; }
      const options=(list,selected,prefix)=>[['','Belum dipilih'],...list.map(i=>[i.id,prefix+i.name]),...(selected && !list.some(i=>i.id===selected)?[[selected,'ID tersimpan — tidak tersedia / tidak dapat dikelola']]:[])].map(([v,l])=>`<option value="${esc(v)}" ${v===selected?'selected':''}>${esc(l)}</option>`).join('');
      const embed=w.welcomeEmbed||{}; const color=Number.isInteger(embed.color)?embed.color:0x57f287;
      slot.innerHTML=`<form class="f-form" id="realWelcome">${field('Aktifkan welcome','Kirim pesan saat anggota bergabung.',`<span class="f-check"><input type="checkbox" name="enabled" ${w.enabled?'checked':''}><span class="fake-switch"></span></span>`)}${field('Channel welcome','Channel teks server.',`<select name="channelId">${options(channels,w.channelId||'','# ')}</select>`)}${field('Pesan','Variabel: {user}, {server}, {memberCount}.',`<textarea name="welcomeMessage" rows="4" maxlength="1500" required>${esc(w.welcomeMessage)}</textarea>`)}${field('Ping anggota','Mention anggota di konten pesan.',`<span class="f-check"><input type="checkbox" name="welcomePing" ${w.welcomePing?'checked':''}><span class="fake-switch"></span></span>`)}${field('URL gambar','HTTPS, opsional.',`<input name="welcomeImage" type="url" value="${esc(w.welcomeImage||'')}" maxlength="1000">`)}${field('Autorole',verificationActive?'Verification aktif; kosongkan autorole.':'Bot harus dapat mengelola role.',`<select name="roleId">${options(roles,w.roleIds?.[0]||'','@ ')}</select>`)}${field('Judul embed','Maksimum 256 karakter.',`<input name="title" maxlength="256" required value="${esc(embed.title||'🎉 Welcome!')}">`)}${field('Footer embed','Variabel welcome didukung.',`<input name="footer" maxlength="1024" value="${esc(embed.footer||'Welcome to {server}!')}">`)}${field('Warna embed','Warna dalam format heksadesimal.',`<input name="color" type="color" value="#${color.toString(16).padStart(6,'0')}">`)}<div class="f-form-actions"><span>✳ PERUBAHAN TERSIMPAN KE BOT</span><button class="f-primary" type="submit">SIMPAN ↗</button></div></form>`;
      const form=slot.querySelector('form'), test=root.querySelector('#liveTest');test.disabled=false;
      const preview=()=>{root.querySelector('#livePreviewTitle').textContent=form.elements.title.value;root.querySelector('#livePreviewMessage').textContent=form.elements.welcomeMessage.value.replaceAll('{user}','@anggota').replaceAll('{server}','Server').replaceAll('{memberCount}','100');root.querySelector('#livePreviewFooter').textContent=form.elements.footer.value.replaceAll('{server}','Server');const box=root.querySelector('.discord-embed');box.style.borderLeftColor=form.elements.color.value;const image=root.querySelector('#livePreviewImage');try{const url=new URL(form.elements.welcomeImage.value);if(url.protocol!=='https:')throw Error();image.src=url.href;image.hidden=false}catch{image.removeAttribute('src');image.hidden=true}};
      form.addEventListener('input',preview);preview();
      form.addEventListener('submit',async e=>{e.preventDefault();const x=form.elements;const b={enabled:x.enabled.checked,channelId:x.channelId.value||null,welcomeMessage:x.welcomeMessage.value,welcomePing:x.welcomePing.checked,welcomeImage:x.welcomeImage.value.trim()||null,roleIds:x.roleId.value?[x.roleId.value]:[],welcomeEmbed:{title:x.title.value,footer:x.footer.value,color:parseInt(x.color.value.slice(1),16)}};const button=form.querySelector('button');button.disabled=true;try{await request('welcome',{method:'PATCH',body:JSON.stringify(b)});notify('Pengaturan welcome berhasil disimpan.')}catch(err){notify(err.message)}finally{button.disabled=false}});
      test.addEventListener('click',async()=>{if(!confirm('Kirim pesan tes ke channel welcome yang sudah disimpan? Tes menggunakan akunmu dan tidak melakukan ping.'))return;test.disabled=true;try{await request('welcome/test',{method:'POST',body:JSON.stringify({confirmed:true})});notify('Pesan tes berhasil dikirim.')}catch(err){notify(err.message)}finally{test.disabled=false}});
    }).catch(e=>{if(slot.isConnected)slot.textContent=e.message});
  }
  function afterRender(root,page) {
    if(!enabled || page!=='overview')return;
    usage(root);
    const label=root.querySelector('.small-badge');if(label)label.textContent='✳ MEMUAT STATUS';
    const lamp=root.querySelector('.lamp');if(lamp)lamp.textContent='● MEMUAT';
    const status=root.querySelector('.card-bottomline strong');if(status)status.textContent=' / MEMUAT';
    request('overview').then(data=>{
      if(!root.querySelector('.metrics'))return;
      const values=root.querySelectorAll('.metric strong');
      const duration=ms=>{let n=Math.floor(ms/60000);return `${Math.floor(n/60)}j ${n%60}m`};
      [data.online?'ONLINE':'OFFLINE', data.guild.memberCount??'—',data.ping===null?'—':data.ping,data.uptime===null?'—':duration(data.uptime)].forEach((v,i)=>{if(values[i])values[i].textContent=v});
      if(label)label.textContent='✳ DATA BOT';if(lamp)lamp.textContent=data.online?'● ONLINE':'○ OFFLINE';
      if(status)status.textContent=` / ${data.online?'ONLINE':'OFFLINE'} · DB ${data.database==='connected'?'TERHUBUNG':'TIDAK TERSEDIA'}`;
    }).catch(()=>{if(label)label.textContent='✳ STATUS TIDAK TERSEDIA';if(lamp)lamp.textContent='○ TIDAK TERSEDIA';if(status)status.textContent=' / TIDAK TERSEDIA';});
  }
  window.ZentixLive={enabled,welcome,bindWelcome,afterRender};
})();
