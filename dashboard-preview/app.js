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
const placeholder = (items) => `<div class="placeholder-grid">${items.map(([n,title,desc,s])=>`<article class="placeholder-card"><div class="card-number"><span>${n} / ZENTIX</span><span>${s}</span></div><h3>${title}</h3><p>${desc}</p><div class="soon">UI TERENCANA <span aria-hidden="true">↗</span></div></article>`).join('')}</div><div class="notice-panel"><div class="notice-icon">✳</div><div><strong>Fondasi UI, belum terhubung.</strong><p>Halaman dan kontrol fitur akan dirancang serta dihubungkan pada tahap berikutnya.</p></div></div>`;
const overview=()=>`<section class="intro"><div><div class="kicker"><span class="pill-num">01 / OVERVIEW</span><i></i> YOUR COMMUNITY, IN CONTROL</div><h1>Ruang untuk<br><span class="outline">komunitasmu.</span></h1><p class="intro-copy">Semua yang kamu butuhkan untuk mengelola server, dalam satu tempat yang terasa seperti rumah.</p></div><aside class="intro-side"><span>✳ &nbsp; THE CONTROL ROOM</span><p>Lebih sedikit mengurus. Lebih banyak membangun komunitas.</p><div class="arrow">↘</div></aside></section>
<div class="ticker"><span>SERVER OVERVIEW &nbsp; / &nbsp; 01</span><span class="ticker-right"><span>BUILT FOR COMMUNITY</span>${icon}</span></div>
<section class="dashboard"><div class="dashboard-left"><div class="block-label"><span>01 / KONDISI SERVER</span><span class="small-badge">✳ DATA CONTOH</span></div><div class="main-card"><div class="card-topline"><span>CONTROL ROOM / ZENTIXBOT</span><span class="lamp">● &nbsp; PREVIEW</span></div><div><h2>Komunitas yang baik,<br>dimulai dari sini.</h2><p>Panel utama untuk melihat kondisi dan mengelola server Discord kamu.</p></div><div class="card-bottomline"><span>BOT STATUS <strong> / BELUM TERHUBUNG</strong></span><span>↗ &nbsp; 01</span></div></div><div class="metrics"><div class="metric"><div class="metric-top">STATUS <span>↗</span></div><strong>—</strong><small>Bot</small></div><div class="metric"><div class="metric-top">MEMBER <span>↗</span></div><strong>—</strong><small>Anggota</small></div><div class="metric"><div class="metric-top">PING <span>↗</span></div><strong>—</strong><small>Milidetik</small></div><div class="metric"><div class="metric-top">UPTIME <span>↗</span></div><strong>—</strong><small>Durasi aktif</small></div></div></div>
<div class="dashboard-right"><div class="block-label"><span>02 / AKSES CEPAT</span><span>ALL SYSTEMS ↗</span></div><h2 class="right-title">Kerja lebih mudah.</h2><p class="right-desc">Akses ruang utama untuk setiap kebutuhan komunitasmu.</p><div class="module-list"><button class="module-row" data-go="features"><span class="module-num">01</span><span class="module-symbol">▧</span><span class="module-name"><strong>Fitur bot</strong><small>KELOLA KOMUNITAS</small></span><span class="module-arrow">↗</span></button><button class="module-row" data-go="ai"><span class="module-num">02</span><span class="module-symbol">✳</span><span class="module-name"><strong>AI studio</strong><small>KECERDASAN UNTUK SERVER</small></span><span class="module-arrow">↗</span></button><button class="module-row" data-go="settings"><span class="module-num">03</span><span class="module-symbol">☷</span><span class="module-name"><strong>Pengaturan</strong><small>KONTROL & AKSES</small></span><span class="module-arrow">↗</span></button></div><div class="bottom-note"><span><strong>Satu bot. Satu server.</strong><br>Semua fokus untuk komunitasmu.</span><button class="round-arrow" data-go="features" aria-label="Jelajahi fitur">↗</button></div></div></section>
<section><div class="section-header"><h2>Dibuat untuk<br>lebih dekat<span style="color:#c4f82a">.</span></h2><p>FITUR PILIHAN /<br>SEMUANYA DALAM SATU TEMPAT</p></div><div class="collection"><button class="collection-card" data-go="features"><div class="collection-top"><span>01 / KOMUNITAS</span><span>↗</span></div><h3>Welcome.</h3><p>Sambut setiap anggota baru dengan kesan yang personal.</p><div class="collection-bottom"><span class="label">WELCOME</span><span>01 — 03</span></div></button><button class="collection-card" data-go="ai"><div class="collection-top"><span>02 / CERDAS</span><span>↗</span></div><h3>AI studio.</h3><p>Ide, bantuan, dan aktivitas yang bikin komunitas lebih hidup.</p><div class="collection-bottom"><span class="label">AI FEATURES</span><span>02 — 03</span></div></button><button class="collection-card" data-go="features"><div class="collection-top"><span>03 / SUPPORT</span><span>↗</span></div><h3>Ticket.</h3><p>Kelola percakapan dan bantu anggota di tempat yang tepat.</p><div class="collection-bottom"><span class="label">SUPPORT</span><span>03 — 03</span></div></button></div></section>`;
const pageTemplates={
 overview,
 features:()=>`<section class="placeholder-head"><div class="kicker"><span class="pill-num">02 / FITUR BOT</span><i></i> COMMUNITY TOOLS</div><h1>Semua yang<br>kamu butuh.</h1><p>Satu ruang untuk fitur-fitur yang menjaga komunitas tetap nyaman, aktif, dan terhubung.</p></section>${placeholder(botFeatures)}`,
 ai:()=>`<section class="placeholder-head"><div class="kicker"><span class="pill-num">03 / AI STUDIO</span><i></i> INTELLIGENCE FOR COMMUNITY</div><h1>Ide baru.<br><span style="color:#d4ff51">Cara baru.</span></h1><p>Ruang untuk mengelola fitur AI, dari sapaan yang personal hingga alat bantu komunitas.</p></section>${placeholder(aiFeatures)}`,
 settings:()=>`<section class="placeholder-head"><div class="kicker"><span class="pill-num">04 / PENGATURAN</span><i></i> YOUR CONTROL CENTER</div><h1>Semua dalam<br>kendali.</h1><p>Pengaturan untuk bot, akses dashboard, dan koneksi yang dibutuhkan server.</p></section>${placeholder(settings)}`
};
let current='overview', toastTimer;
function closeMenu(){ $('#mobileMenu').hidden=true;$('#mobileTrigger').setAttribute('aria-expanded','false');$('#mobileTrigger').setAttribute('aria-label','Buka menu navigasi'); }
function showToast(text){let el=$('#toast');el.textContent=text;el.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('show'),3500)}
function render(){let page=location.hash.slice(1); current=Object.hasOwn(pageTemplates,page)?page:'overview';main.innerHTML=pageTemplates[current]();document.querySelectorAll('.dock-item').forEach(b=>{let selected=b.dataset.page===current;b.classList.toggle('active',selected);if(selected)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current')});document.querySelectorAll('.mobile-menu button').forEach(b=>{let selected=b.dataset.page===current;if(selected)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current')});document.querySelectorAll('[data-go]',main).forEach(b=>b.onclick=()=>navigate(b.dataset.go));closeMenu();window.scrollTo(0,0)}
function navigate(page){if(location.hash==='#'+page)render();else location.hash=page}
document.querySelectorAll('[data-page]').forEach(b=>b.addEventListener('click',()=>navigate(b.dataset.page)));
$('#mobileTrigger').addEventListener('click',()=>{let isOpen=$('#mobileTrigger').getAttribute('aria-expanded')==='true';$('#mobileMenu').hidden=isOpen;$('#mobileTrigger').setAttribute('aria-expanded',String(!isOpen));$('#mobileTrigger').setAttribute('aria-label',isOpen?'Buka menu navigasi':'Tutup menu navigasi')});
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeMenu()});document.addEventListener('click',e=>{if(!e.target.closest('.nav-wrap'))closeMenu()});
$('#profileButton').addEventListener('click',()=>showToast('Preview tahap 1: login dan akun belum terhubung.'));
function updateClock(){try{$('#clock').textContent=new Intl.DateTimeFormat('id-ID',{timeZone:'Asia/Jakarta',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date()).replace('.',':')}catch{$('#clock').textContent='--:--'}}
updateClock();setInterval(updateClock,60000);window.addEventListener('hashchange',render);render();
