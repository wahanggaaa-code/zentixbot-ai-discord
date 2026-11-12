if (location.pathname.startsWith('/dashboard/')) {
  window.ZentixSession = fetch('/dashboard/api/me', {cache:'no-store'}).then(async response => {
    if (!response.ok) throw new Error('Sesi tidak lagi memiliki akses.');
    const data = await response.json();
    const button = document.getElementById('profileButton');
    button.textContent = data.user.username.slice(0, 1).toUpperCase();
    button.title = `${data.user.username} · ${data.guild.name} — klik untuk keluar`;
    button.addEventListener('click', async () => {
      if (!confirm(`Keluar dari akun ${data.user.username}?`)) return;
      const result = await fetch('/dashboard/api/logout', {method:'POST',headers:{'x-csrf-token':data.csrf}});
      if (result.ok) location.assign('/dashboard/login'); else alert('Gagal keluar. Coba lagi.');
    });
    return data;
  }).catch(error => { location.assign('/dashboard/login'); throw error; });
}
