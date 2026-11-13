/* Giveaways on PostgreSQL: list, create, end, reroll, delete and repair of an
   unfinished delivery. Every change is confirmed against freshly loaded data.
   Discord and the database are separate; each message says which may have changed. */
(() => {
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

 async function request(path,method='GET',body){
  const session=await window.ZentixSession;
  const response=await fetch('/dashboard/api/bot/giveaway/'+path,{
   method,
   cache:'no-store',
   headers:body?{'content-type':'application/json','x-csrf-token':session.csrf}:{},
   ...(body?{body:JSON.stringify(body)}:{}),
  });
  const data=await response.json();
  if(!response.ok)throw Object.assign(Error(data.error||'Permintaan gagal.'),{code:data.code});
  return data;
 }

 function render(){
  return `<div class="f-layout"><div>`
   +`<section class="f-panel"><div class="f-panel-head"><div><h2>Daftar Giveaway tersimpan</h2>`
   +`<p>Diurutkan berdasarkan ID pesan, bukan waktu.</p></div><span>✳</span></div>`
   +`<div id="giveawayLive" aria-live="polite">Memuat daftar…</div></section></div>`
   +`<aside><section class="f-panel"><div class="f-panel-head"><div><h2>Buat Giveaway</h2>`
   +`<p>Bot langsung mengirim pesan publik ke channel yang dipilih.</p></div><span>✳</span></div>`
   +`<div id="giveawayCreate" aria-live="polite">Memuat pilihan…</div></section>`
   +`<section class="f-panel" style="margin-top:18px"><div class="f-panel-head"><div><h2>Yang perlu diperhatikan</h2>`
   +`<p>Data berasal dari PostgreSQL, bukan hasil pemeriksaan pesan Discord.</p></div><span>✳</span></div>`
   +`<p class="f-muted">Status tersimpan bukan jaminan pesan Discord sudah sesuai. Status pengiriman yang tidak tercatat bukan bukti gagal atau berhasil. Periksa pesan sebelum bertindak.</p>`
   +`<p class="f-muted">Mengakhiri atau mengundi ulang akan mengedit pesan dan mengirim atau memperbarui pengumuman. Menghapus akan menghapus pesan Giveaway dan seluruh entrinya; pengumuman pemenang yang sudah ada dibiarkan.</p>`
   +`<p class="f-muted">Jika pengiriman tertunda, periksa channel dulu: tandai terkirim bila pengumumannya sudah ada, atau kirim ulang bila belum. Bot tidak pernah mengulang sendiri.</p>`
   +`</section></aside></div>`;
 }

 // ---- List --------------------------------------------------------------
 const STATUS_TEXT={active:'TERCATAT AKTIF',ended:'TERCATAT SELESAI'};
 const DELIVERY_TEXT={delivered:'tercatat selesai',pending:'tertunda / tidak diketahui',not_recorded:'tidak tercatat'};
 const ACTION_LABEL={
  end:'AKHIRI',
  reroll:'UNDI ULANG',
  mark_delivered:'TANDAI TERKIRIM',
  redeliver:'KIRIM ULANG',
  delete:'HAPUS',
  delete_record:'HAPUS CATATAN SAJA',
 };

 /** Which actions a stored row offers. The server decides again on every request. */
 function actionsFor(g,legacyDetected){
  // Unreliable data is never acted on from here.
  const unreliable=g.dataReview===undefined?g.review:g.dataReview;
  if(legacyDetected||(unreliable&&!g.deleting))return [];
  if(g.deleting)return ['delete','delete_record'];
  if(g.delivery==='pending')return ['mark_delivered','redeliver','delete'];
  if(g.status==='active')return ['end','delete'];
  if(g.status==='ended'&&g.delivery==='delivered'&&g.entries>0)return ['reroll','delete'];
  if(g.status==='ended')return ['delete'];
  return [];
 }

 function rowHtml(g,index,legacyDetected){
  const actions=actionsFor(g,legacyDetected);
  const label=action=>g.deleting&&action==='delete'?'LANJUTKAN HAPUS':ACTION_LABEL[action];
  const status=g.deleting?'PENGHAPUSAN BELUM SELESAI':STATUS_TEXT[g.status]||'PERLU DIPERIKSA';
  const warnings=g.review&&Array.isArray(g.warnings)?`<br><small>${g.warnings.map(esc).join(' ')}</small>`:'';
  const end=g.endAt===null||g.endAt===undefined?'—':esc(new Date(g.endAt).toLocaleString('id-ID'));
  return `<tr><td><b>${esc(g.prize||'Perlu diperiksa')}</b><br><small>Pesan ${esc(g.messageId)}<br>`
   +`Channel ${esc(g.channelId||'—')} · Host ${esc(g.hostId||'—')}</small></td>`
   +`<td>${status}<br><small>Pengiriman: ${DELIVERY_TEXT[g.delivery]||'perlu diperiksa'}</small>${warnings}</td>`
   +`<td>${end}<br><small>Entri: ${esc(g.entries??'—')} · Target pemenang: ${esc(g.winnerCount??'—')}</small></td>`
   +`<td>${actions.length?actions.map(action=>`<button type="button" class="f-link" data-gw-action="${action}" data-index="${index}">${label(action)}</button>`).join('<br>'):'—'}</td></tr>`;
 }

 /** Why the freshly loaded state forbids the action, or null. */
 function refusal(action,latest){
  const waiting='Pengiriman mungkin masih berjalan. Tunggu sekitar dua menit, muat ulang, lalu periksa Discord.';
  if(action==='end'||action==='reroll'){
   if(latest.deleting)return 'Giveaway ini sedang dalam penghapusan yang belum selesai.';
   if(latest.deliveryStatus==='pending')return 'Pengiriman sebelumnya tertunda atau tidak diketahui. Periksa Discord dan database.';
   if((action==='end'&&latest.ended)||(action==='reroll'&&!latest.canReroll))return 'Status berubah atau pengundian ulang belum aman. Muat ulang dan periksa.';
   return null;
  }
  if(action==='mark_delivered'||action==='redeliver'){
   if(latest.canResolve)return null;
   return latest.deliveryStatus==='pending'&&!latest.deleting?waiting:'Status berubah. Muat ulang dan periksa.';
  }
  return latest.canDelete?null:waiting;
 }

 function confirmation(action,latest){
  const what=`giveaway “${latest.prize}” (pesan ${latest.messageId}, ${latest.entries} entri tersimpan)`;
  if(action==='end')return `Akhiri ${what}? Bot akan mengedit pesan dan mengirim atau memperbarui pengumuman di Discord.`;
  if(action==='reroll')return `Undi ulang ${what}? Bot akan mengedit pesan dan mengirim atau memperbarui pengumuman di Discord.`;
  if(action==='mark_delivered')return `Tandai hasil ${what} sebagai sudah terkirim? Lakukan hanya jika Anda sudah melihat pengumuman pemenangnya di Discord. Bot tidak mengirim apa pun.`;
  if(action==='redeliver')return `Kirim ulang hasil ${what}? Pemenang yang tersimpan diumumkan lagi tanpa undian baru. Jika pengumuman pertama sebenarnya sudah terkirim, akan ada dua pengumuman.`;
  if(action==='delete_record')return `Hapus HANYA catatan ${what}? Discord tidak disentuh: jika pesannya masih ada, hapus sendiri di Discord. Semua entri hilang dan tidak dapat dikembalikan.`;
  return `Hapus ${what}? Bot menghapus pesan Giveaway di Discord dan catatannya. Semua entri hilang dan tidak dapat dikembalikan. Pengumuman pemenang yang sudah ada tidak dihapus.`;
 }

 function successText(action,result){
  if(action==='delete')return result.discord==='deleted'?'Giveaway dihapus: pesan dan catatan.':'Catatan dihapus; pesannya sudah tidak ada di Discord.';
  if(action==='delete_record')return 'Catatan dihapus. Discord tidak disentuh.';
  if(action==='mark_delivered')return 'Ditandai terkirim. Tidak ada yang dikirim ke Discord.';
  if(action==='redeliver')return `Hasil dikirim ulang: ${result.winners} pemenang tersimpan.`;
  return `Selesai: ${result.winners} pemenang dari ${result.entries} entri tersimpan.`;
 }

 function bindList(root){
  const slot=root.querySelector('#giveawayLive');
  if(!slot)return ()=>{};

  async function load(after,notice=''){
   slot.textContent='Memuat daftar…';
   let data;
   try{data=await request('list'+(after?'?after='+encodeURIComponent(after):''))}
   catch(e){
    if(!slot.isConnected)return;
    slot.textContent=e.message;
    const retry=document.createElement('button');
    retry.type='button';retry.className='f-outline';retry.textContent='COBA LAGI';retry.onclick=()=>load(after);
    slot.append(retry);
    return;
   }
   if(!slot.isConnected)return;

   const legacy=data.legacyDetected?'<p role="alert">Ada data Giveaway lama di penyimpanan lain. Daftar ini mungkin tidak lengkap; periksa database sebelum mengambil keputusan.</p>':'';
   const table=data.giveaways.length
    ?`<div class="f-table-wrap"><table class="f-table"><thead><tr><th>HADIAH / PESAN</th><th>STATUS TERSIMPAN</th><th>SELESAI / ENTRI</th><th>AKSI</th></tr></thead>`
     +`<tbody>${data.giveaways.map((g,i)=>rowHtml(g,i,data.legacyDetected)).join('')}</tbody></table></div>`
    :'<p class="f-muted">Tidak ada data pada halaman ini.</p>';
   slot.innerHTML=`<p id="giveawayNotice" role="status" class="f-muted">${esc(notice)}</p><div id="giveawayFollowUp"></div>${legacy}`
    +`<p class="f-muted">Jumlah entri hanya jumlah tersimpan, bukan verifikasi anggota atau kelayakan. Waktu mengikuti zona waktu browser.</p>`
    +`${table}<div id="giveawayNav"></div>`;

   const nav=slot.querySelector('#giveawayNav'),noticeEl=slot.querySelector('#giveawayNotice'),followUp=slot.querySelector('#giveawayFollowUp');
   const make=(label,handler)=>{const b=document.createElement('button');b.type='button';b.className='f-outline';b.textContent=label;b.onclick=handler;nav.append(b)};
   make('MULAI DARI AWAL ↻',()=>load(null));
   if(data.next)make('HALAMAN BERIKUTNYA ↗',()=>load(data.next));

   const buttons=[...slot.querySelectorAll('[data-gw-action]')];
   const setButtons=disabled=>buttons.forEach(b=>b.disabled=disabled);
   const setNav=disabled=>nav.querySelectorAll('button').forEach(b=>b.disabled=disabled);

   async function run(action,g){
    setButtons(true);setNav(true);followUp.innerHTML='';
    noticeEl.textContent='Memeriksa data terbaru…';
    let posted=false;
    try{
     const latest=await request('prepare?messageId='+encodeURIComponent(g.messageId));
     const reason=refusal(action,latest);
     if(reason)throw Error(reason);
     if(!confirm(confirmation(action,latest))){
      noticeEl.textContent='Dibatalkan.';
      setButtons(false);setNav(false);
      return;
     }
     posted=true;
     noticeEl.textContent=action==='mark_delivered'||action==='delete_record'?'Menyimpan…':'Menyimpan dan menghubungi Discord…';
     const result=await request('action','POST',{messageId:g.messageId,action,revision:latest.revision,confirmed:true});
     await load(after,successText(action,result));
    }catch(e){
     // After a request was sent, the list on screen is out of date: only reloading is offered.
     const uncertain=posted&&(action==='end'||action==='reroll');
     noticeEl.textContent=e.message+(uncertain?' Hasil mungkin tidak diketahui. Periksa Discord dan database sebelum mencoba lagi.':'');
     setNav(false);
     if(!posted)setButtons(false);
     // The bot could not reach the message and changed nothing: offer to drop the record alone.
     if(action==='delete'&&e.code==='GIVEAWAY_DISCORD_UNVERIFIED'){
      const only=document.createElement('button');
      only.type='button';only.className='f-outline';only.id='giveawayRecordOnly';
      only.textContent=`HAPUS CATATAN SAJA (pesan ${g.messageId})`;
      only.onclick=()=>run('delete_record',g);
      followUp.append(only);
     }
    }
   }
   buttons.forEach(button=>button.onclick=()=>{
    const g=data.giveaways[Number(button.dataset.index)];
    if(g)run(button.dataset.gwAction,g);
   });
  }

  load(null);
  return notice=>load(null,notice);
 }

 // ---- Create ------------------------------------------------------------
 const UNIT_MS={m:60_000,h:3_600_000,d:86_400_000};
 const UNIT_TEXT={m:'menit',h:'jam',d:'hari'};
 /** "5 menit", "30 hari": the largest unit that divides the limit exactly. */
 function spanText(ms){
  for(const unit of ['d','h','m'])if(ms%UNIT_MS[unit]===0)return `${ms/UNIT_MS[unit]} ${UNIT_TEXT[unit]}`;
  return `${Math.ceil(ms/1000)} detik`;
 }

 function bindCreate(root,reloadList){
  const slot=root.querySelector('#giveawayCreate');
  if(!slot)return;

  async function load(){
   slot.textContent='Memuat pilihan…';
   let options;
   try{options=await request('options')}
   catch(e){if(slot.isConnected)showUnavailable(e.message);return}
   if(!slot.isConnected)return;
   const limits=options.limits;
   if(!Array.isArray(options.channels)||!limits)return showUnavailable('Pilihan channel tidak dapat dimuat.');
   if(!options.channels.length)return showUnavailable('Tidak ada channel teks yang dapat dipakai. Bot memerlukan izin melihat channel, mengirim pesan dan menyematkan tautan.');
   showForm(options.channels,limits,options.channelsTruncated===true);
  }

  function showUnavailable(message){
   slot.innerHTML=`<p class="f-muted" role="status">${esc(message)}</p>`;
   const retry=document.createElement('button');
   retry.type='button';retry.className='f-outline';retry.textContent='MUAT ULANG PILIHAN ↻';retry.onclick=load;
   slot.append(retry);
  }

  function showForm(channels,limits,truncated){
   slot.innerHTML=`<form class="f-form" id="giveawayCreateForm"><fieldset style="border:0;padding:0;margin:0;min-width:0">`
    +`<label class="f-field"><span><b>Channel</b><small>Hanya channel teks tempat bot boleh mengirim.${truncated?' Daftar dipotong; tidak semua channel tampil.':''}</small></span>`
    +`<select name="channelId" required><option value="">Pilih channel…</option>`
    +`${channels.map(c=>`<option value="${esc(c.id)}"># ${esc(c.name)}</option>`).join('')}</select></label>`
    +`<label class="f-field"><span><b>Hadiah</b><small>Tampil sebagai judul pesan. Maksimal ${esc(limits.prizeMaxLength)} karakter.</small></span>`
    +`<input name="prize" type="text" maxlength="${esc(limits.prizeMaxLength)}" autocomplete="off" required></label>`
    +`<label class="f-field"><span><b>Jumlah pemenang</b><small>${esc(limits.minWinners)}–${esc(limits.maxWinners)}</small></span>`
    +`<input name="winnerCount" type="number" min="${esc(limits.minWinners)}" max="${esc(limits.maxWinners)}" step="1" value="1" required></label>`
    +`<label class="f-field"><span><b>Durasi</b><small>${esc(spanText(limits.minDurationMs))} sampai ${esc(spanText(limits.maxDurationMs))}</small></span>`
    +`<input name="amount" type="number" min="1" max="999" step="1" value="1" required></label>`
    +`<label class="f-field"><span><b>Satuan</b></span><select name="unit">`
    +`<option value="m">menit</option><option value="h">jam</option><option value="d" selected>hari</option></select></label>`
    +`<p id="giveawayCreateStatus" class="f-muted" role="status"></p>`
    +`<div class="f-form-actions"><span>✳ PESAN PUBLIK</span><button type="submit" class="f-primary">BUAT GIVEAWAY ↗</button></div>`
    +`</fieldset></form>`;
   const form=slot.querySelector('form'),fields=form.querySelector('fieldset'),status=slot.querySelector('#giveawayCreateStatus');

   form.onsubmit=async event=>{
    event.preventDefault();
    const channelId=form.elements.channelId.value;
    const channel=channels.find(c=>c.id===channelId);
    const prize=form.elements.prize.value.trim();
    const winnersText=form.elements.winnerCount.value.trim(),amountText=form.elements.amount.value.trim();
    const unit=form.elements.unit.value;
    const winnerCount=Number(winnersText),amount=Number(amountText);
    if(!channel){status.textContent='Pilih channel.';return}
    if(!prize||prize.length>limits.prizeMaxLength){status.textContent=`Hadiah harus 1–${limits.prizeMaxLength} karakter.`;return}
    if(!/^\d{1,3}$/.test(winnersText)||winnerCount<limits.minWinners||winnerCount>limits.maxWinners){status.textContent=`Jumlah pemenang harus ${limits.minWinners}–${limits.maxWinners}.`;return}
    const durationMs=amount*UNIT_MS[unit];
    if(!/^[1-9]\d{0,2}$/.test(amountText)||!UNIT_MS[unit]||durationMs<limits.minDurationMs||durationMs>limits.maxDurationMs){
     status.textContent=`Durasi harus ${spanText(limits.minDurationMs)} sampai ${spanText(limits.maxDurationMs)}.`;return;
    }
    const summary=`“${prize}” di #${channel.name}, ${winnerCount} pemenang, durasi ${amount} ${UNIT_TEXT[unit]}`;
    if(!confirm(`Buat giveaway ${summary}? Bot akan langsung mengirim pesan publik di channel itu.`))return;
    fields.disabled=true;status.textContent='Mengirim pesan dan menyimpan…';
    let created;
    try{created=await request('create','POST',{channelId,prize,winnerCount,duration:`${amount}${unit}`,confirmed:true})}
    catch(e){
     if(!slot.isConnected)return;
     // The message says what was left behind; the input stays for a deliberate retry.
     status.textContent=e.message;
     fields.disabled=false;
     return;
    }
    if(!slot.isConnected)return;
    form.elements.prize.value='';
    fields.disabled=false;
    status.textContent=`Giveaway dibuat: ${summary} (pesan ${created.messageId}).`;
    reloadList('Giveaway baru dibuat.');
   };
  }

  load();
 }

 function bind(root){
  const reloadList=bindList(root);
  bindCreate(root,reloadList);
 }
 window.ZentixGiveaway={render,bind};
})();
