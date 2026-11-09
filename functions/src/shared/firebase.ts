import {getApp, getApps, initializeApp, type AppOptions} from 'firebase-admin/app';

// Lazy initialization lets every topic reuse the default app without doing
// credential or service setup during Firebase's function discovery.
export function getAdminApp(options?: AppOptions) {
  return getApps().some(app => app.name === '[DEFAULT]') ? getApp() : initializeApp(options);
}
