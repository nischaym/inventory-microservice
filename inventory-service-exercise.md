# AI-Assisted Inventory Service

## Objective

Build a working, documented HTTP microservice that manages vehicle inventory for dealerships.

We want to see how you use AI to turn product requirements into a well-designed, verified technical implementation. Expect to use AI assistants throughout the exercise.

## What we're evaluating

In rough order of importance:

1. **Correctness of the inventory behavior.** The snapshot semantics described below are handled correctly, including the edge cases.
2. **Domain modeling and design.** Inventory concepts and rules are expressed clearly in the code and kept separate from HTTP and storage concerns. Apply design principles such as SOLID where they earn their place; we value a clear, proportionate design over maximum abstraction.
3. **Verification.** Automated tests show that the service does what the requirements say, and you can explain how you checked the AI's work.
4. **Judgment.** You make sensible decisions where the requirements leave room, and you document them along with their trade-offs.
5. **Operability.** The container meets the requirements below and runs on the first try.
6. **Communication.** The repository documentation lets another engineer run, use, and extend the service, and your report explains how you worked.

We are not evaluating which AI tool or model you use, visual polish, or the amount of code you produce.

## AI tools

Use whichever AI tools and workflow you like.

You don't need to pay for anything. Many AI tools have free tiers, including agentic coding tools that can edit files and run commands for you (for example, Gemini CLI or GitHub Copilot Free). You may also use any paid tools you already have. We do not provide or reimburse tools.

## Timebox

Aim to spend about **two hours**. Four hours is the absolute maximum, including any setup.

Spend your time on reviewing and verifying what the AI produces, not on polish. If you reach the limit before completing everything, submit what you have and document what remains. Please record the actual time you spent in your report.

## Questions

Feel free to ask us questions at any time. If you'd rather not wait for an answer, make a reasonable assumption and document it.

## Technical freedom

You may use any programming language, framework, libraries, or development tools.

The solution must:

- Provide an HTTP API that accepts feeds as JSON request bodies and serves inventory queries
- Require no frontend
- Require no external database or other external service
- Include automated tests
- Be delivered as a runnable container image
- Include documentation describing the API and important technical decisions

The API structure, internal architecture, validation approach, and storage design are yours to decide.

## Product context

Each dealership's inventory provider sends a scheduled export from the dealership's inventory system. Each feed is a **complete snapshot** of the vehicles the dealership currently wants published, not a list of changes. Vehicles that are sold or otherwise removed simply disappear from the next snapshot.

The service holds inventory for multiple dealerships. A feed affects only the dealership named in that feed. A dealership becomes known to the service when its first feed is accepted.

Staff need to be able to:

- Ingest a dealership's daily inventory feed
- View a dealership's active inventory
- Find a vehicle by VIN
- Filter inventory by relevant vehicle attributes
- See how long a vehicle has been in inventory
- Look up vehicles that have been removed from inventory
- List the dealerships the service knows about, with each one's most recently accepted `feedDate` and number of active vehicles

## Terminology

- **Active**: the vehicle appears in the dealership's most recently accepted feed and is currently for sale.
- **Removed**: the vehicle appeared in an earlier feed but is absent from the most recently accepted feed.
- **Lot status** (`lotStatus` in the feed): where an active vehicle physically is, either `on_lot` or `in_transit`. Both values mean the vehicle is for sale.

## Inventory behavior

Within a dealership, a VIN identifies a vehicle.

When a dealership's feed is accepted:

- A VIN th at has not appeared before becomes a new active vehicle.
- A VIN that is already active is updated with the latest information.
- An active VIN that is missing from the feed becomes removed.
- A removed vehicle remains retrievable by VIN.
- A removed VIN may appear in a later feed. It becomes active again, and its details, including `stockedOn`, come from that feed.
- Submitting the same feed more than once does not create duplicate vehicles or otherwise change inventory.
- Feed acceptance is all-or-nothing. If any part of a feed is invalid, the entire feed is rejected and inventory is unchanged.

Staff commonly narrow a dealership's active inventory by:

