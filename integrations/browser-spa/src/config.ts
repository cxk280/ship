/**
 * Configuration for the Ship browser SPA demo.
 *
 * Override via a .env.local Vite file:
 *   VITE_SHIP_BASE_URL=http://localhost:3000
 *   VITE_CLIENT_ID=ship_app_spa
 */

export const BASE_URL: string = import.meta.env.VITE_SHIP_BASE_URL ?? 'http://localhost:3000';
export const CLIENT_ID: string = import.meta.env.VITE_CLIENT_ID ?? 'ship_app_spa';
export const REDIRECT_URI: string = `${window.location.origin}/callback`;
export const SCOPES = 'documents:read';
