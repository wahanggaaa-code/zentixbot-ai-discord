/* Dashboard mode switch, shared request helper, connected overview and welcome. Other pages have their own *-live.js module. */
(() => {
  const enabled=location.pathname.startsWith('/dashboard/');
  if (enabled) document.querySelector('.demo-strip').textContent = 'TAHAP 08 / INTEGRASI AI · PERIKSA LABEL TIAP MODUL';
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const notify=text=>{const t=document.getElementById('toast');t.textContent=text;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),4000)};
  async function request(path,opts={}) {
    const session=await window.ZentixSession;
    const res=await fetch('/dashboard/api/bot/'+path,{cache:'no-store',...opts,headers:{...(opts.body?{'Content-Type':'application/json','x-csrf-token':session.csrf}:{}),...opts.headers}});
    const data=await res.json(); if(!res.ok)throw Error(data.error || 'Permintaan gagal.'); return data;
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
    const resource=root.querySelector('.resource-section'); if(resource) resource.innerHTML=`<div class="resource-top"><div><div class="resource-kicker">03 / HOSTING</div><h2>Di balik layar<span>.</span></h2><p>Statistik hosting belum terhubung.</p></div></div><div class="resource-empty"><div class="empty-symbol">↗</div><div><strong>Data hosting belum tersedia.</strong><p>Tidak ada angka yang ditampilkan sebelum koneksi Wispbyte dan pembatasan akses owner diimplementasikan.</p></div><span>STATUS / OFFLINE</span></div>`;
    async function updateHosting() {
      if (!resource?.isConnected) return;
      try {
        const d=await request('hosting'); if(!resource.isConnected)return;
        const fmt=(v,unit)=>v===null?'—':`${Number(v).toFixed(v<10?1:0)}${unit}`;
        const bytes=v=>v===null?'—':v>=1073741824?fmt(v/1073741824,' GB'):fmt(v/1048576,' MB');
        resource.innerHTML=`<div class="resource-top"><div><div class="resource-kicker">03 / HOSTING · OWNER BOT</div><h2>Di balik layar<span>.</span></h2><p>Statistik sumber hosting terhubung.</p></div></div><div class="resource-bar"><span>HOSTING / STATUS</span><span id="hostState"></span></div><div class="resource-grid">${[['CPU',fmt(d.cpuPercent,'%')],['RAM',bytes(d.memoryBytes)],['DISK',bytes(d.diskBytes)],['JARINGAN',`${bytes(d.networkInBytesPerSecond)}/s ↓ · ${bytes(d.networkOutBytesPerSecond)}/s ↑`]].map(([name,value])=>`<article class="resource-card"><div class="res-label">${name}</div><div class="res-value">${value}</div></article>`).join('')}</div><div class="resource-foot"><span>JARINGAN BERDASARKAN SELISIH SAMPEL</span><span>REFRESH / 30 DETIK</span></div>`;
        resource.querySelector('#hostState').textContent=d.status;
      } catch(e) { if(resource.isConnected){resource.innerHTML='<div class="resource-top"><div><div class="resource-kicker">03 / HOSTING</div><h2>Di balik layar<span>.</span></h2></div></div><div class="resource-empty"><div class="empty-symbol">↗</div><div><strong>Data hosting belum tersedia.</strong><p></p></div><span>STATUS / OFFLINE</span></div>';resource.querySelector('.resource-empty p').textContent=e.message;} }
    }
    updateHosting();
    if(window.ZentixHostingTimer)clearInterval(window.ZentixHostingTimer);
    window.ZentixHostingTimer=setInterval(()=>{if(resource?.isConnected)updateHosting();else clearInterval(window.ZentixHostingTimer)},30000);
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
