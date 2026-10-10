// Browsers won't run the form's scripts on a page opened straight from disk,
// so explain how to start the server instead of showing a half-working form.
if (location.protocol === 'file:') {
  const notice = document.createElement('div');
  notice.className = 'notice notice-warn';
  notice.setAttribute('role', 'alert');
  notice.textContent = 'You opened this file directly, so the form can’t run. In the project folder, run “npm install” and then “npm start”, and open http://localhost:3000 in your browser.';
  document.querySelector('main')?.prepend(notice);
}
