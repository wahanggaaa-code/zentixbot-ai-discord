const $ = (s, root = document) => root.querySelector(s);
const main = $('#main');
const botFeatures = [
  ['01','Welcome & verification','Sambutan, autorole, dan verifikasi anggota.','♡'],
  ['02','Moderation','Pusat pengelolaan dan riwayat moderasi.','◇'],
  ['03','Ticket','Panel bantuan dan penanganan tiket.','▤'],
  ['04','Economy & leveling','Ekonomi, progres anggota, dan leaderboard.','↗'],
  ['05','Music','Pemutaran musik dan antrean server.','♫'],
  ['06','Logging','Pengaturan serta riwayat aktivitas server.','▥']
];
const aiFeatures = [
  ['01','Welcome & goodbye','Pesan yang lebih natural untuk anggota.','✳'],
  ['02','Activities','Trivia dan tebak emoji untuk komunitas.','◇'],
  ['03','Agent & chat','Asisten komunitas di DM dan channel.','◌'],
  ['04','Pengetahuan','Dokumen server sebagai rujukan AI.','▤'],
  ['05','AI tools','Ringkasan, pencarian, terjemahan & cek fakta.','↗'],
  ['06','Image studio','Pembuatan dan pengeditan gambar.','▧'],
  ['07','Server builder','Rancang struktur server dengan bantuan AI.','⌗'],
  ['08','Provider & fallback','Pengaturan model, batas, dan cadangan AI.','◈']
];
const settings = [
  ['01','Server','Pengaturan dasar untuk satu server.','↗'],
  ['02','Akses & izin','Kelola akses owner dan admin.','↗'],
  ['03','Koneksi hosting','Status sumber data resource hosting.','↗'],
  ['04','Pengaturan AI','Provider, model, batas dan fallback untuk owner.','↗']
];
const icon = '<span class="tiny-cross">✳</span>';
const placeholder = (items) => `<div class="placeholder-grid">${items.map(([n,title,desc,s])=>`<article class="placeholder-card"><div class="card-number"><span>${n} / ZENTIX</span><span>${s}</span></div><h3>${title}</h3><p>${desc}</p><div class="soon">HANYA DI DASHBOARD LOGIN <span aria-hidden="true">↗</span></div></article>`).join('')}</div><div class="notice-panel"><div class="notice-icon">✳</div><div><strong>Preview statis.</strong><p>Halaman pengaturan membaca kondisi server, penyimpanan dan akses hanya pada dashboard yang login.</p></div></div>`;
const overview=()=>`<section class="intro"><div><div class="kicker"><span class="pill-num">01 / OVERVIEW</span><i></i> YOUR COMMUNITY, IN CONTROL</div><h1>Ruang untuk<br><span class="outline">komunitasmu.</span></h1><p class="intro-copy">Semua yang kamu butuhkan untuk mengelola server, dalam satu tempat yang terasa seperti rumah.</p></div><aside class="intro-side"><span>✳ &nbsp; THE CONTROL ROOM</span><p>Lebih sedikit mengurus. Lebih banyak membangun komunitas.</p><div class="arrow">↘</div></aside></section>
<div class="ticker"><span>SERVER OVERVIEW &nbsp; / &nbsp; 01</span><span class="ticker-right"><span>BUILT FOR COMMUNITY</span>${icon}</span></div>
<section class="dashboard"><div class="dashboard-left"><div class="block-label"><span>01 / KONDISI SERVER</span><span class="small-badge">✳ DATA CONTOH</span></div><div class="main-card"><div class="card-topline"><span>CONTROL ROOM / ZENTIXBOT</span><span class="lamp">● &nbsp; PREVIEW</span></div><div><h2>Komunitas yang baik,<br>dimulai dari sini.</h2><p>Panel utama untuk melihat kondisi dan mengelola server Discord kamu.</p></div><div class="card-bottomline"><span>BOT STATUS <strong> / BELUM TERHUBUNG</strong></span><span>↗ &nbsp; 01</span></div></div><div class="metrics"><div class="metric"><div class="metric-top">STATUS <span>↗</span></div><strong>—</strong><small>Bot</small></div><div class="metric"><div class="metric-top">MEMBER <span>↗</span></div><strong>—</strong><small>Anggota</small></div><div class="metric"><div class="metric-top">PING <span>↗</span></div><strong>—</strong><small>Milidetik</small></div><div class="metric"><div class="metric-top">UPTIME <span>↗</span></div><strong>—</strong><small>Durasi aktif</small></div></div></div>
<div class="dashboard-right" id="systemUsage"><div class="block-label"><span>02 / PEMAKAIAN SISTEM</span><span class="usage-state">✳ DATA CONTOH</span></div><h2 class="right-title">Di balik layar.</h2><p class="right-desc">CPU, RAM, jaringan dan disk hosting bot dalam satu pandangan.</p><div class="usage-grid"><article class="usage-card" data-usage="cpu"><div class="usage-label"><span>01 / CPU</span><span aria-hidden="true">◉</span></div><div class="usage-value">24<span>%</span></div><div class="usage-sub">DARI 100% · CONTOH</div><div class="progress" aria-hidden="true"><i style="width:24%"></i></div></article><article class="usage-card" data-usage="memory"><div class="usage-label"><span>02 / RAM</span><span aria-hidden="true">▦</span></div><div class="usage-value">384<span> MB</span></div><div class="usage-sub">DARI 1 GB · CONTOH</div><div class="progress" aria-hidden="true"><i style="width:38%"></i></div></article><article class="usage-card" data-usage="network"><div class="usage-label"><span>03 / JARINGAN</span><span aria-hidden="true">⇅</span></div><div class="usage-net"><div><em>↓ MASUK</em><strong><b>142</b><span> KB/s</span></strong></div><div><em>↑ KELUAR</em><strong><b>38</b><span> KB/s</span></strong></div></div><div class="usage-sub">MASUK / KELUAR · CONTOH</div></article><article class="usage-card" data-usage="disk"><div class="usage-label"><span>04 / DISK</span><span aria-hidden="true">▱</span></div><div class="usage-value">1.2<span> GB</span></div><div class="usage-sub">DARI 5 GB · CONTOH</div><div class="progress" aria-hidden="true"><i style="width:24%"></i></div></article></div><div class="usage-foot"><span>✳ SELURUH ANGKA ADALAH CONTOH STATIS.</span><span>DATA NYATA SETELAH LOGIN ↗</span></div></div></section>
<section class="quick-section" aria-labelledby="quick-heading"><div class="section-header"><h2 id="quick-heading">Akses<br>cepat<span style="color:#c4f82a">.</span></h2><p>03 / AKSES CEPAT /<br>KERJA LEBIH MUDAH</p></div><p class="right-desc">Akses ruang utama untuk setiap kebutuhan komunitasmu.</p><div class="module-list quick-list"><button class="module-row" data-go="features"><span class="module-num">01</span><span class="module-symbol">▧</span><span class="module-name"><strong>Fitur bot</strong><small>KELOLA KOMUNITAS</small></span><span class="module-arrow">↗</span></button><button class="module-row" data-go="ai"><span class="module-num">02</span><span class="module-symbol">✳</span><span class="module-name"><strong>AI studio</strong><small>KECERDASAN UNTUK SERVER</small></span><span class="module-arrow">↗</span></button><button class="module-row" data-go="settings"><span class="module-num">03</span><span class="module-symbol">☷</span><span class="module-name"><strong>Pengaturan</strong><small>KONTROL & AKSES</small></span><span class="module-arrow">↗</span></button></div><div class="bottom-note"><span><strong>Satu bot. Satu server.</strong><br>Semua fokus untuk komunitasmu.</span><button class="round-arrow" data-go="features" aria-label="Jelajahi fitur">↗</button></div></section>`;
const pageTemplates={
 overview,
 features:()=>window.ZentixFeatures.render(location.hash.split('/')[1]||''),
 ai:()=>window.ZentixAI.render(location.hash.split('/')[1]||''),
 settings:()=>window.ZentixSettings?.enabled?window.ZentixSettings.render():`<section class="placeholder-head"><div class="kicker"><span class="pill-num">04 / PENGATURAN</span><i></i> YOUR CONTROL CENTER</div><h1>Semua dalam<br>kendali.</h1><p>Pengaturan untuk bot, akses dashboard, dan koneksi yang dibutuhkan server.</p></section>${placeholder(settings)}`
};
let current='overview', toastTimer;
function closeMenu(){ $('#mobileMenu').hidden=true;$('#mobileTrigger').setAttribute('aria-expanded','false');$('#mobileTrigger').setAttribute('aria-label','Buka menu navigasi'); }
function showToast(text){let el=$('#toast');el.textContent=text;el.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('show'),3500)}
function render(resetScroll=true){let page=location.hash.slice(1).split('/')[0]; current=Object.hasOwn(pageTemplates,page)?page:'overview';main.innerHTML=pageTemplates[current]();document.querySelectorAll('.dock-item').forEach(b=>{let selected=b.dataset.page===current;b.classList.toggle('active',selected);if(selected)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current')});document.querySelectorAll('.mobile-menu button').forEach(b=>{let selected=b.dataset.page===current;if(selected)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current')});document.querySelectorAll('[data-go]',main).forEach(b=>b.onclick=()=>navigate(b.dataset.go));if(current==='features')window.ZentixFeatures.bind(main,location.hash.split('/')[1]||'',render,showToast);if(current==='ai')window.ZentixAI.bind(main,location.hash.split('/')[1]||'',render,showToast);if(current==='settings'&&window.ZentixSettings?.enabled)window.ZentixSettings.bind(main);window.ZentixLive?.afterRender(main,current);closeMenu();if(resetScroll)window.scrollTo(0,0)}
function navigate(page){if(location.hash==='#'+page)render();else location.hash=page}
document.querySelectorAll('[data-page]').forEach(b=>b.addEventListener('click',()=>navigate(b.dataset.page)));
$('#mobileTrigger').addEventListener('click',()=>{let isOpen=$('#mobileTrigger').getAttribute('aria-expanded')==='true';$('#mobileMenu').hidden=isOpen;$('#mobileTrigger').setAttribute('aria-expanded',String(!isOpen));$('#mobileTrigger').setAttribute('aria-label',isOpen?'Buka menu navigasi':'Tutup menu navigasi')});
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeMenu()});document.addEventListener('click',e=>{if(!e.target.closest('.nav-wrap'))closeMenu()});
if (!window.ZentixLive?.enabled) $('#profileButton').addEventListener('click',()=>showToast('Preview statis: login dan akun belum terhubung.'));
function updateClock(){try{$('#clock').textContent=new Intl.DateTimeFormat('id-ID',{timeZone:'Asia/Jakarta',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date()).replace('.',':')}catch{$('#clock').textContent='--:--'}}
updateClock();setInterval(updateClock,60000);window.addEventListener('hashchange',()=>render());render();