- Condition
- Lot status
- Make
- Maximum price

Results should be returned in a stable order that you choose and document. Pagination is not required.

### Days in inventory

"Days in inventory" is the number of calendar days from `stockedOn` to a reference date:

- For an **active** vehicle, the reference date is the current date in UTC.
- For a **removed** vehicle, the reference date is the `feedDate` of the feed in which the vehicle was first absent. The value stops increasing once the vehicle is removed.

### Decisions left to you

The requirements deliberately don't specify the following. Decide how your service handles each one and document your reasoning:

- A feed arrives with a `feedDate` earlier than one already accepted for that dealership.
- A feed arrives with the same `feedDate` as an accepted feed but different contents.
- A feed contains an empty `vehicles` array.
- Two feeds for the same dealership are submitted at the same time.

## Incoming data

A feed contains a dealership identifier, the date the feed represents, and the complete inventory for that date.

Example:

```json
{
  "dealershipId": "LHS-1042",
  "feedDate": "2026-03-15",
  "vehicles": [
    {
      "vin": "2HGFE1F71NH304352",
      "stockNumber": "H2401",
      "condition": "used",
      "lotStatus": "on_lot",
      "year": 2022,
      "make": "Honda",
      "model": "Civic",
      "trim": "EX",
      "price": 18495,
      "mileage": 41850,
      "stockedOn": "2026-02-03"
    },
    {
      "vin": "5J6RS4H84TL012345",
      "stockNumber": "H2410",
      "condition": "new",
      "lotStatus": "on_lot",
      "year": 2026,
      "make": "Honda",
      "model": "CR-V",
      "trim": "EX-L",
      "price": 34250,
      "mileage": 8,
      "stockedOn": "2026-03-05"
    },
    {
      "vin": "1HGCY1F39TA098765",
      "stockNumber": "H2418",
      "condition": "new",
      "lotStatus": "in_transit",
      "year": 2026,
      "make": "Honda",
      "model": "Accord",
      "trim": "Sport",
      "price": 31480,
      "mileage": 4,
      "stockedOn": "2026-03-10"
    }
  ]
}
```

Field rules:

- All fields are required except `trim`, which may be omitted.- `vin` is 17 characters. Comparisons ignore surrounding whitespace and letter case. Check-digit validation is optional; every VIN in this document is valid.
- `condition` is `new`, `used`, or `certified`.
- `lotStatus` is `on_lot` or `in_transit`.
- `year` is a four-digit model year.
- `price` is a positive whole number of dollars.
- `mileage` is a non-negative whole number.
- Dates use `YYYY-MM-DD`.
- A VIN may appear only once in a feed. A feed with duplicate VINs is invalid.
- Stock numbers are dealership labels, not unique vehicle identifiers.

## Example feed progression

On March 15, dealership `LHS-1042` sends the preceding feed.

On March 16, it sends:

```json
{
  "dealershipId": "LHS-1042",
  "feedDate": "2026-03-16",
  "vehicles": [
    {
      "vin": "2hgfe1f71nh304352",
      "stockNumber": "H2401",
      "condition": "used",
      "lotStatus": "on_lot",
      "year": 2022,
      "make": "Honda",
      "model": "Civic",
      "trim": "EX",
      "price": 17995,
      "mileage": 41910,
      "stockedOn": "2026-02-03"
    },
    {
      "vin": "5J6RS4H84TL012345",
      "stockNumber": "H2410",
      "condition": "new",
      "lotStatus": "on_lot",
      "year": 2026,
      "make": "Honda",
      "model": "CR-V",
      "trim": "EX-L",
      "price": 34250,
      "mileage": 8,
      "stockedOn": "2026-03-05"
    },
    {
      "vin": "5FNYG1H78RB033333",
      "stockNumber": "H2422",
      "condition": "used",
      "lotStatus": "on_lot",
      "year": 2024,
      "make": "Honda",
      "model": "Pilot",
      "trim": "TrailSport",
      "price": 38900,
      "mileage": 22140,
      "stockedOn": "2026-03-16"
    }
  ]
}
```

