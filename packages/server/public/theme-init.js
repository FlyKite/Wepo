/**
 * 外观初始化:在 CSS 加载前应用主题,避免页面闪烁。
 * 偏好保存在 localStorage 的 wepo.theme:system | light | dark
 */
(function () {
  var choice = 'system';
  try {
    var saved = localStorage.getItem('wepo.theme');
    if (saved === 'light' || saved === 'dark' || saved === 'system') choice = saved;
  } catch (err) {
    /* localStorage 不可用时按跟随系统处理 */
  }
  var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  var dark = choice === 'dark' || (choice === 'system' && prefersDark);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.dataset.themeChoice = choice;
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#1c1c1c' : '#ededed');
})();
