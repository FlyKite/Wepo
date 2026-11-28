/**
 * 微仓助手 Tauri 桥接层。
 * 让原有渲染逻辑继续调用 window.wepo，而不需要依赖 Electron。
 */
(function initTauriBridge() {
  const tauri = window.__TAURI__;
  if (!tauri || !tauri.core || !tauri.event) {
    console.error('Tauri API 未注入，无法启动微仓助手');
    return;
  }

  const { invoke } = tauri.core;
  const { listen } = tauri.event;
  let importEventHandler = null;
  let unsubscribeImportEvent = null;

  // Tauri 的 listen 是异步注册；提前订阅并缓存回调，避免导入开始时的首批事件丢失。
  listen('import-event', (event) => {
    if (importEventHandler) importEventHandler(event.payload);
  }).then((unlisten) => {
    unsubscribeImportEvent = unlisten;
  }).catch((err) => {
    console.error('订阅导入事件失败:', err);
  });

  window.wepo = {
    selectBackupDir: () => invoke('select_backup_dir'),
    selectBackupZip: () => invoke('select_backup_zip'),
    pathExists: (target) => invoke('path_exists', { target }),
    startImport: (payload) => invoke('start_import', { payload }),
    cancelImport: () => invoke('cancel_import'),
    openViewer: (url) => invoke('open_viewer', { url }),
    onImportEvent: (callback) => {
      importEventHandler = callback;
      return () => {
        if (importEventHandler === callback) importEventHandler = null;
      };
    },
    _unsubscribe: () => {
      if (unsubscribeImportEvent) unsubscribeImportEvent();
      unsubscribeImportEvent = null;
    },
  };
})();