After the March 16 feed:

- The Civic is active, with its new price and mileage.
- The lowercase Civic VIN does not create a second vehicle.
- The CR-V is active and unchanged.
- The Pilot is a new active vehicle.
- The Accord is removed because it is absent, and it can still be retrieved by VIN.
- The Accord's days in inventory is 6 (March 10 to March 16) and stays 6.
- Submitting the March 16 feed again does not change inventory.
- No other dealership's inventory is affected.

## Invalid data example

This vehicle is invalid because `cpo` is not a supported condition:

```json
{
  "vin": "5J6RS4H84TL012345",
  "stockNumber": "H2410",
  "condition": "cpo",
  "lotStatus": "on_lot",
  "year": 2026,
  "make": "Honda",
  "model": "CR-V",
  "trim": "EX-L",
  "price": 34250,
  "mileage": 8,
  "stockedOn": "2026-03-05"
}
```

When a feed is rejected, staff should receive an explanation that identifies what is wrong and where, and the previously accepted inventory must remain intact.

## Container requirements

Deliver the completed service as a prebuilt OCI-compatible container image.

The image must:

- Be built for `linux/amd64`
- Start the service using its default container command
- Listen for HTTP traffic on port `8080`
- Run without internet access or external services
- Run as a non-root user
- Require no credentials or secrets
- Provide and document a way to determine when the service is healthy

We will run your image with this command:

```
docker run --read-only --tmpfs /tmp --cap-drop ALL \
  --memory 512m --cpus 1 \
  -v inventory-data:/data -p 8080:8080 <your-image>
```

This means:

- The root filesystem is read-only. Only `/data` and `/tmp` are writable.
- `/data` starts as an empty named volume. Store all persistent application data there, and make sure your image creates `/data` with ownership that lets your non-root user write to it.
- All Linux capabilities are dropped.
- The container is limited to 512 MB of memory and one CPU.
- The container has no outbound internet access.
- We will stop and restart the container with the same volume, and inventory must survive the restart.

Please test your image with this command before submitting.

If you're on an ARM machine such as an Apple Silicon Mac, build with `docker buildx build --platform linux/amd64` (or your tool's equivalent).

You may deliver the image either:

- Through a public OCI-compatible registry, such as GitHub Container Registry, with the complete image reference and immutable digest. The evaluator must be able to pull the image without credentials.
- As a compressed container image archive, with instructions for loading and running it.

## Submission

Email the following to **craig.carlson@c-4analytics.com**, CC: **marc.arbesman@c-4analytics.com** and **sarah.wilkins@c-4analytics.com**:

- A link to the source repository, either public or shared with **[https://github.com/C-4Engineering]**. Please don't squash your commit history; we're interested in how the work progressed.
- The prebuilt container image or compressed image archive, plus the image digest if delivered through a registry
- `AI_DEVELOPMENT.md`, described below

We'll review the source repository and container definition, and use the prebuilt image to run the service.

### Repository documentation

Document the repository to the standard you'd expect of a production service. Wherever you think it belongs, it should cover:

- How to build and run the container, and how to run the tests
- The API you designed
- The architecture and important technical decisions, including how you handled "Decisions left to you"
- How the design would need to change to handle thousands of dealerships, feeds with tens of thousands of vehicles, and multiple service instances running at once. You are not expected to build for scale.
- Assumptions, incomplete work, and known limitations

The repository must also include the `Dockerfile` or equivalent container build definition, and a runnable script or request collection (for example, a shell script with `curl` commands or an `.http` file) that replays the March 15 and March 16 example against the running container and shows the resulting inventory.

## AI development report

`AI_DEVELOPMENT.md` is a short report on how you worked. Don't repeat anything already covered by the repository documentation; link to it if needed. Include:

- The AI tools and models you used, where known
- How you structured your work with AI: planning, implementation, and testing
- How you reviewed and verified AI-generated work
- One example of AI output you corrected, rejected, or substantially changed, and why
- The actual time you spent
- Any limitations introduced by the timebox

Full AI conversation transcripts are not required.
