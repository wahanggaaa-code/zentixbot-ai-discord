/* Birthday channel and existing member records in the authenticated dashboard. */
(() => {
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 async function request(path,method='GET',body){const session=await window.ZentixSession;const response=await fetch('/dashboard/api/bot/birthday/'+path,{method,cache:'no-store',headers:body?{'Content-Type':'application/json','x-csrf-token':session.csrf}:{},...(body?{body:JSON.stringify(body)}:{})});const data=await response.json();if(!response.ok)throw Error(data.error||'Permintaan gagal.');return data;}
 function render(){return `<div class="f-layout"><div><section class="f-panel"><div class="f-panel-head"><div><h2>Channel ulang tahun</h2><p>Pengumuman bot menggunakan channel ini. Kosongkan untuk menonaktifkan.</p></div><span>✳</span></div><div id="liveBirthdaySettings" aria-live="polite">Memuat pengaturan…</div></section><div class="f-callout">ⓘ &nbsp; Pengiriman dijalankan oleh scheduler bot, bukan dashboard. Izin dan ketersediaan channel dapat berubah setelah disimpan.</div>${renderAdd()}</div><aside><section class="f-panel"><div class="f-panel-head"><div><h2>Daftar ulang tahun</h2><p>ID anggota dan tanggal, tanpa tahun.</p></div><span>✳</span></div><div id="liveBirthdayList" aria-live="polite">Memuat daftar…</div></section><p class="f-muted">Data pribadi: hanya admin/owner. Ubah atau hapus hanya dengan dasar dan izin yang sesuai. Daftar bukan backup.</p></aside></div>`;}
 function bind(root){
  const settings=root.querySelector('#liveBirthdaySettings'),list=root.querySelector('#liveBirthdayList');if(!settings||!list)return;
  async function loadSettings(){settings.textContent='Memuat pengaturan…';try{const data=await request('settings');if(!settings.isConnected)return;let expected=data.channelId;const choices=[['','Nonaktif'],...data.channels.map(c=>[c.id,'# '+c.name])];if(expected&&!data.channels.some(c=>c.id===expected))choices.push([expected,'ID tersimpan — tidak tersedia']);settings.innerHTML=`<p role="status" id="birthdayError" class="f-muted"></p><form class="f-form" id="birthdayForm"><fieldset style="border:0;padding:0;margin:0;min-width:0"><label class="f-field"><span><b>Channel pengumuman</b><small>Bot memerlukan izin melihat, mengirim, dan menyematkan tautan.</small></span><select name="channelId">${choices.map(([id,name])=>`<option value="${esc(id)}" ${id===(expected||'')?'selected':''}>${esc(name)}</option>`).join('')}</select></label><div class="f-form-actions"><span>✳ SIMPAN KE BOT</span><button type="submit" class="f-primary">SIMPAN ↗</button></div></fieldset></form><button type="button" class="f-outline" id="reloadBirthday">MUAT ULANG ↻</button>`;
   const form=settings.querySelector('form'),field=form.querySelector('fieldset'),reload=settings.querySelector('#reloadBirthday'),error=settings.querySelector('#birthdayError');reload.onclick=()=>{if(confirm('Muat ulang? Perubahan yang belum disimpan akan hilang.'))loadSettings()};form.onsubmit=async e=>{e.preventDefault();field.disabled=true;reload.disabled=true;error.textContent='';try{const saved=await request('settings','PATCH',{channelId:form.elements.channelId.value||null,expectedChannelId:expected});expected=saved.channelId;error.textContent='Channel disimpan.'}catch(e){error.textContent=e.message}finally{field.disabled=false;reload.disabled=false}};
  }catch(e){if(settings.isConnected)settings.textContent=e.message}}
  async function loadList(after){
   list.textContent='Memuat daftar…';try{
    const data=await request('list'+(after?'?after='+encodeURIComponent(after):''));if(!list.isConnected)return;
    list.innerHTML=data.birthdays.length?`<div class="f-table-wrap"><table class="f-table"><thead><tr><th>ID ANGGOTA</th><th>TANGGAL</th><th>AKSI</th></tr></thead><tbody>${data.birthdays.map((b,i)=>`<tr><td>${esc(b.userId)}</td><td>${esc(String(b.day).padStart(2,'0'))}/${esc(String(b.month).padStart(2,'0'))}</td><td><button type="button" class="f-link" data-edit="${i}">KELOLA ↗</button></td></tr>`).join('')}</tbody></table></div>`:'<p class="f-muted">Tidak ada data pada halaman ini.</p>';
    const navigation=document.createElement('div');list.append(navigation);const reload=document.createElement('button');reload.type='button';reload.className='f-outline';reload.textContent='MULAI DARI AWAL ↻';reload.onclick=()=>loadList(null);navigation.append(reload);
    if(data.next){const next=document.createElement('button');next.type='button';next.className='f-outline';next.textContent='HALAMAN BERIKUTNYA ↗';next.onclick=()=>loadList(data.next);navigation.append(next)}
    const editor=document.createElement('div');list.prepend(editor);
    list.querySelectorAll('[data-edit]').forEach(button=>button.onclick=()=>{
     const record=data.birthdays[Number(button.dataset.edit)];if(!record)return;
     list.querySelectorAll('[data-edit]').forEach(b=>b.disabled=true);navigation.hidden=true;
     editor.innerHTML=`<form id="birthdayMemberForm" class="f-form"><fieldset style="border:0;padding:0;margin:0;min-width:0"><p><b>Anggota ${esc(record.userId)}</b><br><small>Periksa identitas dan izin sebelum mengubah data pribadi.</small></p><label class="f-field"><span><b>Hari</b></span><input name="day" type="number" min="1" max="31" step="1" required value="${esc(record.day)}"></label><label class="f-field"><span><b>Bulan</b></span><input name="month" type="number" min="1" max="12" step="1" required value="${esc(record.month)}"></label><p id="birthdayMemberError" class="f-muted" role="status"></p><div class="f-form-actions"><button type="submit" class="f-primary">SIMPAN TANGGAL ↗</button><button type="button" class="f-outline" id="birthdayDelete">HAPUS TANGGAL</button><button type="button" class="f-outline" id="birthdayCancel">BATAL</button></div></fieldset></form>`;
     const form=editor.querySelector('form'),fields=form.querySelector('fieldset'),error=editor.querySelector('#birthdayMemberError');editor.querySelector('#birthdayCancel').onclick=()=>{editor.innerHTML='';navigation.hidden=false;list.querySelectorAll('[data-edit]').forEach(b=>b.disabled=false)};
     const save=async next=>{const label=next===null?'Hapus':'Ubah';if(!confirm(`${label} tanggal ulang tahun anggota ${record.userId}? Pastikan Anda memiliki izin yang sesuai.`))return;fields.disabled=true;error.textContent='';try{await request('member/'+encodeURIComponent(record.userId),'PATCH',{expected:{month:record.month,day:record.day},next});const toast=document.getElementById('toast');toast.textContent=next===null?'Tanggal dihapus.':'Tanggal disimpan.';toast.classList.add('show');setTimeout(()=>toast.classList.remove('show'),4000);await loadList(null)}catch(e){error.textContent=e.message+' Jika hasil tidak diketahui, muat ulang dan periksa sebelum mengulang.';fields.disabled=false}};
     form.onsubmit=e=>{e.preventDefault();save({month:Number(form.elements.month.value),day:Number(form.elements.day.value)})};editor.querySelector('#birthdayDelete').onclick=()=>save(null);
    });
   }catch(e){if(list.isConnected){list.textContent=e.message;const retry=document.createElement('button');retry.type='button';retry.className='f-outline';retry.textContent='COBA LAGI';retry.onclick=()=>loadList(after);list.append(retry)}}
  }
  loadSettings();loadList(null);bindAdd(root,()=>{if(!list.querySelector('#birthdayMemberForm'))loadList(null)});
 }

 // ---- Add a date for a member who has none -------------------------------
 const DAYS_IN_MONTH=[31,29,31,30,31,30,31,31,30,31,30,31];
 const two=n=>String(n).padStart(2,'0');
 function renderAdd(){
  return `<section class="f-panel" style="margin-top:18px"><div class="f-panel-head"><div><h2>Tambah tanggal</h2>`
   +`<p>Untuk anggota yang belum punya tanggal. Tanggal yang sudah ada diubah lewat KELOLA pada daftar.</p></div><span>✳</span></div>`
   +`<div id="liveBirthdayAdd" aria-live="polite"></div></section>`;
 }
 function bindAdd(root,reloadList){
  const slot=root.querySelector('#liveBirthdayAdd');if(!slot)return;

  function askId(message=''){
   slot.innerHTML=`<form class="f-form" id="birthdayLookupForm"><label class="f-field"><span><b>ID anggota</b>`
    +`<small>ID Discord 17–20 digit. Identitas diperiksa ke Discord sebelum tanggal dapat diisi.</small></span>`
    +`<input name="userId" type="text" inputmode="numeric" maxlength="20" autocomplete="off" required></label>`
    +`<p id="birthdayAddStatus" class="f-muted" role="status">${esc(message)}</p>`
    +`<div class="f-form-actions"><span>✳ DATA PRIBADI</span><button type="submit" class="f-primary">PERIKSA ANGGOTA ↗</button></div></form>`;
   const form=slot.querySelector('form'),status=slot.querySelector('#birthdayAddStatus'),button=form.querySelector('button');
   form.onsubmit=async event=>{
    event.preventDefault();
    const userId=form.elements.userId.value.trim();
    if(!/^\d{17,20}$/.test(userId)){status.textContent='ID anggota harus 17 sampai 20 digit.';return}
    button.disabled=true;status.textContent='Memeriksa anggota…';
    let member;
    try{member=await request('member/'+encodeURIComponent(userId))}
    catch(error){if(slot.isConnected){status.textContent=error.message;button.disabled=false}return}
    if(!slot.isConnected)return;
    if(member.bot){status.textContent='ID itu milik akun bot; tidak dapat diberi tanggal.';button.disabled=false;return}
    if(member.hasBirthday){status.textContent=`${member.name||member.userId} sudah memiliki tanggal. Gunakan KELOLA pada daftar.`;button.disabled=false;return}
    askDate(member);
   };
  }

  function askDate(member){
   const fallback=member.leapDayFallback;
   slot.innerHTML=`<form class="f-form" id="birthdayAddForm"><fieldset style="border:0;padding:0;margin:0;min-width:0">`
    +`<p><b>${esc(member.name||'Nama tidak tersedia')}</b><br><small>ID ${esc(member.userId)} · anggota server saat diperiksa</small></p>`
    +`<label class="f-field"><span><b>Hari</b></span><input name="day" type="number" min="1" max="31" step="1" required></label>`
    +`<label class="f-field"><span><b>Bulan</b></span><input name="month" type="number" min="1" max="12" step="1" required></label>`
    +(fallback?`<p class="f-muted">29 Februari dapat disimpan. Pada tahun tanpa tanggal itu, bot merayakannya pada ${esc(two(fallback.day))}/${esc(two(fallback.month))}.</p>`:'')
    +`<p id="birthdayAddStatus" class="f-muted" role="status"></p>`
    +`<div class="f-form-actions"><button type="submit" class="f-primary">TAMBAH TANGGAL ↗</button>`
    +`<button type="button" class="f-outline" id="birthdayAddCancel">BATAL</button></div></fieldset></form>`;
   const form=slot.querySelector('form'),fields=form.querySelector('fieldset'),status=slot.querySelector('#birthdayAddStatus');
   slot.querySelector('#birthdayAddCancel').onclick=()=>askId();
   form.onsubmit=async event=>{
    event.preventDefault();
    const dayText=form.elements.day.value.trim(),monthText=form.elements.month.value.trim();
    const day=Number(dayText),month=Number(monthText);
    if(!/^\d{1,2}$/.test(dayText)||!/^\d{1,2}$/.test(monthText)||month<1||month>12||day<1||day>DAYS_IN_MONTH[month-1]){status.textContent='Tanggal tidak ada di kalender. Periksa hari dan bulan.';return}
    const who=`${member.name||'anggota'} (${member.userId})`;
    if(!confirm(`Tambah tanggal ${two(day)}/${two(month)} untuk ${who}? Ini data pribadi; pastikan Anda memiliki izin yang sesuai.`))return;
    fields.disabled=true;status.textContent='Menyimpan…';
    try{await request('member','POST',{userId:member.userId,month,day,confirmed:true})}
    catch(error){if(slot.isConnected){status.textContent=error.message+' Jika hasil tidak diketahui, muat ulang daftar dan periksa sebelum mengulang.';fields.disabled=false}return}
    if(!slot.isConnected)return;
    askId(`Tanggal ${two(day)}/${two(month)} ditambahkan untuk ${who}.`);
    reloadList();
   };
  }

  askId();
 }
 window.ZentixBirthday={render,bind};
})();
