/* Integrated bot settings. Other screens retain their simulation warning. */
(() => {
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const field=(l,h,c)=>`<label class="f-field"><span><b>${esc(l)}</b><small>${esc(h)}</small></span>${c}</label>`;
 const toggle=(name,label,val)=>field(label,'',`<span class="f-check"><input type="checkbox" name="${name}" ${val?'checked':''}><span class="fake-switch"></span></span>`);
 const text=(name,label,value,max=2000)=>field(label,'',`<input name="${name}" maxlength="${max}" value="${esc(value||'')}">`);
 const area=(name,label,value)=>field(label,'',`<textarea name="${name}" rows="4" maxlength="2000">${esc(value||'')}</textarea>`);
 const num=(name,label,value,min,max)=>field(label,'',`<input name="${name}" type="number" min="${min}" max="${max}" value="${esc(value)}" required>`);
 const select=(name,label,items,value,prefix='')=>field(label,'',`<select name="${name}"><option value="">Belum dipilih</option>${items.map(x=>`<option value="${esc(x.id)}" ${x.id===value?'selected':''}>${esc(prefix+x.name)}</option>`).join('')}${value&&!items.some(x=>x.id===value)?`<option value="${esc(value)}" selected>ID tersimpan (tidak tersedia)</option>`:''}</select>`);
 const notice=message=>{const el=document.getElementById('toast');el.textContent=message;el.classList.add('show');setTimeout(()=>el.classList.remove('show'),4000)};
 async function req(path,opts={}){const s=await window.ZentixSession;const r=await fetch('/dashboard/api/bot/'+path,{cache:'no-store',...opts,headers:opts.body?{'Content-Type':'application/json','x-csrf-token':s.csrf}:{}});const b=await r.json();if(!r.ok)throw Error(b.error||'Permintaan gagal');return b;}
 // ---- reward roles (leveling) ----------------------------------------------
 // The list shows what the bot can give right now; the button starts a sync
 // that only adds missing roles to members who already reached the level.
 function rewardList(rewardRoles) {
  const rows = (rewardRoles || []).map(item => {
   const label = item.name ? '@ ' + item.name : 'ID ' + item.roleId;
   const state = item.ok ? 'Dapat diberikan' : 'Tidak diberikan: ' + (item.reason || 'tidak tersedia');
   return `<li data-ok="${item.ok ? '1' : '0'}"><b>Level ${esc(item.level)}</b> · ${esc(label)} — ${esc(state)}</li>`;
  }).join('');
  return rows
   ? `<ul class="f-muted" id="rewardRoleList">${rows}</ul>`
   : '<p class="f-muted" id="rewardRoleList">Belum ada role hadiah yang tersimpan.</p>';
 }
 function rewardBox(rewardRoles) {
  return `<div class="f-form" id="rewardRoleBox"><p><b>Role hadiah tersimpan</b></p>${rewardList(rewardRoles)}`
   + '<p class="f-muted" id="rewardSyncStatus"></p>'
   + '<div class="f-form-actions"><span>✳ HANYA MENAMBAH ROLE</span>'
   + '<button class="f-outline" id="rewardSyncStart" type="button">SINKRONKAN ROLE HADIAH ↗</button></div></div>';
 }
 function rewardSyncText(status) {
  const time = value => { const d = new Date(value); return isNaN(d) ? '' : d.toLocaleString('id-ID'); };
  if (!status || (!status.running && !status.finishedAt)) return 'Sinkronisasi belum dijalankan sejak bot menyala.';
  if (status.running) return 'Sinkronisasi sedang berjalan sejak ' + time(status.startedAt) + '…';
  if (status.failed || !status.summary) return 'Sinkronisasi terakhir (' + time(status.finishedAt) + ') gagal. Periksa log bot.';
  const s = status.summary;
  return 'Sinkronisasi terakhir selesai ' + time(status.finishedAt) + ': '
   + s.membersChecked + ' anggota diperiksa, ' + s.rolesReAwarded + ' role diberikan, '
   + s.missingRewardEntries + ' role hadiah sudah tidak ada, '
   + s.unusableRewardEntries + ' role hadiah tidak dapat diberikan bot, ' + s.errors + ' galat.';
 }
 function bindRewardSync(slot, initial) {
  const text = slot.querySelector('#rewardSyncStatus'), button = slot.querySelector('#rewardSyncStart');
  if (!text || !button) return;
  let timer = null;
  const show = status => {
   text.textContent = rewardSyncText(status);
   button.disabled = status?.running === true;
   if (status?.running && !timer) timer = setTimeout(poll, 3000);
  };
  const poll = async () => {
   timer = null;
   if (!slot.isConnected) return;
   try { show((await req('leveling/reward-sync')).status); }
   catch (err) { text.textContent = err.message; button.disabled = false; }
  };
  button.onclick = async () => {
   if (!confirm('Berikan role hadiah yang belum dimiliki anggota yang sudah mencapai levelnya? Role tidak ada yang dicabut.')) return;
   button.disabled = true;
   try {
    const result = await req('leveling/reward-sync', { method: 'POST', body: JSON.stringify({ confirmed: true }) });
    notice('Sinkronisasi role hadiah dimulai.');
    show(result.status);
   } catch (err) { notice(err.message); button.disabled = false; }
  };
  show(initial);
 }
 function render(kind){return `<div class="f-layout"><div><section class="f-panel"><div class="f-panel-head"><div><h2>Pengaturan ${esc(kind)}</h2><p>Data server · perubahan disimpan ke bot.</p></div><span>✳</span></div><div id="moduleLive" data-kind="${esc(kind)}">Memuat pengaturan…</div></section></div><aside><section class="f-panel"><div class="f-panel-head"><div><h2>Kontrol server</h2><p>Hanya owner dan administrator server.</p></div><span>✳</span></div><div class="f-feature-note">◈<p>Periksa pengaturan sebelum menyimpan. Pengiriman panel memerlukan konfirmasi dan memakai konfigurasi yang sudah tersimpan.</p></div>${['verification','ticket'].includes(kind)?'<div class="f-preview-action"><button class="f-outline" id="modulePanel" type="button" disabled>KIRIM / PERBARUI PANEL ↗</button></div>':''}</section></aside></div>`;}
 function bind(root){const slot=root.querySelector('#moduleLive');if(!slot)return;const kind=slot.dataset.kind;
  req('settings/'+kind).then(({settings:s,channels,categories,roles,events,groups,rewardRoles,rewardSync,revision})=>{
   if(!slot.isConnected)return;let controls='';
   if(kind==='verification')controls=toggle('enabled','Aktifkan verification',s.enabled)+select('channelId','Channel panel',channels,s.channelId,'# ')+select('roleId','Role terverifikasi',roles,s.roleId,'@ ')+area('message','Pesan panel',s.message||'Klik tombol untuk verifikasi.')+text('buttonText','Teks tombol',s.buttonText||'Verify',80);
   if(kind==='ticket')controls=select('channelId','Channel panel',channels,s.channelId,'# ')+select('staffRoleId','Role staf',roles,s.staffRoleId,'@ ')+select('categoryId','Kategori tiket terbuka',categories,s.categoryId)+select('closedCategoryId','Kategori tiket tertutup',categories,s.closedCategoryId)+area('message','Pesan panel',s.message)+text('buttonText','Label tombol',s.buttonText,80)+select('logsChannelId','Channel log tiket',channels,s.logsChannelId,'# ')+select('transcriptChannelId','Channel transcript tiket',channels,s.transcriptChannelId,'# ')+num('maxTicketsPerUser','Maksimum tiket per anggota',s.maxTicketsPerUser,1,50)+toggle('dmOnClose','DM saat tiket ditutup',s.dmOnClose);
   if(kind==='leveling')controls=toggle('enabled','Aktifkan leveling',s.enabled!==false)+num('min','XP minimum',s.xpRange?.min??s.xpPerMessage?.min??15,1,10000)+num('max','XP maksimum',s.xpRange?.max??s.xpPerMessage?.max??25,1,10000)+num('cooldown','Cooldown dalam detik',s.xpCooldown??20,1,3600)+select('channelId','Channel level-up',channels,s.levelUpChannel,'# ')+toggle('announce','Umumkan level-up',s.announceLevelUp!==false)+toggle('publicLeaderboard','Publikasikan leaderboard (opt-in)',s.publicLeaderboard===true)+area('levelUpMessage','Pesan level-up: {user}, {level}, {xp}, {xpNeeded}',s.levelUpMessage||'{user} has leveled up to level {level}!')+text('ignoredChannels','ID channel yang diabaikan (pisahkan dengan koma)',(s.ignoredChannels||[]).join(', '))+text('ignoredRoles','ID role yang diabaikan (pisahkan dengan koma)',(s.ignoredRoles||[]).join(', '))+area('roleRewards','Hadiah role: satu baris level:ID role (level 1–500)',Object.entries(s.roleRewards||{}).map(([level,id])=>level+':'+id).join('\n'))+'<p class="f-muted">Gunakan ID Discord dari server ini. Role hadiah harus dapat diberikan bot dan tidak boleh memiliki izin pengelolaan atau moderasi server. Role hanya ditambahkan dan tidak pernah dicabut, juga saat level diturunkan. Anggota yang sudah melewati level menerima role saat naik level berikutnya, saat bot dinyalakan, atau lewat sinkronisasi di bawah.</p>';
   if(kind==='logging')controls=toggle('enabled','Aktifkan logging',s.enabled)+['audit','applications','reports'].map(k=>select(k,'Channel '+k,channels,s.channels?.[k],'# ')).join('')+'<p class="f-muted">Kategori dan event dapat dinonaktifkan. Event tetap nonaktif bila kategorinya nonaktif.</p>'+groups.map(g=>toggle('group:'+g,g+' / seluruh kategori',s.enabledEvents?.[g+'.*']!==false)).join('')+events.map(e=>toggle('event:'+e,e,s.enabledEvents?.[e]!==false)).join('');
   slot.innerHTML=`<form class="f-form" id="moduleForm">${controls}<div class="f-form-actions"><span>✳ DISIMPAN KE BOT</span><button class="f-primary">SIMPAN ↗</button></div></form>`+(kind==='leveling'?rewardBox(rewardRoles):'');
   if(kind==='leveling')bindRewardSync(slot,rewardSync);
   const f=slot.querySelector('form');const get=n=>f.elements.namedItem(n);const val=n=>get(n).value||null;const checked=n=>get(n).checked;
   f.addEventListener('submit',async e=>{e.preventDefault();let body;
    if(kind==='verification')body={enabled:checked('enabled'),channelId:val('channelId'),roleId:val('roleId'),message:get('message').value,buttonText:get('buttonText').value};
    if(kind==='ticket')body={channelId:val('channelId'),staffRoleId:val('staffRoleId'),categoryId:val('categoryId'),closedCategoryId:val('closedCategoryId'),message:get('message').value,buttonText:get('buttonText').value,logsChannelId:val('logsChannelId'),transcriptChannelId:val('transcriptChannelId'),maxTicketsPerUser:Number(get('maxTicketsPerUser').value),dmOnClose:checked('dmOnClose')};
    if(kind==='leveling')body={enabled:checked('enabled'),min:Number(get('min').value),max:Number(get('max').value),cooldown:Number(get('cooldown').value),channelId:val('channelId'),announce:checked('announce'),publicLeaderboard:checked('publicLeaderboard'),levelUpMessage:get('levelUpMessage').value,ignoredChannels:get('ignoredChannels').value.split(',').map(v=>v.trim()).filter(Boolean),ignoredRoles:get('ignoredRoles').value.split(',').map(v=>v.trim()).filter(Boolean),roleRewards:{}};
    if(kind==='leveling'){const lines=get('roleRewards').value.split('\n').map(v=>v.trim()).filter(Boolean);for(const line of lines){const match=/^([1-9]\d{0,2}):\s*(\d{17,20})$/.exec(line);if(!match||body.roleRewards[match[1]]){notice('Format reward tidak valid atau level duplikat. Gunakan level:ID role per baris.');return;}body.roleRewards[match[1]]=match[2];}if(revision)body.revision=revision;}
    if(kind==='logging'){const enabledEvents={};for(const g of groups)enabledEvents[g+'.*']=checked('group:'+g);for(const event of events)enabledEvents[event]=checked('event:'+event);body={enabled:checked('enabled'),channels:{audit:val('audit'),applications:val('applications'),reports:val('reports')},enabledEvents};}
    const button=f.querySelector('button');button.disabled=true;try{await req('settings/'+kind,{method:'PATCH',body:JSON.stringify(body)});notice('Pengaturan berhasil disimpan.');
     if(kind==='leveling'){const fresh=await req('settings/leveling').catch(()=>null),list=slot.querySelector('#rewardRoleList');if(fresh&&list)list.outerHTML=rewardList(fresh.rewardRoles);if(fresh)revision=fresh.revision;}
    }catch(err){notice(err.message)}finally{button.disabled=false}
   });
   const panel=root.querySelector('#modulePanel');if(panel){panel.disabled=false;panel.onclick=async()=>{if(!confirm('Kirim atau perbarui panel Discord dari pengaturan tersimpan?'))return;panel.disabled=true;try{await req('panel/'+kind,{method:'POST',body:JSON.stringify({confirmed:true})});notice('Panel Discord berhasil dikirim / diperbarui.')}catch(err){notice(err.message)}finally{panel.disabled=false}};}
  }).catch(e=>{if(slot.isConnected)slot.textContent=e.message});
 }
 window.ZentixModules={render,bind};
})();
