import path from 'node:path';
import { app, dialog } from 'electron';

// Separate entry: no viewer lock, profiles, owner sockets or terminal initialization.
app.on('window-all-closed', () => {});
process.on('SIGTERM', () => app.exit(0));
app
  .whenReady()
  .then(async () => {
    const host = process.argv[2];
    // Mirrors ALIAS_PATTERN in sshCommand.ts; ssh aliases may contain @ (user@pool jump hosts).
    if (!host || !/^[A-Za-z0-9][A-Za-z0-9._@-]{0,252}$/.test(host))
      throw new Error('Invalid upload host');
    const chosen = await dialog.showOpenDialog({
      title: `Choose one file to upload to ${host}`,
      buttonLabel: 'Choose file',
      properties: ['openFile'],
    });
    if (chosen.canceled || chosen.filePaths.length !== 1) {
      app.exit(0);
      return;
    }
    const file = chosen.filePaths[0];
    if (!file) throw new Error('No chosen file');
    const confirmation = await dialog.showMessageBox({
      type: 'question',
      title: 'Upload file',
      message: `Upload ${path.basename(file)} to ${host}?`,
      detail: 'The remote website will be able to read this file.',
      buttons: ['Cancel', 'Upload'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (confirmation.response === 1) {
      process.stdout.write(`${JSON.stringify({ file })}\n`, () => app.exit(0));
    } else app.exit(0);
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
