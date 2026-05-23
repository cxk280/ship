# Railway Deployment

Deployment date: 2026-05-23

## Railway Resources

| Resource | Value |
|---|---|
| Project | `shipshape` |
| Project ID | `904aa42d-be5e-449e-8b8f-ce7f6bf1805c` |
| Environment | `production` |
| Environment ID | `11619a13-d887-4e7b-ad97-ebe66f68bd4f` |
| App service | `shipshape-app` |
| App service ID | `87837a16-2b65-4866-bff7-5db30aafc068` |
| Postgres service | `Postgres` |
| Postgres service ID | `e6bf1a48-f998-40c2-b89f-05224d28fcbc` |
| Public URL | `https://shipshape-app-production-7ed8.up.railway.app` |

## Verification

- `GET https://shipshape-app-production-7ed8.up.railway.app/health` returned `200` with `{"status":"ok"}`.
- `HEAD https://shipshape-app-production-7ed8.up.railway.app/` returned `200` and served `text/html`.
- `GET /api/setup/status` returned `{"needsSetup": false}` after initialization.
- Login verified with:
  - Email: `dev@ship.local`
  - Password: `admin123`

## Deployment Notes

- The Railway MCP created one initial project ID, but subsequent MCP mutations intermittently returned `Unauthorized`. The completed deployment was performed with the authenticated Railway CLI session after confirming `railway whoami`.
- The application is deployed as a single Docker service that builds API, shared, and web packages, runs DB migrations on start, serves the React app from Express, and uses Railway Postgres through `DATABASE_URL`.
- Runtime `NODE_ENV` is currently `development` on Railway to bypass the app's AWS SSM production-secret bootstrap. `LOAD_SSM=false` and a code-level Railway SSM bypass are also committed for the Docker build path.
