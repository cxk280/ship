/**
 * Side-effect import that forces every v1 route module to load, so the route-meta
 * registry and the OpenAPI path registrations are populated before generation /
 * fitness checks. (Importing the router pulls in /me and /documents.)
 */
import '../api/v1/router.js';
import './registry.js';
