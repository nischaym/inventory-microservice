# Inventory Service

Dealership vehicle inventory service: ingests full-snapshot feeds and serves active and removed inventory. See [spec.md](spec.md) for requirements, design and decisions, and [docs/openapi.json](docs/openapi.json) for the API.

## Run locally

Requires Node.js 22.13 or newer.

```bash
npm ci
npm run build
DATA_DIR=./.data npm start
```

`npm start` runs the compiled `dist/main.js` and does **not** compile first. Run `npm run build` on a fresh checkout and after every source change; otherwise `start` fails because `dist/` is missing, or runs stale code.

The service listens on port 8080. Check it with:

```bash
curl http://localhost:8080/healthz
```

### Configuration

| Variable    | Default | Meaning                                                    |
|-------------|---------|------------------------------------------------------------|
| `PORT`      | `8080`  | HTTP port                                                  |
| `DATA_DIR`  | `/data` | Directory for the SQLite database (created if missing)     |
| `LOG_LEVEL` | `info`  | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent` |

`/data` is the container volume path and is usually not writable on a development machine, so set `DATA_DIR` when running locally.

## Run the delivered image

The image ships as a `linux/amd64` archive in `artifacts/`, with a SHA-256 checksum next to it. Requires Docker.

1. Verify the archive and load it:

   ```bash
   cd artifacts
   ```

   ```bash
   shasum -a 256 -c inventory-service-linux-amd64.tar.gz.sha256
   ```

   ```bash
   docker load -i inventory-service-linux-amd64.tar.gz
   ```

   This loads the image as `inventory-service:local`.

2. Run it with the production constraints (read-only filesystem, no capabilities, 512 MB, 1 CPU). Data lives in the named volume `inventory-data`:

   ```bash
   docker run -d --name inventory-service --platform linux/amd64 --read-only --tmpfs /tmp --cap-drop ALL --memory 512m --cpus 1 -v inventory-data:/data -p 8080:8080 inventory-service:local
   ```

   `--platform linux/amd64` only silences the platform warning on Apple Silicon or other arm64 hosts, where Docker runs the image under emulation.

3. Check that it is healthy. The image has a Docker `HEALTHCHECK` on `/healthz`; the status becomes `healthy` within a few seconds:

   ```bash
   curl http://localhost:8080/healthz
   ```

   ```bash
   docker inspect -f '{{.State.Health.Status}}' inventory-service
   ```

4. Optionally, replay the brief's March 15 and 16 feeds and print the resulting inventory:

   ```bash
   scripts/replay-example.sh
   ```

5. Stop it. The service shuts down cleanly on `SIGTERM`, and the data stays in the volume for the next `docker start inventory-service`:

   ```bash
   docker stop inventory-service
   ```

   To delete the container and its data:

   ```bash
   docker rm inventory-service && docker volume rm inventory-data
   ```

If the service logs a permission error on `/data`, the volume already existed and is owned by root. Docker copies the image's `/data` ownership (user `10001`) only into a new, empty volume. Remove the volume and run again, or `chown` it to `10001:10001`.

To rebuild the image and archive from source, run `scripts/export-image.sh`. To check the image end to end (health, example replay, restart persistence, read-only, no network), run `scripts/container-smoke.sh`.

## Test

```bash
npm run typecheck
npm test
```

## Technical Decisions / Limitations / Scaling

Please refer to the spec.md for these sections. I treated the spec.md as essentially a technical design doc. so all the additional details can be found in it.


## API

Base path `/v1`. Full schema: [docs/openapi.json](docs/openapi.json).

| Method and path | Definition |
|---|---|
| `POST /v1/feeds` | Ingest a dealership's full-snapshot feed; returns `201` when applied, `200` when it is an identical replay. |
| `GET /v1/dealerships` | List known dealerships with their latest `feedDate` and active vehicle count. |
| `GET /v1/dealerships/{dealershipId}/vehicles` | List a dealership's active vehicles, ordered by VIN, filterable by `condition`, `lotStatus`, `make` and `maxPrice`. |
| `GET /v1/dealerships/{dealershipId}/vehicles?status=removed` | List the dealership's removed vehicles, with the same filters available. |
| `GET /v1/dealerships/{dealershipId}/vehicles/{vin}` | Get one vehicle by VIN, whether active or removed. |
| `GET /healthz` | Report service health; returns `200` when the database is usable, `503` otherwise. |



## 12. Deliverables checklist

- [] Repository public, or shared with the `C-4Engineering` GitHub org
- [ ] `Dockerfile` + prebuilt `linux/amd64` image (registry digest or archive with load instructions)
- [ ] `README.md`: build/run/test, API, architecture and decisions (D-1…D-10), scale notes, assumptions, limitations
- [ ] `scripts/replay-example.sh` (and `examples/*.json`) replaying March 15/16
- [ ] Automated tests passing
- [ ] `AI_DEVELOPMENT.md`
- [ ] Email to the three addressees in the brief