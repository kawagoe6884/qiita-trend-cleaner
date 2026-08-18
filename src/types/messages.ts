/** content script -> service worker */
export type QtgRequest = { type: 'PING' };

/** service worker -> content script */
export type QtgResponse = { type: 'PONG'; version: string };
