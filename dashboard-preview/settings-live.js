/* Main settings page: a read-only control center. It shows what the bot sees in
   Discord right now, which storage it uses, and why this session has access.
   Nothing on this page changes anything; settings live on their feature pages. */
(() => {
 const enabled=location.pathname.startsWith('/dashboard/');
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

 async function request(path){
  await window.ZentixSession;
  const response=await fetch('/dashboard/api/bot/'+path,{cache:'no-store'});
  const data=await response.json();
  if(!response.ok)throw Error(data.error||'Permintaan gagal.');
  return data;
 }

 const SHORTCUTS=[
  ['features/core','Akses perintah','Aktif/nonaktifkan perintah dan kategori.'],
  ['features/welcome','Welcome & verification','Sambutan, goodbye, autorole, verifikasi.'],
  ['features/logging','Logging','Channel audit dan event yang dicatat.'],
  ['features/birthday','Birthday','Channel pengumuman dan tanggal anggota.'],
  ['features/giveaway','Giveaway','Buat, akhiri dan hapus giveaway.'],
  ['features/join-to-create','Join to Create','Trigger voice sementara.'],
  ['ai/providers','Pengaturan AI','Provider, model dan batas. Khusus owner bot.'],
 ];

 function render(){
  return `<section class="placeholder-head"><div class="kicker"><span class="pill-num">04 / PENGATURAN</span><i></i> YOUR CONTROL CENTER</div>`
   +`<h1>Semua dalam<br>kendali.</h1><p>Kondisi server, penyimpanan dan akses dashboard saat ini. Halaman ini hanya membaca; `
   +`setiap pengaturan diubah di halaman fiturnya.</p></section>`
   +`<div class="f-layout" style="padding-top:25px"><div>`
   +`<section class="f-panel"><div class="f-panel-head"><div><h2>Server di Discord</h2>`
   +`<p>Yang dilihat bot di Discord saat halaman dimuat, bukan data tersimpan.</p></div><span>✳</span></div>`
   +`<div id="settingsDiscord" aria-live="polite">Memuat…</div></section>`
   +`<section class="f-panel" style="margin-top:18px"><div class="f-panel-head"><div><h2>Tempat mengatur</h2>`
   +`<p>Pengaturan tersimpan ada di halaman masing-masing fitur.</p></div><span>✳</span></div>`
   +`<div class="f-table-wrap"><table class="f-table"><tbody>${SHORTCUTS.map(([go,title,desc])=>`<tr><td><b>${title}</b><br><small>${desc}</small></td>`
    +`<td><button type="button" class="f-link" data-go="${go}">BUKA ↗</button></td></tr>`).join('')}</tbody></table></div></section>`
   +`</div><aside>`
   +`<section class="f-panel"><div class="f-panel-head"><div><h2>Penyimpanan</h2><p>Database yang dipakai bot.</p></div><span>✳</span></div>`
   +`<div id="settingsStorage" aria-live="polite">Memuat…</div></section>`
   +`<section class="f-panel" style="margin-top:18px"><div class="f-panel-head"><div><h2>Akses &amp; izin</h2><p>Mengapa sesi ini boleh membuka dashboard.</p></div><span>✳</span></div>`
   +`<div id="settingsAccess" aria-live="polite">Memuat…</div></section>`
   +`<section class="f-panel" style="margin-top:18px"><div class="f-panel-head"><div><h2>Koneksi hosting</h2><p>Sumber statistik resource. Khusus owner bot.</p></div><span>✳</span></div>`
   +`<div id="settingsHosting" aria-live="polite">Memuat…</div></section>`
   +`<p class="f-muted" id="settingsReadAt"></p>`
   +`<button type="button" class="f-outline" id="settingsReload">MUAT ULANG ↻</button>`
   +`</aside></div>`;
 }

 const line=(label,value)=>`<tr><td>${label}</td><td>${value}</td></tr>`;
 const table=rows=>`<div class="f-table-wrap"><table class="f-table" style="min-width:0"><tbody>${rows.join('')}</tbody></table></div>`;
 const unknown='<i>tidak tersedia</i>';
 const number=value=>value===null||value===undefined?unknown:esc(new Intl.NumberFormat('id-ID').format(value));
 const time=value=>value===null||value===undefined?unknown:esc(new Date(value).toLocaleString('id-ID'));
 function duration(ms){
  if(ms===null||ms===undefined)return unknown;
  const minutes=Math.floor(ms/60000),days=Math.floor(minutes/1440),hours=Math.floor(minutes%1440/60);
  return esc(days?`${days} hari ${hours} jam`:hours?`${hours} jam ${minutes%60} menit`:`${minutes} menit`);
 }

 function discordHtml({guild,bot}){
  const rows=[
   line('Nama server',`<b>${esc(guild.name)}</b>`),
   line('ID server',esc(guild.id)),
   line('Anggota',number(guild.memberCount)),
   line('Owner server',guild.ownerId?esc(guild.ownerId):unknown),
   line('Bot',bot.ready?'TERHUBUNG':'<b>TIDAK TERHUBUNG</b>'),
   line('Ping gateway',bot.ping===null?unknown:`${esc(bot.ping)} ms`),
   line('Aktif selama',duration(bot.uptimeMs)),
  ];
  if(bot.highestRole){
   const above=bot.highestRole.rolesAbove;
   rows.push(line('Peran tertinggi bot',`${esc(bot.highestRole.name)}<br><small>${above?`${esc(above)} peran berada di atasnya dan tidak dapat diberikan atau dicabut oleh bot.`:'Tidak ada peran di atasnya.'}</small>`));
  }
  let permissions='<p class="f-muted">Izin bot tidak dapat dibaca dari Discord saat ini.</p>';
  if(bot.permissions){
   const missing=bot.permissions.items.filter(item=>!item.granted);
   const summary=bot.permissions.administrator
    ?'Bot memiliki izin Administrator, sehingga semua izin di bawah berlaku.'
    :missing.length?`${missing.length} izin belum dimiliki bot di tingkat server. Fitur yang memakainya bisa gagal.`
    :'Semua izin yang diperiksa dimiliki bot di tingkat server.';
   permissions=`<p id="settingsPermissionSummary" class="f-muted" role="status">${esc(summary)}</p>`
    +`<div class="f-table-wrap"><table class="f-table"><thead><tr><th>IZIN BOT</th><th>CONTOH PEMAKAI</th><th>STATUS</th></tr></thead><tbody>`
    +bot.permissions.items.map(item=>`<tr><td>${esc(item.label)}</td><td>${esc(item.usedBy)}</td>`
     +`<td data-permission="${esc(item.key)}">${item.granted?'ADA':'<b>TIDAK ADA</b>'}</td></tr>`).join('')
    +`</tbody></table></div><p class="f-muted">Ini izin tingkat server. Pengaturan per channel dan urutan peran dapat tetap menghalangi bot di tempat tertentu.</p>`;
  }
  return table(rows)+permissions;
 }

 const BACKEND={postgresql:'PostgreSQL',sqlite:'SQLite',memory:'Memori (tidak tersimpan)',none:'Belum ada',unknown:'Tidak dikenal'};
 const STORAGE_STATUS={
  connected:['TERHUBUNG','Database menjawab saat halaman dimuat.'],
  degraded:['MODE CADANGAN','Bot berjalan tanpa database utamanya. Perubahan mungkin tidak tersimpan.'],
  unavailable:['TIDAK TERSEDIA','Database tidak menjawab. Halaman fitur akan menolak membaca atau menyimpan.'],
 };
 function storageHtml(storage){
  const [label,note]=STORAGE_STATUS[storage.status]||['TIDAK DIKENAL',''];
  return table([
   line('Jenis',esc(BACKEND[storage.backend]||BACKEND.unknown)),
   line('Status',`<b id="settingsStorageStatus">${label}</b><br><small>${esc(note)}</small>`),
  ]);
 }

 function accessHtml(access,dashboard){
  const basis=access.isGuildOwner?'Owner server':access.isAdministrator?'Memiliki izin Administrator':'Tidak dapat dipastikan';
  const roles=access.adminRoles.length
   ?`<ul>${access.adminRoles.map(role=>`<li>${esc(role.name)}${role.managed?' <small>(milik bot/integrasi)</small>':''}</li>`).join('')}</ul>`
    +(access.adminRolesTruncated?'<p class="f-muted">Daftar dipotong; ada peran lain.</p>':'')
   :'<p class="f-muted">Tidak ada peran dengan izin Administrator. Hanya owner server yang dapat masuk.</p>';
  return table([
   line('Akun',`<b>${esc(access.user.username)}</b><br><small>${esc(access.user.id)}</small>`),
   line('Dasar akses',`<span id="settingsAccessBasis">${esc(basis)}</span>`),
   line('Owner bot',access.isBotOwner?'YA<br><small>Dapat membuka statistik hosting dan pengaturan AI.</small>':'BUKAN<br><small>Statistik hosting dan pengaturan AI tidak tersedia.</small>'),
   line('Sesi berakhir',time(access.sessionExpiresAt)),
  ])
   +`<p class="f-muted">Dashboard terbuka untuk owner server dan siapa pun yang memiliki izin Administrator. Izin diperiksa ulang ke Discord pada setiap permintaan; mencabut peran langsung mencabut akses.</p>`
   +(dashboard?.sessionStore==='process'?`<p class="f-muted" id="settingsSessionNote">Sesi disimpan di memori proses bot. Saat bot dimulai ulang, semua orang harus login lagi.</p>`:'')
   +`<p><b>Peran dengan izin Administrator</b></p>${roles}`
   +`<button type="button" class="f-outline" id="settingsLogout">KELUAR</button>`;
 }

 function bind(root){
  const slots={
   discord:root.querySelector('#settingsDiscord'),
   storage:root.querySelector('#settingsStorage'),
   access:root.querySelector('#settingsAccess'),
   hosting:root.querySelector('#settingsHosting'),
  };
  const readAt=root.querySelector('#settingsReadAt'),reload=root.querySelector('#settingsReload');
  if(!slots.discord||!reload)return;

  function bindHosting(hosting){
   const slot=slots.hosting;
   if(hosting.configured===null){slot.innerHTML='<p class="f-muted">Hanya owner bot yang dapat melihat koneksi hosting.</p>';return}
   if(!hosting.configured){slot.innerHTML='<p class="f-muted">Belum dikonfigurasi. Panel, ID server dan kunci API hosting diatur lewat environment bot, bukan dari dashboard.</p>';return}
   slot.innerHTML='<p class="f-muted">Dikonfigurasi lewat environment bot. Nilainya tidak ditampilkan.</p>'
    +'<p id="settingsHostingStatus" class="f-muted" role="status"></p>'
    +'<button type="button" class="f-outline" id="settingsHostingCheck">PERIKSA KONEKSI ↗</button>';
   const status=slot.querySelector('#settingsHostingStatus'),button=slot.querySelector('#settingsHostingCheck');
   button.onclick=async()=>{
    button.disabled=true;status.textContent='Menghubungi panel hosting…';
    try{
     const data=await request('hosting');
     if(slot.isConnected)status.textContent=`Panel menjawab. Status server: ${data.status}.`;
    }catch(e){if(slot.isConnected)status.textContent=e.message}
    finally{button.disabled=false}
   };
  }

  async function load(){
   reload.disabled=true;
   for(const slot of Object.values(slots))slot.textContent='Memuat…';
   readAt.textContent='';
   let data;
   try{data=await request('control-center')}
   catch(e){
    if(!slots.discord.isConnected)return;
    // One failed read: nothing on the page may look current.
    for(const slot of Object.values(slots))slot.textContent='Tidak dapat dimuat.';
    slots.discord.textContent=e.message;
    reload.disabled=false;
    return;
   }
   if(!slots.discord.isConnected)return;
   slots.discord.innerHTML=discordHtml(data.discord);
   slots.storage.innerHTML=storageHtml(data.storage);
   slots.access.innerHTML=accessHtml(data.access,data.dashboard);
   slots.access.querySelector('#settingsLogout').onclick=()=>document.getElementById('profileButton').click();
   bindHosting(data.hosting);
   readAt.textContent=`Dibaca ${new Date(data.readAt).toLocaleString('id-ID')}. Halaman tidak memperbarui diri; muat ulang untuk kondisi terbaru.`;
   reload.disabled=false;
  }
  reload.onclick=load;
  load();
 }

 window.ZentixSettings={enabled,render,bind};
})();
