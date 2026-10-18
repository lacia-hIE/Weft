// Keep this entry independent of the application module graph so a rejected
// chunk produces a recoverable error instead of a permanent loading message.
const applicationModule = '/assets/app.js';
void import(applicationModule).catch(() => {
  const root = document.getElementById('root');
  if (!root) return;
  const message = document.createElement('p');
  message.textContent = '界面资源加载失败，请刷新页面重试。';
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.textContent = '重新加载';
  retry.addEventListener('click', () => location.reload());
  root.replaceChildren(message, retry);
});
