import { contextBridge, ipcRenderer } from 'electron';
const methods = [
  'checkUpdate',
  'installUpdate',
  'task',
  'deleteTasks',
  'removeAccount',
  'resetLocalData',
  'refreshAvatars',
  'bootstrap',
  'list',
  'permissions',
  'inspect',
  'preview',
  'submit',
  'control',
  'settings',
  'importCredentials',
  'authorize',
  'disconnect',
  'switchMode',
  'exportSnapshot',
  'exportReport',
  'openExternal',
  'copyLinks',
];
contextBridge.exposeInMainWorld(
  'workbench',
  Object.freeze({
    ...Object.fromEntries(
      methods.map((name) => [
        name,
        (...args: unknown[]) => ipcRenderer.invoke(`workbench:${name}`, ...args),
      ]),
    ),
    onScanProgress(callback: (progress: unknown) => void) {
      const listener = (_event: unknown, progress: unknown) => callback(progress);
      ipcRenderer.on('workbench:scanProgress', listener);
      return () => {
        ipcRenderer.removeListener('workbench:scanProgress', listener);
      };
    },
  }),
);
